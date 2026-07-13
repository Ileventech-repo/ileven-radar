import axios from "axios";
import * as cheerio from "cheerio";
import { env, hunterEnabled, googleSearchEnabled } from "../config/env";
import { childLogger } from "../config/logger";
import { pool } from "../db/pool";
import { withRetry, sleep } from "../utils/retry";

const log = childLogger("ContactFinder");

const EMAIL_REGEX = /[\w.+'-]+@[\w-]+\.[a-z]{2,}/gi;
const IGNORED_DOMAINS = /\.(png|jpg|jpeg|gif|svg|webp|pdf|woff|ttf)$/i;
const JUNK_PREFIXES = /^(noreply|no-reply|donotreply|mailer|bounce|support@sentry|example)/i;

function extractEmails(text: string): string[] {
  const found = text.match(EMAIL_REGEX) ?? [];
  return [...new Set(found)]
    .map((e) => e.toLowerCase())
    .filter((e) => !JUNK_PREFIXES.test(e) && e.length < 100);
}

function rankEmails(emails: string[]): string | null {
  if (emails.length === 0) return null;
  const priority = /^(hello|info|contact|sales|business|admin|office|team|mail)@/;
  const sorted = emails.sort((a, b) => {
    const aP = priority.test(a) ? 1 : 0;
    const bP = priority.test(b) ? 1 : 0;
    return bP - aP;
  });
  return sorted[0];
}

// ── Hunter.io domain search ─────────────────────────────────────────────────
export async function findEmailForDomain(domain: string): Promise<string | null> {
  if (!hunterEnabled) return null;
  try {
    const response = await withRetry(
      () => axios.get("https://api.hunter.io/v2/domain-search", {
        params: { domain, api_key: env.HUNTER_API_KEY, limit: 5 },
        timeout: 10_000,
      }),
      { label: `Hunter.io: ${domain}`, retries: 1 }
    );
    const emails: Array<{ value: string; confidence: number }> =
      response.data?.data?.emails ?? [];
    return emails.sort((a, b) => b.confidence - a.confidence)[0]?.value ?? null;
  } catch {
    return null;
  }
}

// ── Website contact-page scraper ────────────────────────────────────────────
async function scrapeWebsiteForEmail(website: string): Promise<string | null> {
  const base = website.replace(/\/$/, "");
  const pagesToTry = [base, `${base}/contact`, `${base}/contact-us`, `${base}/about`, `${base}/about-us`];

  for (const url of pagesToTry) {
    try {
      if (IGNORED_DOMAINS.test(url)) continue;
      const { data } = await axios.get(url, {
        timeout: 8_000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
        maxRedirects: 3,
      });
      const $ = cheerio.load(data as string);

      // mailto: links first — most reliable
      const mailtoEmails: string[] = [];
      $("a[href^='mailto:']").each((_, el) => {
        const href = $(el).attr("href") ?? "";
        const email = href.replace("mailto:", "").split("?")[0].trim().toLowerCase();
        if (email && email.includes("@")) mailtoEmails.push(email);
      });
      if (mailtoEmails.length > 0) return rankEmails(mailtoEmails);

      // Fall back to regex scan of page text
      const text = $("body").text();
      const emails = extractEmails(text);
      const ranked = rankEmails(emails);
      if (ranked) return ranked;
    } catch {
      // page not found or timeout — try next
    }
    await sleep(300);
  }
  return null;
}

// ── Google CSE search for email ─────────────────────────────────────────────
async function findEmailViaGoogleSearch(businessName: string, location: string): Promise<string | null> {
  if (!googleSearchEnabled) return null;
  try {
    const query = `"${businessName}" "${location}" email contact`;
    const response = await withRetry(
      () => axios.get("https://www.googleapis.com/customsearch/v1", {
        params: {
          q: query,
          key: env.GOOGLE_CSE_API_KEY,
          cx: env.GOOGLE_CSE_ID,
          num: 5,
        },
        timeout: 10_000,
      }),
      { label: `CSE email search: ${businessName}`, retries: 1 }
    );

    const items: Array<{ snippet?: string; link?: string }> = response.data?.items ?? [];

    // 1. Try to extract emails directly from snippets
    for (const item of items) {
      const emails = extractEmails(item.snippet ?? "");
      const ranked = rankEmails(emails);
      if (ranked) return ranked;
    }

    // 2. Try visiting the top result pages
    for (const item of items.slice(0, 2)) {
      if (!item.link || IGNORED_DOMAINS.test(item.link)) continue;
      try {
        const { data } = await axios.get(item.link, {
          timeout: 8_000,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
          maxRedirects: 3,
        });
        const $ = cheerio.load(data as string);
        const mailtoEmails: string[] = [];
        $("a[href^='mailto:']").each((_, el) => {
          const href = $(el).attr("href") ?? "";
          const email = href.replace("mailto:", "").split("?")[0].trim().toLowerCase();
          if (email && email.includes("@")) mailtoEmails.push(email);
        });
        if (mailtoEmails.length > 0) return rankEmails(mailtoEmails);

        const emails = extractEmails($("body").text());
        const ranked = rankEmails(emails);
        if (ranked) return ranked;
      } catch { /* skip */ }
      await sleep(400);
    }
  } catch (err) {
    log.warn({ err: (err as Error).message, businessName }, "Google CSE email search failed");
  }
  return null;
}

// ── Main enrichment: tries all methods in order ─────────────────────────────
export async function findEmailForProspect(
  placeId: string,
  businessName: string,
  location: string,
  website?: string | null
): Promise<string | null> {
  // 1. Website scraper (fastest, free)
  if (website) {
    const scraped = await scrapeWebsiteForEmail(website);
    if (scraped) {
      log.info({ businessName, scraped }, "Email found via website scrape");
      return scraped;
    }
  }

  // 2. Hunter.io domain search
  if (website && hunterEnabled) {
    try {
      const domain = new URL(website).hostname.replace(/^www\./, "");
      await sleep(300);
      const hunterEmail = await findEmailForDomain(domain);
      if (hunterEmail) {
        log.info({ businessName, hunterEmail }, "Email found via Hunter.io");
        return hunterEmail;
      }
    } catch { /* bad URL */ }
  }

  // 3. Google search (works even without a website)
  const searchEmail = await findEmailViaGoogleSearch(businessName, location);
  if (searchEmail) {
    log.info({ businessName, searchEmail }, "Email found via Google search");
    return searchEmail;
  }

  return null;
}

// ── Batch enrichment pipeline ────────────────────────────────────────────────
export async function enrichProspectsWithEmails(): Promise<number> {
  // Pick prospects not yet enriched (with or without a website)
  const result = await pool.query<{
    place_id: string; name: string; location: string; website: string | null;
  }>(
    `SELECT place_id, name, location, website FROM prospects
     WHERE contact_email IS NULL
     ORDER BY created_at DESC LIMIT 30`
  );

  let enriched = 0;
  for (const row of result.rows) {
    try {
      await sleep(500);
      const email = await findEmailForProspect(row.place_id, row.name, row.location, row.website);
      if (email) {
        await pool.query(`UPDATE prospects SET contact_email=$1 WHERE place_id=$2`, [email, row.place_id]);
        log.info({ name: row.name, email }, "Prospect email enriched");
        enriched++;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, name: row.name }, "Enrichment failed");
    }
  }

  log.info({ enriched }, "Prospect email enrichment complete");
  return enriched;
}
