import { pool } from "../db/pool";
import { childLogger } from "../config/logger";
import { openai } from "./openaiClient";
import { sendEmail } from "./emailService";
import { env } from "../config/env";

const log = childLogger("SequenceService");

const FOLLOW_UP_DAYS = [3, 7]; // Days after initial email for steps 2 and 3

export async function createFollowUpSequence(
  outreachId: string,
  refType: "prospect" | "opportunity",
  refId: string,
  toEmail: string
): Promise<void> {
  const now = new Date();
  for (let i = 0; i < FOLLOW_UP_DAYS.length; i++) {
    const scheduledAt = new Date(now);
    scheduledAt.setDate(scheduledAt.getDate() + FOLLOW_UP_DAYS[i]);
    await pool.query(
      `INSERT INTO email_sequences (outreach_id, ref_type, ref_id, to_email, step, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [outreachId, refType, refId, toEmail, i + 2, scheduledAt]
    );
  }
  log.info({ outreachId, toEmail }, "Follow-up sequence created (steps 2 & 3)");
}

async function draftFollowUp(
  step: number,
  toEmail: string,
  originalSubject: string,
  originalBody: string,
  refType: string
): Promise<{ subject: string; html: string }> {
  const stepContext = step === 2
    ? "This is a short, friendly follow-up sent 3 days after the initial email. Reference the previous email briefly. Keep it to 2 short paragraphs max. No hard sell — just a gentle nudge."
    : "This is the final follow-up sent 7 days after the initial email. Keep it to 2 sentences. Be gracious, mention it's your last follow-up, and leave the door open for the future.";

  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [{
      role: "user",
      content: `You are writing follow-up email step ${step} of 3 on behalf of ${env.COMPANY_NAME}.

Original email subject: ${originalSubject}
Original email summary: ${originalBody.replace(/<[^>]+>/g, "").slice(0, 400)}
Recipient: ${toEmail}
Context type: ${refType}

${stepContext}

Return JSON with: subject (string, prefix with "Re: "), body (short HTML with <p> tags only).`,
    }],
    response_format: { type: "json_object" },
    temperature: 0.7,
  });

  const raw = JSON.parse(response.choices[0].message.content ?? "{}");
  return {
    subject: raw.subject ?? `Re: ${originalSubject}`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">${raw.body ?? ""}<br><br><strong>${env.COMPANY_NAME}</strong></body></html>`,
  };
}

export async function runPendingSequences(): Promise<number> {
  const due = await pool.query<{
    id: string; outreach_id: string; ref_type: string; ref_id: string;
    to_email: string; step: number;
  }>(
    `SELECT s.id, s.outreach_id, s.ref_type, s.ref_id, s.to_email, s.step,
            o.subject AS orig_subject, o.html_body AS orig_body
     FROM email_sequences s
     JOIN email_outreach o ON o.id = s.outreach_id
     WHERE s.status = 'pending' AND s.scheduled_at <= now()
     ORDER BY s.scheduled_at ASC LIMIT 20`
  );

  let sent = 0;
  for (const row of due.rows as Array<{
    id: string; outreach_id: string; ref_type: string; ref_id: string;
    to_email: string; step: number; orig_subject: string; orig_body: string;
  }>) {
    try {
      const draft = await draftFollowUp(row.step, row.to_email, row.orig_subject, row.orig_body, row.ref_type);
      const ok = await sendEmail({ to: row.to_email, subject: draft.subject, html: draft.html });
      if (ok) {
        await pool.query(
          `UPDATE email_sequences SET status='sent', sent_at=now() WHERE id=$1`,
          [row.id]
        );
        log.info({ to: row.to_email, step: row.step }, "Follow-up sent");
        sent++;
      }
    } catch (err) {
      log.error({ err: (err as Error).message, sequenceId: row.id }, "Follow-up send failed");
    }
  }
  return sent;
}

export async function cancelSequence(outreachId: string): Promise<void> {
  await pool.query(
    `UPDATE email_sequences SET status='cancelled' WHERE outreach_id=$1 AND status='pending'`,
    [outreachId]
  );
}
