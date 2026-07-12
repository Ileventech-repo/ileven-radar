import { runAllProspectTargets } from "../agents/placesProspectorAgent";
import { deliverUnsentProspects } from "../telegram/bot";
import { enrichProspectsWithEmails } from "../services/contactFinderService";
import { runPendingSequences } from "../services/sequenceService";
import { childLogger } from "../config/logger";

const log = childLogger("ProspectOrchestrator");

let running = false;

export async function runProspectCycle(trigger: string): Promise<void> {
  if (running) {
    log.warn({ trigger }, "Prospect cycle already running, skipping");
    return;
  }
  running = true;
  const startedAt = Date.now();
  log.info({ trigger }, "Prospect cycle started");

  try {
    const found = await runAllProspectTargets();
    const delivered = await deliverUnsentProspects();
    const enriched = await enrichProspectsWithEmails();
    const followUpsSent = await runPendingSequences();
    log.info({ trigger, found, delivered, enriched, followUpsSent, durationMs: Date.now() - startedAt }, "Prospect cycle finished");
  } catch (err) {
    log.error({ trigger, err: (err as Error).message }, "Prospect cycle errored");
  } finally {
    running = false;
  }
}
