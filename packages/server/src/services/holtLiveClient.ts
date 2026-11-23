/**
 * holt-live's agent sessions (#wg-runtime-form:#22; raft-deck
 * packages/holt-live/README.md "Agent sessions"): Raft asks holt-live to put
 * a realtime voice model into a LiveKit room as the agent, and signs the
 * caller's room token. The audio never passes through Raft.
 *
 * Deployment config: `HOLT_LIVE_URL` (the API origin) and `HOLT_LIVE_API_TOKEN`
 * (a `raft-call` project token with `voice:agents`). Either missing: calls are
 * not available here, nothing else changes. The token is never logged or
 * returned, and an error never carries holt-live's response text.
 */
import { AGENT_VOICE_CALL_MAX_MINUTES } from "@botiverse/raft-shared";

export type HoltLiveConfig = { baseUrl: string; token: string };

export function resolveHoltLiveConfig(env: NodeJS.ProcessEnv = process.env): HoltLiveConfig | null {
  const token = env.HOLT_LIVE_API_TOKEN?.trim();
  const raw = env.HOLT_LIVE_URL?.trim();
  if (!token || !raw || /\s/.test(token)) return null;
  try {
    const url = new URL(raw);
    // The token and every call's callback secret travel to it: https, except a local holt-live.
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return { baseUrl: url.origin, token };
  } catch {
    return null;
  }
}

/** A failed holt-live request: its HTTP status (0 when none came back) and error code, never its text. */
export class HoltLiveError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`holt-live answered ${status || "nothing"}${code ? ` (${code})` : ""}`);
    this.name = "HoltLiveError";
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

export type HoltLiveTransport = typeof fetch;

export type HoltLiveClient = {
  issueRoomToken(input: { room: string; identity: string; name: string; ttlSeconds: number }): Promise<{ url: string; token: string; expiresAtMs: number; relay?: string }>;
  startSession(input: HoltLiveSessionStart): Promise<{ sessionId: string }>;
  say(sessionId: string, input: { text: string; callId: string }): Promise<"said" | "ended">;
  /** `gone`: holt-live no longer knows the session (it already ended). */
  stop(sessionId: string, reason: string): Promise<"stopped" | "gone">;
};

export type HoltLiveTool = { name: string; description: string; parameters: Record<string, unknown> };

export type HoltLiveSessionStart = {
  room: string;
  agent: { id: string; name: string; avatar?: string };
  listen: Array<{ identity: string; name?: string }>;
  instructions: string;
  tools: HoltLiveTool[];
  callback: { url: string; secret: string };
  /** Publish the call's captions into the room as data messages (topic "caption"); holt-live's default is off. */
  captions?: boolean;
};

export function createHoltLiveClient(config: HoltLiveConfig, transport: HoltLiveTransport = fetch): HoltLiveClient {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    let response: Response;
    try {
      response = await transport(`${config.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new HoltLiveError(0, null);
    }
    const json = await response.json().then((v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null), () => null);
    return { status: response.status, json };
  }
  function fail(result: { status: number; json: Record<string, unknown> | null }): never {
    const code = typeof result.json?.code === "string" ? result.json.code.slice(0, 64) : null;
    throw new HoltLiveError(result.status, code);
  }
  return {
    async issueRoomToken(input) {
      const result = await call("POST", `/v1/rooms/${encodeURIComponent(input.room)}/tokens`, {
        identity: input.identity,
        name: input.name,
        ttl_s: input.ttlSeconds,
      });
      const json = result.json;
      if (result.status !== 200 && result.status !== 201) fail(result);
      if (typeof json?.url !== "string" || typeof json.token !== "string" || typeof json.expiresAt !== "number") throw new HoltLiveError(result.status, "malformed_reply");
      return { url: json.url, token: json.token, expiresAtMs: json.expiresAt, ...(typeof json.relay === "string" ? { relay: json.relay } : {}) };
    },
    async startSession(input) {
      const result = await call("POST", "/v1/agents/sessions", { ...input, max_minutes: AGENT_VOICE_CALL_MAX_MINUTES });
      if (result.status !== 200 && result.status !== 201) fail(result);
      const sessionId = result.json?.session_id;
      if (typeof sessionId !== "string" || !sessionId) throw new HoltLiveError(result.status, "malformed_reply");
      return { sessionId };
    },
    async say(sessionId, input) {
      const result = await call("POST", `/v1/agents/sessions/${encodeURIComponent(sessionId)}/say`, { text: input.text, call_id: input.callId });
      if (result.status === 409) return "ended";
      if (result.status < 200 || result.status >= 300) fail(result);
      return "said";
    },
    async stop(sessionId, reason) {
      const result = await call("POST", `/v1/agents/sessions/${encodeURIComponent(sessionId)}/stop`, { reason });
      if (result.status === 404 || result.status === 409) return "gone";
      if (result.status < 200 || result.status >= 300) fail(result);
      return "stopped";
    },
  };
}
