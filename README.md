# 🛰 Ileven Radar

**Autonomous AI agent that discovers, analyzes, scores, and delivers business opportunities — 24/7.**

Ileven Radar continuously scans the open web for software development tenders, website & mobile-app requests, RFPs/RFQs, government ICT contracts, startup funding rounds, "looking for a developer" posts, digital-transformation and IT-consulting opportunities. Every discovery is enriched and scored by AI, then qualified leads are pushed straight to Telegram.

It runs on its own. Boot it once and it works every hour, forever, with no human in the loop.

---

## How it works

```
                 ┌─────────────────────────────────────────────┐
   every hour →  │              Pipeline Orchestrator           │
   (cron)        └─────────────────────────────────────────────┘
                       │            │             │
                       ▼            ▼             ▼
              ┌──────────────┐ ┌──────────┐ ┌──────────────┐
              │  Collector   │ │ Analysis │ │   Telegram   │
              │  + Web Search│ │ + Scoring│ │ Notification │
              │    Agents    │ │  Agents  │ │    Agent     │
              └──────────────┘ └──────────┘ └──────────────┘
                     │              │              │
        RSS feeds ───┤              │              │
        Google CSE ──┘              │              │
                                    ▼              ▼
                              PostgreSQL ───► Telegram chats
```

The discovery cycle (one run, every hour):

1. **Collect** — pull items from every enabled source (RSS feeds + Google Search queries).
2. **Discover & extract** — turn each item into a raw opportunity record.
3. **Deduplicate** — content-hash + a `UNIQUE` DB constraint drop anything seen before.
4. **Analyze** — OpenAI extracts company, location, budget, deadline, industry, contact info, technologies; categorizes; summarizes; and recommends an action.
5. **Score** — five AI sub-scores (budget, urgency, credibility, relevance, quality) combine into a deterministic 0–100 score with a **HOT / WARM / LOW PRIORITY** label.
6. **Deliver** — qualified leads (score ≥ `MIN_SCORE_TO_NOTIFY`) are pushed to all Telegram subscribers.

### Agents

| Agent | File | Responsibility |
|---|---|---|
| Source Collector | `src/agents/collectorAgent.ts` | Iterates sources, dedupes, stores new raw items |
| Web Search | `src/sources/googleSearchSource.ts` | Google Programmable Search keyword monitoring |
| Opportunity Extraction + AI Analysis | `src/agents/aiAnalysisAgent.ts` | Extraction, categorization, summary, sub-scores |
| Lead Scoring | `src/agents/leadScoringAgent.ts` | Weighted 0–100 score + label |
| Telegram Notification | `src/telegram/bot.ts` | Push delivery + bot commands |

---

## Tech stack

Node.js 20 · TypeScript · OpenAI GPT · PostgreSQL · Telegram Bot API · Express (health + REST) · node-cron · Docker · Railway.

---

## Quick start (local)

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env       # then fill in the values

# 3. Start Postgres (any local instance works), then:
npm run migrate:dev        # applies the schema + seeds starter sources

# 4. Run in watch mode
npm run dev
```

You need, at minimum: a running PostgreSQL (`DATABASE_URL`), an `OPENAI_API_KEY`, and a `TELEGRAM_BOT_TOKEN` from [@BotFather](https://t.me/BotFather). Google Search monitoring is optional — without `GOOGLE_CSE_API_KEY` / `GOOGLE_CSE_ID`, those sources are simply skipped and RSS keeps working.

Open Telegram, message your bot `/start`, and you're subscribed.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `OPENAI_API_KEY` | ✅ | — | OpenAI key for analysis |
| `OPENAI_MODEL` | | `gpt-4o-mini` | Chat model used for analysis |
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from @BotFather |
| `GOOGLE_CSE_API_KEY` | | — | Google Custom Search API key (optional) |
| `GOOGLE_CSE_ID` | | — | Google Programmable Search engine ID (optional) |
| `MIN_SCORE_TO_NOTIFY` | | `50` | Minimum score to push a lead to Telegram |
| `CRON_SCHEDULE` | | `0 * * * *` | When the discovery cycle runs (hourly) |
| `RUN_ON_STARTUP` | | `true` | Run one cycle immediately on boot |
| `PORT` | | `8080` | HTTP port for health + REST API |
| `LOG_LEVEL` | | `info` | pino log level |

---

## Telegram commands

| Command | Action |
|---|---|
| `/start` | Subscribe to live opportunity alerts |
| `/help` | List commands |
| `/status` | Agent health & stats |
| `/latest` | 10 most recent opportunities |
| `/hot` | Current HOT leads (80+) |
| `/funding` | Startup funding opportunities |
| `/tenders` | Government tenders |
| `/websites` | Website projects |
| `/mobileapps` | Mobile app projects |
| `/search [keyword]` | Search all opportunities |

A delivered lead looks like:

```
🚨 NEW OPPORTUNITY 🔥
Title: Redesign of the State Health Portal
Company: Lagos State Ministry of Health
Category: Website Project
Score: 86/100 (HOT)
Budget: ₦18,000,000
Summary: ...
Required Technologies: React, Node.js, PostgreSQL
Source: Google: website redesign request
Link: https://...
Recommended Action: Submit a proposal before the 14-day deadline.
```

---

## REST API

A small Express API runs alongside the agent (used for the Railway healthcheck and for inspecting/managing data):

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness + DB check |
| `GET` | `/api/stats` | Totals, hot/warm counts, today, pending |
| `GET` | `/api/opportunities` | Filter by `category`, `label`, `minScore`, `search`, `limit` |
| `GET` | `/api/analytics` | Counts by category |
| `GET` | `/api/sources` | List all sources |
| `POST` | `/api/sources` | Add an RSS feed or Google Search query |
| `PATCH` | `/api/sources/:id` | Enable/disable a source |
| `POST` | `/api/run` | Trigger a discovery cycle now |

**Add unlimited sources** without redeploying:

```bash
# An RSS feed
curl -X POST localhost:8080/api/sources -H 'content-type: application/json' -d '{
  "name": "My Country Procurement Feed",
  "type": "rss",
  "category": "Government Tender",
  "config": { "url": "https://example.gov/tenders.rss" }
}'

# A Google Search query
curl -X POST localhost:8080/api/sources -H 'content-type: application/json' -d '{
  "name": "Fintech app developer wanted",
  "type": "google_search",
  "category": "Mobile App Project",
  "config": { "query": "fintech startup \"hiring app developer\"" }
}'
```

---

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Add the **PostgreSQL** plugin. Railway injects `DATABASE_URL` automatically.
4. In the service **Variables** tab, set `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, and (optionally) the Google CSE vars.
5. Deploy. Railway builds from the `Dockerfile`, runs migrations on boot, and keeps the process alive (restart-on-failure is configured in `railway.json`).

The container starts the HTTP server (so the `/health` check passes), the Telegram bot, and the hourly scheduler — then runs autonomously.

> **Single worker:** keep this deployed as **one** instance. The bot uses Telegram long polling and the scheduler runs in-process; running multiple replicas would cause duplicate polling and duplicate cycles.

---

## Project structure

```
src/
├── config/        env validation, logger
├── db/            pg pool, migration runner, SQL migrations
├── types/         shared TypeScript types
├── utils/         retry-with-backoff, content hashing (dedup)
├── sources/       RSS + Google Search collectors, source registry
├── agents/        collector, AI analysis, lead scoring
├── services/      OpenAI client, opportunity repository, analysis worker
├── telegram/      bot (commands + push), message formatting, subscribers
├── scheduler/     pipeline orchestrator, cron
├── api/           Express REST + health server
└── index.ts       entrypoint (migrate → API → bot → scheduler)
```

---

## Database schema

- **sources** — every monitored RSS feed / search query (configurable at runtime).
- **opportunities** — the core entity: raw discovery + AI extraction + scores + delivery status.
- **telegram_subscribers** — chats that ran `/start`.
- **source_runs** — per-source execution log for observability.

Migrations live in `src/db/migrations/` and run automatically on startup (idempotent, tracked in `schema_migrations`).

---

## Reliability

- **Retries** — every external call (HTTP, OpenAI, Telegram) goes through exponential backoff with jitter.
- **Isolation** — a failing source or a single un-analyzable item never aborts the cycle; failures are logged and recorded.
- **Idempotency** — deduplication is enforced at the database level, so re-runs are safe.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` stop polling and drain the pool cleanly.
- **No silent death** — `unhandledRejection` / `uncaughtException` are logged, and Railway restarts on failure.
