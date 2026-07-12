import { openai } from "../services/openaiClient";
import { env } from "../config/env";
import { childLogger } from "../config/logger";
import { Prospect } from "./placesProspectorAgent";
import { OpportunityRecord } from "../types/opportunity";

const log = childLogger("EmailDraftAgent");

export interface EmailDraft {
  to: string;
  subject: string;
  html: string;
  plainText: string;
}

const SIGNATURE = `
<br><br>
<strong>${env.COMPANY_NAME}</strong><br>
${env.COMPANY_CONTACT_EMAIL ? `Email: ${env.COMPANY_CONTACT_EMAIL}<br>` : ""}
${env.COMPANY_WEBSITE ? `Web: ${env.COMPANY_WEBSITE}<br>` : ""}
`;

function wrapHtml(body: string): string {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.6;max-width:600px;margin:0 auto;padding:20px">
${body}${SIGNATURE}
</body></html>`;
}

export async function draftProspectEmail(prospect: Prospect, toEmail: string): Promise<EmailDraft> {
  const context =
    prospect.prospectType === "no_website"
      ? `This business has NO website at all.`
      : `This business has a poor website (Speed: ${prospect.perfScore}/100, Mobile: ${prospect.mobileScore}/100, SEO: ${prospect.seoScore}/100).`;

  const prompt = `You are writing a short, friendly, professional cold outreach email on behalf of ${env.COMPANY_NAME}, a web design and development agency that offers ${env.COMPANY_SERVICE}.

Business details:
- Name: ${prospect.name}
- Type: ${prospect.businessType}
- Location: ${prospect.address}
- Issue: ${context}

Write a concise cold email (3-4 short paragraphs) that:
1. Opens with a specific observation about their online presence (or lack of it)
2. Briefly explains how a professional website would benefit their specific business type
3. Introduces ${env.COMPANY_NAME} and our service in one sentence
4. Ends with a clear, low-pressure call to action (e.g., a free consultation or quick call)

Do NOT use generic fluff. Be specific to their business type and location.
Return JSON with keys: subject (string), body (HTML string with <p> tags, no wrapper html/body tags).`;

  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.7,
  });

  const raw = JSON.parse(response.choices[0].message.content ?? "{}");
  const subject: string = raw.subject ?? `Web presence opportunity for ${prospect.name}`;
  const bodyHtml: string = raw.body ?? `<p>We noticed ${prospect.name} could benefit from a professional online presence.</p>`;
  const plainText = bodyHtml.replace(/<[^>]+>/g, "").trim();

  log.info({ to: toEmail, subject }, "Email draft generated");

  return {
    to: toEmail,
    subject,
    html: wrapHtml(bodyHtml),
    plainText,
  };
}

export async function draftOpportunityEmail(opp: OpportunityRecord, toEmail: string): Promise<EmailDraft> {
  const prompt = `You are writing a professional service proposal email on behalf of ${env.COMPANY_NAME}, which offers ${env.COMPANY_SERVICE}.

Opportunity details:
- Title: ${opp.title ?? opp.rawTitle}
- Company: ${opp.company ?? "Unknown"}
- Category: ${opp.category}
- Summary: ${opp.summary ?? ""}
- Budget: ${opp.budgetText ?? "Not specified"}
- Deadline: ${opp.deadline ?? "Not specified"}
- Technologies: ${opp.technologies.join(", ") || "Not specified"}
- Recommended action: ${opp.recommendedAction ?? ""}

Write a concise, professional proposal email (3-4 paragraphs) that:
1. References the specific opportunity by name
2. Explains why ${env.COMPANY_NAME} is a strong fit
3. Briefly highlights our relevant capabilities for this project
4. Proposes a next step (discovery call, sending portfolio, etc.)

Be specific and confident. No generic filler.
Return JSON with keys: subject (string), body (HTML string with <p> tags, no wrapper html/body tags).`;

  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.7,
  });

  const raw = JSON.parse(response.choices[0].message.content ?? "{}");
  const subject: string = raw.subject ?? `Proposal: ${opp.title ?? opp.rawTitle}`;
  const bodyHtml: string = raw.body ?? `<p>We would like to submit a proposal for ${opp.title}.</p>`;
  const plainText = bodyHtml.replace(/<[^>]+>/g, "").trim();

  log.info({ to: toEmail, subject }, "Opportunity email draft generated");

  return {
    to: toEmail,
    subject,
    html: wrapHtml(bodyHtml),
    plainText,
  };
}
