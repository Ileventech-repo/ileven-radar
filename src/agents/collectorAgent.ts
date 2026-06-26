import { collectFromRssSource } from "../sources/rssSource";
import { collectFromGoogleSearchSource } from "../sources/googleSearchSource";
import {
  listEnabledSources,
  markSourceOutcome,
  recordSourceRunFinish,
  recordSourceRunStart,
} from "../sources/registry";
import { insertRawIfNew } from "../services/opportunityRepository";
import { RawItem, SourceRecord } from "../types/opportunity";
import { childLogger } from "../config/logger";

const log = childLogger("CollectorAgent");

async function collectFromSource(source: SourceRecord): Promise<RawItem[]> {
  switch (source.type) {
    case "rss":
      return collectFromRssSource(source);
    case "google_search":
      // The Web Search Agent is just the google_search branch of the
      // collector - same interface, different transport.
      return collectFromGoogleSearchSource(source);
    default:
      log.warn({ type: source.type }, "Unknown source type, skipping");
      return [];
  }
}

export interface CollectionSummary {
  sourcesProcessed: number;
  itemsFound: number;
  itemsNew: number;
  newItemIds: string[];
}

/**
 * Source Collector Agent (workflow steps 1-4): for every enabled source,
 * fetch items, deduplicate, and persist the new ones as 'new' rows ready
 * for analysis. Each source is isolated so one failing feed never aborts
 * the whole cycle.
 */
export async function runCollection(): Promise<CollectionSummary> {
  const sources = await listEnabledSources();
  log.info({ count: sources.length }, "Starting collection cycle");

  const summary: CollectionSummary = {
    sourcesProcessed: 0,
    itemsFound: 0,
    itemsNew: 0,
    newItemIds: [],
  };

  for (const source of sources) {
    const runId = await recordSourceRunStart(source);
    let found = 0;
    let isNew = 0;
    try {
      const items = await collectFromSource(source);
      found = items.length;

      for (const item of items) {
        const id = await insertRawIfNew(item);
        if (id) {
          isNew += 1;
          summary.newItemIds.push(id);
        }
      }

      await markSourceOutcome(source.id, { success: true });
      await recordSourceRunFinish(runId, {
        itemsFound: found,
        itemsNew: isNew,
        status: "success",
      });
      log.info({ source: source.name, found, new: isNew }, "Source collected");
    } catch (err) {
      const message = (err as Error)?.message ?? "Unknown error";
      await markSourceOutcome(source.id, { success: false, error: message });
      await recordSourceRunFinish(runId, {
        itemsFound: found,
        itemsNew: isNew,
        status: "failed",
        error: message,
      });
      log.error({ source: source.name, err: message }, "Source collection failed");
    }

    summary.sourcesProcessed += 1;
    summary.itemsFound += found;
    summary.itemsNew += isNew;
  }

  log.info(summary, "Collection cycle complete");
  return summary;
}
