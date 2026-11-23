// Raft voice calls (#wg-runtime-form:#22): a person calls an agent. The routes
// are the server's (routes/agents.ts › voice/calls); the browser holds only
// the room grant they answer with. Each request names the call's own server,
// so a renewal or a hang-up still reaches it after the person moves to
// another server mid-call.
import { asAgentVoiceCallId } from "@botiverse/raft-shared";
import type { AgentVoiceCallId, AgentVoiceCallRefusalCode } from "@botiverse/raft-shared";
import api from "../../api/client";

/** Why a call didn't start or didn't connect, as the call window says it. */
export type AgentVoiceCallProblem =
  | "not_allowed"
  | "agent_offline"
  | "unavailable"
  | "unsupported_runtime"
  | "rate_limited"
  | "failed"
  | "mic_permission"
  | "mic_busy"
  | "mic_none";

const REFUSALS: Record<AgentVoiceCallRefusalCode, AgentVoiceCallProblem> = {
  voice_call_unavailable: "unavailable",
  agent_offline: "agent_offline",
  unsupported_runtime: "unsupported_runtime",
};

/** The start route's refusal, read: 404 not yours to call, 409 `{code}`, 429 too many calls; anything else failed. */
export function startProblemOf(error: unknown): AgentVoiceCallProblem {
  const response = (error as { response?: { status?: unknown; data?: { code?: unknown } } } | null)?.response;
  if (response?.status === 404) return "not_allowed";
  if (response?.status === 429) return "rate_limited";
  const code = response?.data?.code;
  if (response?.status === 409 && typeof code === "string" && Object.hasOwn(REFUSALS, code)) return REFUSALS[code as AgentVoiceCallRefusalCode];
  return "failed";
}

/** A room grant the browser can join with: a URL, a token, and when it expires (ms). */
export type AgentVoiceCallRoom = { url: string; token: string; expiresAt: number };

/** The start's or a renewal's answer, checked: a field that isn't what the contract says is null. */
export type AgentVoiceCallAnswer = { callId: AgentVoiceCallId | null; room: AgentVoiceCallRoom | null };

/** Reads `AgentVoiceCallStarted` at the boundary: the call id minted by asAgentVoiceCallId, the grant only whole. */
export function readCallAnswer(body: unknown): AgentVoiceCallAnswer {
  const fields = (body && typeof body === "object" ? body : {}) as { callId?: unknown; room?: unknown };
  const room = (fields.room && typeof fields.room === "object" ? fields.room : {}) as { url?: unknown; token?: unknown; expiresAt?: unknown };
  const expiresAt = typeof room.expiresAt === "string" ? Date.parse(room.expiresAt) : Number.NaN;
  const whole = typeof room.url === "string" && room.url !== "" && typeof room.token === "string" && room.token !== "" && Number.isFinite(expiresAt);
  return {
    callId: asAgentVoiceCallId(fields.callId),
    room: whole ? { url: room.url as string, token: room.token as string, expiresAt } : null,
  };
}

function onServer(serverId: string) {
  return { headers: { "X-Server-Id": serverId } };
}

export async function startAgentVoiceCall(agentId: string, serverId: string): Promise<AgentVoiceCallAnswer> {
  return readCallAnswer((await api.post<unknown>(`/agents/${encodeURIComponent(agentId)}/voice/calls`, {}, onServer(serverId))).data);
}

export async function renewAgentVoiceCallToken(agentId: string, callId: AgentVoiceCallId, serverId: string): Promise<AgentVoiceCallAnswer> {
  return readCallAnswer((await api.post<unknown>(`/agents/${encodeURIComponent(agentId)}/voice/calls/${encodeURIComponent(callId)}/token`, {}, onServer(serverId))).data);
}

export async function hangUpAgentVoiceCall(agentId: string, callId: AgentVoiceCallId, serverId: string): Promise<void> {
  await api.post(`/agents/${encodeURIComponent(agentId)}/voice/calls/${encodeURIComponent(callId)}/hang-up`, {}, onServer(serverId));
}
