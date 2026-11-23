import { and, eq, inArray } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index";
import { agentChannelReadCursors, userChannelReadCursors } from "../db/schema";
import * as channelService from "./channelService";

export const READ_RECEIPT_PEER_STATE_LIMIT = 50;

export type ReadReceiptPeerKind = "human" | "agent";

export type PeerReadState = {
  peerKind: ReadReceiptPeerKind;
  peerId: string;
  maxReadSeq: number;
};

export type PeerReadSummary = {
  peerCount: number;
  readCountAtSeq: Array<{ seq: number; count: number }>;
};

export type PeerReadHydrate =
  | { peerReadStates: PeerReadState[] }
  | { peerReadSummary: PeerReadSummary };

type PeerIdentity = Pick<PeerReadState, "peerKind" | "peerId">;

const READ_RECEIPT_SCOPE_TYPES = ["channel", "private", "joint", "dm"];

/**
 * Whether `scopeId` carries read receipts. A thread has no membership of its
 * own (getChannelMembers delegates to the parent), so it is eligible exactly
 * when its parent channel or DM is: threads under #all stay excluded for the
 * same reasons #all is. A joint channel (and a thread under one) is eligible on
 * each server's own projection: what it exposes is agents only, as everywhere
 * (listExposedReadPeers), and the agents of every server in it (readScopeFaces).
 */
export async function isReadReceiptScope(serverId: string, scopeId: string): Promise<boolean> {
  return (await readReceiptScopeChannel(serverId, scopeId)) !== null;
}

type ScopeChannel = NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>;

/** isReadReceiptScope, answering with the scope's channel row (null when not a scope). */
async function readReceiptScopeChannel(serverId: string, scopeId: string): Promise<ScopeChannel | null> {
  const channel = await channelService.getChannel(scopeId);
  if (!channel || channel.serverId !== serverId) return null;
  if (channel.type !== "thread") {
    return READ_RECEIPT_SCOPE_TYPES.includes(channel.type) && !channelService.isAllSystemChannel(channel) ? channel : null;
  }
  const parentId = await channelService.getChannelMembershipAuthorityChannelId(channel.id);
  if (!parentId) return null;
  const parent = await channelService.getChannel(parentId);
  return !!parent
    && parent.serverId === serverId
    && READ_RECEIPT_SCOPE_TYPES.includes(parent.type)
    && !channelService.isAllSystemChannel(parent)
    ? channel
    : null;
}

/** One server's face of a conversation: the id that server's people open it by. */
export type ReadScopeFace = { serverId: string; scopeId: string };

export type ReadScopeFaces = {
  /** Every active server's face, `scopeId`'s own included. One for a conversation that is not joint. */
  faces: ReadScopeFace[];
  /** Where the conversation's messages are stored: a joint channel's or joint thread's canonical id, else `scopeId`. */
  storageScopeId: string;
};

/**
 * The faces of `scopeId` (a conversation of `serverId`). A joint channel, and a
 * thread under one, has one local projection per active server, and each
 * server's people and agents use their own: an agent's read cursor is on its
 * own server's projection, and that server's sockets sit in that projection's
 * rooms. So reading every agent's position, and reaching every viewer, takes
 * all of them. Any other conversation is its own only face.
 */
export async function readScopeFaces(
  serverId: string,
  scopeId: string,
  /** The scope's row when the caller already has it (one query fewer). */
  knownChannel?: ScopeChannel,
): Promise<ReadScopeFaces> {
  const own: ReadScopeFaces = { faces: [{ serverId, scopeId }], storageScopeId: scopeId };
  const channel = knownChannel ?? await channelService.getChannel(scopeId);
  if (!channel || channel.serverId !== serverId) return own;
  if (channel.type === "joint") {
    const projections = await channelService.getActiveJointChannelProjectionsByLocalChannel(scopeId);
    if (!projections.some((projection) => projection.localChannelId === scopeId && projection.serverId === serverId)) return own;
    return {
      faces: projections.map((projection) => ({ serverId: projection.serverId, scopeId: projection.localChannelId })),
      storageScopeId: projections[0]!.canonicalChannelId,
    };
  }
  if (channel.type !== "thread") return own;
  const thread = await channelService.getJointThreadProjectionByLocalThread(scopeId, serverId);
  if (!thread) return own;
  const projections = await channelService.getActiveJointThreadProjectionsByCanonicalThread(thread.canonicalThreadChannelId);
  return {
    faces: projections.map((projection) => ({ serverId: projection.localServerId, scopeId: projection.localThreadChannelId })),
    storageScopeId: thread.canonicalThreadChannelId,
  };
}

/** Channel membership — used ONLY to authorize who may read receipts. */
async function listScopeMembers(channelId: string): Promise<PeerIdentity[]> {
  const members = await channelService.getChannelMembers(channelId);
  return [
    ...members.humans.map((human) => ({ peerKind: "human" as const, peerId: human.id })),
    ...members.agents.map((agent) => ({ peerKind: "agent" as const, peerId: agent.id })),
  ];
}

/**
 * Whose read state may be EXPOSED: agents only. A human's read state must never
 * leave the server (artin, 2026-07-27, task #693).
 *
 * Hiding it in the UI is not enough — this feeds both the hydrate payload and
 * the realtime `scope_read:updated` broadcast, and that broadcast goes to the
 * whole `channel:<id>` room. Including humans would ship "who read your message,
 * and when" to every other client, trivially observable in devtools no matter
 * what the UI draws.
 *
 * Deliberately separate from `listScopeMembers`: humans must still be able to
 * FETCH (they are the audience for agent badges) — they just must not be
 * SUBJECTS. Collapsing the two is how a human viewer would either lose the
 * feature or leak their own peers.
 */
export async function listExposedReadPeers(channelId: string): Promise<PeerIdentity[]> {
  const members = await channelService.getChannelMembers(channelId);
  return members.agents.map((agent) => ({ peerKind: "agent" as const, peerId: agent.id }));
}

function buildPeerReadSummary(states: PeerReadState[]): PeerReadSummary {
  const watermarkCounts = new Map<number, number>();
  for (const state of states) {
    watermarkCounts.set(state.maxReadSeq, (watermarkCounts.get(state.maxReadSeq) ?? 0) + 1);
  }

  let cumulative = 0;
  const readCountAtSeq = [...watermarkCounts.entries()]
    .sort(([left], [right]) => right - left)
    .map(([seq, count]) => {
      cumulative += count;
      return { seq, count: cumulative };
    })
    .reverse();

  return { peerCount: states.length, readCountAtSeq };
}

/**
 * The peers' read positions. An agent's cursor is on its own server's face of
 * the conversation, so agents are looked up in every face (`agentScopeIds`,
 * readScopeFaces); an agent belongs to one server, and the highest position
 * found counts.
 */
async function loadPeerReadStates(channelId: string, peers: PeerIdentity[], agentScopeIds: string[] = [channelId]): Promise<PeerReadState[]> {
  const humanIds = peers.filter((peer) => peer.peerKind === "human").map((peer) => peer.peerId);
  const agentIds = peers.filter((peer) => peer.peerKind === "agent").map((peer) => peer.peerId);
  const db = getDb();
  const [humanRows, agentRows] = await Promise.all([
    humanIds.length === 0
      ? []
      : db
          .select({ peerId: userChannelReadCursors.userId, maxReadSeq: userChannelReadCursors.lastReadSeq })
          .from(userChannelReadCursors)
          .where(and(
            eq(userChannelReadCursors.channelId, channelId),
            inArray(userChannelReadCursors.userId, humanIds),
          )),
    agentIds.length === 0
      ? []
      : db
          .select({ peerId: agentChannelReadCursors.agentId, maxReadSeq: agentChannelReadCursors.lastReadSeq })
          .from(agentChannelReadCursors)
          .where(and(
            agentScopeIds.length === 1
              ? eq(agentChannelReadCursors.channelId, agentScopeIds[0]!)
              : inArray(agentChannelReadCursors.channelId, agentScopeIds),
            inArray(agentChannelReadCursors.agentId, agentIds),
          )),
  ]);
  const humanWatermarks = new Map(humanRows.map((row) => [row.peerId, row.maxReadSeq]));
  const agentWatermarks = new Map<string, number>();
  for (const row of agentRows) {
    agentWatermarks.set(row.peerId, Math.max(agentWatermarks.get(row.peerId) ?? 0, row.maxReadSeq));
  }

  return peers
    .map((peer): PeerReadState => ({
      ...peer,
      maxReadSeq: peer.peerKind === "human"
        ? humanWatermarks.get(peer.peerId) ?? 0
        : agentWatermarks.get(peer.peerId) ?? 0,
    }))
    .sort((left, right) => {
      if (left.peerKind !== right.peerKind) return left.peerKind < right.peerKind ? -1 : 1;
      if (left.peerId === right.peerId) return 0;
      return left.peerId < right.peerId ? -1 : 1;
    });
}

export async function getPeerReadHydrate(input: {
  serverId: string;
  channelId: string;
  viewerKind: ReadReceiptPeerKind;
  viewerId: string;
}): Promise<PeerReadHydrate | null> {
  const scopeChannel = await readReceiptScopeChannel(input.serverId, input.channelId);
  if (!scopeChannel) return null;

  const members = await listScopeMembers(input.channelId);
  const viewerIsMember = members.some((member) =>
    member.peerKind === input.viewerKind && member.peerId === input.viewerId
  );
  if (!viewerIsMember) return null;

  const exposedPeers = await listExposedReadPeers(input.channelId);
  const peers = exposedPeers.filter((member) =>
    member.peerKind !== input.viewerKind || member.peerId !== input.viewerId
  );
  const { faces } = await readScopeFaces(input.serverId, input.channelId, scopeChannel);
  const faceIds = faces.map((face) => face.scopeId);
  const states = await loadPeerReadStates(input.channelId, peers, faceIds);
  if (states.length <= READ_RECEIPT_PEER_STATE_LIMIT) return { peerReadStates: states };
  return { peerReadSummary: buildPeerReadSummary(states) };
}

export async function emitScopeReadUpdated(input: {
  io?: SocketServer;
  serverId: string;
  scopeId: string;
  peerKind: ReadReceiptPeerKind;
  peerId: string;
  maxReadSeq: number;
  changed: boolean;
}): Promise<void> {
  // Must stay the first check. Only agents' reads are broadcast (the exposed
  // peers below are agents-only), so a human actor can never pass the member
  // check. Deciding that after the channel/member queries cost ~10
  // queries per scope for nothing -- and read-all fans this out concurrently
  // over every changed scope, enough to saturate the connection pool.
  if (input.peerKind === "human") return;
  if (!input.changed || !input.io) return;

  const scopeChannel = await readReceiptScopeChannel(input.serverId, input.scopeId);
  if (!scopeChannel) return;

  // Only agents' reads are broadcast; a human read never reaches other clients
  // (human actors already returned at the top).
  const members = await listExposedReadPeers(input.scopeId);
  const actorIsMember = members.some((member) =>
    member.peerKind === input.peerKind && member.peerId === input.peerId
  );
  if (!actorIsMember) return;

  // Threshold on the FULL exposed-peer count, not `length - 1`.
  //
  // The `- 1` was "exclude self" from when `members` still contained humans and
  // the actor was always inside it. Now `members` is agents-only, so for a human
  // viewer the actor is not subtracted from *their* hydrate: at exactly
  // LIMIT + 1 agents the hydrate is a summary (states.length > LIMIT) while the
  // emitter saw LIMIT and pushed a detailed frame. A summary scope ignores
  // detailed frames by design, so the count froze permanently.
  //
  // This frame goes to one shared `channel:<id>` room, so its shape must be
  // conservative for the widest legitimate audience: above the limit everyone
  // gets `summaryChanged`. An agent viewer whose own hydrate is still per-peer
  // safely ignores it; a human viewer's summary rehydrates correctly.
  const peerCount = members.length;
  // A joint conversation: every server's face hears it, each under its own id
  // (readScopeFaces). The exposed agents are the same from every face
  // (getChannelMembers merges the servers' agents).
  const { faces } = await readScopeFaces(input.serverId, input.scopeId, scopeChannel);
  for (const face of faces) {
    if (face.scopeId !== input.scopeId) {
      if (!await isReadReceiptScope(face.serverId, face.scopeId)) continue;
    }
    if (peerCount > READ_RECEIPT_PEER_STATE_LIMIT) {
      input.io.to(`channel:${face.scopeId}`).emit("scope_read:updated", {
        scopeId: face.scopeId,
        summaryChanged: true,
      });
      continue;
    }
    input.io.to(`channel:${face.scopeId}`).emit("scope_read:updated", {
      scopeId: face.scopeId,
      peerKind: input.peerKind,
      peerId: input.peerId,
      maxReadSeq: input.maxReadSeq,
    });
  }
}
