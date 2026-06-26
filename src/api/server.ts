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

  // ---- Manual pipeline trigger (handy for testing without waiting for cron) ----
  app.post("/api/run", async (_req, res) => {
    void runPipeline("api");
    res.status(202).json({ status: "started" });
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
