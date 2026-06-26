import { z } from "zod";
import { openai, OPENAI_MODEL } from "../services/openaiClient";
import { withRetry } from "../utils/retry";
import { childLogger } from "../config/logger";
import { AiAnalysisResult, OpportunityCategory } from "../types/opportunity";

const log = childLogger("AiAnalysisAgent");

const CATEGORIES: OpportunityCategory[] = [
  "Website Project",
  "Mobile App Project",
  "SaaS Project",
  "AI Project",
  "Government Tender",
  "Startup Funding",
  "Consulting Opportunity",
  "Enterprise Software",
  "Jobs & Projects",
  "Uncategorized",
];

// The shape we force the model to return. Validated with zod so a
// malformed response is caught and retried rather than corrupting the DB.
const analysisSchema = z.object({
  title: z.string().min(1),
  company: z.string().nullable(),
  location: z.string().nullable(),
  industry: z.string().nullable(),
  budgetText: z.string().nullable(),
  estimatedValueUsd: z.number().nullable(),
  deadline: z.string().nullable(),
  contactInfo: z.string().nullable(),
  technologies: z.array(z.string()),
  category: z.enum(CATEGORIES as [string, ...string[]]),
  summary: z.string().min(1),
  recommendedAction: z.string().min(1),
  scoreBudget: z.number().min(0).max(100),
  scoreUrgency: z.number().min(0).max(100),
  scoreCredibility: z.number().min(0).max(100),
  scoreRelevance: z.number().min(0).max(100),
  scoreQuality: z.number().min(0).max(100),
});

const SYSTEM_PROMPT = `You are the analysis engine for "Ileven Radar", a lead-intelligence agent that finds business opportunities for software development, web development, mobile app and IT consulting agencies.

Given a raw discovered item (title + content + source), do ALL of the following and respond with a SINGLE JSON object only (no markdown, no prose):

1. Extract: title (cleaned), company, location, industry, budgetText (verbatim budget mention if any), estimatedValueUsd (your best numeric USD estimate of project value, or null), deadline (ISO yyyy-mm-dd or null), contactInfo (email/phone/portal if present, else null), technologies (array of relevant tech/skills the opportunity implies, e.g. ["React","Node.js","PostgreSQL"]).
2. Categorize into exactly one of: ${CATEGORIES.join(", ")}.
3. Write a concise 1-3 sentence summary aimed at an agency owner deciding whether to pursue.
4. Write a one-sentence recommendedAction (e.g. "Submit a proposal before the deadline" / "Reach out to the founder offering app dev services").
5. Produce five 0-100 sub-scores reflecting how attractive this is as a lead for such an agency:
   - scoreBudget: likely budget size.
   - scoreUrgency: how time-sensitive (deadlines, "urgent", funding just raised).
   - scoreCredibility: how legitimate/credible the company or source is.
   - scoreRelevance: how relevant to software/web/app/IT-consulting services.
   - scoreQuality: overall opportunity quality and actionability.

Use null where information is genuinely absent. Never invent contact details. If the item is clearly NOT a real opportunity (generic news with no actionable lead), set scoreRelevance and scoreQuality low.`;

export async function analyzeItem(input: {
  title: string;
  content: string | null;
  sourceName: string;
  sourceCategory: string;
  url: string;
}): Promise<AiAnalysisResult> {
  const userContent = [
    `SOURCE: ${input.sourceName} (category hint: ${input.sourceCategory})`,
    `URL: ${input.url}`,
    `TITLE: ${input.title}`,
    `CONTENT: ${(input.content ?? "").slice(0, 6000)}`,
  ].join("\n");

  const raw = await withRetry(
    async () => {
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      });
      const text = completion.choices[0]?.message?.content;
      if (!text) {
        throw new Error("Empty response from OpenAI");
      }
      return text;
    },
    { label: "OpenAI analysis", retries: 3 }
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const validated = analysisSchema.parse(parsed);

  log.debug({ title: validated.title, category: validated.category }, "Analyzed item");

  return {
    ...validated,
    category: validated.category as OpportunityCategory,
  };
}
