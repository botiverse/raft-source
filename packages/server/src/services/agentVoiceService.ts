/**
 * Raft voice (#wg-runtime-form:#22): a person asks an agent what it is doing
 * now, or asks it one question, without disturbing it. The daemon answers
 * (agentSideAsk.ts in shared and daemon); this decides who may ask.
 *
 * - `status`: a non-guest member whose role can view agents
 *   (`viewAgents`). That is the audience of the agent's detailed activity
 *   already: `agent:activity`, trajectory text included, is pushed to every
 *   member of the server. A personal assistant answers its owner only.
 * - `question`: View Context (canViewAgentContext): the agent's human
 *   creator or an owner/admin, never a guest; an assistant, its owner only.
 *
 * Every refusal before the Computer is asked (flag off for the server, an
 * agent that is missing, deleted, another server's or not findable by the
 * person, a person who may not ask) is the same `not_found`, so the answer
 * tells none of them apart. Access is read fresh on every request.
 *
 * Each person has a budget per agent, and for questions one across all
 * agents (fixed windows, Redis across replicas, per replica in memory without
 * it). A question spends from the agent's account, so a Redis error refuses
 * it; a status costs nothing and is admitted.
 *
 * Every question is recorded before the Computer is asked
 * (`agent.voice_question_asked`: who, which agent, when, through which App;
 * never the question or the answer), and listed to the same people who may ask
 * (listAgentVoiceQuestions, GET /api/agents/:id/voice-questions).
 */
import {
  AGENT_SIDE_ASK_QUESTION_MAX_CHARS,
  AGENT_VOICE_FEATURE_FLAG_KEY,
  isExternalAgentRuntime,
  type AgentSideAskAsker,
  type AgentVoiceQuestionRecord,
} from "@botiverse/raft-shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { integrationAuditEvents, oauthClients, serverMembers, users } from "../db/schema";
import { getActorServerRoleInServer, roleCanInspectAgentPrivateSurfaces, roleCanReadAgentVoiceStatus } from "../lib/actorPermissions";
import { getRedis, isRedisAvailable } from "../redis";
import { addTraceEvent } from "../tracing/semanticTrace";
import type { AgentOrchestrator, AgentSideAskRequestResult } from "./agentOrchestrator";
import { isAgentFindableBy } from "./agentMemberListPolicy";
import * as agentService from "./agentService";
import { evaluateFeatureFlag } from "./featureFlagService";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import * as userService from "./userService";

/** A side question's record (integration audit): who, which agent, when, through which App; never the question or the answer. */
export const AGENT_VOICE_QUESTION_ASKED = "agent.voice_question_asked";

export type AgentVoiceAskKind = "status" | "question";

export type AgentVoiceAskResult =
  | { ok: true; result: AgentSideAskRequestResult }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "rate_limited"; retryAfterSeconds: number };

/** Per person, per agent, per window: a conversation's worth, not a sweep. */
export const AGENT_VOICE_RATE_LIMITS: Record<AgentVoiceAskKind, { max: number; windowSeconds: number }> = {
  status: { max: 120, windowSeconds: 60 * 60 },
  question: { max: 20, windowSeconds: 60 * 60 },
};

/**
 * Per person across every agent: questions spend from each agent's account,
 * so someone who may ask many agents (an admin) cannot spend 20 an hour from
 * each of them.
 */
export const AGENT_VOICE_QUESTION_TOTAL_LIMIT = { max: 60, windowSeconds: 60 * 60 };

/**
 * Calls (agentVoiceCallService): per person, a few an hour to one agent and
 * a day's worth across all of them. Each call is capped at
 * AGENT_VOICE_CALL_MAX_MINUTES, so these also bound the voice minutes one
 * person can spend in a day.
 */
export const AGENT_VOICE_CALL_LIMITS = {
  perAgent: { max: 6, windowSeconds: 60 * 60 },
  perPersonDaily: { max: 20, windowSeconds: 24 * 60 * 60 },
};

export type AgentVoiceAskInput = {
  orchestrator: AgentOrchestrator;
  serverId: string;
  userId: string;
  agentId: string;
  ask: { kind: "status" } | { kind: "question"; question: string };
  /** The App asking for the person (its oauth_clients id), recorded with a question. */
  clientRecordId?: string | null;
};

/** Asked and answered in one wait (askAgentByVoice); a route that answers at once uses prepareVoiceAsk. */
export async function askAgentByVoice(input: AgentVoiceAskInput): Promise<AgentVoiceAskResult> {
  const prepared = await prepareVoiceAsk(input);
  return prepared.ok ? { ok: true, result: await prepared.ask() } : prepared;
}

/**
 * Every check of an ask, and a question's record, without the Computer's
 * answer: `ask()` waits for it (up to the side ask's own limit plus the
 * relay's margin), so a caller can answer before it (#otter-lounge:#1: the
 * edge closes a request silent for 30 s).
 */
export async function prepareVoiceAsk(input: AgentVoiceAskInput): Promise<
  | { ok: true; ask: () => Promise<AgentSideAskRequestResult> }
  | Exclude<AgentVoiceAskResult, { ok: true }>
> {
  const { orchestrator, serverId, userId, agentId, ask } = input;
  const trace = (outcome: string) => addTraceEvent("agent.voice_ask", {
    agent_id: agentId,
    server_id: serverId,
    user_id: userId,
    kind: ask.kind,
    outcome,
  });
  const flag = await evaluateFeatureFlag({ key: AGENT_VOICE_FEATURE_FLAG_KEY, serverId, userId });
  if (!flag.enabled) return { ok: false, code: "not_found" };
  const agent = await agentService.getAgent(agentId).catch(() => null);
  if (!agent || agent.serverId !== serverId || !isAgentFindableBy({ userId }, agent)) {
    trace("not_found");
    return { ok: false, code: "not_found" };
  }
  const role = await getActorServerRoleInServer(serverId, "user", userId);
  // The agent's editors can turn asking off (voice_askable): then it is the same not-found.
  if (!role || role === "guest" || !mayAsk(ask.kind, role, userId, agent) || !agent.voiceAskable) {
    trace("not_found");
    return { ok: false, code: "not_found" };
  }
  const admission = await admitVoiceAsk(ask.kind, userId, agent.id);
  if (!admission.admitted) {
    trace("rate_limited");
    return { ok: false, code: "rate_limited", retryAfterSeconds: admission.retryAfterSeconds };
  }
  if (isExternalAgentRuntime(agent.runtime)) {
    trace("unsupported_runtime");
    return { ok: true, ask: async () => ({ outcome: "unsupported_runtime" }) };
  }
  if (ask.kind === "status") {
    return {
      ok: true,
      ask: async () => {
        const result = await orchestrator.sideAskAgent(agent.id, agent.machineId ?? null, { kind: "status" });
        trace(result.outcome);
        return result;
      },
    };
  }
  const user = await userService.getUser(userId);
  const asker: AgentSideAskAsker = {
    displayName: user?.displayName || user?.name || "someone",
    role,
    isAgentOwner: agent.assistantOwnerUserId
      ? agent.assistantOwnerUserId === userId
      : agent.creatorType === "user" && agent.creatorId === userId,
  };
  // The question's record comes first: a question the record could not be
  // written for is never asked (the person gets a server error).
  await recordIntegrationAuditEvent({
    serverId,
    clientId: input.clientRecordId ?? null,
    eventType: AGENT_VOICE_QUESTION_ASKED,
    outcome: "success",
    source: "api",
    actor: { type: "human", id: userId },
    subject: { type: "agent", id: agent.id },
    target: { type: "agent", id: agent.id },
    metadata: { agentId: agent.id, machineId: agent.machineId ?? null },
  });
  return {
    ok: true,
    ask: async () => {
      const result = await orchestrator.sideAskAgent(agent.id, agent.machineId ?? null, {
        kind: "question",
        question: ask.question.slice(0, AGENT_SIDE_ASK_QUESTION_MAX_CHARS),
        asker,
      });
      trace(result.outcome);
      return result;
    },
  };
}

function mayAsk(
  kind: AgentVoiceAskKind,
  role: "owner" | "admin" | "member",
  userId: string,
  agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null },
): boolean {
  return kind === "question"
    ? roleCanInspectAgentPrivateSurfaces(role, userId, agent)
    : roleCanReadAgentVoiceStatus(role, userId, agent);
}

export type Admission = { admitted: true } | { admitted: false; retryAfterSeconds: number };

const COUNT = `
local n = redis.call("INCR", KEYS[1])
if n == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then redis.call("EXPIRE", KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

const memory = new Map<string, { count: number; resetAtMs: number }>();

/** The budgets one ask counts against: its own per agent, and a question or a call also the person's total. */
function budgetsOf(kind: AgentVoiceAskKind | "call", userId: string, agentId: string) {
  if (kind === "call") {
    return [
      { key: `slock:agent-voice:call:${userId}:${agentId}`, ...AGENT_VOICE_CALL_LIMITS.perAgent },
      { key: `slock:agent-voice:call-daily:${userId}`, ...AGENT_VOICE_CALL_LIMITS.perPersonDaily },
    ];
  }
  const own = { key: `slock:agent-voice:${kind}:${userId}:${agentId}`, ...AGENT_VOICE_RATE_LIMITS[kind] };
  return kind === "question"
    ? [own, { key: `slock:agent-voice:question-total:${userId}`, ...AGENT_VOICE_QUESTION_TOTAL_LIMIT }]
    : [own];
}

async function countIn(budget: { key: string; windowSeconds: number }, nowMs: number): Promise<{ count: number; ttlSeconds: number }> {
  if (!isRedisAvailable()) {
    let entry = memory.get(budget.key);
    if (!entry || entry.resetAtMs <= nowMs) {
      entry = { count: 0, resetAtMs: nowMs + budget.windowSeconds * 1000 };
      memory.set(budget.key, entry);
    }
    entry.count += 1;
    if (memory.size > 10_000) {
      for (const [k, v] of memory) if (v.resetAtMs <= nowMs) memory.delete(k);
    }
    return { count: entry.count, ttlSeconds: (entry.resetAtMs - nowMs) / 1000 };
  }
  const result = await getRedis().eval(COUNT, 1, budget.key, String(budget.windowSeconds)) as [number, number];
  return { count: Number(result[0]), ttlSeconds: Number(result[1]) };
}

/** A call spends voice minutes: a Redis error refuses it, as it does a question. */
export function admitVoiceCall(userId: string, agentId: string): Promise<Admission> {
  return admitVoiceAsk("call", userId, agentId);
}

async function admitVoiceAsk(kind: AgentVoiceAskKind | "call", userId: string, agentId: string, nowMs = Date.now()): Promise<Admission> {
  let retryAfterSeconds = 0;
  for (const budget of budgetsOf(kind, userId, agentId)) {
    let counted: { count: number; ttlSeconds: number };
    try {
      counted = await countIn(budget, nowMs);
    } catch {
      if (kind === "status") continue;
      return { admitted: false, retryAfterSeconds: 60 };
    }
    if (counted.count > budget.max) retryAfterSeconds = Math.max(retryAfterSeconds, Math.max(1, Math.ceil(counted.ttlSeconds)));
  }
  return retryAfterSeconds > 0 ? { admitted: false, retryAfterSeconds } : { admitted: true };
}

/** The most questions the list returns (newest first). */
export const AGENT_VOICE_QUESTIONS_LIMIT = 100;

/**
 * Who asked the agent questions (`GET /api/agents/:id/voice-questions`), to
 * the people who may ask it: the flag on and the question rule
 * (`mayAskAgentQuestions`); null otherwise, which the route answers as an
 * unknown agent. A person is named only while a current, not retired,
 * non-Guest member of the Server, as in View Context's "Viewed by".
 */
export async function listAgentVoiceQuestions(input: { serverId: string; userId: string; agentId: string }): Promise<AgentVoiceQuestionRecord[] | null> {
  if (!await mayAskAgentQuestions(input)) return null;
  const rows = await getDb()
    .select({
      at: integrationAuditEvents.createdAt,
      askerId: users.id,
      askerName: sql<string | null>`coalesce(${users.displayName}, ${users.name})`,
      appName: oauthClients.name,
    })
    .from(integrationAuditEvents)
    .leftJoin(users, and(
      eq(users.id, integrationAuditEvents.actorId),
      isNull(users.retiredAt),
      sql`exists (select 1 from ${serverMembers} where ${serverMembers.serverId} = ${input.serverId} and ${serverMembers.userId} = ${users.id} and ${serverMembers.role} <> 'guest')`,
    ))
    .leftJoin(oauthClients, eq(oauthClients.id, integrationAuditEvents.clientId))
    .where(and(
      eq(integrationAuditEvents.serverId, input.serverId),
      eq(integrationAuditEvents.eventType, AGENT_VOICE_QUESTION_ASKED),
      eq(integrationAuditEvents.subjectType, "agent"),
      eq(integrationAuditEvents.subjectId, input.agentId),
    ))
    .orderBy(desc(integrationAuditEvents.createdAt), desc(integrationAuditEvents.id))
    .limit(AGENT_VOICE_QUESTIONS_LIMIT);
  return rows.map((row) => ({
    asker: row.askerId ? { id: row.askerId, name: row.askerName ?? "" } : null,
    at: row.at.toISOString(),
    app: row.appName ? { name: row.appName } : null,
  }));
}

/** The flag and the question rule, read fresh: the same check a question passes before it is asked. */
async function mayAskAgentQuestions(input: { serverId: string; userId: string; agentId: string }): Promise<boolean> {
  return mayStillAskAgent({ ...input, kind: "question" }, { askable: false });
}

/**
 * The flag and the ask rule for `kind`, read fresh (prepareVoiceAsk's checks
 * without its budget). An answer kept for a `respondAsync` ask is shown only
 * while this still holds (Tenny's 1.28.0 review): someone who lost the right
 * after asking no longer reads it. `askable`: also the agent's voice_askable.
 */
export async function mayStillAskAgent(
  input: { serverId: string; userId: string; agentId: string; kind: AgentVoiceAskKind },
  options: { askable: boolean } = { askable: true },
): Promise<boolean> {
  const flag = await evaluateFeatureFlag({ key: AGENT_VOICE_FEATURE_FLAG_KEY, serverId: input.serverId, userId: input.userId });
  if (!flag.enabled) return false;
  const agent = await agentService.getAgent(input.agentId).catch(() => null);
  if (!agent || agent.serverId !== input.serverId || !isAgentFindableBy({ userId: input.userId }, agent)) return false;
  if (options.askable && !agent.voiceAskable) return false;
  const role = await getActorServerRoleInServer(input.serverId, "user", input.userId);
  return !!role && role !== "guest" && mayAsk(input.kind, role, input.userId, agent);
}

/** Whether people may ask the agent (status and side questions) and call it. */
export type AgentVoiceSettings = { askable: boolean; callable: boolean };

/**
 * The agent's voice settings, to the people who may change them: the flag on
 * and the agent's edit rule (its creator or an owner/admin; an assistant, its
 * owner; never a guest). Null otherwise, which the routes answer as an
 * unknown agent. A change is written by the route under the actor's fence.
 */
export async function agentVoiceSettings(input: { serverId: string; userId: string; agentId: string }): Promise<AgentVoiceSettings | null> {
  const flag = await evaluateFeatureFlag({ key: AGENT_VOICE_FEATURE_FLAG_KEY, serverId: input.serverId, userId: input.userId });
  if (!flag.enabled) return null;
  const agent = await agentService.getAgent(input.agentId).catch(() => null);
  if (!agent || agent.serverId !== input.serverId || !isAgentFindableBy({ userId: input.userId }, agent)) return null;
  const role = await getActorServerRoleInServer(input.serverId, "user", input.userId);
  if (!role || role === "guest" || !roleCanInspectAgentPrivateSurfaces(role, input.userId, agent)) return null;
  return { askable: agent.voiceAskable, callable: agent.voiceCallable };
}

/** Test seam: forget the in-memory windows. */
export function resetAgentVoiceRateLimitForTests(): void {
  memory.clear();
}
