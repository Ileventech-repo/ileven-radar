import cron from "node-cron";
import { env } from "../config/env";
import { childLogger } from "../config/logger";
import { runPipeline } from "./pipeline";

const log = childLogger("Scheduler");

export function startScheduler(): void {
  if (!cron.validate(env.CRON_SCHEDULE)) {
    throw new Error(`Invalid CRON_SCHEDULE: "${env.CRON_SCHEDULE}"`);
  }

  cron.schedule(env.CRON_SCHEDULE, () => {
    void runPipeline("cron");
  });

  log.info({ schedule: env.CRON_SCHEDULE }, "Scheduler started");

  if (env.RUN_ON_STARTUP) {
    log.info("RUN_ON_STARTUP enabled - kicking off an immediate cycle");
    // Fire and forget; pipeline has its own locking + error handling.
    void runPipeline("startup");
  }
}
