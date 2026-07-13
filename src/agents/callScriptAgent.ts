import { env } from "../config/env";
import { openai } from "../services/openaiClient";
import { Prospect } from "./placesProspectorAgent";
import { OpportunityRecord } from "../types/opportunity";
import { childLogger } from "../config/logger";

const log = childLogger("CallScriptAgent");

export interface CallScript {
  opener: string;
  hook: string;
  elevator: string;
  questions: string[];
  objectionHandling: Array<{ objection: string; response: string }>;
  close: string;
}

async function generateScript(context: string, businessName: string, prospectType: string): Promise<CallScript> {
  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a sales coach writing cold call scripts for ${env.COMPANY_NAME}, a tech company offering ${env.COMPANY_SERVICE}. Write natural, conversational scripts that sound human — not robotic. Keep each section concise and direct.`,
      },
      {
        role: "user",
        content: `Write a cold call script for this prospect:

Business: ${businessName}
Context: ${context}
Prospect type: ${prospectType}
Our company: ${env.COMPANY_NAME}
Our service: ${env.COMPANY_SERVICE}
Our contact: ${env.COMPANY_CONTACT_EMAIL ?? ""}
Our website: ${env.COMPANY_WEBSITE ?? ""}

Return JSON with:
- opener: first 5 seconds — greeting and who you are (1-2 sentences)
- hook: the reason you're calling specific to this business (1-2 sentences, mention what you noticed)
- elevator: 15-second pitch of what we do and the benefit (2-3 sentences)
- questions: array of 2-3 qualifying questions to ask
- objectionHandling: array of 3 objects with "objection" and "response" for the most common pushbacks
- close: how to ask for the next step (meeting, callback, or site visit) — 1-2 sentences`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.7,
  });

  const raw = JSON.parse(response.choices[0].message.content ?? "{}");
  return {
    opener: raw.opener ?? "",
    hook: raw.hook ?? "",
    elevator: raw.elevator ?? "",
    questions: Array.isArray(raw.questions) ? raw.questions : [],
    objectionHandling: Array.isArray(raw.objectionHandling) ? raw.objectionHandling : [],
    close: raw.close ?? "",
  };
}

export async function buildProspectCallScript(prospect: Prospect): Promise<CallScript> {
  log.info({ name: prospect.name }, "Generating cold call script for prospect");
  const context = `${prospect.name} is a ${prospect.businessType} in ${prospect.address}. ${prospect.pitchReason}${prospect.phone ? ` Phone: ${prospect.phone}.` : ""}`;
  return generateScript(context, prospect.name, prospect.prospectType === "no_website" ? "no website" : "poor website");
}

export async function buildOpportunityCallScript(opp: OpportunityRecord): Promise<CallScript> {
  log.info({ title: opp.title }, "Generating cold call script for opportunity");
  const context = `${opp.title ?? opp.rawTitle} at ${opp.company ?? "a company"}. ${opp.summary ?? ""}. Budget: ${opp.budgetText ?? "TBD"}. Contact: ${opp.contactInfo ?? "unknown"}.`;
  return generateScript(context, opp.company ?? "the company", opp.category ?? "business opportunity");
}

export function formatCallScript(script: CallScript, businessName: string): string {
  const lines: string[] = [
    `📞 <b>Cold Call Script — ${businessName}</b>`,
    ``,
    `<b>🟢 OPENER</b>`,
    script.opener,
    ``,
    `<b>🎯 HOOK (why you're calling)</b>`,
    script.hook,
    ``,
    `<b>⚡ ELEVATOR PITCH</b>`,
    script.elevator,
    ``,
    `<b>❓ QUALIFYING QUESTIONS</b>`,
    ...script.questions.map((q, i) => `${i + 1}. ${q}`),
    ``,
    `<b>🛡 OBJECTION HANDLING</b>`,
    ...script.objectionHandling.map(
      (o) => `<i>"${o.objection}"</i>\n→ ${o.response}`
    ),
    ``,
    `<b>🏁 CLOSE</b>`,
    script.close,
    ``,
    `<i>💡 Tip: Smile while you talk. Keep it conversational, not scripted.</i>`,
  ];
  return lines.join("\n");
}
