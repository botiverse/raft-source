/**
 * Agent read progress (flag `agent_read_progress_v0`; wire contract in
 * packages/shared/src/agentReadProgress.ts).
 *
 * The web shows each agent's avatar on the last message it has read in the
 * open conversation and moves it as the agent reads. The starting positions
 * are the channel detail's `peerReadStates` (readReceiptService); this module
 * pushes the moves, and only to the connections that asked for them:
 *
 * - Every writer of an agent's read cursor (channelService: markRead and
 *   markReadLatest for agents, markAgentOwnSendRead, markAgentLegacyRead,
 *   markAgentLegacyAckCheckpoint) reports a forward move through
 *   noteAgentReadAdvance, or through beginAgentReadAdvance when it does not
 *   know the position it moved from. That covers history reads, model-seen
 *   reports, `/events` acks and receive-ack checkpoints (a hosted agent's
 *   `raft message check` is answered by its daemon and reports nothing:
 *   RFC 081 §3), external-agent acks, an agent's own sends, freshness holds and read-all on an agent's
 *   behalf. While the flag is off for the server (a cached evaluation, see
 *   below) a report costs a map lookup and nothing else.
 * - Reports are coalesced per conversation (agentReadProgressCoalescer.ts):
 *   one flush at most every READ_PROGRESS_FLUSH_INTERVAL_MS.
 * - A flush re-checks the flag and the conversation (the read-receipt scopes:
 *   channel, private channel, joint channel, DM; a thread as its parent;
 *   never #all), keeps only agents the channel detail exposes
 *   (listExposedReadPeers: agents only, a person's position never leaves the
 *   server), keeps no one above the detail's per-peer bound (that detail
 *   serves a summary, with no per-agent positions to move), and keeps only
 *   agents whose move passed a message the conversation shows (below). One
 *   `read_progress:updated` frame then goes to the sockets in
 *   `read-progress:<scopeId>` (those that watched the conversation) that are
 *   still in its `channel:<id>` room (still allowed to see it, see
 *   flushAgentReadProgress): never to the whole `channel:<id>` room
 *   (every member's socket joins those at connect, viewing or not), Activity or
 *   the inbox. A joint conversation gets one frame per server's face of it
 *   (below).
 * - A socket watches a conversation with `read_progress:watch`
 *   (watchAgentReadProgress): the flag must be on for its server, its person
 *   must be able to open the conversation (canUserAccessChannel, the
 *   `join:channel` check) and the conversation must carry read progress.
 *   At most READ_PROGRESS_MAX_WATCHED_SCOPES per socket; one more drops the
 *   oldest, so a client that switches conversations without unwatching keeps
 *   following the ones it opened last instead of being refused.
 *
 * Joint channels (artin, #botiverse-raft-deployment msgs 8837d73c, 90309626,
 * 9b3f12dc): everyone who can see a joint channel, from every server in it,
 * sees every agent's read position, the agents of all those servers. A
 * person's position is never exposed, here as everywhere. Each server has its
 * own projection of the channel (and of each thread under it); its people
 * open and watch that one, and its agents' read cursors are on that one
 * (readReceiptService readScopeFaces). So:
 * - The flag is per server, and the VIEWER's server decides: a socket may
 *   watch when the flag is on for its own server (watchAgentReadProgress), and
 *   a frame goes to a face only while that face's server has it on. The
 *   agents shown are those of every server in the channel, whatever the
 *   other servers' flag says.
 * - The starting positions (the channel detail's `peerReadStates`) read each
 *   agent's cursor on its own server's projection.
 * - A move is noted where the agent's cursor moved, behind the cheap flag gate
 *   of the agent's own server (noteAgentReadAdvance). Limit: while the flag is
 *   off for that server but on for the viewer's, its agents show at their
 *   positions as of the last detail load (each open, reconnect or refresh) and
 *   do not move live. With the flag on for both, every move reaches both.
 * - A flush builds one frame per face, under that face's id, with the agents
 *   that face's detail exposes, and sends it to that face's watchers still in
 *   that face's `channel:<id>` room (its membership authority's), i.e. still
 *   allowed to see it on their own server (canUserAccessChannel, including
 *   a joint channel's cross-server membership). The per-peer
 *   bound applies per face.
 *
 * "Passed a message the conversation shows": `messages.seq` is one counter for
 * the whole database (every channel's rows interleave in it), and an agent's
 * read position (`agent_channel_read_cursors.last_read_seq`) is the seq of the
 * last message it has read in that conversation. So a move from `from` to `to`
 * passed exactly the conversation's rows with seq in (from, to]; `to - from` is
 * not a count. A row counts as shown when it is not retracted
 * (`deleted_at IS NULL`; a retracted row stays in the timeline only as a
 * placeholder). Everything else the history read returns counts: chat from
 * anyone, the agent's own messages (its own send moves its avatar onto its
 * message) and system lines. The rows are looked up in the same storage ids
 * the history read uses (channelConversionReadScope.ts; for a joint
 * conversation, its canonical storage), so a conversation mid-conversion is
 * not missed. The plan's history cutoff is not applied: an
 * agent's position moves past recent rows, not ones older than the cutoff.
 * The check is one bounded query per flush (one EXISTS per agent that moved,
 * at most the per-peer bound of them).
 *
 * Under your latest message in a thread, the web names an agent that stopped
 * following it, one of the line's two reasons to show (`stoppedFollowing` on
 * the detail's `peerReadStates`, readReceiptService). That is not a read move and gets no
 * frame: `thread:followers-updated` tells an open thread to load the detail
 * again (noteAgentThreadFollowResumed for the follows that come back). In a
 * joint thread that event reaches every server's projection
 * (emitThreadFollowersUpdated), wherever the follow changed.
 *
 * In a channel, an agent that muted it says so the same way (`mutedChannel`,
 * readReceiptService). No channel event said that an agent's mute moved, so
 * READ_PROGRESS_DETAIL_CHANGED_EVENT goes to the watchers of every face
 * (noteAgentChannelMuteChanged): only those who show the line hear it.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Server as SocketServer, Socket } from "socket.io";
import {
  parseReadProgressScopeId,
  READ_PROGRESS_DETAIL_CHANGED_EVENT,
  READ_PROGRESS_MAX_WATCHED_SCOPES,
  READ_PROGRESS_UPDATED_EVENT,
  READ_PROGRESS_WATCHED_EVENT,
  readProgressRoom,
  type ReadProgressDetailChangedPayload,
  type ReadProgressPeer,
  type ReadProgressUpdatedPayload,
  type ServerId,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentChannelReadCursors } from "../db/schema";
import { resolveConversionReadChannelIds } from "./channelConversionReadScope";
import * as channelService from "./channelService";
import { AGENT_READ_PROGRESS_FEATURE_FLAG_KEY, evaluateFeatureFlag } from "./featureFlagService";
import { isReadReceiptScope, listExposedReadPeers, READ_RECEIPT_PEER_STATE_LIMIT, readScopeFaces } from "./readReceiptService";
import { AgentReadProgressCoalescer, type AgentReadAdvance, type AgentReadProgressBatch } from "./agentReadProgressCoalescer";
import { emitThreadFollowersUpdated } from "./threadFollowerRealtimeService";

/** At most one frame per conversation this often. */
export const READ_PROGRESS_FLUSH_INTERVAL_MS = 300;
/** How long one flag evaluation answers for a server's advances. A watch always evaluates afresh. */
export const READ_PROGRESS_FLAG_CACHE_MS = 30_000;
const READ_PROGRESS_FLAG_CACHE_MAX_SERVERS = 10_000;
const READ_PROGRESS_MAX_PENDING_SCOPES = 5_000;
// Above the per-peer bound no frame is sent at all, so a few more than it is enough.
const READ_PROGRESS_MAX_PENDING_AGENTS_PER_SCOPE = READ_RECEIPT_PEER_STATE_LIMIT + 14;

let socketServer: SocketServer | null = null;

/** The socket server frames go out on (setupSocket). Without one, advances are not even noted. */
export function registerAgentReadProgressSocketServer(io: SocketServer): void {
  socketServer = io;
}

/** Forget `io` if it is the registered one (its HTTP server closed). */
export function unregisterAgentReadProgressSocketServer(io: SocketServer): void {
  if (socketServer === io) socketServer = null;
}

// ── Flag ─────────────────────────────────────────────────

const flagCache = new Map<string, { enabled: boolean; expiresAt: number }>();
const flagInFlight = new Map<string, Promise<boolean>>();

function cachedFlag(serverId: string, now: number): boolean | undefined {
  const cached = flagCache.get(serverId);
  return cached && cached.expiresAt > now ? cached.enabled : undefined;
}

function rememberFlag(serverId: string, enabled: boolean, now: number): void {
  if (flagCache.size >= READ_PROGRESS_FLAG_CACHE_MAX_SERVERS && !flagCache.has(serverId)) {
    for (const [key, entry] of flagCache) if (entry.expiresAt <= now) flagCache.delete(key);
    if (flagCache.size >= READ_PROGRESS_FLAG_CACHE_MAX_SERVERS) flagCache.clear();
  }
  flagCache.set(serverId, { enabled, expiresAt: now + READ_PROGRESS_FLAG_CACHE_MS });
}

async function evaluateFlag(serverId: string): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: AGENT_READ_PROGRESS_FEATURE_FLAG_KEY, serverId })).enabled === true;
  } catch (error) {
    console.warn("[AgentReadProgress] feature_flag_evaluation_failed", {
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * The flag for a server: cached for READ_PROGRESS_FLAG_CACHE_MS (one
 * evaluation per server at a time), or evaluated afresh with `fresh`, which
 * also refreshes the cache. Any evaluation failure reads as off.
 */
export async function agentReadProgressEnabled(serverId: string, options: { fresh?: boolean } = {}): Promise<boolean> {
  if (!options.fresh) {
    const cached = cachedFlag(serverId, Date.now());
    if (cached !== undefined) return cached;
    const inFlight = flagInFlight.get(serverId);
    if (inFlight) return inFlight;
  }
  const evaluation = evaluateFlag(serverId).then((enabled) => {
    rememberFlag(serverId, enabled, Date.now());
    return enabled;
  }).finally(() => {
    if (flagInFlight.get(serverId) === evaluation) flagInFlight.delete(serverId);
  });
  flagInFlight.set(serverId, evaluation);
  return evaluation;
}

// ── Advances ─────────────────────────────────────────────

const coalescer = new AgentReadProgressCoalescer({
  intervalMs: READ_PROGRESS_FLUSH_INTERVAL_MS,
  maxScopes: READ_PROGRESS_MAX_PENDING_SCOPES,
  maxAgentsPerScope: READ_PROGRESS_MAX_PENDING_AGENTS_PER_SCOPE,
  flush: (batch) => flushAgentReadProgress(batch),
  onFlushError: (error, batch) => {
    console.warn("[AgentReadProgress] flush_failed", {
      serverId: batch.serverId,
      scopeId: batch.scopeId,
      error: error instanceof Error ? error.message : String(error),
    });
  },
});

/**
 * An agent's read position in `scopeId` moved from `from` to `to` (both read
 * positions, i.e. message seqs). Never throws and never waits: with the flag
 * off for the server (cached) it returns at once; with no cached answer it
 * evaluates the flag in the background first.
 */
export function noteAgentReadAdvance(advance: AgentReadAdvance): void {
  if (!socketServer || !(advance.to > advance.from)) return;
  const cached = cachedFlag(advance.serverId, Date.now());
  if (cached === false) return;
  if (cached === true) {
    coalescer.note(advance);
    return;
  }
  void agentReadProgressEnabled(advance.serverId).then((enabled) => {
    if (enabled) coalescer.note(advance);
  }).catch(() => {});
}

/**
 * An agent that had stopped following a thread follows it again (a mention, its
 * own reply, an action card's result: recordThreadFollow). The thread's open
 * panels hold "stopped following" in the channel detail, and those writers have
 * no socket of their own, so `thread:followers-updated` goes out from here.
 * Never throws and never waits: the write it follows already happened.
 */
export function noteAgentThreadFollowResumed(threadChannelId: string): void {
  if (!socketServer) return;
  void emitThreadFollowersUpdated(socketServer, threadChannelId).catch((error: unknown) => {
    console.warn("[AgentReadProgress] follow_resumed_emit_failed", {
      threadChannelId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * An agent muted or unmuted a channel (`raft channel mute` / `unmute`, after
 * the write committed). The channel's open views hold "muted" in the channel
 * detail, so READ_PROGRESS_DETAIL_CHANGED_EVENT tells them to load it again:
 * the watchers of every face (an agent mutes on its own server's face of a
 * joint channel, and every server's people see the line), each under its own
 * id, and only those still in the face's channel room, as frames go
 * (flushAgentReadProgress). Never throws and never waits.
 */
export function noteAgentChannelMuteChanged(serverId: string, channelId: string): void {
  if (!socketServer) return;
  void emitReadProgressDetailChanged(serverId, channelId).catch((error: unknown) => {
    console.warn("[AgentReadProgress] mute_changed_emit_failed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function emitReadProgressDetailChanged(serverId: string, channelId: string): Promise<void> {
  const { faces } = await readScopeFaces(serverId, channelId);
  for (const face of faces) {
    const io = socketServer;
    if (!io) return;
    // A channel is its own membership authority: its room says "may still see it".
    const channelRoom = `channel:${face.scopeId}`;
    const payload: ReadProgressDetailChangedPayload = { scopeId: face.scopeId };
    const watchers = await io.in(readProgressRoom(face.scopeId)).fetchSockets();
    for (const watcher of watchers) {
      if (watcher.rooms.has(channelRoom)) watcher.emit(READ_PROGRESS_DETAIL_CHANGED_EVENT, payload);
    }
  }
}

export type AgentReadAdvanceTracker = {
  /** Report the write's outcome; notes an advance when it moved the position. */
  finish(result: { maxReadSeq: number; changed: boolean }): void;
};

/**
 * For a cursor writer that does not return the position it moved from (the
 * read-mutation sequencer's acks): call before the write. Null while the flag
 * is off for the server (cached; no read); otherwise the position is read
 * first, and `finish` notes the move. A concurrent advance between the read
 * and the write can only make the range wider, never hide a move.
 */
export async function beginAgentReadAdvance(input: {
  serverId: string;
  scopeId: string;
  agentId: string;
}): Promise<AgentReadAdvanceTracker | null> {
  if (!socketServer) return null;
  try {
    if (!await agentReadProgressEnabled(input.serverId)) return null;
    const [row] = await getDb()
      .select({ lastReadSeq: agentChannelReadCursors.lastReadSeq })
      .from(agentChannelReadCursors)
      .where(and(
        eq(agentChannelReadCursors.agentId, input.agentId),
        eq(agentChannelReadCursors.channelId, input.scopeId),
      ))
      .limit(1);
    const from = Number(row?.lastReadSeq ?? 0);
    return {
      finish(result) {
        if (!result.changed) return;
        noteAgentReadAdvance({ ...input, from, to: result.maxReadSeq });
      },
    };
  } catch {
    // Read progress is best-effort: a failed read never fails the read write.
    return null;
  }
}

/**
 * The agents (of `ranges`) whose move passed a message the conversation shows
 * (see the module comment). One query: one EXISTS per agent over the
 * conversation's storage ids (`storageScopeId`: a joint conversation's
 * canonical id, see readScopeFaces) and (from, to].
 */
async function agentsPassingShownMessage(
  storageScopeId: string,
  ranges: Array<{ agentId: string; from: number; to: number }>,
): Promise<Set<string>> {
  if (ranges.length === 0) return new Set();
  const db = getDb();
  const storageIds = await resolveConversionReadChannelIds(db, storageScopeId);
  if (storageIds.length === 0) return new Set();
  const values = sql.join(
    ranges.map((range) => sql`(${range.agentId}::text, ${range.from}::bigint, ${range.to}::bigint)`),
    sql`, `,
  );
  const result = await db.execute(sql`
    SELECT moved.agent_id AS "agentId"
    FROM (VALUES ${values}) AS moved(agent_id, from_seq, to_seq)
    WHERE EXISTS (
      SELECT 1 FROM messages m
      WHERE m.channel_id = ANY(${`{${storageIds.join(",")}}`}::uuid[])
        AND m.seq > moved.from_seq
        AND m.seq <= moved.to_seq
        AND m.deleted_at IS NULL
    )
  `);
  return new Set((result.rows as Array<{ agentId: string }>).map((row) => String(row.agentId)));
}

/**
 * The frames for a batch: one per face of the conversation whose server has
 * the flag on (readScopeFaces: one face, or each server's projection of a
 * joint channel or thread), each under that face's id. Empty when it sends
 * none. Exported for tests.
 */
export async function buildAgentReadProgressFrames(batch: AgentReadProgressBatch): Promise<ReadProgressUpdatedPayload[]> {
  const { faces, storageScopeId } = await readScopeFaces(batch.serverId, batch.scopeId);
  const audiences: Array<{ scopeId: string; agentIds: Set<string> }> = [];
  for (const face of faces) {
    // The viewer's server decides (module comment, "Joint channels").
    if (!await agentReadProgressEnabled(face.serverId)) continue;
    if (!await isReadReceiptScope(face.serverId, face.scopeId)) continue;
    const exposed = await listExposedReadPeers(face.scopeId);
    // The channel detail serves a summary above the bound: no per-agent positions to move.
    if (exposed.length > READ_RECEIPT_PEER_STATE_LIMIT) continue;
    audiences.push({ scopeId: face.scopeId, agentIds: new Set(exposed.map((peer) => peer.peerId)) });
  }
  const ranges = [...batch.advances]
    .filter(([agentId]) => audiences.some((audience) => audience.agentIds.has(agentId)))
    .map(([agentId, range]) => ({ agentId, from: range.from, to: range.to }));
  if (ranges.length === 0) return [];
  const passed = await agentsPassingShownMessage(storageScopeId, ranges);
  const frames: ReadProgressUpdatedPayload[] = [];
  for (const audience of audiences) {
    const peers: ReadProgressPeer[] = ranges
      .filter((range) => passed.has(range.agentId) && audience.agentIds.has(range.agentId))
      .map((range) => ({ peerId: range.agentId, maxReadSeq: range.to }))
      .sort((left, right) => (left.peerId < right.peerId ? -1 : left.peerId > right.peerId ? 1 : 0));
    if (peers.length > 0) frames.push({ scopeId: audience.scopeId, peers });
  }
  return frames;
}

async function flushAgentReadProgress(batch: AgentReadProgressBatch): Promise<void> {
  if (!socketServer) return;
  const frames = await buildAgentReadProgressFrames(batch);
  for (const frame of frames) {
    // Re-read: the socket server may have closed while the frames were built.
    const io = socketServer;
    if (!io) return;
    // Only to watchers still in the conversation's `channel:<id>` room. The
    // watch room marks "has it open"; the channel room is "may still see it": a
    // person whose access is revoked (removed, the channel made private, left the
    // server, a Guest ended, a conversion's audience changed, a joint channel's
    // server disconnected) is taken out of the channel room on the spot
    // (socketsLeave at those sites), not out of read-progress rooms. So read
    // progress stops when the conversation's own messages stop, without every
    // revocation site knowing about watches.
    // A thread's sockets are not in `channel:<threadId>` (joined on demand only,
    // and private, DM and joint thread replies don't use it) and revocations
    // leave the parent's room: the room that says "may still see it" is the
    // membership authority's (a thread's parent channel or DM, a task's
    // channel; itself otherwise), on the frame's own face. One lookup per frame.
    const authorityId = await channelService.getChannelMembershipAuthorityChannelId(frame.scopeId);
    if (!authorityId) continue;
    const channelRoom = `channel:${authorityId}`;
    const watchers = await io.in(readProgressRoom(frame.scopeId)).fetchSockets();
    for (const watcher of watchers) {
      if (watcher.rooms.has(channelRoom)) watcher.emit(READ_PROGRESS_UPDATED_EVENT, frame);
    }
  }
}

// ── Watching ─────────────────────────────────────────────

type WatchSocket = Pick<Socket, "join" | "leave" | "emit" | "connected" | "data">;

type WatchState = {
  /** Watched scope ids, oldest first. */
  scopes: string[];
  /** The latest watch request per scope still being checked; an unwatch or a newer watch replaces it. */
  pending: Map<string, symbol>;
};

function watchState(socket: WatchSocket): WatchState {
  const data = socket.data as { readProgress?: WatchState };
  data.readProgress ??= { scopes: [], pending: new Map() };
  return data.readProgress;
}

export type WatchAgentReadProgressDeps = {
  flagEnabled: (serverId: string) => Promise<boolean>;
  canAccess: (scopeId: string, userId: string, serverId: ServerId) => Promise<boolean>;
  isEligible: (serverId: string, scopeId: string) => Promise<boolean>;
};

const defaultWatchDeps: WatchAgentReadProgressDeps = {
  flagEnabled: (serverId) => agentReadProgressEnabled(serverId, { fresh: true }),
  canAccess: (scopeId, userId, serverId) => channelService.canUserAccessChannel(scopeId, userId, serverId),
  isEligible: isReadReceiptScope,
};

/**
 * `read_progress:watch { scopeId }`: join the conversation's read-progress
 * room when allowed, and answer `read_progress:watched { scopeId, ok }`. A
 * body without a scope id is not answered. A request overtaken by an unwatch
 * or a newer watch of the same scope joins nothing and is not answered (the
 * newer request answers). Returns whether the socket now watches the scope.
 */
export async function watchAgentReadProgress(
  socket: WatchSocket,
  input: { userId: string; serverId: ServerId | null; body: unknown },
  deps: WatchAgentReadProgressDeps = defaultWatchDeps,
): Promise<boolean> {
  const scopeId = parseReadProgressScopeId(input.body);
  if (!scopeId) return false;
  const state = watchState(socket);
  const request = Symbol(scopeId);
  state.pending.set(scopeId, request);

  let ok = false;
  const serverId = input.serverId;
  if (serverId) {
    try {
      ok = await deps.flagEnabled(serverId)
        && await deps.canAccess(scopeId, input.userId, serverId)
        && await deps.isEligible(serverId, scopeId);
    } catch {
      // Malformed ids and failed reads fail closed, as join:channel does.
      ok = false;
    }
  }
  if (state.pending.get(scopeId) !== request) return false;
  state.pending.delete(scopeId);
  if (!socket.connected) return false;

  if (ok) {
    const existing = state.scopes.indexOf(scopeId);
    if (existing >= 0) state.scopes.splice(existing, 1);
    state.scopes.push(scopeId);
    socket.join(readProgressRoom(scopeId));
    while (state.scopes.length > READ_PROGRESS_MAX_WATCHED_SCOPES) {
      const oldest = state.scopes.shift()!;
      socket.leave(readProgressRoom(oldest));
    }
  }
  socket.emit(READ_PROGRESS_WATCHED_EVENT, { scopeId, ok });
  return ok;
}

/** `read_progress:unwatch { scopeId }`: leave the room, and cancel a watch of it still being checked. */
export function unwatchAgentReadProgress(socket: WatchSocket, body: unknown): void {
  const scopeId = parseReadProgressScopeId(body);
  if (!scopeId) return;
  const state = watchState(socket);
  state.pending.delete(scopeId);
  const index = state.scopes.indexOf(scopeId);
  if (index >= 0) state.scopes.splice(index, 1);
  socket.leave(readProgressRoom(scopeId));
}

/** Tests: forget cached flags and pending advances (their timers too). */
export function __resetAgentReadProgressForTests(): void {
  flagCache.clear();
  flagInFlight.clear();
  coalescer.clear();
}
