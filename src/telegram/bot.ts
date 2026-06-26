import TelegramBot from "node-telegram-bot-api";
import { env } from "../config/env";
import { childLogger } from "../config/logger";
import { withRetry, sleep } from "../utils/retry";
import {
  esc,
  formatOpportunityLine,
  formatOpportunityMessage,
} from "./format";
import {
  deactivateSubscriber,
  getActiveSubscriberChatIds,
  getChannelsForCategory,
  listActiveChannels,
  upsertChannel,
  upsertSubscriber,
} from "./subscribers";
import {
  getStats,
  getUnsentQualified,
  markTelegramSent,
  queryOpportunities,
} from "../services/opportunityRepository";
import { OpportunityRecord } from "../types/opportunity";

const log = childLogger("TelegramAgent");

let bot: TelegramBot | null = null;

const HTML = { parse_mode: "HTML" as const, disable_web_page_preview: true };

export function getBot(): TelegramBot {
  if (!bot) {
    throw new Error("Telegram bot not initialized - call startTelegramBot() first");
  }
  return bot;
}

async function sendToChat(chatId: number, message: string): Promise<void> {
  try {
    await withRetry(() => getBot().sendMessage(chatId, message, HTML), {
      label: "Telegram send",
      retries: 2,
    });
    await sleep(120);
  } catch (err) {
    const code = (err as { response?: { statusCode?: number } })?.response?.statusCode;
    if (code === 403) {
      await deactivateSubscriber(chatId);
      log.info({ chatId }, "Subscriber blocked bot, deactivated");
    } else {
      log.error({ chatId, err: (err as Error).message }, "Failed to deliver lead");
    }
  }
}

/**
 * Telegram Notification Agent (push side): routes every qualified,
 * not-yet-sent opportunity to category-specific channels AND to all
 * individual DM subscribers, then marks it sent.
 */
export async function deliverQualifiedLeads(): Promise<number> {
  if (!bot) return 0;

  const leads = await getUnsentQualified(env.MIN_SCORE_TO_NOTIFY);
  if (leads.length === 0) return 0;

  const subscriberIds = await getActiveSubscriberChatIds();

  let delivered = 0;
  for (const lead of leads) {
    const message = formatOpportunityMessage(lead);
    const channelIds = await getChannelsForCategory(lead.category);

    const allTargets = new Set([...channelIds, ...subscriberIds]);
    if (allTargets.size === 0) {
      log.info({ lead: lead.id }, "Qualified lead but no channels or subscribers");
      continue;
    }

    for (const chatId of allTargets) {
      await sendToChat(chatId, message);
    }

    await markTelegramSent(lead.id);
    delivered += 1;
  }

  log.info({ delivered, channels: "by-category" }, "Delivered qualified leads");
  return delivered;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function sendList(
  chatId: number,
  title: string,
  opps: OpportunityRecord[]
): Promise<void> {
  if (opps.length === 0) {
    await getBot().sendMessage(chatId, `${title}\n\nNothing found yet — the agent checks every hour.`, HTML);
    return;
  }
  const lines = opps.map((o, i) => formatOpportunityLine(o, i + 1));
  await getBot().sendMessage(chatId, `<b>${title}</b>\n\n${lines.join("\n")}`, HTML);
}

const VALID_CATEGORIES = [
  "all",
  "Website Project",
  "Mobile App Project",
  "SaaS Project",
  "AI Project",
  "Government Tender",
  "Startup Funding",
  "Consulting Opportunity",
  "Enterprise Software",
  "Software Development",
  "Freelance Project",
  "Jobs & Projects",
];

const HELP_TEXT = `<b>Ileven Radar</b> — autonomous opportunity radar 🛰

I scan tenders, RFPs, funding rounds, and "looking for a developer" posts every hour, score them with AI, and push the best leads here.

<b>Commands</b>
/start — subscribe to live opportunity alerts
/help — show this message
/status — agent health & stats
/latest — 10 most recent opportunities
/hot — current HOT leads (80+)
/funding — startup funding opportunities
/tenders — government tenders
/websites — website projects
/mobileapps — mobile app projects
/search [keyword] — search all opportunities

<b>Channel routing</b>
/setchannel [category] — route a category to this channel
/channels — list active channel mappings
/categories — list available categories`;

function registerCommands(b: TelegramBot): void {
  b.onText(/^\/start\b/, async (msg) => {
    await upsertSubscriber(msg.chat.id, msg.chat.username);
    await b.sendMessage(
      msg.chat.id,
      `✅ You're subscribed to <b>Ileven Radar</b>.\n\nYou'll receive qualified opportunities (score ≥ ${env.MIN_SCORE_TO_NOTIFY}) as they're found.\n\n${HELP_TEXT}`,
      HTML
    );
  });

  b.onText(/^\/help\b/, async (msg) => {
    await b.sendMessage(msg.chat.id, HELP_TEXT, HTML);
  });

  b.onText(/^\/status\b/, async (msg) => {
    const stats = await getStats();
    await b.sendMessage(
      msg.chat.id,
      [
        `<b>📡 Ileven Radar status</b>`,
        ``,
        `Total opportunities: <b>${stats.total}</b>`,
        `🔥 Hot leads: <b>${stats.hot}</b>`,
        `🌤 Warm leads: <b>${stats.warm}</b>`,
        `🆕 New (last 24h): <b>${stats.today}</b>`,
        `⏳ Awaiting analysis: <b>${stats.pending}</b>`,
        ``,
        `Agent is running and scanning sources every hour.`,
      ].join("\n"),
      HTML
    );
  });

  b.onText(/^\/latest\b/, async (msg) => {
    const opps = await queryOpportunities({ limit: 10 });
    await sendList(msg.chat.id, "🆕 Latest opportunities", opps);
  });

  b.onText(/^\/hot\b/, async (msg) => {
    const opps = await queryOpportunities({ label: "HOT", limit: 10 });
    await sendList(msg.chat.id, "🔥 Hot leads", opps);
  });

  b.onText(/^\/funding\b/, async (msg) => {
    const opps = await queryOpportunities({ category: "Startup Funding", limit: 10 });
    await sendList(msg.chat.id, "💰 Startup funding", opps);
  });

  b.onText(/^\/tenders\b/, async (msg) => {
    const opps = await queryOpportunities({ category: "Government Tender", limit: 10 });
    await sendList(msg.chat.id, "🏛 Government tenders", opps);
  });

  b.onText(/^\/websites\b/, async (msg) => {
    const opps = await queryOpportunities({ category: "Website Project", limit: 10 });
    await sendList(msg.chat.id, "🌐 Website projects", opps);
  });

  b.onText(/^\/mobileapps\b/, async (msg) => {
    const opps = await queryOpportunities({ category: "Mobile App Project", limit: 10 });
    await sendList(msg.chat.id, "📱 Mobile app projects", opps);
  });

  b.onText(/^\/search\b\s*(.*)$/, async (msg, match) => {
    const keyword = (match?.[1] ?? "").trim();
    if (!keyword) {
      await b.sendMessage(msg.chat.id, "Usage: <code>/search react agency Nigeria</code>", HTML);
      return;
    }
    const opps = await queryOpportunities({ search: keyword, limit: 10 });
    await sendList(msg.chat.id, `🔎 Results for "${keyword}"`, opps);
  });

  b.onText(/^\/setchannel\b\s*(.*)$/, async (msg, match) => {
    const category = (match?.[1] ?? "").trim();
    if (!category) {
      await b.sendMessage(
        msg.chat.id,
        `Usage: <code>/setchannel Government Tender</code>\n\nUse /categories to see available categories.\nUse <code>/setchannel all</code> to receive all categories.`,
        HTML
      );
      return;
    }
    if (!VALID_CATEGORIES.includes(category)) {
      await b.sendMessage(
        msg.chat.id,
        `❌ Unknown category: "${category}"\n\nUse /categories to see available categories.`,
        HTML
      );
      return;
    }
    const chatTitle = msg.chat.title ?? msg.chat.username ?? String(msg.chat.id);
    const channel = await upsertChannel(msg.chat.id, chatTitle, category);
    await b.sendMessage(
      msg.chat.id,
      `✅ This chat is now receiving <b>${category}</b> opportunities.\n\nChannel: ${esc(channel.name)}`,
      HTML
    );
    log.info({ chatId: msg.chat.id, category, name: chatTitle }, "Channel registered");
  });

  b.onText(/^\/channels\b/, async (msg) => {
    const channels = await listActiveChannels();
    if (channels.length === 0) {
      await b.sendMessage(msg.chat.id, "No channels configured yet.\n\nUse /setchannel [category] in a group/channel to route opportunities there.", HTML);
      return;
    }
    const lines = channels.map((c) => `• <b>${esc(c.category)}</b> → ${esc(c.name)}`);
    await b.sendMessage(msg.chat.id, `<b>📡 Active channel routes</b>\n\n${lines.join("\n")}`, HTML);
  });

  b.onText(/^\/categories\b/, async (msg) => {
    const lines = VALID_CATEGORIES.map((c) => `• <code>${c}</code>`);
    await b.sendMessage(
      msg.chat.id,
      `<b>Available categories</b>\n\n${lines.join("\n")}\n\nUsage: <code>/setchannel Government Tender</code>`,
      HTML
    );
  });

  b.on("polling_error", (err) => {
    log.error({ err: err.message }, "Telegram polling error");
  });
}

export async function startTelegramBot(): Promise<void> {
  bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: true });
  registerCommands(bot);

  await bot.setMyCommands([
    { command: "start", description: "Subscribe to opportunity alerts" },
    { command: "help", description: "Show available commands" },
    { command: "status", description: "Agent health & stats" },
    { command: "latest", description: "10 most recent opportunities" },
    { command: "hot", description: "Current HOT leads" },
    { command: "funding", description: "Startup funding opportunities" },
    { command: "tenders", description: "Government tenders" },
    { command: "websites", description: "Website projects" },
    { command: "mobileapps", description: "Mobile app projects" },
    { command: "search", description: "Search opportunities by keyword" },
    { command: "setchannel", description: "Route a category to this chat" },
    { command: "channels", description: "List active channel routes" },
    { command: "categories", description: "List available categories" },
  ]);

  log.info("Telegram bot started (long polling)");
}

export async function stopTelegramBot(): Promise<void> {
  if (bot) {
    await bot.stopPolling();
    bot = null;
  }
}
