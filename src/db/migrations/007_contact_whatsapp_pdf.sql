-- Add contact email (from Hunter.io) and WhatsApp tracking to prospects
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS whatsapp_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS whatsapp_sent_at TIMESTAMPTZ;

-- Track WhatsApp outreach separately
CREATE TABLE IF NOT EXISTS whatsapp_outreach (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_type      TEXT NOT NULL CHECK (ref_type IN ('prospect', 'opportunity')),
  ref_id        TEXT NOT NULL,
  to_phone      TEXT NOT NULL,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_outreach_ref ON whatsapp_outreach (ref_type, ref_id);
