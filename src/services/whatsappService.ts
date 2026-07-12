import twilio from "twilio";
import { env, whatsappEnabled } from "../config/env";
import { childLogger } from "../config/logger";
import { pool } from "../db/pool";
import { withRetry } from "../utils/retry";
import { openai } from "./openaiClient";
import { Prospect } from "../agents/placesProspectorAgent";

const log = childLogger("WhatsAppService");

function getClient() {
  return twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
}

async function draftWhatsAppMessage(prospect: Prospect): Promise<string> {
  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [{
      role: "user",
      content: `Write a SHORT WhatsApp cold outreach message (max 3 sentences) on behalf of ${env.COMPANY_NAME}.

Business: ${prospect.name}
Type: ${prospect.businessType}
Location: ${prospect.address}
Issue: ${prospect.prospectType === "no_website" ? "They have no website" : `Their website scores poorly (Speed: ${prospect.perfScore}/100, Mobile: ${prospect.mobileScore}/100)`}

The message should:
1. Be friendly and conversational (WhatsApp tone, not formal email)
2. Mention the specific issue briefly
3. End with a simple question like "Would you be open to a quick chat?"

Return plain text only. No JSON. No formatting. Just the message.`,
    }],
    temperature: 0.8,
  });
  return response.choices[0].message.content?.trim() ?? `Hi, I noticed ${prospect.name} could benefit from a stronger online presence. We help businesses like yours get professional websites that bring in more customers. Would you be open to a quick chat?`;
}

export async function sendWhatsAppMessage(
  toPhone: string,
  message: string,
  refType: "prospect" | "opportunity",
  refId: string
): Promise<boolean> {
  if (!whatsappEnabled) {
    log.warn("WhatsApp (Twilio) not configured");
    return false;
  }
  const to = toPhone.startsWith("whatsapp:") ? toPhone : `whatsapp:${toPhone}`;
  try {
    await withRetry(
      () => getClient().messages.create({
        from: env.TWILIO_WHATSAPP_NUMBER,
        to,
        body: message,
      }),
      { label: `WhatsApp to ${toPhone}`, retries: 2 }
    );
    await pool.query(
      `INSERT INTO whatsapp_outreach (ref_type, ref_id, to_phone, message, status, sent_at)
       VALUES ($1,$2,$3,$4,'sent',now())`,
      [refType, refId, toPhone, message]
    );
    log.info({ to: toPhone }, "WhatsApp message sent");
    return true;
  } catch (err) {
    log.error({ err: (err as Error).message, to: toPhone }, "WhatsApp send failed");
    await pool.query(
      `INSERT INTO whatsapp_outreach (ref_type, ref_id, to_phone, message, status)
       VALUES ($1,$2,$3,$4,'failed')`,
      [refType, refId, toPhone, message]
    );
    return false;
  }
}

export async function draftAndSendWhatsApp(
  prospect: Prospect,
  phone: string
): Promise<{ message: string; sent: boolean }> {
  const message = await draftWhatsAppMessage(prospect);
  const sent = await sendWhatsAppMessage(phone, message, "prospect", prospect.placeId);
  return { message, sent };
}
