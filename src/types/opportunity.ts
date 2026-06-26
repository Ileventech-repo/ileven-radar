/** A category an opportunity can be classified into. */
export type OpportunityCategory =
  | "Website Project"
  | "Mobile App Project"
  | "SaaS Project"
  | "AI Project"
  | "Government Tender"
  | "Startup Funding"
  | "Consulting Opportunity"
  | "Enterprise Software"
  | "Jobs & Projects"
  | "Uncategorized";

export type LeadLabel = "HOT" | "WARM" | "LOW PRIORITY";

export type SourceType = "rss" | "google_search" | "linkedin";

export interface SourceRecord {
  id: string;
  name: string;
  type: SourceType;
  category: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

/**
 * A raw, un-analyzed item as discovered by a collector (RSS parser or
 * Google Search). This is the input to the Extraction + AI Analysis
 * pipeline.
 */
export interface RawItem {
  sourceId: string;
  sourceName: string;
  sourceCategory: string;
  sourceType: SourceType;
  url: string;
  title: string;
  content: string;
  publishedAt?: Date;
}

/** Structured output produced by the AI Analysis Agent for one RawItem. */
export interface AiAnalysisResult {
  title: string;
  company: string | null;
  location: string | null;
  industry: string | null;
  budgetText: string | null;
  estimatedValueUsd: number | null;
  deadline: string | null; // ISO date or null
  contactInfo: string | null;
  technologies: string[];
  category: OpportunityCategory;
  summary: string;
  recommendedAction: string;
  scoreBudget: number; // 0-100
  scoreUrgency: number; // 0-100
  scoreCredibility: number; // 0-100
  scoreRelevance: number; // 0-100
  scoreQuality: number; // 0-100
}

/** Final computed score + label from the Lead Scoring Agent. */
export interface LeadScoreResult {
  opportunityScore: number; // 0-100
  label: LeadLabel;
}

/** Full row shape as stored in / read from the `opportunities` table. */
export interface OpportunityRecord {
  id: string;
  sourceName: string;
  sourceCategory: string;
  url: string;
  rawTitle: string;
  title: string | null;
  company: string | null;
  location: string | null;
  industry: string | null;
  budgetText: string | null;
  estimatedValueUsd: number | null;
  deadline: string | null;
  contactInfo: string | null;
  technologies: string[];
  category: string;
  summary: string | null;
  recommendedAction: string | null;
  opportunityScore: number | null;
  label: LeadLabel | null;
  status: "new" | "analyzed" | "failed";
  telegramSent: boolean;
  createdAt: string;
}
