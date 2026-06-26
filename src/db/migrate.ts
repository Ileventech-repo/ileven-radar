import fs from "fs";
import path from "path";
import { pool } from "./pool";
import { logger } from "../config/logger";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const result = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations"
  );
  return new Set(result.rows.map((row) => row.name));
}

export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    logger.info({ migration: file }, "Applying migration");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      logger.info({ migration: file }, "Migration applied successfully");
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error({ migration: file, err }, "Migration failed");
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info("All migrations up to date");
}

// Allow `node dist/db/migrate.js` to run standalone (used in the `start`
// script before booting the app, and in `migrate` / `migrate:dev` scripts).
if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, "Migration run failed");
      process.exit(1);
    });
}
