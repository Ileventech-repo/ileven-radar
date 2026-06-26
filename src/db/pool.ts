import { Pool } from "pg";
import { env } from "../config/env";
import { logger } from "../config/logger";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Railway/most managed Postgres providers require SSL outside their
  // private network; allow self-signed certs in that scenario.
  ssl:
    env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected error on idle Postgres client");
});

export async function withTransaction<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
