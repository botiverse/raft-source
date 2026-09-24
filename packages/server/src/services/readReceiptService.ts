import { and, eq, inArray } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index.js";
import { agentChannelReadCursors, userChannelReadCursors } from "../db/schema.js";
import * as channelService from "./channelService.js";
import { evaluateFeatureFlag, READ_RECEIPTS_FEATURE_FLAG_KEY } from "./featureFlagService.js";

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

async function readReceiptsEnabled(serverId: string): Promise<boolean> {
  try {
    const result = await evaluateFeatureFlag({
      key: READ_RECEIPTS_FEATURE_FLAG_KEY,
      serverId,
    });
    return result.enabled;
  } catch (error) {
    console.warn("[ReadReceipts] feature_flag_evaluation_failed", {
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
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
async function listExposedReadPeers(channelId: string): Promise<PeerIdentity[]> {
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

async function loadPeerReadStates(channelId: string, peers: PeerIdentity[]): Promise<PeerReadState[]> {
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
            eq(agentChannelReadCursors.channelId, channelId),
            inArray(agentChannelReadCursors.agentId, agentIds),
          )),
  ]);
  const humanWatermarks = new Map(humanRows.map((row) => [row.peerId, row.maxReadSeq]));
  const agentWatermarks = new Map(agentRows.map((row) => [row.peerId, row.maxReadSeq]));

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
  if (!await readReceiptsEnabled(input.serverId)) return null;

  const channel = await channelService.getChannel(input.channelId);
  if (
    !channel
    || channel.serverId !== input.serverId
    || !["channel", "private", "dm"].includes(channel.type)
    || channelService.isAllSystemChannel(channel)
  ) return null;

  const members = await listScopeMembers(input.channelId);
  const viewerIsMember = members.some((member) =>
    member.peerKind === input.viewerKind && member.peerId === input.viewerId
  );
  if (!viewerIsMember) return null;

  const exposedPeers = await listExposedReadPeers(input.channelId);
  const peers = exposedPeers.filter((member) =>
    member.peerKind !== input.viewerKind || member.peerId !== input.viewerId
  );
  const states = await loadPeerReadStates(input.channelId, peers);
  if (states.length <= READ_RECEIPT_PEER_STATE_LIMIT) {
    return { peerReadStates: states };
  }
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
  if (!input.changed || !input.io || !await readReceiptsEnabled(input.serverId)) return;

  const channel = await channelService.getChannel(input.scopeId);
  if (
    !channel
    || channel.serverId !== input.serverId
    || !["channel", "private", "dm"].includes(channel.type)
    || channelService.isAllSystemChannel(channel)
  ) return;

  // Only agents' reads are broadcast; a human read never reaches other clients.
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
  if (peerCount > READ_RECEIPT_PEER_STATE_LIMIT) {
    input.io.to(`channel:${input.scopeId}`).emit("scope_read:updated", {
      scopeId: input.scopeId,
      summaryChanged: true,
    });
    return;
  }

  input.io.to(`channel:${input.scopeId}`).emit("scope_read:updated", {
    scopeId: input.scopeId,
    peerKind: input.peerKind,
    peerId: input.peerId,
    maxReadSeq: input.maxReadSeq,
  });
}
