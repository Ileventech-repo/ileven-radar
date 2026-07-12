-- Email follow-up sequences: tracks multi-step outreach per contact
CREATE TABLE IF NOT EXISTS email_sequences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outreach_id   UUID REFERENCES email_outreach(id) ON DELETE CASCADE,
  ref_type      TEXT NOT NULL CHECK (ref_type IN ('prospect', 'opportunity')),
  ref_id        TEXT NOT NULL,
  to_email      TEXT NOT NULL,
  step          SMALLINT NOT NULL CHECK (step IN (1,2,3)),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled')),
  scheduled_at  TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(outreach_id, step)
);

CREATE INDEX IF NOT EXISTS idx_email_sequences_scheduled ON email_sequences (scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_email_sequences_outreach ON email_sequences (outreach_id);
