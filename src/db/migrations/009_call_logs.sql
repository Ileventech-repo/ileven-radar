CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid VARCHAR(64) UNIQUE NOT NULL,
  ref_type VARCHAR(20) NOT NULL DEFAULT 'prospect',
  ref_id VARCHAR(128) NOT NULL DEFAULT '',
  to_phone VARCHAR(32) NOT NULL,
  prospect_name VARCHAR(256),
  status VARCHAR(32),
  duration_seconds INTEGER DEFAULT 0,
  transcript TEXT,
  telegram_chat_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
