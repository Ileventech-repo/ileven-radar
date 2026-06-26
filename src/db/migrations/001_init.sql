-- =============================================================================
-- Ileven Radar - Initial schema (001_init.sql)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- -----------------------------------------------------------------------------
-- sources: every monitored source (RSS feed or Google Search query) lives
-- here. This is what makes the "RSS Feed Engine" and "Google Search
-- Monitoring" requirements configurable at runtime instead of hard-coded.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('rss', 'google_search')),
  category        TEXT NOT NULL DEFAULT 'general',
  -- For type=rss: { "url": "https://..." }
  -- For type=google_search: { "query": "\"request for proposal\" website redesign" }
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at     TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources (enabled);
CREATE INDEX IF NOT EXISTS idx_sources_type ON sources (type);

-- -----------------------------------------------------------------------------
-- opportunities: the core entity. One row per discovered, AI-analyzed,
-- scored opportunity.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Raw discovery info
  source_id           UUID REFERENCES sources(id) ON DELETE SET NULL,
  source_name         TEXT NOT NULL,
  source_category     TEXT NOT NULL,
  url                 TEXT NOT NULL,
  raw_title           TEXT NOT NULL,
  raw_content         TEXT,
  published_at        TIMESTAMPTZ,

  -- Deduplication
  content_hash        TEXT NOT NULL UNIQUE,

  -- AI-extracted fields
  title               TEXT,
  company             TEXT,
  location             TEXT,
  industry            TEXT,
  budget_text         TEXT,
  estimated_value_usd NUMERIC,
  deadline            DATE,
  contact_info        TEXT,
  technologies        TEXT[] DEFAULT '{}',
  category            TEXT NOT NULL DEFAULT 'Uncategorized',
  summary             TEXT,
  recommended_action  TEXT,

  -- Scoring (Lead Scoring Agent)
  score_budget        SMALLINT,
  score_urgency       SMALLINT,
  score_credibility   SMALLINT,
  score_relevance     SMALLINT,
  score_quality       SMALLINT,
  opportunity_score   SMALLINT,
  label               TEXT CHECK (label IN ('HOT', 'WARM', 'LOW PRIORITY')),

  -- Pipeline status
  status              TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'analyzed', 'failed')),
  analysis_error      TEXT,
  telegram_sent       BOOLEAN NOT NULL DEFAULT FALSE,
  telegram_sent_at    TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunities_score ON opportunities (opportunity_score DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_category ON opportunities (category);
CREATE INDEX IF NOT EXISTS idx_opportunities_created_at ON opportunities (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_label ON opportunities (label);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities (status);

-- -----------------------------------------------------------------------------
-- telegram_subscribers: chats that have run /start and should receive
-- proactive push notifications for qualified leads.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_subscribers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     BIGINT NOT NULL UNIQUE,
  username    TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- source_runs: execution log for every collection cycle, per source.
-- Powers /status and basic observability without an external APM.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID REFERENCES sources(id) ON DELETE SET NULL,
  source_name   TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  items_found   INT NOT NULL DEFAULT 0,
  items_new     INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_runs_started_at ON source_runs (started_at DESC);

-- -----------------------------------------------------------------------------
-- Seed sources: a starter set of RSS feeds and search queries across every
-- category the brief asks for. Admins can add unlimited additional sources
-- via the API (POST /api/sources) or directly via SQL.
-- -----------------------------------------------------------------------------
INSERT INTO sources (name, type, category, config) VALUES
  ('TechCrunch - Startups', 'rss', 'Startup Funding', '{"url": "https://techcrunch.com/category/startups/feed/"}'),
  ('TechCrunch - Funding', 'rss', 'Startup Funding', '{"url": "https://techcrunch.com/tag/funding/feed/"}'),
  ('SAM.gov - Contract Opportunities (IT Services)', 'rss', 'Government Tender', '{"url": "https://sam.gov/api/prod/rssservice/opportunities?naics=541512"}'),
  ('Y Combinator Blog', 'rss', 'Startup Funding', '{"url": "https://www.ycombinator.com/blog/rss"}'),
  ('Google: Government RFP software development', 'google_search', 'Government Tender', '{"query": "\"request for proposal\" software development government"}'),
  ('Google: company looking for developers', 'google_search', 'Jobs & Projects', '{"query": "\"looking for a software development agency\" OR \"looking for developers\""}'),
  ('Google: website redesign request', 'google_search', 'Website Project', '{"query": "\"request for proposal\" website redesign -jobs"}'),
  ('Google: mobile app development RFP', 'google_search', 'Mobile App Project', '{"query": "\"RFP\" \"mobile app development\""}'),
  ('Google: startup raises funding', 'google_search', 'Startup Funding', '{"query": "startup raises seed round announcement"}'),
  ('Google: digital transformation consulting RFP', 'google_search', 'Consulting Opportunity', '{"query": "\"digital transformation\" \"request for proposal\" consulting"}'),
  ('Google: AI implementation project RFP', 'google_search', 'AI Project', '{"query": "\"RFP\" \"AI implementation\" OR \"artificial intelligence implementation\""}'),
  ('Google: IT outsourcing opportunity', 'google_search', 'Consulting Opportunity', '{"query": "IT outsourcing \"request for proposal\" OR \"seeking vendor\""}')
ON CONFLICT DO NOTHING;
