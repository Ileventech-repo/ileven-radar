import axios from "axios";
import { env, hunterEnabled } from "../config/env";
import { childLogger } from "../config/logger";
import { pool } from "../db/pool";
import { withRetry, sleep } from "../utils/retry";

const log = childLogger("ContactFinder");

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
    const emails: Array<{ value: string; confidence: number; type: string }> =
      response.data?.data?.emails ?? [];
    // Prefer generic/department emails, then highest confidence
    const sorted = emails.sort((a, b) => {
      const aGeneric = /^(hello|info|contact|sales|business)@/.test(a.value) ? 1 : 0;
      const bGeneric = /^(hello|info|contact|sales|business)@/.test(b.value) ? 1 : 0;
      if (bGeneric !== aGeneric) return bGeneric - aGeneric;
      return b.confidence - a.confidence;
    });
    return sorted[0]?.value ?? null;
  } catch {
    return null;
  }
}

export async function enrichProspectsWithEmails(): Promise<number> {
  if (!hunterEnabled) {
    log.warn("HUNTER_API_KEY not set — skipping contact enrichment");
    return 0;
  }

  // Find prospects with websites but no contact email yet
  const result = await pool.query<{ place_id: string; website: string }>(
    `SELECT place_id, website FROM prospects
     WHERE website IS NOT NULL AND contact_email IS NULL AND telegram_sent = TRUE
     ORDER BY created_at DESC LIMIT 20`
  );

  let enriched = 0;
  for (const row of result.rows) {
    try {
      const domain = new URL(row.website).hostname.replace(/^www\./, "");
      await sleep(300); // Hunter.io rate limit
      const email = await findEmailForDomain(domain);
      if (email) {
        await pool.query(
          `UPDATE prospects SET contact_email=$1 WHERE place_id=$2`,
          [email, row.place_id]
        );
        log.info({ domain, email }, "Contact email found");
        enriched++;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, placeId: row.place_id }, "Contact enrichment failed");
    }
  }

  log.info({ enriched }, "Contact enrichment complete");
  return enriched;
}
