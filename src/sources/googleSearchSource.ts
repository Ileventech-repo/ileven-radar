import axios from "axios";
import { RawItem, SourceRecord } from "../types/opportunity";
import { withRetry } from "../utils/retry";
import { childLogger } from "../config/logger";
import { env, googleSearchEnabled } from "../config/env";

const log = childLogger("GoogleSearchSource");

interface GoogleSearchItem {
  title: string;
  link: string;
  snippet: string;
}

/**
 * Runs a single Google Programmable Search query and converts the top
 * results into RawItems. This is what continuously "searches the
 * internet" for keyword-based opportunities (RFPs, "looking for a
 * developer", funding announcements, etc) that don't have a dedicated
 * RSS feed.
 */
export async function collectFromGoogleSearchSource(source: SourceRecord): Promise<RawItem[]> {
  if (!googleSearchEnabled) {
    log.warn(
      { source: source.name },
      "Skipping google_search source - GOOGLE_CSE_API_KEY / GOOGLE_CSE_ID not configured"
    );
    return [];
  }

  const query = String(source.config.query ?? "");
  if (!query) {
    throw new Error(`Google search source "${source.name}" is missing config.query`);
  }

  const response = await withRetry(
    () =>
      axios.get("https://www.googleapis.com/customsearch/v1", {
        params: {
          key: env.GOOGLE_CSE_API_KEY,
          cx: env.GOOGLE_CSE_ID,
          q: query,
          num: 10,
          dateRestrict: "d7", // last 7 days keeps results fresh on every hourly run
        },
        timeout: 15_000,
      }),
    { label: `Google search (${source.name})`, retries: 2 }
  );

  const results: GoogleSearchItem[] = response.data?.items ?? [];

  const items: RawItem[] = results
    .filter((r) => r.link && r.title)
    .map((r) => ({
      sourceId: source.id,
      sourceName: source.name,
      sourceCategory: source.category,
      sourceType: "google_search",
      url: r.link,
      title: r.title.trim(),
      content: (r.snippet ?? "").trim(),
    }));

  log.debug({ source: source.name, query, count: items.length }, "Collected Google search results");
  return items;
}
