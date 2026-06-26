import { logger } from "../config/logger";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

/**
 * Runs `fn`, retrying with exponential backoff + jitter on failure.
 * Used to make every external call (HTTP fetch, OpenAI, Telegram, DB)
 * resilient to transient errors without crashing the whole pipeline.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { retries = 3, baseDelayMs = 500, maxDelayMs = 8_000, label = "operation" } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) {
        break;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.7 + Math.random() * 0.6);
      logger.warn(
        { err: (err as Error)?.message, attempt: attempt + 1, retries, delayMs: Math.round(delay) },
        `${label} failed, retrying`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
