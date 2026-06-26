import { analyzeItem } from "../agents/aiAnalysisAgent";
import { scoreOpportunity } from "../agents/leadScoringAgent";
import {
  getPendingAnalysis,
  markAnalysisFailed,
  saveAnalysis,
} from "./opportunityRepository";
import { childLogger } from "../config/logger";

const log = childLogger("AnalysisWorker");

/**
 * Pulls every 'new' opportunity, runs it through the AI Analysis Agent
 * (extraction + categorization + summary + sub-scores) and the Lead
 * Scoring Agent (final 0-100 + label), then persists the result.
 * One failure is isolated to a single item via try/catch + status='failed'.
 */
export async function runAnalysis(): Promise<{ analyzed: number; failed: number }> {
  let analyzed = 0;
  let failed = 0;

  // Process in batches until the 'new' queue is drained.
  for (;;) {
    const pending = await getPendingAnalysis(25);
    if (pending.length === 0) break;

    for (const item of pending) {
      try {
        const analysis = await analyzeItem({
          title: item.rawTitle,
          content: item.rawContent,
          sourceName: item.sourceName,
          sourceCategory: item.sourceCategory,
          url: item.url,
        });
        const score = scoreOpportunity(analysis);
        await saveAnalysis(item.id, analysis, score);
        analyzed += 1;
      } catch (err) {
        const message = (err as Error)?.message ?? "Unknown analysis error";
        await markAnalysisFailed(item.id, message);
        failed += 1;
        log.error({ id: item.id, err: message }, "Analysis failed for item");
      }
    }
  }

  log.info({ analyzed, failed }, "Analysis pass complete");
  return { analyzed, failed };
}
