import { logger } from "./config/logger";
import { runMigrations } from "./db/migrate";
import { pool } from "./db/pool";
import { createApiServer } from "./api/server";
import { startTelegramBot, stopTelegramBot } from "./telegram/bot";
import { startScheduler } from "./scheduler/cron";
import { attachCallMediaStream } from "./api/webhooks/twilioVoice";
import { callAgentEnabled } from "./config/env";

async function main() {
  logger.info("🛰  Ileven Radar starting up");

  // 1. Ensure the schema is in place (idempotent).
  await runMigrations();

  // 2. HTTP API + healthcheck (Railway needs a listening port).
  const { app, listen } = createApiServer();
  const server = listen();

  // 2b. WebSocket server for Twilio call media stream
  if (callAgentEnabled) {
    attachCallMediaStream(server);
    logger.info("Call agent WebSocket ready");
  }

  // 3. Telegram bot (commands + push notifications).
  await startTelegramBot();

  // 4. Hourly autonomous discovery pipeline.
  startScheduler();

  logger.info("✅ Ileven Radar is live and running 24/7");

  // ---- Graceful shutdown ----
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gracefully");
    server.close();
    await stopTelegramBot().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Never let an unhandled rejection silently kill the agent.
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup");
  process.exit(1);
});
