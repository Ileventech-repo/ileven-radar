import TelegramBot from "node-telegram-bot-api";
import { env, emailEnabled, whatsappEnabled, callAgentEnabled } from "../config/env";
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
import {
  getUnsentProspects,
  markProspectSent,
  scanProspects,
  scanLocation,
  Prospect,
} from "../agents/placesProspectorAgent";
import { draftProspectEmail, draftOpportunityEmail } from "../agents/emailDraftAgent";
import { buildProspectCallScript, buildOpportunityCallScript, formatCallScript } from "../agents/callScriptAgent";
import { buildCallSystemPrompt, initiateCall } from "../services/callAgentService";
import { openai } from "../services/openaiClient";
import { sendEmail } from "../services/emailService";
import { createFollowUpSequence } from "../services/sequenceService";
import { draftAndSendWhatsApp } from "../services/whatsappService";
import { generateProspectProposal, generateOpportunityProposal } from "../services/proposalPdfService";
import { pool } from "../db/pool";

const log = childLogger("TelegramAgent");

let bot: TelegramBot | null = null;

const HTML = { parse_mode: "HTML" as const, disable_web_page_preview: true };

// Tracks pending edit sessions: key = "chatId:promptMsgId" → { draftId, action }
const pendingEdits = new Map<string, { draftId: string; action: "subject" | "body" }>();

function plainToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222">${escaped.replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
}

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
      try {
        const opts: TelegramBot.SendMessageOptions = { ...HTML };
        const emailMatch = lead.contactInfo?.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
        const emailCb = emailMatch
          ? `draft_email:opportunity:${lead.id}:${emailMatch[0]}`
          : `ask_email:opportunity:${lead.id}`;
        const buttons: TelegramBot.InlineKeyboardButton[] = [
          { text: "📞 Call Script", callback_data: `call_script:opportunity:${lead.id}` },
        ];
        if (emailEnabled) {
          buttons.push({ text: "📧 Draft Email", callback_data: emailCb });
        }
        opts.reply_markup = { inline_keyboard: [buttons] };
        await withRetry(() => getBot().sendMessage(chatId, message, opts), { label: "Telegram send", retries: 2 });
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

    await markTelegramSent(lead.id);
    delivered += 1;
  }

  log.info({ delivered, channels: "by-category" }, "Delivered qualified leads");
  return delivered;
}

function formatProspect(p: Prospect, index: number): string {
  const typeLabel =
    p.prospectType === "no_website" ? "🚫 NO WEBSITE" :
    p.prospectType === "bad_website" ? "⚠️ BAD WEBSITE" :
    "✅ HAS WEBSITE";
  const lines = [
    `${index}. ${typeLabel}`,
    `<b>${esc(p.name)}</b>`,
    `📍 ${esc(p.address)}`,
  ];
  if (p.phone) lines.push(`📞 ${esc(p.phone)}`);
  if (p.website) lines.push(`🌐 ${esc(p.website)}`);
  if (p.contactEmail) lines.push(`✉️ ${esc(p.contactEmail)}`);
  if (p.prospectType === "bad_website" && p.perfScore !== undefined) {
    lines.push(`📊 Speed: ${p.perfScore} | Mobile: ${p.mobileScore} | SEO: ${p.seoScore}`);
  }
  if (p.mapsUrl) lines.push(`🗺 <a href="${esc(p.mapsUrl)}">Google Maps</a>`);
  lines.push(`💡 ${esc(p.pitchReason)}`);
  return lines.join("\n");
}

function buildProspectButtons(p: Prospect): TelegramBot.InlineKeyboardButton[][] {
  const row1: TelegramBot.InlineKeyboardButton[] = [
    { text: "📞 Call Script", callback_data: `call_script:prospect:${p.placeId}` },
  ];
  if (callAgentEnabled && p.phone) {
    row1.push({ text: "🤖 AI Call", callback_data: `make_call:prospect:${p.placeId}` });
  }

  const row2: TelegramBot.InlineKeyboardButton[] = [];
  if (emailEnabled) {
    if (p.contactEmail) {
      // Email already found — go straight to drafting
      row2.push({ text: "📧 Send Cold Email", callback_data: `draft_email:prospect:${p.placeId}:${p.contactEmail}` });
    } else if (p.website) {
      row2.push({ text: "📧 Draft Email", callback_data: `draft_email:prospect:${p.placeId}:webmaster@${new URL(p.website).hostname}` });
    } else {
      row2.push({ text: "📧 Draft Email", callback_data: `ask_email:prospect:${p.placeId}` });
    }
  }
  if (whatsappEnabled && p.phone) {
    row2.push({ text: "📱 WhatsApp", callback_data: `whatsapp_send:${p.placeId}:${p.phone}` });
  }

  return row2.length > 0 ? [row1, row2] : [row1];
}

export async function deliverUnsentProspects(): Promise<number> {
  if (!bot) return 0;
  const prospects = await getUnsentProspects();
  if (prospects.length === 0) return 0;

  const chatIds = await getActiveSubscriberChatIds();
  if (chatIds.length === 0) return 0;

  // Group by location for cleaner messages
  const groups = new Map<string, Prospect[]>();
  for (const p of prospects) {
    const key = `${p.businessType} | ${p.location}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  let delivered = 0;
  for (const [groupKey, items] of groups) {
    const noSite = items.filter((p) => p.prospectType === "no_website").length;
    const badSite = items.filter((p) => p.prospectType === "bad_website").length;
    const found = items.filter((p) => p.prospectType === "found").length;
    const parts = [
      noSite ? `${noSite} no-website` : "",
      badSite ? `${badSite} bad-website` : "",
      found ? `${found} has-website` : "",
    ].filter(Boolean).join(" · ");
    const header = `🌍 <b>Prospects — ${esc(groupKey)}</b>\nFound: ${parts}\n`;

    for (const p of items) {
      const message = `${header}\n${formatProspect(p, 1)}`;
      for (const chatId of chatIds) {
        try {
          const opts: TelegramBot.SendMessageOptions = {
            ...HTML,
            disable_web_page_preview: false,
          };
          opts.reply_markup = { inline_keyboard: buildProspectButtons(p) };
          await withRetry(() => getBot().sendMessage(chatId, message, opts), { label: "Telegram prospect send", retries: 2 });
          await sleep(120);
        } catch (err) {
          const code = (err as { response?: { statusCode?: number } })?.response?.statusCode;
          if (code === 403) await deactivateSubscriber(chatId);
          else log.error({ chatId, err: (err as Error).message }, "Failed to deliver prospect");
        }
      }
      await markProspectSent(p.placeId);
    }
    delivered += items.length;
  }

  log.info({ delivered }, "Delivered prospect alerts");
  return delivered;
}

// ---------------------------------------------------------------------------
// Email approval flow
// ---------------------------------------------------------------------------

async function createEmailDraftRecord(
  refType: "prospect" | "opportunity",
  refId: string,
  toEmail: string,
  subject: string,
  htmlBody: string,
  plainBody: string,
  chatId: number
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO email_outreach (ref_type, ref_id, to_email, subject, html_body, plain_body, telegram_chat_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [refType, refId, toEmail, subject, htmlBody, plainBody, chatId]
  );
  return result.rows[0].id;
}

async function showEmailPreview(
  b: TelegramBot,
  chatId: number,
  draftId: string,
  toEmail: string,
  subject: string,
  plainText: string
): Promise<void> {
  const MAX_BODY = 3200;
  const body = plainText.length > MAX_BODY
    ? plainText.slice(0, MAX_BODY) + "\n\n<i>... (email continues — tap Edit Body to see/change full text)</i>"
    : plainText;

  const preview = [
    `📧 <b>Email Draft</b>`,
    ``,
    `<b>To:</b> ${esc(toEmail)}`,
    `<b>Subject:</b> ${esc(subject)}`,
    ``,
    esc(body),
  ].join("\n");

  const sent = await b.sendMessage(chatId, preview, {
    ...HTML,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Send Email", callback_data: `email_send:${draftId}` },
          { text: "📎 Send with PDF", callback_data: `email_send_pdf:${draftId}` },
        ],
        [
          { text: "✏️ Edit Subject", callback_data: `edit_subject:${draftId}` },
          { text: "✏️ Edit Body", callback_data: `edit_body:${draftId}` },
        ],
        [
          { text: "❌ Cancel", callback_data: `email_cancel:${draftId}` },
        ],
      ],
    },
  });

  // Save preview message_id so we know which message to reference for edits
  await pool.query(`UPDATE email_outreach SET telegram_msg_id = $1 WHERE id = $2`, [sent.message_id, draftId]);
}

export async function sendEmailApprovalRequest(
  chatId: number,
  refType: "prospect" | "opportunity",
  refId: string,
  toEmail: string,
  label: string
): Promise<void> {
  if (!bot || !emailEnabled) return;

  await bot.sendMessage(chatId, `⏳ Drafting email for <b>${esc(label)}</b>...`, HTML);

  try {
    let draft;
    if (refType === "prospect") {
      const result = await pool.query(
        `SELECT place_id,name,address,phone,website,maps_url,business_type,location,prospect_type,perf_score,mobile_score,seo_score,pitch_reason FROM prospects WHERE place_id=$1`,
        [refId]
      );
      const r = result.rows[0];
      const prospect: Prospect = {
        placeId: r.place_id, name: r.name, address: r.address, phone: r.phone,
        website: r.website, mapsUrl: r.maps_url, businessType: r.business_type,
        location: r.location, prospectType: r.prospect_type,
        perfScore: r.perf_score, mobileScore: r.mobile_score, seoScore: r.seo_score,
        pitchReason: r.pitch_reason,
      };
      draft = await draftProspectEmail(prospect, toEmail);
    } else {
      const result = await pool.query(
        `SELECT id,source_name,source_category,url,raw_title,title,company,location,industry,budget_text,estimated_value_usd,deadline,contact_info,technologies,category,summary,recommended_action,opportunity_score,label,status,telegram_sent,created_at FROM opportunities WHERE id=$1`,
        [refId]
      );
      const r = result.rows[0];
      const opp: OpportunityRecord = {
        id: r.id, sourceName: r.source_name, sourceCategory: r.source_category,
        url: r.url, rawTitle: r.raw_title, title: r.title, company: r.company,
        location: r.location, industry: r.industry, budgetText: r.budget_text,
        estimatedValueUsd: r.estimated_value_usd ? Number(r.estimated_value_usd) : null,
        deadline: r.deadline, contactInfo: r.contact_info,
        technologies: r.technologies ?? [], category: r.category,
        summary: r.summary, recommendedAction: r.recommended_action,
        opportunityScore: r.opportunity_score, label: r.label,
        status: r.status, telegramSent: r.telegram_sent, createdAt: r.created_at,
      };
      draft = await draftOpportunityEmail(opp, toEmail);
    }

    const draftId = await createEmailDraftRecord(
      refType, refId, toEmail, draft.subject, draft.html, draft.plainText, chatId
    );

    await showEmailPreview(bot, chatId, draftId, toEmail, draft.subject, draft.plainText);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Failed to draft email: ${esc((err as Error).message)}`, HTML);
  }
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
/categories — list available categories

<b>Prospect scanner</b>
/scan [location] — sweep all popular business types in any city
/scan [anything] in [location] — scan any specific business type

<b>Examples</b>
/scan Lagos, Nigeria
/scan barbershops in Atlanta
/scan nail salons in London
/scan churches in Accra

<b>Outreach on every card</b>
📞 Call Script · 🤖 AI Call · 📧 Cold Email · 📱 WhatsApp`;

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

  // /prospect kept as alias for backwards compatibility
  b.onText(/^\/prospect\b\s*(.*)$/, async (msg, match) => {
    const input = (match?.[1] ?? "").trim();
    if (!input) {
      await b.sendMessage(msg.chat.id, `Use <code>/scan [anything] in [location]</code>\n\nExamples:\n<code>/scan hotels in Lagos</code>\n<code>/scan Atlanta, USA</code>`, HTML);
      return;
    }
    // forward to scan handler by re-emitting the text as /scan
    await handleScan(msg.chat.id, input);
  });

  async function handleScan(chatId: number, input: string): Promise<void> {
    if (!input) {
      await b.sendMessage(
        chatId,
        `<b>Scan any place, anywhere</b>\n\n` +
        `<code>/scan [location]</code> — sweep all popular business types\n` +
        `<code>/scan [type] in [location]</code> — scan any specific type\n\n` +
        `<b>Examples:</b>\n` +
        `<code>/scan Atlanta, USA</code>\n` +
        `<code>/scan barbershops in Lagos</code>\n` +
        `<code>/scan nail salons in London</code>\n` +
        `<code>/scan churches in Accra</code>\n` +
        `<code>/scan supermarkets in Dubai</code>`,
        HTML
      );
      return;
    }

    // Detect "type in location" vs bare location
    const inMatch = input.match(/^(.+?)\s+in\s+(.+)$/i);

    if (inMatch) {
      // Specific type scan — any business type the user wants
      const businessType = inMatch[1].trim();
      const location = inMatch[2].trim();
      await b.sendMessage(chatId, `🔍 Scanning <b>${esc(businessType)}</b> in <b>${esc(location)}</b>...`, HTML);
      try {
        const prospects = await scanProspects(businessType, location);
        await deliverScanResults(chatId, prospects, `${businessType} in ${location}`);
      } catch (err) {
        await b.sendMessage(chatId, `❌ Scan failed: ${esc((err as Error).message)}`, HTML);
      }
    } else {
      // Full location sweep — all predefined business types
      const location = input.trim();
      await b.sendMessage(chatId, `🌍 Scanning <b>all business types</b> in <b>${esc(location)}</b>...\nThis takes a few minutes. Results will arrive as they're found.`, HTML);
      try {
        const prospects = await scanLocation(location);
        await deliverScanResults(chatId, prospects, location);
      } catch (err) {
        await b.sendMessage(chatId, `❌ Scan failed: ${esc((err as Error).message)}`, HTML);
      }
    }
  }

  async function deliverScanResults(chatId: number, prospects: Prospect[], label: string): Promise<void> {
    if (prospects.length === 0) {
      await b.sendMessage(chatId, `✅ Scan complete — no new places found for <b>${esc(label)}</b>.`, HTML);
      return;
    }
    const noSite = prospects.filter((p) => p.prospectType === "no_website").length;
    const badSite = prospects.filter((p) => p.prospectType === "bad_website").length;
    const hasSite = prospects.filter((p) => p.prospectType === "found").length;
    await b.sendMessage(
      chatId,
      `✅ <b>${esc(label)}</b> — ${prospects.length} results\n🚫 ${noSite} no-website · ⚠️ ${badSite} bad-website · ✅ ${hasSite} has-website`,
      HTML
    );
    for (const p of prospects) {
      try {
        await b.sendMessage(chatId, formatProspect(p, 1), {
          ...HTML,
          reply_markup: { inline_keyboard: buildProspectButtons(p) },
        });
        await sleep(150);
      } catch { /* skip individual failures */ }
    }
  }

  b.onText(/^\/scan\b\s*(.*)$/, async (msg, match) => {
    await handleScan(msg.chat.id, (match?.[1] ?? "").trim());
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

  // /email command: manually draft + send a service email
  b.onText(/^\/email\b\s*(.*)$/, async (msg, match) => {
    const input = (match?.[1] ?? "").trim();
    if (!input || !input.includes("@")) {
      await b.sendMessage(
        msg.chat.id,
        `Usage: <code>/email contact@business.com prospect:PLACE_ID</code>\nor: <code>/email contact@business.com opportunity:OPP_ID</code>\n\nThe agent will draft a personalized email and ask for your approval before sending.`,
        HTML
      );
      return;
    }
    const parts = input.split(/\s+/);
    const toEmail = parts[0];
    const refPart = parts[1] ?? "";
    const [refType, refId] = refPart.split(":") as ["prospect" | "opportunity", string];
    if (!refId || !["prospect", "opportunity"].includes(refType)) {
      await b.sendMessage(msg.chat.id, `❌ Invalid format. Use: <code>/email to@email.com prospect:ID</code>`, HTML);
      return;
    }
    await sendEmailApprovalRequest(msg.chat.id, refType, refId, toEmail, toEmail);
  });

  // Callback queries: handle email send/cancel button presses
  b.on("callback_query", async (query) => {
    const data = query.data ?? "";
    const chatId = query.message?.chat.id;
    const msgId = query.message?.message_id;
    if (!chatId) return;

    if (data.startsWith("email_send:") || data.startsWith("email_send_pdf:")) {
      const withPdf = data.startsWith("email_send_pdf:");
      const draftId = data.replace(withPdf ? "email_send_pdf:" : "email_send:", "");
      try {
        const result = await pool.query<{
          to_email: string; subject: string; html_body: string;
          ref_type: string; ref_id: string;
        }>(
          `UPDATE email_outreach SET status='sent', sent_at=now() WHERE id=$1 AND status='pending'
           RETURNING to_email, subject, html_body, ref_type, ref_id`,
          [draftId]
        );
        if (result.rows.length === 0) {
          await b.answerCallbackQuery(query.id, { text: "Already processed." });
          return;
        }
        const { to_email, subject, html_body, ref_type, ref_id } = result.rows[0];

        let pdfBuffer: Buffer | undefined;
        if (withPdf) {
          try {
            if (ref_type === "prospect") {
              const pr = await pool.query(`SELECT * FROM prospects WHERE place_id=$1`, [ref_id]);
              if (pr.rows[0]) {
                const p = pr.rows[0];
                pdfBuffer = await generateProspectProposal({
                  placeId: p.place_id, name: p.name, address: p.address, phone: p.phone,
                  website: p.website, mapsUrl: p.maps_url, businessType: p.business_type,
                  location: p.location, prospectType: p.prospect_type,
                  perfScore: p.perf_score, mobileScore: p.mobile_score, seoScore: p.seo_score,
                  pitchReason: p.pitch_reason,
                });
              }
            } else {
              const or = await pool.query(`SELECT * FROM opportunities WHERE id=$1`, [ref_id]);
              if (or.rows[0]) {
                const o = or.rows[0];
                pdfBuffer = await generateOpportunityProposal({
                  id: o.id, sourceName: o.source_name, sourceCategory: o.source_category,
                  url: o.url, rawTitle: o.raw_title, title: o.title, company: o.company,
                  location: o.location, industry: o.industry, budgetText: o.budget_text,
                  estimatedValueUsd: o.estimated_value_usd ? Number(o.estimated_value_usd) : null,
                  deadline: o.deadline, contactInfo: o.contact_info,
                  technologies: o.technologies ?? [], category: o.category,
                  summary: o.summary, recommendedAction: o.recommended_action,
                  opportunityScore: o.opportunity_score, label: o.label,
                  status: o.status, telegramSent: o.telegram_sent, createdAt: o.created_at,
                });
              }
            }
          } catch (pdfErr) {
            log.error({ err: (pdfErr as Error).message }, "PDF generation failed, sending without PDF");
          }
        }

        const { Resend } = await import("resend");
        const resendClient = new (Resend as unknown as { new(key: string): { emails: { send: (o: object) => Promise<unknown> } } })(env.RESEND_API_KEY);
        const emailPayload: Record<string, unknown> = {
          from: env.FROM_EMAIL,
          to: to_email,
          subject,
          html: html_body,
          replyTo: env.COMPANY_CONTACT_EMAIL || undefined,
        };
        if (pdfBuffer) {
          emailPayload.attachments = [{
            filename: `${env.COMPANY_NAME.replace(/\s+/g, "_")}_Proposal.pdf`,
            content: pdfBuffer.toString("base64"),
          }];
        }
        await resendClient.emails.send(emailPayload);

        // Create follow-up sequence
        await createFollowUpSequence(draftId, ref_type as "prospect" | "opportunity", ref_id, to_email);

        const pdfNote = pdfBuffer ? " (with PDF proposal)" : "";
        await b.editMessageText(
          `✅ Email sent to <b>${esc(to_email)}</b>${pdfNote}\n<b>Subject:</b> ${esc(subject)}\n\n📅 Follow-up emails scheduled for Day 3 and Day 7.`,
          { chat_id: chatId, message_id: msgId, ...HTML }
        );
        await b.answerCallbackQuery(query.id, { text: `Email sent${pdfNote}!` });
      } catch (err) {
        log.error({ err: (err as Error).message }, "Email send via callback failed");
        await b.answerCallbackQuery(query.id, { text: "Error sending email." });
      }
    } else if (data.startsWith("email_cancel:")) {
      const draftId = data.replace("email_cancel:", "");
      await pool.query(`UPDATE email_outreach SET status='cancelled' WHERE id=$1`, [draftId]);
      await b.editMessageText("❌ Email cancelled.", { chat_id: chatId, message_id: msgId, ...HTML });
      await b.answerCallbackQuery(query.id, { text: "Cancelled." });
    } else if (data.startsWith("whatsapp_send:")) {
      const parts = data.replace("whatsapp_send:", "").split(":");
      const placeId = parts[0];
      const phone = parts.slice(1).join(":");
      await b.answerCallbackQuery(query.id, { text: "Sending WhatsApp..." });
      try {
        const pr = await pool.query(`SELECT * FROM prospects WHERE place_id=$1`, [placeId]);
        if (pr.rows[0]) {
          const p = pr.rows[0];
          const prospect: Prospect = {
            placeId: p.place_id, name: p.name, address: p.address, phone: p.phone,
            website: p.website, mapsUrl: p.maps_url, businessType: p.business_type,
            location: p.location, prospectType: p.prospect_type,
            perfScore: p.perf_score, mobileScore: p.mobile_score, seoScore: p.seo_score,
            pitchReason: p.pitch_reason,
          };
          const { message, sent } = await draftAndSendWhatsApp(prospect, phone);
          if (sent) {
            await b.editMessageText(`✅ WhatsApp sent to ${esc(phone)}\n\n<i>${esc(message)}</i>`, { chat_id: chatId, message_id: msgId, ...HTML });
          } else {
            await b.editMessageText(`❌ WhatsApp failed to send to ${esc(phone)}`, { chat_id: chatId, message_id: msgId, ...HTML });
          }
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, "WhatsApp send failed");
      }
    } else if (data.startsWith("make_call:")) {
      const parts = data.replace("make_call:", "").split(":");
      const refType = parts[0] as "prospect" | "opportunity";
      const refId = parts.slice(1).join(":");
      await b.answerCallbackQuery(query.id, { text: "Initiating AI call..." });

      try {
        let toPhone: string | undefined;
        let prospectName: string;
        let pitchContext: string;

        if (refType === "prospect") {
          const pr = await pool.query(`SELECT * FROM prospects WHERE place_id=$1`, [refId]);
          if (!pr.rows[0]) { await b.sendMessage(chatId, "❌ Prospect not found.", HTML); return; }
          const p = pr.rows[0];
          toPhone = p.phone;
          prospectName = p.name;
          pitchContext = `${p.name} is a ${p.business_type} in ${p.address}. ${p.pitch_reason}`;
        } else {
          await b.sendMessage(chatId, "❌ AI calls currently supported for prospects only.", HTML);
          return;
        }

        if (!toPhone) {
          await b.sendMessage(chatId, `❌ No phone number found for this prospect. Try WhatsApp or Email instead.`, HTML);
          return;
        }

        const systemPrompt = buildCallSystemPrompt(prospectName, pitchContext);
        await b.sendMessage(
          chatId,
          `📞 <b>Calling ${esc(prospectName)}</b>\n${esc(toPhone)}\n\n<i>The AI agent will introduce ${esc(env.COMPANY_NAME)}, pitch the service, and try to book a follow-up. You'll receive the transcript when the call ends.</i>`,
          HTML
        );

        const callSid = await initiateCall(toPhone, prospectName, systemPrompt, chatId);
        log.info({ callSid, prospectName, toPhone }, "AI call initiated from Telegram");
      } catch (err) {
        log.error({ err: (err as Error).message }, "AI call initiation failed");
        await b.sendMessage(chatId, `❌ Failed to start call: ${esc((err as Error).message)}`, HTML);
      }
    } else if (data.startsWith("call_script:")) {
      const parts = data.replace("call_script:", "").split(":");
      const refType = parts[0] as "prospect" | "opportunity";
      const refId = parts.slice(1).join(":");
      await b.answerCallbackQuery(query.id, { text: "Generating call script..." });
      await b.sendMessage(chatId, `⏳ Generating cold call script...`, HTML);
      try {
        let script;
        let businessName: string;
        if (refType === "prospect") {
          const pr = await pool.query(`SELECT * FROM prospects WHERE place_id=$1`, [refId]);
          if (!pr.rows[0]) { await b.sendMessage(chatId, "❌ Prospect not found.", HTML); return; }
          const p = pr.rows[0];
          const prospect: Prospect = {
            placeId: p.place_id, name: p.name, address: p.address, phone: p.phone,
            website: p.website, mapsUrl: p.maps_url, businessType: p.business_type,
            location: p.location, prospectType: p.prospect_type,
            perfScore: p.perf_score, mobileScore: p.mobile_score, seoScore: p.seo_score,
            pitchReason: p.pitch_reason,
          };
          script = await buildProspectCallScript(prospect);
          businessName = p.name;
        } else {
          const or = await pool.query(`SELECT * FROM opportunities WHERE id=$1`, [refId]);
          if (!or.rows[0]) { await b.sendMessage(chatId, "❌ Opportunity not found.", HTML); return; }
          const o = or.rows[0];
          const opp: OpportunityRecord = {
            id: o.id, sourceName: o.source_name, sourceCategory: o.source_category,
            url: o.url, rawTitle: o.raw_title, title: o.title, company: o.company,
            location: o.location, industry: o.industry, budgetText: o.budget_text,
            estimatedValueUsd: o.estimated_value_usd ? Number(o.estimated_value_usd) : null,
            deadline: o.deadline, contactInfo: o.contact_info,
            technologies: o.technologies ?? [], category: o.category,
            summary: o.summary, recommendedAction: o.recommended_action,
            opportunityScore: o.opportunity_score, label: o.label,
            status: o.status, telegramSent: o.telegram_sent, createdAt: o.created_at,
          };
          script = await buildOpportunityCallScript(opp);
          businessName = o.company ?? o.title ?? "Lead";
        }
        const formatted = formatCallScript(script, businessName);
        await b.sendMessage(chatId, formatted, HTML);
      } catch (err) {
        log.error({ err: (err as Error).message }, "Call script generation failed");
        await b.sendMessage(chatId, `❌ Failed to generate call script: ${esc((err as Error).message)}`, HTML);
      }
    } else if (data.startsWith("edit_subject:") || data.startsWith("edit_body:")) {
      const isBody = data.startsWith("edit_body:");
      const draftId = data.replace(isBody ? "edit_body:" : "edit_subject:", "");
      await b.answerCallbackQuery(query.id, { text: isBody ? "Paste new body below" : "Enter new subject below" });
      const action = isBody ? "body" : "subject";
      const prompt = isBody
        ? `✏️ <b>Edit Email Body</b>\n\nReply with your full updated email body (plain text). It will replace the current body.`
        : `✏️ <b>Edit Subject Line</b>\n\nReply with the new subject line:`;
      const promptMsg = await b.sendMessage(chatId, prompt, {
        ...HTML,
        reply_markup: { force_reply: true, selective: true },
      });
      pendingEdits.set(`${chatId}:${promptMsg.message_id}`, { draftId, action });
    } else if (data.startsWith("draft_email:")) {
      const parts = data.replace("draft_email:", "").split(":");
      const refType = parts[0] as "prospect" | "opportunity";
      const refId = parts[1];
      const toEmail = parts.slice(2).join(":");
      await b.answerCallbackQuery(query.id, { text: "Drafting email..." });
      await sendEmailApprovalRequest(chatId, refType, refId, toEmail, toEmail);
    } else if (data.startsWith("ask_email:")) {
      const parts = data.replace("ask_email:", "").split(":");
      const refType = parts[0] as "prospect" | "opportunity";
      const refId = parts[1];
      await b.answerCallbackQuery(query.id, { text: "Enter email address" });
      const sent = await b.sendMessage(
        chatId,
        `📧 Enter the recipient's email address for this ${refType}:`,
        {
          reply_markup: { force_reply: true, selective: true },
        }
      );
      // Store pending context so we can pick it up when user replies
      await pool.query(
        `INSERT INTO email_outreach (ref_type, ref_id, to_email, subject, html_body, plain_body, status, telegram_chat_id, telegram_msg_id)
         VALUES ($1,$2,'','','','','pending',$3,$4)`,
        [refType, refId, chatId, sent.message_id]
      );
    }
  });

  // AI intent classifier for free-form messages
  async function handleFreeTextScan(chatId: number, input: string): Promise<void> {
    const inMatch = input.match(/^(.+?)\s+in\s+(.+)$/i);
    if (inMatch) {
      const businessType = inMatch[1].trim();
      const location = inMatch[2].trim();
      await b.sendMessage(chatId, `🔍 Scanning <b>${esc(businessType)}</b> in <b>${esc(location)}</b>...`, HTML);
      const prospects = await scanProspects(businessType, location);
      await deliverScanResults(chatId, prospects, `${businessType} in ${location}`);
    } else {
      await b.sendMessage(chatId, `🌍 Scanning all business types in <b>${esc(input)}</b>...\nResults will arrive as they're found.`, HTML);
      const prospects = await scanLocation(input);
      await deliverScanResults(chatId, prospects, input);
    }
  }

  async function handleFreeText(chatId: number, text: string): Promise<void> {
    let parsed: { intent: string; params: Record<string, string> } = { intent: "unknown", params: {} };
    try {
      const res = await openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content: `You are the command router for Ileven Radar, an AI business-opportunity discovery agent for a tech company.
Classify the user message into one intent and extract parameters.

Intents:
- latest        → show latest opportunities
- hot           → show hot leads (score 80+)
- funding       → show startup funding
- tenders       → show government tenders
- websites      → show website projects
- mobileapps    → show mobile app projects
- search        → search by keyword (param: keyword)
- status        → show agent stats
- prospect      → scan one business type in a location (params: businessType, location)
- scan          → scan ALL business types in a location (param: location)
- help          → show help
- unknown       → can't match any intent

Return ONLY valid JSON: {"intent":"...","params":{}}`,
          },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        max_tokens: 80,
        temperature: 0,
      });
      parsed = JSON.parse(res.choices[0].message.content ?? "{}");
    } catch {
      // fall through to unknown
    }

    const { intent, params } = parsed;

    if (intent === "latest") {
      const opps = await queryOpportunities({ limit: 10 });
      await sendList(chatId, "🆕 Latest opportunities", opps);
    } else if (intent === "hot") {
      const opps = await queryOpportunities({ label: "HOT", limit: 10 });
      await sendList(chatId, "🔥 Hot leads", opps);
    } else if (intent === "funding") {
      const opps = await queryOpportunities({ category: "Startup Funding", limit: 10 });
      await sendList(chatId, "💰 Startup funding", opps);
    } else if (intent === "tenders") {
      const opps = await queryOpportunities({ category: "Government Tender", limit: 10 });
      await sendList(chatId, "🏛 Government tenders", opps);
    } else if (intent === "websites") {
      const opps = await queryOpportunities({ category: "Website Project", limit: 10 });
      await sendList(chatId, "🌐 Website projects", opps);
    } else if (intent === "mobileapps") {
      const opps = await queryOpportunities({ category: "Mobile App Project", limit: 10 });
      await sendList(chatId, "📱 Mobile app projects", opps);
    } else if (intent === "search" && params.keyword) {
      const opps = await queryOpportunities({ search: params.keyword, limit: 10 });
      await sendList(chatId, `🔎 Results for "${params.keyword}"`, opps);
    } else if (intent === "status") {
      const stats = await getStats();
      await b.sendMessage(chatId, [
        `<b>📡 Ileven Radar status</b>`,
        `Total opportunities: <b>${stats.total}</b>`,
        `🔥 Hot leads: <b>${stats.hot}</b>`,
        `🌤 Warm leads: <b>${stats.warm}</b>`,
        `🆕 New (last 24h): <b>${stats.today}</b>`,
        `Agent is running and scanning every hour.`,
      ].join("\n"), HTML);
    } else if ((intent === "scan" || intent === "prospect") && params.location) {
      const scanInput = params.businessType
        ? `${params.businessType} in ${params.location}`
        : params.location;
      await handleFreeTextScan(chatId, scanInput);
    } else if (intent === "help") {
      await b.sendMessage(chatId, HELP_TEXT, HTML);
    } else {
      await b.sendMessage(
        chatId,
        `🤖 I didn't quite get that. Here's what I can do:\n\n${HELP_TEXT}`,
        HTML
      );
    }
  }

  // Catch replies to force_reply prompts (edits + email address entry)
  // Also handles free-form text via AI intent classifier
  b.on("message", async (msg) => {
    if (!msg.text) return;
    const chatId = msg.chat.id;

    // Skip commands — already handled by onText handlers
    if (msg.text.startsWith("/")) return;

    // ---- Force-reply handling ----
    if (msg.reply_to_message) {
    const repliedMsgId = msg.reply_to_message.message_id;

    // ---- Handle edit body / edit subject replies ----
    const editKey = `${chatId}:${repliedMsgId}`;
    const pendingEdit = pendingEdits.get(editKey);
    if (pendingEdit) {
      pendingEdits.delete(editKey);
      const { draftId, action } = pendingEdit;
      const newValue = msg.text.trim();

      try {
        if (action === "subject") {
          await pool.query(`UPDATE email_outreach SET subject = $1 WHERE id = $2`, [newValue, draftId]);
        } else {
          const newHtml = plainToHtml(newValue);
          await pool.query(`UPDATE email_outreach SET plain_body = $1, html_body = $2 WHERE id = $3`, [newValue, newHtml, draftId]);
        }

        // Fetch the updated draft and show the full preview again
        const dr = await pool.query<{ to_email: string; subject: string; plain_body: string }>(
          `SELECT to_email, subject, plain_body FROM email_outreach WHERE id = $1`,
          [draftId]
        );
        if (dr.rows[0]) {
          const { to_email, subject, plain_body } = dr.rows[0];
          await b.sendMessage(chatId, `✅ ${action === "subject" ? "Subject" : "Body"} updated.`, HTML);
          await showEmailPreview(b, chatId, draftId, to_email, subject, plain_body);
        }
      } catch (err) {
        await b.sendMessage(chatId, `❌ Failed to update ${action}: ${esc((err as Error).message)}`, HTML);
      }
      return;
    }

    // ---- Handle email address entry (ask_email flow) ----
    const result = await pool.query<{ id: string; ref_type: string; ref_id: string }>(
      `SELECT id, ref_type, ref_id FROM email_outreach
       WHERE status = 'pending' AND to_email = '' AND telegram_chat_id = $1 AND telegram_msg_id = $2`,
      [chatId, repliedMsgId]
    );
    if (result.rows.length === 0) return;

    const { id, ref_type, ref_id } = result.rows[0];
    const emailInput = msg.text.trim();
    if (!/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(emailInput)) {
      await b.sendMessage(chatId, `❌ That doesn't look like a valid email address. Please try again.`, HTML);
      return;
    }

      await pool.query(`UPDATE email_outreach SET to_email = $1 WHERE id = $2`, [emailInput, id]);
      await pool.query(`DELETE FROM email_outreach WHERE id = $1`, [id]);
      await sendEmailApprovalRequest(chatId, ref_type as "prospect" | "opportunity", ref_id, emailInput, emailInput);
      return;
    } // end force-reply block

    // ---- Free-form text: AI intent router ----
    try {
      await handleFreeText(chatId, msg.text);
    } catch (err) {
      log.error({ err: (err as Error).message }, "Free-text handler failed");
      await b.sendMessage(chatId, `❌ Something went wrong. Try /help to see available commands.`, HTML);
    }
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
    { command: "prospect", description: "Scan one business type in a location" },
    { command: "scan", description: "Scan ALL business types in a location" },
  ]);

  log.info("Telegram bot started (long polling)");
}

export async function stopTelegramBot(): Promise<void> {
  if (bot) {
    await bot.stopPolling();
    bot = null;
  }
}
