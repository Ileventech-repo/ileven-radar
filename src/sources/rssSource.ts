import Parser from "rss-parser";
import { RawItem, SourceRecord } from "../types/opportunity";
import { withRetry } from "../utils/retry";
import { childLogger } from "../config/logger";

const log = childLogger("RssSource");
const parser = new Parser({ timeout: 15_000 });

/**
 * Fetches a single RSS/Atom feed and converts every entry into a RawItem.
 * Supports "unlimited RSS feeds" because each feed is just a row in the
 * `sources` table (type='rss') - add as many as you like via the API.
 */
export async function collectFromRssSource(source: SourceRecord): Promise<RawItem[]> {
  const url = String(source.config.url ?? "");
  if (!url) {
    throw new Error(`RSS source "${source.name}" is missing config.url`);
  }

  const feed = await withRetry(() => parser.parseURL(url), {
    label: `RSS fetch (${source.name})`,
    retries: 2,
  });

  const items: RawItem[] = (feed.items ?? [])
    .filter((item) => item.link && (item.title || item.contentSnippet))
    .map((item) => ({
      sourceId: source.id,
      sourceName: source.name,
      sourceCategory: source.category,
      sourceType: "rss",
      url: item.link as string,
      title: (item.title ?? "Untitled").trim(),
      content: (item.contentSnippet ?? item.content ?? item.summary ?? "").toString().trim(),
      publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
    }));

  log.debug({ source: source.name, count: items.length }, "Collected RSS items");
  return items;
}
