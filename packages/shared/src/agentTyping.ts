/**
 * Agent typing line (stdrc, #proj-chat:ce40cff2; raft-design 0042).
 *
 * An agent posts by running `raft message send --target <T> …`. Most runtimes
 * stream the tool call's arguments, and the target comes before the body, so
 * the daemon knows where the agent is about to speak while the body is still
 * being generated. Runtimes that only hand over the finished command are
 * covered later, when the command is complete (`early: false`).
 *
 *   daemon  --agent:send_intent-->  server  --agent:typing-->  web (channel room)
 *
 * The raw target never leaves the server: it is resolved read-only (nothing is
 * created), checked against what the agent may post to, and only then emitted,
 * to the target channel's own room, never the server-wide room.
 */

/** Server capability (on `machine:context.capabilities`): the server accepts
 *  `agent:send_intent`. A daemon sends the frame only to a server advertising it. */
export const SERVER_CAPABILITY_AGENT_SEND_INTENT_V1 = "agent:send-intent-v1";

/** How long a typing line lives without a refresh. */
export const AGENT_TYPING_TTL_MS = 20_000;
/** While a send is still being generated, the daemon re-sends `start` this often. */
export const AGENT_SEND_INTENT_REFRESH_MS = 8_000;

/**
 * Daemon -> server. `callId` is the runtime's tool-call id (or a daemon-minted
 * one for runtimes without ids), unique per agent while the call is live.
 * `start` may repeat (refresh); `end` is sent once when the call finishes,
 * fails, is interrupted, or the turn/process ends.
 */
export type AgentSendIntentFrame = {
  type: "agent:send_intent";
  agentId: string;
  launchId?: string;
  callId: string;
  phase: "start" | "end";
  /** The `--target` value as written (e.g. "#general", "#general:abcd1234", "dm:@alice"). Required on `start`. */
  target?: string;
  /** True when found in streamed arguments before the command was complete. */
  early?: boolean;
};

/**
 * Server -> web, socket event name `agent:typing`, emitted to `channel:<channelId>`.
 * For a thread reply, `channelId` is the parent channel and `parentMessageId`
 * the thread's root message (the thread may not exist yet). For a task v2
 * reply (`raft task reply`), `channelId` is the reader-server's task
 * conversation (its own room), `parentMessageId` is null and `taskId` names
 * the task; it is set only then.
 */
export const AGENT_TYPING_SOCKET_EVENT = "agent:typing";
export type AgentTypingEvent = {
  agentId: string;
  serverId: string;
  channelId: string;
  parentMessageId: string | null;
  /** Task v2: the task whose conversation `channelId` is (absent otherwise). */
  taskId?: string;
  callId: string;
  state: "start" | "end";
  /** Epoch ms after which a client drops a `start` it hasn't seen refreshed. */
  expiresAt: number;
};
