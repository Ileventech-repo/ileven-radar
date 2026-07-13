import axios from "axios";
import { env, placesEnabled } from "../config/env";
import { childLogger } from "../config/logger";
import { withRetry, sleep } from "../utils/retry";
import { pool } from "../db/pool";

const log = childLogger("PlacesProspector");

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";
const PAGESPEED_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const BAD_SITE_THRESHOLD = env.PROSPECT_MIN_SCORE;

export type ProspectType = "no_website" | "bad_website" | "found";

export interface Prospect {
  placeId: string;
  name: string;
  address: string;
  phone?: string;
  website?: string;
  mapsUrl?: string;
  businessType: string;
  location: string;
  prospectType: ProspectType;
  perfScore?: number;
  mobileScore?: number;
  seoScore?: number;
  pitchReason: string;
  contactEmail?: string;
}

interface PlaceSearchResult {
  place_id: string;
  name: string;
  formatted_address: string;
}

interface PlaceDetailsResult {
  place_id: string;
  name: string;
  formatted_address: string;
  formatted_phone_number?: string;
  website?: string;
  url?: string;
}

interface PageSpeedScores {
  performance: number;
  mobile: number;
  seo: number;
}

const RESULTS_PER_SCAN = 25;

async function searchPlaces(businessType: string, location: string): Promise<PlaceSearchResult[]> {
  const params: Record<string, string> = {
    query: `${businessType} in ${location}`,
    key: env.GOOGLE_PLACES_API_KEY,
  };

  const first = await withRetry(
    () => axios.get(`${PLACES_BASE}/textsearch/json`, { params, timeout: 15_000 }),
    { label: `Places search: ${businessType} in ${location}`, retries: 2 }
  );

  const results: PlaceSearchResult[] = first.data?.results ?? [];
  const nextPageToken: string | undefined = first.data?.next_page_token;

  // Google requires a short delay before the next_page_token is valid
  if (results.length < RESULTS_PER_SCAN && nextPageToken) {
    await sleep(2_000);
    try {
      const second = await withRetry(
        () => axios.get(`${PLACES_BASE}/textsearch/json`, {
          params: { key: env.GOOGLE_PLACES_API_KEY, pagetoken: nextPageToken },
          timeout: 15_000,
        }),
        { label: `Places search page 2: ${businessType} in ${location}`, retries: 2 }
      );
      results.push(...(second.data?.results ?? []));
    } catch { /* page 2 is optional */ }
  }

  return results.slice(0, RESULTS_PER_SCAN);
}

async function getPlaceDetails(placeId: string): Promise<PlaceDetailsResult | null> {
  try {
    const response = await withRetry(
      () =>
        axios.get(`${PLACES_BASE}/details/json`, {
          params: {
            place_id: placeId,
            fields: "place_id,name,formatted_address,formatted_phone_number,website,url",
            key: env.GOOGLE_PLACES_API_KEY,
          },
          timeout: 15_000,
        }),
      { label: `Place details: ${placeId}`, retries: 2 }
    );
    return response.data?.result ?? null;
  } catch {
    return null;
  }
}

async function getPageSpeedScores(url: string): Promise<PageSpeedScores | null> {
  try {
    const response = await withRetry(
      () =>
        axios.get(PAGESPEED_BASE, {
          params: {
            url,
            strategy: "mobile",
            key: env.GOOGLE_PLACES_API_KEY || undefined,
            category: ["performance", "seo", "accessibility"],
          },
          timeout: 30_000,
        }),
      { label: `PageSpeed: ${url}`, retries: 1 }
    );
    const cats = response.data?.lighthouseResult?.categories;
    if (!cats) return null;
    return {
      performance: Math.round((cats.performance?.score ?? 0) * 100),
      mobile: Math.round((cats["best-practices"]?.score ?? 0) * 100),
      seo: Math.round((cats.seo?.score ?? 0) * 100),
    };
  } catch {
    return null;
  }
}

function buildPitchReason(prospect: Omit<Prospect, "pitchReason">): string {
  if (prospect.prospectType === "no_website") {
    return "No website found — opportunity to build their first online presence.";
  }
  if (prospect.prospectType === "bad_website") {
    const issues: string[] = [];
    if ((prospect.perfScore ?? 100) < BAD_SITE_THRESHOLD) issues.push(`slow (${prospect.perfScore}/100)`);
    if ((prospect.mobileScore ?? 100) < BAD_SITE_THRESHOLD) issues.push(`not mobile-friendly (${prospect.mobileScore}/100)`);
    if ((prospect.seoScore ?? 100) < BAD_SITE_THRESHOLD) issues.push(`poor SEO (${prospect.seoScore}/100)`);
    return `Website needs work: ${issues.join(", ")}.`;
  }
  return "Active business with online presence — general outreach opportunity.";
}

async function isAlreadyKnown(placeId: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM prospects WHERE place_id = $1",
    [placeId]
  );
  return result.rows.length > 0;
}

async function saveProspect(p: Prospect): Promise<void> {
  await pool.query(
    `INSERT INTO prospects
       (place_id, name, address, phone, website, maps_url, business_type, location,
        prospect_type, perf_score, mobile_score, seo_score, pitch_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (place_id) DO NOTHING`,
    [
      p.placeId, p.name, p.address, p.phone ?? null, p.website ?? null,
      p.mapsUrl ?? null, p.businessType, p.location, p.prospectType,
      p.perfScore ?? null, p.mobileScore ?? null, p.seoScore ?? null, p.pitchReason,
    ]
  );
}

// Run at most `concurrency` async tasks at a time
async function runConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function processPlace(
  place: PlaceSearchResult,
  businessType: string,
  location: string
): Promise<Prospect | null> {
  if (await isAlreadyKnown(place.place_id)) return null;

  const details = await getPlaceDetails(place.place_id);
  if (!details) return null;

  if (!details.website) {
    const p: Prospect = {
      placeId: details.place_id,
      name: details.name,
      address: details.formatted_address,
      phone: details.formatted_phone_number,
      mapsUrl: details.url,
      businessType,
      location,
      prospectType: "no_website",
      pitchReason: "",
    };
    p.pitchReason = buildPitchReason(p);
    await saveProspect(p);
    return p;
  }

  // Has website — check PageSpeed in parallel with other places
  const scores = await getPageSpeedScores(details.website);
  const isBad = scores && (
    scores.performance < BAD_SITE_THRESHOLD ||
    scores.mobile < BAD_SITE_THRESHOLD ||
    scores.seo < BAD_SITE_THRESHOLD
  );

  const p: Prospect = {
    placeId: details.place_id,
    name: details.name,
    address: details.formatted_address,
    phone: details.formatted_phone_number,
    website: details.website,
    mapsUrl: details.url,
    businessType,
    location,
    prospectType: isBad ? "bad_website" : "found",
    perfScore: scores?.performance,
    mobileScore: scores?.mobile,
    seoScore: scores?.seo,
    pitchReason: "",
  };
  p.pitchReason = buildPitchReason(p);
  await saveProspect(p);
  return p;
}

export async function scanProspects(
  businessType: string,
  location: string
): Promise<Prospect[]> {
  if (!placesEnabled) {
    log.warn("GOOGLE_PLACES_API_KEY not set — skipping places scan");
    return [];
  }

  log.info({ businessType, location }, "Scanning prospects");
  const places = await searchPlaces(businessType, location);

  // Process 5 places concurrently — ~4x faster, same API cost
  const settled = await runConcurrent(
    places,
    (place) => processPlace(place, businessType, location).catch(() => null),
    5
  );

  const results = settled.filter((p): p is Prospect => p !== null);

  await pool.query(
    `UPDATE prospect_targets SET last_run_at = now() WHERE business_type = $1 AND location = $2`,
    [businessType, location]
  );

  log.info({ businessType, location, found: results.length }, "Scan complete");
  return results;
}

export const SCAN_BUSINESS_TYPES = [
  "hotel", "restaurant", "law firm", "clinic", "dental clinic",
  "real estate agency", "school", "spa", "gym", "pharmacy",
  "accounting firm", "car dealership", "boutique", "logistics company",
];

export async function scanLocation(location: string, businessTypes = SCAN_BUSINESS_TYPES): Promise<Prospect[]> {
  // Run 3 business types concurrently — each type is already parallelised internally
  const batches = await runConcurrent(
    businessTypes,
    async (type) => {
      try {
        return await scanProspects(type, location);
      } catch (err) {
        log.error({ err: (err as Error).message, type, location }, "scanLocation: type scan failed");
        return [];
      }
    },
    3
  );
  return batches.flat();
}

export async function runAllProspectTargets(): Promise<number> {
  const targets = await pool.query<{ business_type: string; location: string }>(
    "SELECT business_type, location FROM prospect_targets WHERE enabled = TRUE ORDER BY last_run_at ASC NULLS FIRST"
  );

  let total = 0;
  for (const t of targets.rows) {
    try {
      const found = await scanProspects(t.business_type, t.location);
      total += found.length;
    } catch (err) {
      log.error({ err: (err as Error).message, target: t }, "Prospect scan failed");
    }
  }
  return total;
}

export async function getUnsentProspects(): Promise<Prospect[]> {
  const result = await pool.query<{
    place_id: string; name: string; address: string; phone: string;
    website: string; maps_url: string; business_type: string; location: string;
    prospect_type: string; perf_score: number; mobile_score: number;
    seo_score: number; pitch_reason: string; contact_email: string;
  }>(
    `SELECT place_id, name, address, phone, website, maps_url, business_type,
            location, prospect_type, perf_score, mobile_score, seo_score,
            pitch_reason, contact_email
     FROM prospects WHERE telegram_sent = FALSE ORDER BY created_at ASC LIMIT 30`
  );
  return result.rows.map((r) => ({
    placeId: r.place_id,
    name: r.name,
    address: r.address,
    phone: r.phone,
    website: r.website,
    mapsUrl: r.maps_url,
    businessType: r.business_type,
    location: r.location,
    prospectType: r.prospect_type as ProspectType,
    perfScore: r.perf_score,
    mobileScore: r.mobile_score,
    seoScore: r.seo_score,
    pitchReason: r.pitch_reason,
    contactEmail: r.contact_email,
  }));
}

export async function markProspectSent(placeId: string): Promise<void> {
  await pool.query(
    "UPDATE prospects SET telegram_sent = TRUE, telegram_sent_at = now() WHERE place_id = $1",
    [placeId]
  );
}
