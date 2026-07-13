import WebSocket from "ws";
import Twilio from "twilio";
import { env } from "../config/env";
import { childLogger } from "../config/logger";
import { pool } from "../db/pool";

const log = childLogger("CallAgent");

interface PendingCall {
  chatId: number;
  prospectName: string;
  systemPrompt: string;
  toPhone: string;
}

// callSid → pending call context (set before Twilio connects)
const pendingCalls = new Map<string, PendingCall>();

// callSid → transcript lines (built during media stream)
const callTranscripts = new Map<string, string[]>();

export function buildCallSystemPrompt(prospectName: string, pitchContext: string): string {
  return `You are a friendly, professional sales agent calling on behalf of ${env.COMPANY_NAME}.

${env.COMPANY_NAME} offers ${env.COMPANY_SERVICE}.

You are calling ${prospectName}. Here is the context:
${pitchContext}

Your goal:
1. Introduce yourself naturally — name, company, quick reason for calling.
2. Mention the specific thing you noticed about their business (from the context).
3. Deliver a short, compelling pitch (15–20 seconds max).
4. Ask one qualifying question to start a conversation.
5. If they're interested, book a 15-minute discovery call.
6. If they're not interested, thank them and end politely.

Important rules:
- Be warm, human, and conversational — not a robot reading a script.
- Keep the intro under 30 seconds.
- If they ask a question, answer it directly and honestly.
- Never make up pricing. Say you'll follow up with details.
- Respect a firm "not interested" — thank them and end the call gracefully.
- If they want to be called back later, confirm the best time.

Start the call now with your opening greeting.`;
}

export async function initiateCall(
  toPhone: string,
  prospectName: string,
  systemPrompt: string,
  chatId: number
): Promise<string> {
  const client = new (Twilio as unknown as { new(sid: string, token: string): Twilio.Twilio })(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_AUTH_TOKEN
  );

  const publicHost = new URL(env.PUBLIC_URL).host;

  const call = await (client as unknown as Twilio.Twilio).calls.create({
    to: toPhone,
    from: env.TWILIO_PHONE_NUMBER,
    url: `${env.PUBLIC_URL}/webhooks/twilio/voice/twiml`,
    statusCallback: `${env.PUBLIC_URL}/webhooks/twilio/voice/status`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
  });

  pendingCalls.set(call.sid, { chatId, prospectName, systemPrompt, toPhone });
  callTranscripts.set(call.sid, []);
  log.info({ sid: call.sid, to: toPhone }, "Outbound call initiated");
  return call.sid;
}

export function getPendingCall(callSid: string): PendingCall | undefined {
  return pendingCalls.get(callSid);
}

export function removePendingCall(callSid: string): void {
  pendingCalls.delete(callSid);
}

export function getTranscript(callSid: string): string[] {
  return callTranscripts.get(callSid) ?? [];
}

export function removeTranscript(callSid: string): void {
  callTranscripts.delete(callSid);
}

// Bridge Twilio media stream ↔ OpenAI Realtime API
export async function handleMediaStream(
  twilioWs: WebSocket,
  callSid: string
): Promise<void> {
  const pending = pendingCalls.get(callSid);
  if (!pending) {
    log.warn({ callSid }, "No pending call — closing media stream");
    twilioWs.close();
    return;
  }

  const { systemPrompt } = pending;
  const transcript = callTranscripts.get(callSid) ?? [];

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let streamSid = "";
  let openaiReady = false;
  const audioQueue: string[] = [];

  openaiWs.on("open", () => {
    openaiReady = true;
    log.info({ callSid }, "OpenAI Realtime connected");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: systemPrompt,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", silence_duration_ms: 700, threshold: 0.5 },
        voice: "shimmer",
      },
    }));

    // Flush queued audio
    for (const payload of audioQueue) {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
    }
    audioQueue.length = 0;

    // Trigger the AI to speak first
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  });

  // Twilio → OpenAI
  twilioWs.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        event: string;
        start?: { streamSid: string };
        media?: { payload: string };
      };

      if (msg.event === "start" && msg.start) {
        streamSid = msg.start.streamSid;
        log.info({ callSid, streamSid }, "Twilio stream started");
      } else if (msg.event === "media" && msg.media) {
        if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        } else {
          audioQueue.push(msg.media.payload);
        }
      } else if (msg.event === "stop") {
        log.info({ callSid }, "Twilio stream stopped");
        if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      }
    } catch { /* ignore */ }
  });

  // OpenAI → Twilio
  openaiWs.on("message", (raw: Buffer) => {
    try {
      const event = JSON.parse(raw.toString()) as {
        type: string;
        delta?: string;
        transcript?: string;
        item?: { role?: string };
      };

      if (event.type === "response.audio.delta" && event.delta && streamSid) {
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: event.delta } }));
        }
      } else if (event.type === "response.audio_transcript.done" && event.transcript) {
        transcript.push(`🤖 Agent: ${event.transcript}`);
      } else if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
        transcript.push(`👤 Prospect: ${event.transcript}`);
      }
    } catch { /* ignore */ }
  });

  openaiWs.on("error", (err) => {
    log.error({ callSid, err: err.message }, "OpenAI WS error");
  });

  twilioWs.on("close", () => {
    log.info({ callSid }, "Twilio WS closed");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on("error", (err) => {
    log.error({ callSid, err: err.message }, "Twilio WS error");
  });
}

export async function saveCallLog(
  callSid: string,
  refType: string,
  refId: string,
  toPhone: string,
  prospectName: string,
  status: string,
  durationSeconds: number,
  transcript: string[],
  chatId: number
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO call_logs (call_sid, ref_type, ref_id, to_phone, prospect_name, status, duration_seconds, transcript, telegram_chat_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (call_sid) DO UPDATE SET status=$6, duration_seconds=$7, transcript=$8, completed_at=now()`,
      [callSid, refType, refId, toPhone, prospectName, status, durationSeconds, transcript.join("\n"), chatId]
    );
  } catch (err) {
    log.error({ err: (err as Error).message }, "Failed to save call log");
  }
}
