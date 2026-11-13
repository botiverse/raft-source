import { isSubConversationType } from "@botiverse/raft-shared";
import { and, asc, eq, gt, lte, ne, or } from "drizzle-orm";

import { getDb } from "../db";
import { messages } from "../db/schema";
import * as channelService from "./channelService";
import { READ_POSITION_SETTLE_MS } from "./readPositionSettle";

/**
 * How far an agent's read position may move over messages its daemon reported
 * the model was shown (`agent:model-seen`): along the conversation's messages
 * after the current position, as long as each one was reported. The first
 * message that was not shown stops it, so a sparse report (one mention in a
 * long gap) never marks the unshown messages before it read. The agent's own
 * messages do not count as a gap (the caller leaves them out). A row created
 * after `settledBeforeMs` also stops it: a lower seq may still be committing
 * behind it (READ_POSITION_SETTLE_MS).
 */
export function contiguousSeenUpTo(
  priorReadSeq: number,
  reportedSeqs: ReadonlySet<number>,
  conversationRowsAfterPrior: readonly { seq: number; createdAtMs: number }[],
  settledBeforeMs: number,
): number {
  let upTo = priorReadSeq;
  for (const row of conversationRowsAfterPrior) {
    if (row.seq <= upTo) continue;
    if (row.createdAtMs > settledBeforeMs) break;
    if (!reportedSeqs.has(row.seq)) break;
    upTo = row.seq;
  }
  return upTo;
}

export type AgentModelSeenOutcome =
  | { outcome: "advanced"; fromSeq: number; toSeq: number }
  | { outcome: "unchanged"; reason: "no_access" | "not_after_read_position" | "gap" };

export interface ApplyAgentModelSeenOptions {
  now?: () => number;
}

const MAX_SEQS_PER_ITEM = 2_000;


/** Apply one conversation's report to the agent's read position. */
export async function applyAgentModelSeen(input: {
  agentId: string;
  serverId: string | null;
  channelId: string;
  seqs: readonly number[];
}, options: ApplyAgentModelSeenOptions = {}): Promise<AgentModelSeenOutcome> {
  const { agentId, channelId } = input;
  // The conversation must belong to the agent's own server before anything is
  // read for it; the access check alone admits other servers' public channels.
  const channel = input.serverId ? await channelService.getChannel(channelId) : null;
  if (!channel || channel.serverId !== input.serverId) {
    return { outcome: "unchanged", reason: "no_access" };
  }
  if (!await channelService.canAgentAccessChannel(channelId, agentId)) {
    return { outcome: "unchanged", reason: "no_access" };
  }
  const prior = Math.max(0, Number(await channelService.getAgentLegacyReadCursor(agentId, channelId)) || 0);
  const reported = new Set(
    input.seqs.filter((seq) => Number.isInteger(seq) && seq > prior).slice(0, MAX_SEQS_PER_ITEM),
  );
  if (reported.size === 0) return { outcome: "unchanged", reason: "not_after_read_position" };
  const maxReported = Math.max(...reported);

  // Joint conversations keep their rows under the canonical channel; the read
  // position stays keyed by this server's projection (as history reads do).
  const storageChannelId = await resolveStorageChannelId(channel, input.serverId);
  const rows = await getDb()
    .select({ seq: messages.seq, createdAt: messages.createdAt })
    .from(messages)
    .where(and(
      eq(messages.channelId, storageChannelId),
      gt(messages.seq, prior),
      lte(messages.seq, maxReported),
      or(ne(messages.senderType, "agent"), ne(messages.senderId, agentId)),
    ))
    .orderBy(asc(messages.seq));
  const settledBeforeMs = (options.now ?? Date.now)() - READ_POSITION_SETTLE_MS;
  const upTo = contiguousSeenUpTo(
    prior,
    reported,
    rows.map((row) => ({ seq: row.seq, createdAtMs: row.createdAt.getTime() })),
    settledBeforeMs,
  );
  if (upTo <= prior) return { outcome: "unchanged", reason: "gap" };
  await channelService.markRead({ kind: "agent", id: agentId }, channelId, upTo);
  return { outcome: "advanced", fromSeq: prior, toSeq: upTo };
}

async function resolveStorageChannelId(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
  serverId: string | null,
): Promise<string> {
  const channelId = channel.id;
  if (!serverId) return channelId;
  if (isSubConversationType(channel.type)) {
    const projection = await channelService.getJointThreadProjectionByLocalThread(channelId, serverId);
    return projection?.canonicalThreadChannelId ?? channelId;
  }
  if (channel.type === "joint") {
    const access = await channelService.resolveChannelAccess({ serverId, channelId });
    return access?.kind === "joint" ? access.canonicalChannelId : channelId;
  }
  return channelId;
}
