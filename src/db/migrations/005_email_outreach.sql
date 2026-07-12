-- Tracks drafted and sent outreach emails
CREATE TABLE IF NOT EXISTS email_outreach (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_type      TEXT NOT NULL CHECK (ref_type IN ('prospect', 'opportunity')),
  ref_id        TEXT NOT NULL,
  to_email      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  html_body     TEXT NOT NULL,
  plain_body    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  telegram_chat_id BIGINT,
  telegram_msg_id  INTEGER,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_outreach_status ON email_outreach (status);
CREATE INDEX IF NOT EXISTS idx_email_outreach_ref ON email_outreach (ref_type, ref_id);
