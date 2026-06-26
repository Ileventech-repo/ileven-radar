import { OpportunityRecord } from "../types/opportunity";

/** Escape characters that would break Telegram HTML parse mode. */
function esc(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function labelEmoji(label: OpportunityRecord["label"]): string {
  switch (label) {
    case "HOT":
      return "🔥";
    case "WARM":
      return "🌤";
    default:
      return "❄️";
  }
}

function formatValue(opp: OpportunityRecord): string {
  if (opp.budgetText) return esc(opp.budgetText);
  if (opp.estimatedValueUsd) {
    return `~$${opp.estimatedValueUsd.toLocaleString("en-US")} (est.)`;
  }
  return "—";
}

/**
 * Renders the exact "🚨 NEW OPPORTUNITY" card from the brief, using
 * Telegram HTML parse mode. Sent for every qualified lead.
 */
export function formatOpportunityMessage(opp: OpportunityRecord): string {
  const techs = opp.technologies.length ? opp.technologies.map(esc).join(", ") : "—";

  return [
    `🚨 <b>NEW OPPORTUNITY</b> ${labelEmoji(opp.label)}`,
    "",
    `<b>Title:</b> ${esc(opp.title ?? opp.rawTitle)}`,
    `<b>Company:</b> ${esc(opp.company)}`,
    `<b>Category:</b> ${esc(opp.category)}`,
    `<b>Score:</b> ${opp.opportunityScore ?? "—"}/100 (${esc(opp.label)})`,
    `<b>Budget:</b> ${formatValue(opp)}`,
    `<b>Location:</b> ${esc(opp.location)}`,
    "",
    `<b>Summary:</b>`,
    esc(opp.summary),
    "",
    `<b>Required Technologies:</b> ${techs}`,
    `<b>Source:</b> ${esc(opp.sourceName)}`,
    `<b>Link:</b> ${esc(opp.url)}`,
    "",
    `<b>Recommended Action:</b>`,
    esc(opp.recommendedAction),
  ].join("\n");
}

/** Compact one-liner used in list responses (/latest, /hot, /search). */
export function formatOpportunityLine(opp: OpportunityRecord, index: number): string {
  const score = opp.opportunityScore ?? 0;
  const emoji = labelEmoji(opp.label);
  return `${index}. ${emoji} <b>${esc(opp.title ?? opp.rawTitle)}</b> — ${score}/100\n   ${esc(opp.category)} · <a href="${esc(opp.url)}">link</a>`;
}
