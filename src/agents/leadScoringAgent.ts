import { AiAnalysisResult, LeadScoreResult } from "../types/opportunity";

/**
 * Lead Scoring Agent.
 *
 * The AI Analysis Agent produces five independent 0-100 sub-scores
 * (budget, urgency, credibility, relevance, quality). This agent combines
 * them into a single deterministic 0-100 opportunity score using fixed
 * weights, then assigns a label. Keeping the final aggregation
 * deterministic (rather than asking the LLM for the final number) makes
 * scores stable, explainable and tunable without prompt changes.
 */

const WEIGHTS = {
  budget: 0.25,
  urgency: 0.15,
  credibility: 0.15,
  relevance: 0.3, // relevance to our services matters most
  quality: 0.15,
} as const;

export function scoreOpportunity(analysis: AiAnalysisResult): LeadScoreResult {
  const weighted =
    analysis.scoreBudget * WEIGHTS.budget +
    analysis.scoreUrgency * WEIGHTS.urgency +
    analysis.scoreCredibility * WEIGHTS.credibility +
    analysis.scoreRelevance * WEIGHTS.relevance +
    analysis.scoreQuality * WEIGHTS.quality;

  const opportunityScore = Math.max(0, Math.min(100, Math.round(weighted)));

  return {
    opportunityScore,
    label: labelFor(opportunityScore),
  };
}

export function labelFor(score: number): LeadScoreResult["label"] {
  if (score >= 80) return "HOT";
  if (score >= 50) return "WARM";
  return "LOW PRIORITY";
}
