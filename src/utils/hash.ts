import crypto from "crypto";

/**
 * Builds a stable hash from a title + URL pair so the same opportunity
 * discovered twice (e.g. the same tender appears in two RSS feeds, or a
 * search result reappears next hour) is recognized as a duplicate.
 */
export function buildContentHash(title: string, url: string): string {
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedUrl = normalizeUrl(url);
  return crypto.createHash("sha256").update(`${normalizedTitle}::${normalizedUrl}`).digest("hex");
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    // Strip common tracking params so the same article with different
    // utm parameters still dedupes correctly.
    const params = new URLSearchParams(u.search);
    [...params.keys()]
      .filter((k) => k.toLowerCase().startsWith("utm_") || k.toLowerCase() === "ref")
      .forEach((k) => params.delete(k));
    u.search = params.toString();
    return `${u.origin}${u.pathname}${u.search ? `?${u.search}` : ""}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
