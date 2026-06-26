import axios from "axios";
import * as cheerio from "cheerio";
import { RawItem, SourceRecord } from "../types/opportunity";
import { withRetry } from "../utils/retry";
import { childLogger } from "../config/logger";

const log = childLogger("LinkedInSource");

const LINKEDIN_JOBS_URL = "https://www.linkedin.com/jobs-guest/jobs/api/sideBarJobCount";
const LINKEDIN_SEARCH_URL = "https://www.linkedin.com/jobs/search";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

interface LinkedInJobCard {
  title: string;
  company: string;
  location: string;
  url: string;
  listedAt: string;
}

function parseJobCards(html: string): LinkedInJobCard[] {
  const $ = cheerio.load(html);
  const jobs: LinkedInJobCard[] = [];

  $("div.base-card, li.base-card, div.job-search-card").each((_, el) => {
    const card = $(el);
    const title = card.find("h3.base-search-card__title, h3.base-card__title").text().trim();
    const company = card
      .find("h4.base-search-card__subtitle, a.hidden-nested-link")
      .first()
      .text()
      .trim();
    const location = card.find("span.job-search-card__location").text().trim();
    const linkEl = card.find("a.base-card__full-link, a[href*='/jobs/view/']").first();
    const url = linkEl.attr("href")?.split("?")[0]?.trim() ?? "";
    const listedAt = card.find("time").attr("datetime") ?? "";

    if (title && url) {
      jobs.push({ title, company, location, url, listedAt });
    }
  });

  return jobs;
}

export async function collectFromLinkedInSource(source: SourceRecord): Promise<RawItem[]> {
  const keywords = String(source.config.keywords ?? source.config.query ?? "");
  if (!keywords) {
    throw new Error(`LinkedIn source "${source.name}" is missing config.keywords`);
  }

  const location = String(source.config.location ?? "");
  const params: Record<string, string> = {
    keywords,
    f_TPR: "r86400", // last 24 hours
    position: "1",
    pageNum: "0",
    start: "0",
  };
  if (location) {
    params.location = location;
  }

  const html = await withRetry(
    () =>
      axios
        .get(LINKEDIN_SEARCH_URL, { params, headers: HEADERS, timeout: 20_000 })
        .then((r) => r.data as string),
    { label: `LinkedIn search (${source.name})`, retries: 2 }
  );

  const jobs = parseJobCards(html);

  const items: RawItem[] = jobs.map((job) => ({
    sourceId: source.id,
    sourceName: source.name,
    sourceCategory: source.category,
    sourceType: "linkedin" as const,
    url: job.url,
    title: job.title,
    content: [
      job.company && `Company: ${job.company}`,
      job.location && `Location: ${job.location}`,
      job.listedAt && `Listed: ${job.listedAt}`,
    ]
      .filter(Boolean)
      .join(" | "),
    publishedAt: job.listedAt ? new Date(job.listedAt) : undefined,
  }));

  log.debug({ source: source.name, keywords, count: items.length }, "Collected LinkedIn jobs");
  return items;
}
