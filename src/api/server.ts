import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { childLogger } from "../config/logger";
import { pool } from "../db/pool";
import {
  getAnalyticsByCategory,
  getStats,
  queryOpportunities,
} from "../services/opportunityRepository";
import {
  createSource,
  listAllSources,
  setSourceEnabled,
} from "../sources/registry";
import { runPipeline } from "../scheduler/pipeline";
import { runProspectCycle } from "../scheduler/prospectPipeline";
import { scanProspects } from "../agents/placesProspectorAgent";
import axios from "axios";

const log = childLogger("Api");

export function createApiServer() {
  const app = express();
  app.use(express.json());

  // ---- Health: used by Railway's healthcheck ----
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", service: "ileven-radar", time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: "degraded", reason: "database unreachable" });
    }
  });

  app.get("/", (_req, res) => {
    res.json({
      service: "Ileven Radar",
      description: "Autonomous AI business-opportunity discovery agent",
      endpoints: ["/health", "/api/stats", "/api/opportunities", "/api/analytics", "/api/sources"],
    });
  });

  // ---- Stats ----
  app.get("/api/stats", async (_req, res, next) => {
    try {
      res.json(await getStats());
    } catch (err) {
      next(err);
    }
  });

  // ---- Opportunities (filterable + searchable) ----
  app.get("/api/opportunities", async (req, res, next) => {
    try {
      const opps = await queryOpportunities({
        category: req.query.category as string | undefined,
        label: req.query.label as never,
        minScore: req.query.minScore ? Number(req.query.minScore) : undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Math.min(100, Number(req.query.limit)) : 20,
      });
      res.json({ count: opps.length, opportunities: opps });
    } catch (err) {
      next(err);
    }
  });

  // ---- Analytics ----
  app.get("/api/analytics", async (_req, res, next) => {
    try {
      res.json({ byCategory: await getAnalyticsByCategory() });
    } catch (err) {
      next(err);
    }
  });

  // ---- Sources: list ----
  app.get("/api/sources", async (_req, res, next) => {
    try {
      res.json({ sources: await listAllSources() });
    } catch (err) {
      next(err);
    }
  });

  // ---- Sources: create (add unlimited RSS feeds / search queries) ----
  const createSourceSchema = z.object({
    name: z.string().min(1),
    type: z.enum(["rss", "google_search", "linkedin"]),
    category: z.string().min(1),
    config: z.record(z.unknown()),
    enabled: z.boolean().optional(),
  });

  app.post("/api/sources", async (req, res, next) => {
    try {
      const parsed = createSourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const source = await createSource(parsed.data);
      res.status(201).json({ source });
    } catch (err) {
      next(err);
    }
  });

  // ---- Sources: enable/disable ----
  app.patch("/api/sources/:id", async (req, res, next) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      await setSourceEnabled(req.params.id, enabled);
      res.json({ id: req.params.id, enabled });
    } catch (err) {
      next(err);
    }
  });

  // ---- Manual pipeline trigger ----
  app.post("/api/run", async (_req, res) => {
    void runPipeline("api");
    res.status(202).json({ status: "started" });
  });

  // ---- Prospect targets: list ----
  app.get("/api/prospect/targets", async (_req, res, next) => {
    try {
      const result = await pool.query(
        "SELECT id, business_type, location, enabled, last_run_at FROM prospect_targets ORDER BY created_at ASC"
      );
      res.json({ targets: result.rows });
    } catch (err) { next(err); }
  });

  // ---- Prospect targets: add ----
  const prospectTargetSchema = z.object({
    businessType: z.string().min(1),
    location: z.string().min(1),
  });

  app.post("/api/prospect/targets", async (req, res, next) => {
    try {
      const parsed = prospectTargetSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      await pool.query(
        `INSERT INTO prospect_targets (business_type, location) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [parsed.data.businessType, parsed.data.location]
      );
      res.status(201).json({ status: "added", ...parsed.data });
    } catch (err) { next(err); }
  });

  // ---- Prospect: manual scan ----
  app.post("/api/prospect/scan", async (req, res, next) => {
    try {
      const { businessType, location } = req.body ?? {};
      if (!businessType || !location) {
        return res.status(400).json({ error: "businessType and location are required" });
      }
      const prospects = await scanProspects(String(businessType), String(location));
      res.json({ found: prospects.length, prospects });
    } catch (err) { next(err); }
  });

  // ---- Prospect: run all targets now ----
  app.post("/api/prospect/run", async (_req, res) => {
    void runProspectCycle("api");
    res.status(202).json({ status: "started" });
  });

  // ---- Debug: test Places API key directly ----
  app.get("/api/debug/places", async (req, res, next) => {
    try {
      const query = String(req.query.q ?? "hotel in Lagos Nigeria");
      const key = env.GOOGLE_PLACES_API_KEY;
      if (!key) return res.status(400).json({ error: "GOOGLE_PLACES_API_KEY not set" });
      const response = await axios.get("https://maps.googleapis.com/maps/api/place/textsearch/json", {
        params: { query, key },
        timeout: 15_000,
      });
      const { status, results } = response.data;
      res.json({
        apiStatus: status,
        keyConfigured: !!key,
        resultsCount: results?.length ?? 0,
        sample: (results ?? []).slice(0, 3).map((r: { name: string; formatted_address: string; place_id: string }) => ({
          name: r.name,
          address: r.formatted_address,
          placeId: r.place_id,
        })),
      });
    } catch (err) { next(err); }
  });

  // ---- Prospects: list ----
  app.get("/api/prospects", async (req, res, next) => {
    try {
      const type = req.query.type as string | undefined;
      const limit = Math.min(100, Number(req.query.limit ?? 20));
      const params: unknown[] = [];
      const conds: string[] = [];
      if (type) { params.push(type); conds.push(`prospect_type = $${params.length}`); }
      params.push(limit);
      const result = await pool.query(
        `SELECT * FROM prospects ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      res.json({ count: result.rows.length, prospects: result.rows });
    } catch (err) { next(err); }
  });

  // ---- Error handler ----
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err: err.message }, "API error");
    res.status(500).json({ error: "Internal server error" });
  });

  function listen() {
    return app.listen(env.PORT, () => {
      log.info({ port: env.PORT }, "HTTP API listening");
    });
  }

  return { app, listen };
}
