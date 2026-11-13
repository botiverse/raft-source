// Agent read progress, sent only to the connections viewing a conversation
// (flag AGENT_READ_PROGRESS_FEATURE_FLAG_KEY, `agent_read_progress_v0`).
//
// The web draws each agent's avatar on the last message it has read in the
// open channel, DM or thread, and moves it down as the agent reads. The
// starting positions are the channel detail's `peerReadStates` (GET
// /api/channels/:id, read receipts); this socket contract carries the moves:
//
//   web  --read_progress:watch { scopeId }-->    server
//   web  <--read_progress:watched { scopeId, ok }-- server
//   web  <--read_progress:updated { scopeId, peers }-- server (room read-progress:<scopeId>)
//   web  --read_progress:unwatch { scopeId }-->  server
//
// - A watch is answered once with READ_PROGRESS_WATCHED_EVENT. `ok: false`
//   means the flag is off for the socket's server, the person may not open
//   the conversation, or it carries no read progress (the read-receipt
//   scopes: channels, private channels, joint channels and DMs, never #all;
//   a thread as its parent). A body without a string `scopeId` gets no
//   answer.
// - Joint channel: each server watches its own projection's id (the id its
//   people open), and the flag of the watcher's own server decides. Frames
//   for it carry the agents of every server in the channel, under that id.
// - A socket watches at most READ_PROGRESS_MAX_WATCHED_SCOPES conversations;
//   watching one more drops the oldest watch (no notice). Watching one that is
//   already watched answers `ok` again and makes it the newest.
// - Watches belong to the connection: a reconnect starts with none, so the
//   client watches again (as it re-joins rooms). Losing access to a
//   conversation disconnects the socket (server/src/socket/accessRevocation.ts).
// - `read_progress:updated` goes only to the watchers' room, never to the
//   channel room, Activity or the inbox. It carries agents only (a person's
//   read position never leaves the server), only the agents the channel
//   detail exposes, and only when the agent's read position passed a message
//   the conversation shows. One frame at most every ~300 ms per conversation,
//   with the latest position of every agent that moved. Positions only rise:
//   keep the highest `maxReadSeq` seen per agent.
// - A conversation whose detail serves `peerReadSummary` (more agents than the
//   per-peer bound) gets no frames.
// - In a thread, an agent that stopped following it carries
//   `stoppedFollowing: true` in the detail's `peerReadStates`: replies that do
//   not @mention it no longer reach it. Absent means nothing is known (every
//   other agent, a channel, a server older than the field): treat as today.
//   This is not a read move, so no frame carries it: `thread:followers-updated`
//   (to `channel:<threadId>`, an open thread's room) says load the detail again.
//   A joint thread's event goes to every server's projection, each under its
//   own id (a stop, a manager's removal and a follow coming back alike).
// - In a channel (not a thread, not a DM), an agent that muted it carries
//   `mutedChannel: true` in the detail's `peerReadStates`: messages that do not
//   @mention it no longer reach it (a mention pierces the mute; it does not
//   unmute). Absent means nothing is known (every other agent, a thread, a DM,
//   a server older than the field): treat as today. A joint channel's agent
//   mutes on its own server's projection, and every server's detail says so.
//   No frame carries it either: READ_PROGRESS_DETAIL_CHANGED_EVENT, to the
//   watchers of every projection, says load the detail again.

/** Client -> server: ReadProgressWatchRequest; answered with READ_PROGRESS_WATCHED_EVENT. */
export const READ_PROGRESS_WATCH_EVENT = "read_progress:watch";
/** Client -> server: ReadProgressWatchRequest. Not answered. */
export const READ_PROGRESS_UNWATCH_EVENT = "read_progress:unwatch";
/** Server -> client: ReadProgressWatchedPayload. */
export const READ_PROGRESS_WATCHED_EVENT = "read_progress:watched";
/** Server -> client: ReadProgressUpdatedPayload, to readProgressRoom(scopeId) only. */
export const READ_PROGRESS_UPDATED_EVENT = "read_progress:updated";

/**
 * Server -> client: ReadProgressDetailChangedPayload, to readProgressRoom(scopeId)
 * only (watchers still in the conversation's room): what the detail says about
 * its agents changed other than a read position (an agent muted or unmuted
 * the channel). Load GET /api/channels/:id again; no position moved.
 */
export const READ_PROGRESS_DETAIL_CHANGED_EVENT = "read_progress:detail_changed";

/** Most conversations one socket watches at once; one more drops the oldest. */
export const READ_PROGRESS_MAX_WATCHED_SCOPES = 8;

export interface ReadProgressWatchRequest {
  /** The channel, DM or thread id (the id GET /api/channels/:id takes). */
  scopeId: string;
}

export interface ReadProgressWatchedPayload {
  scopeId: string;
  ok: boolean;
}

export interface ReadProgressPeer {
  /** The agent's id. */
  peerId: string;
  /** Its read position: the seq of the last message it has read here (same as peerReadStates). */
  maxReadSeq: number;
}

export interface ReadProgressUpdatedPayload {
  scopeId: string;
  /** Agents only, sorted by id; never empty. */
  peers: ReadProgressPeer[];
}

export interface ReadProgressDetailChangedPayload {
  /** The watched id (each server's own projection in a joint channel). */
  scopeId: string;
}

/** The socket room of one conversation's read-progress watchers. */
export function readProgressRoom(scopeId: string): string {
  return `read-progress:${scopeId}`;
}

/** The scope id of a watch/unwatch body (`{ scopeId }`), or null when there is none. */
export function parseReadProgressScopeId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scopeId = (value as Record<string, unknown>).scopeId;
  if (typeof scopeId !== "string" || scopeId.length === 0 || scopeId.length > 64) return null;
  return scopeId;
}
