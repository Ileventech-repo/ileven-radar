import { runCollection } from "../agents/collectorAgent";
import { runAnalysis } from "../services/analysisWorker";
import { deliverQualifiedLeads } from "../telegram/bot";
import { childLogger } from "../config/logger";

const log = childLogger("Orchestrator");

let running = false;

/**
 * Executes one full discovery cycle end to end:
 *   1-4. Collect from all sources + dedupe        (collectorAgent)
 *   5-7. Analyze, categorize, summarize, score     (analysisWorker)
 *   8.   Deliver qualified leads to Telegram        (telegram bot)
 *
 * A simple in-process lock prevents overlapping runs if a cycle ever
 * takes longer than the cron interval.
 */
export async function runPipeline(trigger: string): Promise<void> {
  if (running) {
    log.warn({ trigger }, "Pipeline already running, skipping this trigger");
    return;
  }
  running = true;
  const startedAt = Date.now();
  log.info({ trigger }, "Pipeline cycle started");

  try {
    const collection = await runCollection();
    const analysis = await runAnalysis();
    const delivered = await deliverQualifiedLeads();

    log.info(
      {
        trigger,
        durationMs: Date.now() - startedAt,
        sources: collection.sourcesProcessed,
        found: collection.itemsFound,
        new: collection.itemsNew,
        analyzed: analysis.analyzed,
        failed: analysis.failed,
        delivered,
      },
      "Pipeline cycle finished"
    );
  } catch (err) {
    log.error({ trigger, err: (err as Error).message }, "Pipeline cycle errored");
  } finally {
    running = false;
  }
}
