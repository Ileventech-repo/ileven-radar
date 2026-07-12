import cron from "node-cron";
import { env } from "../config/env";
import { childLogger } from "../config/logger";
import { runPipeline } from "./pipeline";
import { runProspectCycle } from "./prospectPipeline";

const log = childLogger("Scheduler");

export function startScheduler(): void {
  if (!cron.validate(env.CRON_SCHEDULE)) {
    throw new Error(`Invalid CRON_SCHEDULE: "${env.CRON_SCHEDULE}"`);
  }

  cron.schedule(env.CRON_SCHEDULE, () => {
    void runPipeline("cron");
  });

  cron.schedule(env.PROSPECT_CRON, () => {
    void runProspectCycle("cron");
  });

  log.info({ schedule: env.CRON_SCHEDULE, prospectSchedule: env.PROSPECT_CRON }, "Scheduler started");

  if (env.RUN_ON_STARTUP) {
    log.info("RUN_ON_STARTUP enabled - kicking off an immediate cycle");
    void runPipeline("startup");
  }
}
