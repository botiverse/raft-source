// Side ask (#wg-runtime-form:#22, Raft-native realtime voice): the server asks
// an agent's Computer for one of two things without disturbing the agent.
// - `status`: a few lines on what the agent is doing now, built from the
//   daemon's own state; no model call.
// - `question`: one question answered by a read-only fork of the agent's live
//   session, which is discarded afterwards. The asker's name and role go with
//   it, so the fork applies the agent's rules (credentials, private channels)
//   for that person.
// The server decides who may ask (status: who may see the agent's activity;
// question: who may view the agent's context) and gates it all behind
// `agent_voice_v1`; the daemon only answers.

/** The daemon answers `agent:side-ask` with `agent:side-ask:result`. Without it the server does not send the request. */
export const DAEMON_CAPABILITY_AGENT_SIDE_ASK = "agent:side-ask:v1";

/** A question's longest accepted text, in characters. */
export const AGENT_SIDE_ASK_QUESTION_MAX_CHARS = 2_000;
/** An answer's longest returned text, in characters (a spoken answer is far shorter). */
export const AGENT_SIDE_ASK_ANSWER_MAX_CHARS = 4_000;
/** The longest a daemon works on one request; a request's own `timeoutMs` may only shorten it. */
export const AGENT_SIDE_ASK_MAX_TIMEOUT_MS = 60_000;

/** Who is asking, as the fork is told it: a display name and their standing with this agent. */
export interface AgentSideAskAsker {
  displayName: string;
  /** Their server role. */
  role: "owner" | "admin" | "member";
  /** Whether they are this agent's owner (its human creator, or its assistant's owner). */
  isAgentOwner: boolean;
}

export type AgentSideAskRequest =
  | { type: "agent:side-ask"; agentId: string; requestId: string; kind: "status"; timeoutMs?: number }
  | { type: "agent:side-ask"; agentId: string; requestId: string; kind: "question"; question: string; asker: AgentSideAskAsker; timeoutMs?: number };

/**
 * How a side ask ended.
 * - `answered`: `text` is the answer (or the status lines).
 * - `agent_not_running`: no live session to read or fork (stopped, never
 *   started, or between processes); the server leaves the question for the
 *   agent as a message instead.
 * - `unsupported_runtime`: this runtime cannot be forked here (v0: Claude only).
 * - `busy`: a fork for this agent is already running (one at a time).
 * - `usage_limited`: the agent's account is at its usage limit; a fork would
 *   spend from the same limit.
 * - `context_too_large`: the session is past the fork's context limit.
 * - `timed_out` / `failed`: no answer in time, or the fork failed.
 */
export const AGENT_SIDE_ASK_OUTCOMES = [
  "answered",
  "agent_not_running",
  "unsupported_runtime",
  "busy",
  "usage_limited",
  "context_too_large",
  "timed_out",
  "failed",
] as const;
export type AgentSideAskOutcome = (typeof AGENT_SIDE_ASK_OUTCOMES)[number];

export interface AgentSideAskResult {
  type: "agent:side-ask:result";
  agentId: string;
  requestId: string;
  outcome: AgentSideAskOutcome;
  text?: string;
}

/**
 * One side question to an agent (`GET /api/agents/:id/voice-questions`, newest
 * first): who asked, when, through which App. Never the question or the
 * answer. Listed to the people who may ask the agent questions.
 */
export interface AgentVoiceQuestionRecord {
  /** The person, only while a current, not retired, non-Guest member of the agent's Server; null otherwise. */
  asker: { id: string; name: string } | null;
  /** ISO 8601, when the question was asked. */
  at: string;
  /** The App that asked for them; null when it has since been deleted. */
  app: { name: string } | null;
}

export type AgentVoiceQuestionRecordList = { questions: AgentVoiceQuestionRecord[] };
