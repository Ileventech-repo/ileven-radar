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
