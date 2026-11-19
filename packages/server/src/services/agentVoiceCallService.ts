/**
 * Raft voice calls (#wg-runtime-form:#22, design v6): a person calls an agent.
 * A holt-live agent session speaks as the agent in a LiveKit room the
 * person's browser joins; Raft never carries the audio.
 *
 * Who may call: the flag on, a non-guest who may DM the agent and read its
 * status (the call opens with it), and the agent's editors have not turned
 * calling off (`voice_callable`). Every refusal of that kind is the
 * unknown-agent `not_found`. Each person has a call budget per agent and per
 * day (AGENT_VOICE_CALL_LIMITS), and a call lasts at most
 * AGENT_VOICE_CALL_MAX_MINUTES.
 *
 * During the call the voice model has two tools:
 * - `ask_agent`: one side question to the agent itself, under the side
 *   question's own rules (prepareVoiceAsk: View Context, `voice_askable`, its
 *   budgets and record). Answered within ASK_AGENT_SYNC_MS, or `queued` and
 *   said later (holt-live `say`); a call that ended meanwhile gets the answer
 *   as a DM from the agent.
 * - `tell_user`: a DM from the agent to the caller (a link, a written note).
 *
 * holt-live's callbacks are signed with the call's own secret (Standard
 * Webhooks), which only this row holds (encrypted). The final sentences are
 * kept on the row while the call runs; when it ends they are posted into the
 * caller's DM with the agent as the call's record, marked as transcribed (not
 * the agent's own words) and escaped so no line can pose as another speaker,
 * and cleared here. The opening status is read as a status ask, so the
 * editors' `voice_askable` switch and the status budget hold for calls too.
 */
import { randomBytes } from "node:crypto";
import {
  AGENT_SIDE_ASK_QUESTION_MAX_CHARS,
  AGENT_VOICE_CALL_MAX_MINUTES,
  AGENT_VOICE_FEATURE_FLAG_KEY,
  asAgentVoiceCallId,
  mintAgentVoiceCallId,
  type AgentVoiceCallId,
  isExternalAgentRuntime,
  type AgentVoiceCallRefusalCode,
  type AgentVoiceCallStarted,
} from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index";
import { agentVoiceCalls } from "../db/schema";
import { getActorServerRoleInServer, roleCanReadAgentVoiceStatus } from "../lib/actorPermissions";
import { verifyStandardWebhook, type StandardWebhookHeaders } from "../lib/standardWebhooks";
import { getRedis, isRedisAvailable } from "../redis";
import { addTraceEvent } from "../tracing/semanticTrace";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { isAgentFindableBy } from "./agentMemberListPolicy";
import { getRaftOrigin } from "./agentRuntimeProviderService";
import * as agentService from "./agentService";
import { admitVoiceCall, prepareVoiceAsk } from "./agentVoiceService";
import { AppWebhookConfigError, decryptWebhookSigningSecret, encryptWebhookSigningSecret } from "./appWebhookConfigService";
import * as channelService from "./channelService";
import { checkDirectMessageOpen } from "./directMessageOpenService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { createHoltLiveClient, HoltLiveError, resolveHoltLiveConfig, type HoltLiveClient, type HoltLiveTool } from "./holtLiveClient";
import * as messageService from "./messageService";
import * as userService from "./userService";

/** How long a room token admits (holt-live allows 60-600 s); the browser renews it. */
const ROOM_TOKEN_TTL_SECONDS = 600;
/** holt-live answers `queued` for us after 8 s; answer before it. */
const ASK_AGENT_SYNC_MS = 7_000;
let askAgentSyncMs = ASK_AGENT_SYNC_MS;
const TRANSCRIPT_MAX_LINES = 500;
const TRANSCRIPT_LINE_MAX_CHARS = 2_000;
const TELL_USER_MAX_CHARS = 4_000;
const DEDUPE_TTL_SECONDS = 15 * 60;

let clientOverride: HoltLiveClient | null | undefined;

function holtLive(): HoltLiveClient | null {
  if (clientOverride !== undefined) return clientOverride;
  const config = resolveHoltLiveConfig();
  return config ? createHoltLiveClient(config) : null;
}

/** Test seam: the holt-live client calls use (null: not configured); undefined restores the environment's. */
export function setHoltLiveClientForTests(client: HoltLiveClient | null | undefined): void {
  clientOverride = client;
}

/** Test seam: how long a tool call waits for the agent's answer before `queued`; undefined restores it. */
export function setAskAgentSyncMsForTests(ms: number | undefined): void {
  askAgentSyncMs = ms ?? ASK_AGENT_SYNC_MS;
}

export type AgentVoiceCallStartResult =
  | { ok: true; started: AgentVoiceCallStarted }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; code: AgentVoiceCallRefusalCode };

type Deps = { orchestrator: AgentOrchestrator; io: SocketServer };

const TOOLS: HoltLiveTool[] = [
  {
    name: "ask_agent",
    description: "Ask the real agent one question about its work, files, decisions or anything you do not know from these instructions. It answers from its own session; it may take a while.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "One clear, self-contained question." } },
      required: ["question"],
    },
  },
  {
    name: "tell_user",
    description: "Send the caller a written message from the agent in their DM: a link, a list, anything better read than heard.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The message, in Markdown." } },
      required: ["text"],
    },
  },
];

/** The checks every call route makes: the agent the person may call, or null (the unknown-agent 404). */
async function callableAgent(serverId: string, userId: string, agentId: string) {
  const flag = await evaluateFeatureFlag({ key: AGENT_VOICE_FEATURE_FLAG_KEY, serverId, userId });
  if (!flag.enabled) return null;
  const agent = await agentService.getAgent(agentId).catch(() => null);
  if (!agent || agent.serverId !== serverId || !isAgentFindableBy({ userId }, agent) || !agent.voiceCallable) return null;
  const role = await getActorServerRoleInServer(serverId, "user", userId);
  if (!role || role === "guest" || !roleCanReadAgentVoiceStatus(role, userId, agent)) return null;
  const dm = await checkDirectMessageOpen(serverId, userId, { agentId });
  return dm.ok ? agent : null;
}

/**
 * What the agent is doing now, for the call's opening instructions: read as
 * a status ask (prepareVoiceAsk), so the editors' `voice_askable` switch and
 * the status budget hold. Asking turned off or over budget: no status, and
 * the Computer is not asked. `offline`: the Computer answered that the agent
 * isn't running, or did not answer.
 */
async function openingStatus(deps: Deps, serverId: string, userId: string, agentId: string): Promise<{ text: string | null } | "offline"> {
  const prepared = await prepareVoiceAsk({ orchestrator: deps.orchestrator, serverId, userId, agentId, ask: { kind: "status" } });
  if (!prepared.ok) return { text: null };
  const result = await prepared.ask();
  if (result.outcome === "answered") return { text: result.text ?? null };
  if (result.outcome === "agent_not_running" || result.outcome === "computer_offline" || result.outcome === "computer_upgrade_required") return "offline";
  return { text: null };
}

export async function startAgentVoiceCall(input: Deps & { serverId: string; userId: string; agentId: string }): Promise<AgentVoiceCallStartResult> {
  const { serverId, userId, agentId } = input;
  const trace = (outcome: string, extra: Record<string, string | number> = {}) => addTraceEvent("agent.voice_call_start", {
    agent_id: agentId, server_id: serverId, user_id: userId, outcome, ...extra,
  });
  const agent = await callableAgent(serverId, userId, agentId);
  if (!agent) {
    trace("not_found");
    return { ok: false, code: "not_found" };
  }
  const client = holtLive();
  const origin = getRaftOrigin();
  if (!client || !origin) {
    trace("unavailable");
    return { ok: false, code: "voice_call_unavailable" };
  }
  if (isExternalAgentRuntime(agent.runtime)) {
    trace("unsupported_runtime");
    return { ok: false, code: "unsupported_runtime" };
  }
  await expireStaleCalls(input, agent.id);
  const admission = await admitVoiceCall(userId, agent.id);
  if (!admission.admitted) {
    trace("rate_limited");
    return { ok: false, code: "rate_limited", retryAfterSeconds: admission.retryAfterSeconds };
  }
  const status = await openingStatus(input, serverId, userId, agent.id);
  if (status === "offline") {
    trace("agent_offline");
    return { ok: false, code: "agent_offline" };
  }

  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  let encrypted;
  try {
    encrypted = encryptWebhookSigningSecret(secret);
  } catch (error) {
    if (!(error instanceof AppWebhookConfigError)) throw error;
    trace("unavailable");
    return { ok: false, code: "voice_call_unavailable" };
  }
  const callId = mintAgentVoiceCallId();
  await getDb().insert(agentVoiceCalls).values({
    id: callId,
    serverId,
    agentId: agent.id,
    callerUserId: userId,
    secretCiphertext: encrypted.ciphertext,
    secretIv: encrypted.iv,
    secretAuthTag: encrypted.authTag,
  });
  const user = await userService.getUser(userId);
  const callerName = user?.displayName || user?.name || "someone";
  const agentName = agent.displayName || agent.name;
  let room: Awaited<ReturnType<HoltLiveClient["issueRoomToken"]>>;
  let sessionId: string;
  try {
    room = await client.issueRoomToken({ room: roomOf(callId), identity: identityOf(userId), name: callerName, ttlSeconds: ROOM_TOKEN_TTL_SECONDS });
    ({ sessionId } = await client.startSession({
      room: roomOf(callId),
      agent: { id: `agent:${serverId}:${agent.id}`, name: agentName, ...(agent.avatarUrl?.startsWith("https://") ? { avatar: agent.avatarUrl } : {}) },
      listen: [{ identity: identityOf(userId), name: callerName }],
      instructions: instructionsFor({ agentName, description: agent.description, callerName, status: status.text }),
      tools: TOOLS,
      callback: { url: `${origin}/api/webhooks/holt-live/calls/${callId}`, secret },
    }));
  } catch (error) {
    if (!(error instanceof HoltLiveError)) throw error;
    // No answer at all (status 0): the session may exist, and its callbacks
    // (which bind it) will settle the row; otherwise the stale sweep does.
    if (error.status !== 0) await finishCall(input, callId, "failed", `start_failed_${error.status}`, null);
    trace("unavailable", { holt_status: error.status, ...(error.code ? { holt_code: error.code } : {}) });
    return { ok: false, code: "voice_call_unavailable" };
  }
  // A callback may have bound the session first; either way, a call that already ended is no call.
  const [bound] = await getDb().update(agentVoiceCalls).set({ sessionId: sql`coalesce(${agentVoiceCalls.sessionId}, ${sessionId})` })
    .where(and(eq(agentVoiceCalls.id, callId), inArray(agentVoiceCalls.state, ["starting", "live"])))
    .returning({ id: agentVoiceCalls.id });
  if (!bound) {
    trace("ended_before_start");
    return { ok: false, code: "voice_call_unavailable" };
  }
  trace("started");
  return { ok: true, started: { callId, room: grantOf(room) } };
}

/**
 * The caller's own call, for the routes below; null is the unknown-agent 404.
 * Renewing a token rechecks that the person may still call; hanging up never
 * needs more than being the caller.
 */
async function callersCall(input: { serverId: string; userId: string; agentId: string; callId: string }, recheck: boolean) {
  const { serverId, userId, agentId } = input;
  const id = asAgentVoiceCallId(input.callId);
  if (!id || (recheck && !await callableAgent(serverId, userId, agentId))) return null;
  const [call] = await getDb().select().from(agentVoiceCalls).where(and(
    eq(agentVoiceCalls.id, id),
    eq(agentVoiceCalls.serverId, serverId),
    eq(agentVoiceCalls.agentId, agentId),
    eq(agentVoiceCalls.callerUserId, userId),
  )).limit(1);
  return call ?? null;
}

/** A fresh room token for the caller's running call (the browser renews before it expires). */
export async function renewAgentVoiceCallToken(input: { serverId: string; userId: string; agentId: string; callId: string }): Promise<AgentVoiceCallStarted | null> {
  const call = await callersCall(input, true);
  const client = holtLive();
  if (!call || !client || (call.state !== "starting" && call.state !== "live")) return null;
  const user = await userService.getUser(input.userId);
  const room = await client.issueRoomToken({
    room: roomOf(call.id),
    identity: identityOf(input.userId),
    name: user?.displayName || user?.name || "someone",
    ttlSeconds: ROOM_TOKEN_TTL_SECONDS,
  });
  return { callId: call.id, room: grantOf(room) };
}

/**
 * The caller hangs up: holt-live stops the session, and its `ended` callback
 * finishes the call. A call with no session yet, or one holt-live no longer
 * knows, is finished here.
 */
export async function hangUpAgentVoiceCall(deps: Deps, input: { serverId: string; userId: string; agentId: string; callId: string }): Promise<boolean> {
  const call = await callersCall(input, false);
  if (!call) return false;
  if (call.state !== "starting" && call.state !== "live") return true;
  const client = holtLive();
  const stopped = call.sessionId && client ? await client.stop(call.sessionId, "caller_hung_up") : "gone";
  if (stopped === "gone") await finishCall(deps, call.id, "ended", "caller_hung_up", null);
  return true;
}

/** A call older than its longest length plus a margin that never heard its end (the stale sweep, run before a new call to the agent). */
const STALE_CALL_MS = (AGENT_VOICE_CALL_MAX_MINUTES + 5) * 60_000;

async function expireStaleCalls(deps: Deps, agentId: string): Promise<void> {
  const stale = await getDb().select({ id: agentVoiceCalls.id }).from(agentVoiceCalls).where(and(
    eq(agentVoiceCalls.agentId, agentId),
    inArray(agentVoiceCalls.state, ["starting", "live"]),
    lt(agentVoiceCalls.createdAt, new Date(Date.now() - STALE_CALL_MS)),
  )).limit(10);
  for (const row of stale) await finishCall(deps, row.id, "failed", "expired", null);
}

export type CallbackAnswer = { status: number; body: Record<string, unknown> };

type CallbackEvent =
  | { type: "tool_call"; sessionId: string; callId: string; name: string; args: Record<string, unknown> }
  | { type: "transcript"; sessionId: string; role: "user" | "agent"; text: string; at: string | null }
  | { type: "lifecycle"; sessionId: string; event: "started" }
  | { type: "lifecycle"; sessionId: string; event: "ended"; reason: string; durationS: number | null }
  | { type: "lifecycle"; sessionId: string; event: "error"; code: string };

const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** holt-live's callback body, narrowed once; null for anything else. */
function parseCallbackEvent(payload: Buffer): CallbackEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const sessionId = typeof e.session_id === "string" ? e.session_id : "";
  if (!sessionId) return null;
  const code = (value: unknown) => (typeof value === "string" && CODE.test(value) ? value : "unknown");
  if (e.type === "tool_call") {
    const args = e.args && typeof e.args === "object" && !Array.isArray(e.args) ? e.args as Record<string, unknown> : {};
    return { type: "tool_call", sessionId, callId: typeof e.call_id === "string" ? e.call_id.slice(0, 128) : "", name: typeof e.name === "string" ? e.name : "", args };
  }
  if (e.type === "transcript") {
    const text = typeof e.text === "string" ? e.text.replace(/\s+/g, " ").trim().slice(0, TRANSCRIPT_LINE_MAX_CHARS) : "";
    return { type: "transcript", sessionId, role: e.role === "agent" ? "agent" : "user", text, at: typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : null };
  }
  if (e.type === "lifecycle") {
    if (e.event === "started") return { type: "lifecycle", sessionId, event: "started" };
    if (e.event === "ended") {
      const durationS = typeof e.duration_s === "number" && Number.isFinite(e.duration_s) ? Math.max(0, Math.round(e.duration_s)) : null;
      return { type: "lifecycle", sessionId, event: "ended", reason: code(e.reason), durationS };
    }
    if (e.event === "error") return { type: "lifecycle", sessionId, event: "error", code: code(e.code) };
  }
  return null;
}

/**
 * One holt-live callback for a call (POST /api/webhooks/holt-live/calls/:callId):
 * verified against the call's own secret, then a tool call, a final sentence
 * or a lifecycle event. Anything unverifiable is the same 404 as an unknown
 * call. A webhook id is handled once: it is claimed before and released if
 * handling throws, so holt-live's retry of a failed `ended` is handled again.
 */
export async function handleAgentVoiceCallCallback(input: Deps & {
  callId: string;
  payload: Buffer;
  headers: StandardWebhookHeaders;
}): Promise<CallbackAnswer> {
  const receivedAt = Date.now();
  const notFound: CallbackAnswer = { status: 404, body: { code: "call_not_found" } };
  const id = asAgentVoiceCallId(input.callId);
  if (!id) return notFound;
  const [call] = await getDb().select().from(agentVoiceCalls).where(eq(agentVoiceCalls.id, id)).limit(1);
  if (!call) return notFound;
  const secret = decryptWebhookSigningSecret({ ciphertext: call.secretCiphertext, iv: call.secretIv, authTag: call.secretAuthTag });
  const webhookId = verifyStandardWebhook(input.payload, input.headers, secret, receivedAt);
  if (!webhookId) return notFound;
  const event = parseCallbackEvent(input.payload);
  if (!event) return { status: 400, body: { code: "invalid_callback" } };
  // Signed with this call's own secret, so its session: the first one seen binds it.
  if (call.sessionId && event.sessionId !== call.sessionId) return notFound;
  if (!call.sessionId) {
    await getDb().update(agentVoiceCalls).set({ sessionId: event.sessionId })
      .where(and(eq(agentVoiceCalls.id, call.id), isNull(agentVoiceCalls.sessionId)));
  }
  const claim = await claimDelivery(webhookId);
  if (claim === "seen") return { status: 200, body: {} };
  try {
    return await handleEvent(input, { ...call, sessionId: event.sessionId }, event, webhookId, receivedAt);
  } catch (error) {
    if (claim === "claimed") await releaseDelivery(webhookId);
    throw error;
  }
}

type CallRow = typeof agentVoiceCalls.$inferSelect;

async function handleEvent(deps: Deps, call: CallRow, event: CallbackEvent, webhookId: string, receivedAt: number): Promise<CallbackAnswer> {
  const trace = (outcome: string, extra: Record<string, string | number> = {}) => addTraceEvent("agent.voice_call_callback", {
    call_id: call.id, agent_id: call.agentId, server_id: call.serverId, type: event.type, outcome, ...extra,
  });
  const running = call.state === "starting" || call.state === "live";

  if (event.type === "transcript") {
    if (event.text) {
      const line = { role: event.role, text: event.text, at: event.at ?? new Date(receivedAt).toISOString() };
      await getDb().update(agentVoiceCalls)
        .set({ transcript: sql`${agentVoiceCalls.transcript} || jsonb_build_array(${JSON.stringify(line)}::jsonb)` })
        .where(and(
          eq(agentVoiceCalls.id, call.id),
          inArray(agentVoiceCalls.state, ["starting", "live"]),
          sql`jsonb_array_length(${agentVoiceCalls.transcript}) < ${TRANSCRIPT_MAX_LINES}`,
        ));
    }
    return { status: 200, body: {} };
  }

  if (event.type === "lifecycle") {
    if (event.event === "started") {
      await getDb().update(agentVoiceCalls).set({ state: "live" }).where(and(eq(agentVoiceCalls.id, call.id), eq(agentVoiceCalls.state, "starting")));
      trace("live");
    } else if (event.event === "ended") {
      await finishCall(deps, call.id, "ended", event.reason, event.durationS);
      trace("ended", { reason: event.reason, ...(event.durationS !== null ? { duration_s: event.durationS } : {}) });
    } else {
      await finishCall(deps, call.id, "failed", event.code, null);
      trace("failed", { reason: event.code });
    }
    return { status: 200, body: {} };
  }

  if (!running) return { status: 200, body: { result: { error: "The call has ended." } } };
  if (event.name === "tell_user") {
    const text = typeof event.args.text === "string" ? event.args.text.trim().slice(0, TELL_USER_MAX_CHARS) : "";
    if (!text) return { status: 200, body: { result: { error: "Nothing to send." } } };
    await postAsAgent(deps, call, `📞 *Sent during our voice call:*\n\n${text}`, `voice-call:${call.id}:tell:${event.callId || webhookId}`);
    trace("told");
    return { status: 200, body: { result: { sent: true } } };
  }
  if (event.name === "ask_agent") {
    const question = typeof event.args.question === "string" ? event.args.question.trim().slice(0, AGENT_SIDE_ASK_QUESTION_MAX_CHARS) : "";
    if (!question) return { status: 200, body: { result: { error: "Ask one question." } } };
    const answer = await askDuringCall(deps, call, question, event.callId || webhookId, receivedAt);
    trace(answer ? "answered" : "queued");
    return { status: 200, body: answer ? { result: answer } : { queued: true } };
  }
  return { status: 200, body: { result: { error: "Unknown tool." } } };
}

/**
 * A side question from the call, as the caller (prepareVoiceAsk's rules,
 * budgets and record). Answered within the tool call's budget, counted from
 * when the callback arrived: the result. Otherwise queued, and the answer is
 * said when it comes; if it cannot be said (the call ended, or holt-live
 * failed), it is sent as a DM.
 */
async function askDuringCall(deps: Deps, call: CallRow, question: string, toolCallId: string, receivedAt: number): Promise<Record<string, unknown> | null> {
  const prepared = await prepareVoiceAsk({
    orchestrator: deps.orchestrator,
    serverId: call.serverId,
    userId: call.callerUserId,
    agentId: call.agentId,
    ask: { kind: "question", question },
  });
  if (!prepared.ok) {
    return { error: prepared.code === "rate_limited" ? "Too many questions to the agent; try again later." : "The agent can't be asked that on this call." };
  }
  const pending = prepared.ask().then((r) => answerText(r.outcome, r.text), () => "The agent couldn't answer that right now.");
  let timer: NodeJS.Timeout | undefined;
  const late = Symbol("late");
  const waitMs = Math.max(0, receivedAt + askAgentSyncMs - Date.now());
  let first: string | typeof late;
  try {
    first = await Promise.race([pending, new Promise<typeof late>((resolve) => { timer = setTimeout(() => resolve(late), waitMs); })]);
  } finally {
    clearTimeout(timer);
  }
  if (first !== late) return { answer: first };
  void pending.then(async (text) => {
    const [now] = await getDb().select({ state: agentVoiceCalls.state, sessionId: agentVoiceCalls.sessionId }).from(agentVoiceCalls).where(eq(agentVoiceCalls.id, call.id)).limit(1);
    const client = holtLive();
    let said: "said" | "ended" | "failed" = "ended";
    if (now?.sessionId && client && (now.state === "starting" || now.state === "live")) {
      said = await client.say(now.sessionId, { text, callId: toolCallId }).catch(() => "failed" as const);
    }
    if (said !== "said") await postAsAgent(deps, call, `📞 *You asked on our voice call:* ${quoteLine(question)}\n\n${text}`, `voice-call:${call.id}:late:${toolCallId}`);
  }).catch((error: unknown) => {
    addTraceEvent("agent.voice_call_late_answer", { call_id: call.id, outcome: error instanceof HoltLiveError ? `holt_${error.status}` : "error" });
  });
  return null;
}

function answerText(outcome: string, text: string | undefined): string {
  if (outcome === "answered" && text) return text;
  if (outcome === "agent_not_running" || outcome === "computer_offline") return "The agent isn't running right now, so it can't answer.";
  if (outcome === "usage_limited") return "The agent is at its usage limit and can't answer now.";
  return "The agent couldn't answer that right now.";
}

/**
 * The call is over: record how it ended (once; a later `ended` still fills a
 * missing duration), then post its record into the caller's DM. The
 * sentences are cleared only after the record is posted, so a retry after a
 * failed post posts it again (its send key keeps it to one message).
 */
async function finishCall(deps: Deps, callId: AgentVoiceCallId, state: "ended" | "failed", reason: string, durationS: number | null): Promise<void> {
  const row = await getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(agentVoiceCalls).where(eq(agentVoiceCalls.id, callId)).for("update").limit(1);
    if (!locked) return null;
    if (locked.state === "starting" || locked.state === "live") {
      const [updated] = await tx.update(agentVoiceCalls)
        .set({ state, endReason: reason, durationS, endedAt: new Date() })
        .where(eq(agentVoiceCalls.id, callId)).returning();
      return updated ?? null;
    }
    if (locked.durationS === null && durationS !== null) {
      const [updated] = await tx.update(agentVoiceCalls).set({ durationS }).where(eq(agentVoiceCalls.id, callId)).returning();
      return updated ?? null;
    }
    return locked;
  });
  if (!row || row.recordPostedAt) return;
  // A call nobody spoke on and that never ran (a failed start, a hang-up before it began) leaves no record.
  if (row.transcript.length === 0 && row.durationS === null) {
    await getDb().update(agentVoiceCalls).set({ recordPostedAt: new Date() }).where(eq(agentVoiceCalls.id, callId));
    return;
  }
  const agent = await agentService.getAgent(row.agentId).catch(() => null);
  const caller = await userService.getUser(row.callerUserId);
  const names = { user: caller?.displayName || caller?.name || "Caller", agent: agent?.displayName || agent?.name || "Agent" };
  const heading = `📞 *Voice call record${row.durationS !== null ? ` · ${formatDuration(row.durationS)}` : ""}${row.state === "failed" ? " · ended by an error" : ""}. Transcribed automatically: the caller's words and the voice model's, not written by ${escapeMarkdown(names.agent)}.*`;
  const lines = row.transcript.map((line) => `> **${escapeMarkdown(names[line.role])}:** ${quoteLine(line.text)}`);
  await postAsAgent(deps, row, [heading, ...lines].join("\n\n"), `voice-call:${callId}:record`);
  await getDb().update(agentVoiceCalls).set({ recordPostedAt: new Date(), transcript: [] }).where(eq(agentVoiceCalls.id, callId));
}

const MARKDOWN_SPECIAL = /[\\`*_[\]<>#|~]/g;

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, (c) => `\\${c}`);
}

/** One spoken sentence, on one line and with no markup of its own (it cannot pose as another speaker). */
function quoteLine(text: string): string {
  return escapeMarkdown(text.replace(/\s+/g, " ").trim());
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

/**
 * A message from the agent in the caller's DM with it, while the caller may
 * still DM the agent (a person removed meanwhile gets nothing). The send key
 * makes a retry post it once. It carries the call's id (`voice_call_id`): the
 * voice model wrote it, steered by the caller, so the agent reads it as
 * `posted_by=voice_call`, never as something it said.
 */
async function postAsAgent(deps: Deps, call: Pick<CallRow, "id" | "serverId" | "agentId" | "callerUserId">, content: string, sendKey: string): Promise<void> {
  const allowed = await checkDirectMessageOpen(call.serverId, call.callerUserId, { agentId: call.agentId });
  if (!allowed.ok) return;
  const dm = await channelService.findOrCreateDM(call.serverId, call.callerUserId, call.agentId);
  const agent = await agentService.getAgent(call.agentId).catch(() => null);
  if (!dm || !agent) return;
  // slack-bridge-ordinary-message-producer: agent_voice_call.dm
  await messageService.broadcastAndDeliver(deps.io, deps.orchestrator, {
    channelId: dm.id,
    senderType: "agent",
    senderId: call.agentId,
    senderName: agent.displayName || agent.name,
    content,
    agentSendKey: sendKey,
    voiceCallId: call.id,
  });
}

/**
 * Claims a webhook id (holt-live retries `ended` and `error` with the same
 * one). `seen`: handled or being handled. Without Redis every delivery is
 * handled; the state checks and send keys keep a retry harmless.
 */
async function claimDelivery(webhookId: string): Promise<"claimed" | "seen" | "unclaimed"> {
  if (!isRedisAvailable()) return "unclaimed";
  try {
    return await getRedis().set(dedupeKey(webhookId), "1", "EX", DEDUPE_TTL_SECONDS, "NX") === "OK" ? "claimed" : "seen";
  } catch {
    return "unclaimed";
  }
}

async function releaseDelivery(webhookId: string): Promise<void> {
  await getRedis().del(dedupeKey(webhookId)).catch(() => undefined);
}

function dedupeKey(webhookId: string): string {
  return `slock:agent-voice-call:webhook:${webhookId}`;
}

function roomOf(callId: string): string {
  return `raft-call-${callId}`;
}

function identityOf(userId: string): string {
  return `u${userId}`;
}

function grantOf(room: { url: string; token: string; expiresAtMs: number; relay?: string }): AgentVoiceCallStarted["room"] {
  return { url: room.url, token: room.token, expiresAt: new Date(room.expiresAtMs).toISOString(), ...(room.relay ? { relay: room.relay } : {}) };
}

/** What the voice model is told: who it speaks as, to whom, what the agent is doing (when it may be told), and how to use its tools. */
export function instructionsFor(input: { agentName: string; description: string | null; callerName: string; status: string | null }): string {
  return [
    `You are the voice of ${input.agentName}, an AI agent on Raft${input.description ? ` (${input.description.slice(0, 500)})` : ""}, on a voice call with ${input.callerName}.`,
    "Speak as the agent, in the first person, briefly and naturally, in the caller's language.",
    `You only know what is written here. For anything about ${input.agentName}'s work, files, messages or decisions, call ask_agent with one clear question and say you are checking; never guess or invent an answer.`,
    "You cannot start, change or promise work. If the caller wants something done, suggest they send the agent a message.",
    "Use tell_user to send the caller anything better read than heard, such as a link or a list.",
    "",
    `What ${input.agentName} is doing right now:`,
    input.status ? input.status.slice(0, 4_000) : "(not shared on this call)",
  ].join("\n");
}
