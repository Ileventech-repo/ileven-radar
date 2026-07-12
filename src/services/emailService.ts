import { Resend } from "resend";
import { env, emailEnabled } from "../config/env";
import { childLogger } from "../config/logger";
import { withRetry } from "../utils/retry";

const log = childLogger("EmailService");

let client: Resend | null = null;

function getClient(): Resend {
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

export async function sendEmail(payload: EmailPayload): Promise<boolean> {
  if (!emailEnabled) {
    log.warn("RESEND_API_KEY not set — email not sent");
    return false;
  }
  try {
    await withRetry(
      () =>
        getClient().emails.send({
          from: env.FROM_EMAIL,
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          replyTo: payload.replyTo || env.COMPANY_CONTACT_EMAIL || undefined,
        }),
      { label: `Send email to ${payload.to}`, retries: 2 }
    );
    log.info({ to: payload.to, subject: payload.subject }, "Email sent");
    return true;
  } catch (err) {
    log.error({ err: (err as Error).message, to: payload.to }, "Email send failed");
    return false;
  }
}
