import { pool } from "../db/pool";

export async function upsertSubscriber(chatId: number, username?: string): Promise<void> {
  await pool.query(
    `INSERT INTO telegram_subscribers (chat_id, username, active)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (chat_id) DO UPDATE SET active = TRUE, username = EXCLUDED.username`,
    [chatId, username ?? null]
  );
}

export async function deactivateSubscriber(chatId: number): Promise<void> {
  await pool.query(`UPDATE telegram_subscribers SET active = FALSE WHERE chat_id = $1`, [chatId]);
}

export async function getActiveSubscriberChatIds(): Promise<number[]> {
  const result = await pool.query<{ chat_id: string }>(
    `SELECT chat_id FROM telegram_subscribers WHERE active = TRUE`
  );
  return result.rows.map((r) => Number(r.chat_id));
}

// ---------------------------------------------------------------------------
// Channel routing: map categories to dedicated Telegram channels/groups
// ---------------------------------------------------------------------------

export interface ChannelRecord {
  id: string;
  chatId: number;
  name: string;
  category: string;
  active: boolean;
}

export async function upsertChannel(chatId: number, name: string, category: string): Promise<ChannelRecord> {
  const result = await pool.query<{ id: string; chat_id: string; name: string; category: string; active: boolean }>(
    `INSERT INTO telegram_channels (chat_id, name, category, active)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (chat_id, category) DO UPDATE SET name = EXCLUDED.name, active = TRUE
     RETURNING id, chat_id, name, category, active`,
    [chatId, name, category]
  );
  const r = result.rows[0];
  return { id: r.id, chatId: Number(r.chat_id), name: r.name, category: r.category, active: r.active };
}

export async function removeChannel(chatId: number, category: string): Promise<void> {
  await pool.query(
    `UPDATE telegram_channels SET active = FALSE WHERE chat_id = $1 AND category = $2`,
    [chatId, category]
  );
}

export async function getChannelsForCategory(category: string): Promise<number[]> {
  const result = await pool.query<{ chat_id: string }>(
    `SELECT chat_id FROM telegram_channels WHERE active = TRUE AND (category = $1 OR category = 'all')`,
    [category]
  );
  return result.rows.map((r) => Number(r.chat_id));
}

export async function listActiveChannels(): Promise<ChannelRecord[]> {
  const result = await pool.query<{ id: string; chat_id: string; name: string; category: string; active: boolean }>(
    `SELECT id, chat_id, name, category, active FROM telegram_channels WHERE active = TRUE ORDER BY category, name`
  );
  return result.rows.map((r) => ({
    id: r.id,
    chatId: Number(r.chat_id),
    name: r.name,
    category: r.category,
    active: r.active,
  }));
}
