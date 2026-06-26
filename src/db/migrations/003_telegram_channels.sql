-- Telegram channels: route opportunities by category to dedicated channels/groups
CREATE TABLE IF NOT EXISTS telegram_channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     BIGINT NOT NULL,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chat_id, category)
);

CREATE INDEX IF NOT EXISTS idx_telegram_channels_category ON telegram_channels (category);
CREATE INDEX IF NOT EXISTS idx_telegram_channels_active ON telegram_channels (active);
