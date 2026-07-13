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
  GOOGLE_PLACES_API_KEY: z.string().optional().default(""),

  PROSPECT_MIN_SCORE: z.coerce.number().min(0).max(100).default(60),
  PROSPECT_CRON: z.string().default("0 8 * * *"), // daily at 8am

  // Email / outreach
  RESEND_API_KEY: z.string().optional().default(""),
  FROM_EMAIL: z.string().optional().default("onboarding@resend.dev"),
  COMPANY_NAME: z.string().optional().default("Our Agency"),
  COMPANY_SERVICE: z.string().optional().default("professional web design and development services"),
  COMPANY_CONTACT_EMAIL: z.string().optional().default(""),
  COMPANY_WEBSITE: z.string().optional().default(""),

  // Contact finder
  HUNTER_API_KEY: z.string().optional().default(""),

  // WhatsApp + Voice (Twilio)
  TWILIO_ACCOUNT_SID: z.string().optional().default(""),
  TWILIO_AUTH_TOKEN: z.string().optional().default(""),
  TWILIO_WHATSAPP_NUMBER: z.string().optional().default(""), // e.g. whatsapp:+14155238886
  TWILIO_PHONE_NUMBER: z.string().optional().default(""),   // e.g. +14155551234 (voice calls)
  PUBLIC_URL: z.string().optional().default(""),            // e.g. https://ileven-radar-production.up.railway.app

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

export const placesEnabled = Boolean(env.GOOGLE_PLACES_API_KEY);
export const emailEnabled = Boolean(env.RESEND_API_KEY);
export const hunterEnabled = Boolean(env.HUNTER_API_KEY);
export const whatsappEnabled = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_NUMBER);
export const callAgentEnabled = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER && env.PUBLIC_URL);
