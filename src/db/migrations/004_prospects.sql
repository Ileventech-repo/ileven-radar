-- prospect_targets: configured (business_type, location) pairs to scan globally
CREATE TABLE IF NOT EXISTS prospect_targets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_type TEXT NOT NULL,
  location      TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business_type, location)
);

-- prospects: discovered businesses (deduped by place_id)
CREATE TABLE IF NOT EXISTS prospects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id          TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  address           TEXT,
  phone             TEXT,
  website           TEXT,
  maps_url          TEXT,
  business_type     TEXT,
  location          TEXT,
  prospect_type     TEXT NOT NULL CHECK (prospect_type IN ('no_website', 'bad_website')),
  perf_score        SMALLINT,
  mobile_score      SMALLINT,
  seo_score         SMALLINT,
  pitch_reason      TEXT,
  telegram_sent     BOOLEAN NOT NULL DEFAULT FALSE,
  telegram_sent_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospects_type ON prospects (prospect_type);
CREATE INDEX IF NOT EXISTS idx_prospects_sent ON prospects (telegram_sent);
CREATE INDEX IF NOT EXISTS idx_prospects_created ON prospects (created_at DESC);

-- Seed some global starter targets
INSERT INTO prospect_targets (business_type, location) VALUES
  ('hotel', 'Lagos, Nigeria'),
  ('restaurant', 'Lagos, Nigeria'),
  ('law firm', 'Abuja, Nigeria'),
  ('clinic', 'Lagos, Nigeria'),
  ('hotel', 'Nairobi, Kenya'),
  ('restaurant', 'Accra, Ghana'),
  ('hotel', 'Dubai, UAE'),
  ('law firm', 'London, UK'),
  ('dental clinic', 'Johannesburg, South Africa'),
  ('hotel', 'New York, USA')
ON CONFLICT DO NOTHING;
