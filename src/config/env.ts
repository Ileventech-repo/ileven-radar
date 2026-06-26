import "dotenv/config";
import { z } from "zod";

/**
 * All environment variables the agent needs, validated at boot time.
 * The process fails fast with a clear message if anything required is
 * missing, instead of crashing later deep inside an agent.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().default(8080),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),

  GOOGLE_CSE_API_KEY: z.string().optional().default(""),
  GOOGLE_CSE_ID: z.string().optional().default(""),

  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),

  MIN_SCORE_TO_NOTIFY: z.coerce.number().min(0).max(100).default(50),
  CRON_SCHEDULE: z.string().default("0 * * * *"),
  RUN_ON_STARTUP: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration:");
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const googleSearchEnabled = Boolean(
  env.GOOGLE_CSE_API_KEY && env.GOOGLE_CSE_ID
);
