// Raft voice calls (#wg-runtime-form:#22): a person calls an agent from the
// web. The server opens a holt-live agent session (a realtime voice model that
// speaks as the agent) and hands the browser a room grant; the audio never
// passes through Raft. POST /api/agents/:id/voice/calls starts one.

/** One call's handle; only the server mints it (a UUID). */
export type AgentVoiceCallId = string & { readonly __agentVoiceCallId: unique symbol };

const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Server's mint for a new call id. */
export function mintAgentVoiceCallId(): AgentVoiceCallId {
  return globalThis.crypto.randomUUID() as AgentVoiceCallId;
}

/** The only other mint: a call id read back from a route or a callback, checked. */
export function asAgentVoiceCallId(value: unknown): AgentVoiceCallId | null {
  return typeof value === "string" && CALL_ID.test(value) ? value as AgentVoiceCallId : null;
}

/** What the browser needs to join the call's room (@holtjs/live-client `joinRoom`); it holds no other credential. */
export type AgentVoiceCallRoomGrant = {
  url: string;
  token: string;
  /** When the token stops admitting (ISO 8601); renew with POST …/voice/calls/:callId/token before then. */
  expiresAt: string;
  relay?: string;
};

/** 201 from POST /api/agents/:id/voice/calls, and 200 from …/:callId/token. */
export type AgentVoiceCallStarted = { callId: AgentVoiceCallId; room: AgentVoiceCallRoomGrant };

/**
 * Why a call did not start (409 `{code}`):
 * - `voice_call_unavailable`: calls are not set up on this deployment, or holt-live refused or failed;
 * - `agent_offline`: the agent's Computer did not answer (send it a message instead);
 * - `unsupported_runtime`: the agent runs outside Raft's Computer and cannot be asked.
 */
export type AgentVoiceCallRefusalCode = "voice_call_unavailable" | "agent_offline" | "unsupported_runtime";

/** The longest call, in minutes (holt-live `max_minutes`). */
export const AGENT_VOICE_CALL_MAX_MINUTES = 15;
