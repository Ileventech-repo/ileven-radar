import axios from "axios";
import { env, placesEnabled } from "../config/env";
import { childLogger } from "../config/logger";
import { withRetry, sleep } from "../utils/retry";
import { pool } from "../db/pool";

const log = childLogger("PlacesProspector");

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";
const PAGESPEED_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const BAD_SITE_THRESHOLD = env.PROSPECT_MIN_SCORE;

export interface Prospect {
  placeId: string;
  name: string;
  address: string;
  phone?: string;
  website?: string;
  mapsUrl?: string;
  businessType: string;
  location: string;
  prospectType: "no_website" | "bad_website";
  perfScore?: number;
  mobileScore?: number;
  seoScore?: number;
  pitchReason: string;
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

async function searchPlaces(businessType: string, location: string): Promise<PlaceSearchResult[]> {
  const response = await withRetry(
    () =>
      axios.get(`${PLACES_BASE}/textsearch/json`, {
        params: {
          query: `${businessType} in ${location}`,
          key: env.GOOGLE_PLACES_API_KEY,
        },
        timeout: 15_000,
      }),
    { label: `Places search: ${businessType} in ${location}`, retries: 2 }
  );
  return (response.data?.results ?? []) as PlaceSearchResult[];
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
  const issues: string[] = [];
  if ((prospect.perfScore ?? 100) < BAD_SITE_THRESHOLD) issues.push(`slow (${prospect.perfScore}/100)`);
  if ((prospect.mobileScore ?? 100) < BAD_SITE_THRESHOLD) issues.push(`not mobile-friendly (${prospect.mobileScore}/100)`);
  if ((prospect.seoScore ?? 100) < BAD_SITE_THRESHOLD) issues.push(`poor SEO (${prospect.seoScore}/100)`);
  return `Website needs work: ${issues.join(", ")}.`;
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
  const results: Prospect[] = [];

  for (const place of places) {
    if (await isAlreadyKnown(place.place_id)) continue;

    await sleep(200); // gentle rate limiting
    const details = await getPlaceDetails(place.place_id);
    if (!details) continue;

    if (!details.website) {
      // No website — immediate prospect
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
      results.push(p);
    } else {
      // Has website — check quality
      await sleep(500);
      const scores = await getPageSpeedScores(details.website);
      if (!scores) continue;

      const isBad =
        scores.performance < BAD_SITE_THRESHOLD ||
        scores.mobile < BAD_SITE_THRESHOLD ||
        scores.seo < BAD_SITE_THRESHOLD;

      if (isBad) {
        const p: Prospect = {
          placeId: details.place_id,
          name: details.name,
          address: details.formatted_address,
          phone: details.formatted_phone_number,
          website: details.website,
          mapsUrl: details.url,
          businessType,
          location,
          prospectType: "bad_website",
          perfScore: scores.performance,
          mobileScore: scores.mobile,
          seoScore: scores.seo,
          pitchReason: "",
        };
        p.pitchReason = buildPitchReason(p);
        await saveProspect(p);
        results.push(p);
      }
    }
  }

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
  const all: Prospect[] = [];
  for (const type of businessTypes) {
    try {
      const found = await scanProspects(type, location);
      all.push(...found);
      await sleep(500);
    } catch (err) {
      log.error({ err: (err as Error).message, type, location }, "scanLocation: type scan failed");
    }
  }
  return all;
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
    seo_score: number; pitch_reason: string;
  }>(
    `SELECT place_id, name, address, phone, website, maps_url, business_type,
            location, prospect_type, perf_score, mobile_score, seo_score, pitch_reason
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
    prospectType: r.prospect_type as "no_website" | "bad_website",
    perfScore: r.perf_score,
    mobileScore: r.mobile_score,
    seoScore: r.seo_score,
    pitchReason: r.pitch_reason,
  }));
}

export async function markProspectSent(placeId: string): Promise<void> {
  await pool.query(
    "UPDATE prospects SET telegram_sent = TRUE, telegram_sent_at = now() WHERE place_id = $1",
    [placeId]
  );
}
