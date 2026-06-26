import { pool } from "../db/pool";
import {
  AiAnalysisResult,
  LeadScoreResult,
  OpportunityRecord,
  RawItem,
} from "../types/opportunity";
import { buildContentHash } from "../utils/hash";

interface OppRow {
  id: string;
  source_name: string;
  source_category: string;
  url: string;
  raw_title: string;
  title: string | null;
  company: string | null;
  location: string | null;
  industry: string | null;
  budget_text: string | null;
  estimated_value_usd: string | null;
  deadline: string | null;
  contact_info: string | null;
  technologies: string[] | null;
  category: string;
  summary: string | null;
  recommended_action: string | null;
  opportunity_score: number | null;
  label: OpportunityRecord["label"];
  status: OpportunityRecord["status"];
  telegram_sent: boolean;
  created_at: string;
}

function mapRow(row: OppRow): OpportunityRecord {
  return {
    id: row.id,
    sourceName: row.source_name,
    sourceCategory: row.source_category,
    url: row.url,
    rawTitle: row.raw_title,
    title: row.title,
    company: row.company,
    location: row.location,
    industry: row.industry,
    budgetText: row.budget_text,
    estimatedValueUsd: row.estimated_value_usd ? Number(row.estimated_value_usd) : null,
    deadline: row.deadline,
    contactInfo: row.contact_info,
    technologies: row.technologies ?? [],
    category: row.category,
    summary: row.summary,
    recommendedAction: row.recommended_action,
    opportunityScore: row.opportunity_score,
    label: row.label,
    status: row.status,
    telegramSent: row.telegram_sent,
    createdAt: row.created_at,
  };
}

const SELECT_COLS = `
  id, source_name, source_category, url, raw_title, title, company, location,
  industry, budget_text, estimated_value_usd, deadline, contact_info,
  technologies, category, summary, recommended_action, opportunity_score,
  label, status, telegram_sent, created_at
`;

/**
 * Inserts a raw item if its content hash is new. Returns the new row id,
 * or null if it was a duplicate. This is the deduplication step (workflow
 * step 4) - enforced at the DB level by the UNIQUE constraint on
 * content_hash, so it is safe even with concurrent collectors.
 */
export async function insertRawIfNew(item: RawItem): Promise<string | null> {
  const hash = buildContentHash(item.title, item.url);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO opportunities
       (source_id, source_name, source_category, url, raw_title, raw_content,
        published_at, content_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new')
     ON CONFLICT (content_hash) DO NOTHING
     RETURNING id`,
    [
      item.sourceId,
      item.sourceName,
      item.sourceCategory,
      item.url,
      item.title,
      item.content,
      item.publishedAt ?? null,
      hash,
    ]
  );
  return result.rows[0]?.id ?? null;
}

export async function getPendingAnalysis(limit = 50): Promise<
  Array<{
    id: string;
    sourceName: string;
    sourceCategory: string;
    url: string;
    rawTitle: string;
    rawContent: string | null;
  }>
> {
  const result = await pool.query(
    `SELECT id, source_name, source_category, url, raw_title, raw_content
     FROM opportunities
     WHERE status = 'new'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((r) => ({
    id: r.id,
    sourceName: r.source_name,
    sourceCategory: r.source_category,
    url: r.url,
    rawTitle: r.raw_title,
    rawContent: r.raw_content,
  }));
}

export async function saveAnalysis(
  id: string,
  analysis: AiAnalysisResult,
  score: LeadScoreResult
): Promise<void> {
  await pool.query(
    `UPDATE opportunities SET
       title = $2, company = $3, location = $4, industry = $5, budget_text = $6,
       estimated_value_usd = $7, deadline = $8, contact_info = $9, technologies = $10,
       category = $11, summary = $12, recommended_action = $13,
       score_budget = $14, score_urgency = $15, score_credibility = $16,
       score_relevance = $17, score_quality = $18, opportunity_score = $19,
       label = $20, status = 'analyzed', analysis_error = NULL, updated_at = now()
     WHERE id = $1`,
    [
      id,
      analysis.title,
      analysis.company,
      analysis.location,
      analysis.industry,
      analysis.budgetText,
      analysis.estimatedValueUsd,
      analysis.deadline,
      analysis.contactInfo,
      analysis.technologies,
      analysis.category,
      analysis.summary,
      analysis.recommendedAction,
      analysis.scoreBudget,
      analysis.scoreUrgency,
      analysis.scoreCredibility,
      analysis.scoreRelevance,
      analysis.scoreQuality,
      score.opportunityScore,
      score.label,
    ]
  );
}

export async function markAnalysisFailed(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE opportunities SET status = 'failed', analysis_error = $2, updated_at = now() WHERE id = $1`,
    [id, error.slice(0, 1000)]
  );
}

/** Opportunities that are analyzed, qualify by score, and not yet pushed. */
export async function getUnsentQualified(minScore: number): Promise<OpportunityRecord[]> {
  const result = await pool.query<OppRow>(
    `SELECT ${SELECT_COLS} FROM opportunities
     WHERE status = 'analyzed' AND telegram_sent = FALSE AND opportunity_score >= $1
     ORDER BY opportunity_score DESC, created_at ASC
     LIMIT 50`,
    [minScore]
  );
  return result.rows.map(mapRow);
}

export async function markTelegramSent(id: string): Promise<void> {
  await pool.query(
    `UPDATE opportunities SET telegram_sent = TRUE, telegram_sent_at = now() WHERE id = $1`,
    [id]
  );
}

// --- Read queries used by both the Telegram bot commands and the REST API ---

export interface OpportunityQuery {
  category?: string;
  label?: OpportunityRecord["label"];
  minScore?: number;
  search?: string;
  limit?: number;
}

export async function queryOpportunities(q: OpportunityQuery): Promise<OpportunityRecord[]> {
  const conditions: string[] = ["status = 'analyzed'"];
  const params: unknown[] = [];

  if (q.category) {
    params.push(q.category);
    conditions.push(`category = $${params.length}`);
  }
  if (q.label) {
    params.push(q.label);
    conditions.push(`label = $${params.length}`);
  }
  if (typeof q.minScore === "number") {
    params.push(q.minScore);
    conditions.push(`opportunity_score >= $${params.length}`);
  }
  if (q.search) {
    params.push(`%${q.search}%`);
    const i = params.length;
    conditions.push(
      `(title ILIKE $${i} OR company ILIKE $${i} OR summary ILIKE $${i}
        OR location ILIKE $${i} OR industry ILIKE $${i}
        OR array_to_string(technologies, ',') ILIKE $${i})`
    );
  }

  params.push(q.limit ?? 20);
  const limitIdx = params.length;

  const result = await pool.query<OppRow>(
    `SELECT ${SELECT_COLS} FROM opportunities
     WHERE ${conditions.join(" AND ")}
     ORDER BY opportunity_score DESC NULLS LAST, created_at DESC
     LIMIT $${limitIdx}`,
    params
  );
  return result.rows.map(mapRow);
}

export async function getStats(): Promise<{
  total: number;
  hot: number;
  warm: number;
  today: number;
  pending: number;
}> {
  const result = await pool.query<{
    total: string;
    hot: string;
    warm: string;
    today: string;
    pending: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'analyzed') AS total,
       COUNT(*) FILTER (WHERE label = 'HOT') AS hot,
       COUNT(*) FILTER (WHERE label = 'WARM') AS warm,
       COUNT(*) FILTER (WHERE status = 'analyzed' AND created_at > now() - interval '24 hours') AS today,
       COUNT(*) FILTER (WHERE status = 'new') AS pending
     FROM opportunities`
  );
  const r = result.rows[0];
  return {
    total: Number(r.total),
    hot: Number(r.hot),
    warm: Number(r.warm),
    today: Number(r.today),
    pending: Number(r.pending),
  };
}

export async function getAnalyticsByCategory(): Promise<Array<{ category: string; count: number }>> {
  const result = await pool.query<{ category: string; count: string }>(
    `SELECT category, COUNT(*) AS count FROM opportunities
     WHERE status = 'analyzed' GROUP BY category ORDER BY count DESC`
  );
  return result.rows.map((r) => ({ category: r.category, count: Number(r.count) }));
}
