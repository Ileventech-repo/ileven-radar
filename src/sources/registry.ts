import { pool } from "../db/pool";
import { SourceRecord, SourceType } from "../types/opportunity";

interface SourceRow {
  id: string;
  name: string;
  type: SourceType;
  category: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

function mapRow(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    category: row.category,
    config: row.config,
    enabled: row.enabled,
  };
}

export async function listEnabledSources(): Promise<SourceRecord[]> {
  const result = await pool.query<SourceRow>(
    `SELECT id, name, type, category, config, enabled FROM sources WHERE enabled = TRUE ORDER BY created_at ASC`
  );
  return result.rows.map(mapRow);
}

export async function listAllSources(): Promise<SourceRecord[]> {
  const result = await pool.query<SourceRow>(
    `SELECT id, name, type, category, config, enabled FROM sources ORDER BY created_at ASC`
  );
  return result.rows.map(mapRow);
}

export async function createSource(input: {
  name: string;
  type: SourceType;
  category: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}): Promise<SourceRecord> {
  const result = await pool.query<SourceRow>(
    `INSERT INTO sources (name, type, category, config, enabled)
     VALUES ($1, $2, $3, $4, COALESCE($5, TRUE))
     RETURNING id, name, type, category, config, enabled`,
    [input.name, input.type, input.category, JSON.stringify(input.config), input.enabled]
  );
  return mapRow(result.rows[0]);
}

export async function setSourceEnabled(id: string, enabled: boolean): Promise<void> {
  await pool.query(`UPDATE sources SET enabled = $2, updated_at = now() WHERE id = $1`, [id, enabled]);
}

export async function recordSourceRunStart(source: SourceRecord): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO source_runs (source_id, source_name, status) VALUES ($1, $2, 'running') RETURNING id`,
    [source.id, source.name]
  );
  return result.rows[0].id;
}

export async function recordSourceRunFinish(
  runId: string,
  result: { itemsFound: number; itemsNew: number; status: "success" | "failed"; error?: string }
): Promise<void> {
  await pool.query(
    `UPDATE source_runs
     SET finished_at = now(), items_found = $2, items_new = $3, status = $4, error = $5
     WHERE id = $1`,
    [runId, result.itemsFound, result.itemsNew, result.status, result.error ?? null]
  );
}

export async function markSourceOutcome(
  sourceId: string,
  outcome: { success: boolean; error?: string }
): Promise<void> {
  await pool.query(
    `UPDATE sources SET last_run_at = now(), last_error = $2, updated_at = now() WHERE id = $1`,
    [sourceId, outcome.success ? null : outcome.error ?? "Unknown error"]
  );
}
