import { Router, Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { env } from "../../config/env";
import { childLogger } from "../../config/logger";
import {
  getPendingCall,
  removePendingCall,
  handleMediaStream,
  getTranscript,
  removeTranscript,
  saveCallLog,
} from "../../services/callAgentService";

const log = childLogger("TwilioVoiceWebhook");

export function createVoiceWebhookRouter(): Router {
  const router = Router();

  // Twilio calls this when the prospect picks up — return TwiML to stream audio
  router.post("/twiml", (req: Request, res: Response) => {
    const callSid = (req.body.CallSid ?? "") as string;
    const publicHost = new URL(env.PUBLIC_URL).host;
    log.info({ callSid }, "TwiML requested");

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${publicHost}/ws/call?sid=${encodeURIComponent(callSid)}" />
  </Connect>
</Response>`;

    res.type("text/xml").send(twiml);
  });

  // Twilio status callbacks (ringing, answered, completed, etc.)
  router.post("/status", async (req: Request, res: Response) => {
    const callSid = (req.body.CallSid ?? "") as string;
    const status = (req.body.CallStatus ?? "unknown") as string;
    const duration = parseInt(req.body.CallDuration ?? "0", 10);
    const pending = getPendingCall(callSid);

    log.info({ callSid, status, duration }, "Call status update");

    if (status === "completed" || status === "failed" || status === "no-answer" || status === "busy" || status === "canceled") {
      if (pending) {
        const transcript = getTranscript(callSid);

        // Save to DB
        await saveCallLog(callSid, "prospect", "", pending.toPhone, pending.prospectName, status, duration, transcript, pending.chatId);

        // Send summary to Telegram
        try {
          const { getBot } = await import("../../telegram/bot");
          const bot = getBot();
          const { esc } = await import("../../telegram/format");

          const statusLabel: Record<string, string> = {
            completed: "✅ Completed",
            failed: "❌ Failed",
            "no-answer": "📵 No Answer",
            busy: "📵 Busy",
            canceled: "🚫 Canceled",
          };

          const lines = [
            `📞 <b>AI Call — ${esc(pending.prospectName)}</b>`,
            `${statusLabel[status] ?? status} · ${duration}s`,
            ``,
          ];

          if (transcript.length > 0) {
            lines.push(`<b>📝 Transcript</b>`);
            const truncated = transcript.slice(0, 30);
            lines.push(...truncated.map(esc));
            if (transcript.length > 30) lines.push(`<i>... (${transcript.length - 30} more lines)</i>`);
          } else {
            lines.push(`<i>No transcript available (call may not have connected)</i>`);
          }

          await bot.sendMessage(pending.chatId, lines.join("\n"), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });
        } catch (err) {
          log.error({ err: (err as Error).message }, "Failed to send call summary to Telegram");
        }

        removePendingCall(callSid);
        removeTranscript(callSid);
      }
    }

    res.sendStatus(200);
  });

  return router;
}

// Attach a WebSocket server to the HTTP server for Twilio media streaming
export function attachCallMediaStream(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws/call" });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const callSid = decodeURIComponent(url.searchParams.get("sid") ?? "");
    log.info({ callSid }, "Media stream WS connected");

    void handleMediaStream(ws, callSid);
  });

  log.info("Call media stream WebSocket server ready at /ws/call");
}
