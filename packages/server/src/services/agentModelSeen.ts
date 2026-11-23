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
  return contiguousSeenWalk(priorReadSeq, reportedSeqs, conversationRowsAfterPrior, settledBeforeMs).upTo;
}

/**
 * The same walk, also saying whether it was a reported row still inside the
 * settle window that stopped it (`unsettled`). That stop passes by itself
 * once the row is old enough; a message that was not shown never does.
 */
export function contiguousSeenWalk(
  priorReadSeq: number,
  reportedSeqs: ReadonlySet<number>,
  conversationRowsAfterPrior: readonly { seq: number; createdAtMs: number }[],
  settledBeforeMs: number,
): { upTo: number; unsettled: boolean } {
  let upTo = priorReadSeq;
  for (const row of conversationRowsAfterPrior) {
    if (row.seq <= upTo) continue;
    if (!reportedSeqs.has(row.seq)) return { upTo, unsettled: false };
    if (row.createdAtMs > settledBeforeMs) return { upTo, unsettled: true };
    upTo = row.seq;
  }
  return { upTo, unsettled: false };
}

export type AgentModelSeenOutcome =
  | { outcome: "advanced"; fromSeq: number; toSeq: number; unsettledSeqs?: number[] }
  | { outcome: "unchanged"; reason: "no_access" | "not_after_read_position" | "gap"; unsettledSeqs?: number[] };

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
  const { upTo, unsettled } = contiguousSeenWalk(
    prior,
    reported,
    rows.map((row) => ({ seq: row.seq, createdAtMs: row.createdAt.getTime() })),
    settledBeforeMs,
  );
  // What a too-new row kept back: the reported seqs past the stop, for a later try.
  const held = unsettled ? { unsettledSeqs: [...reported].filter((seq) => seq > upTo).sort((a, b) => a - b) } : {};
  if (upTo <= prior) return { outcome: "unchanged", reason: "gap", ...held };
  await channelService.markRead({ kind: "agent", id: agentId }, channelId, upTo);
  return { outcome: "advanced", fromSeq: prior, toSeq: upTo, ...held };
}

export type AgentModelSeenReplayTrigger = "timer" | "next_report";

export interface AgentModelSeenReplayEvent {
  /** `advanced`: the read position moved over at least one kept-back seq. */
  outcome: "advanced" | "unchanged";
  trigger: AgentModelSeenReplayTrigger;
  /** Why nothing moved; `unsettled` is a row still too new at the second look. */
  reason?: "no_access" | "not_after_read_position" | "gap" | "unsettled" | "error";
  agent_id: string;
  channel_id: string;
  held_count: number;
  from_seq?: number;
  to_seq?: number;
}

export interface AgentModelSeenReplayDeps {
  apply?: typeof applyAgentModelSeen;
  record?: (event: AgentModelSeenReplayEvent) => void;
  /** How long after a kept-back report the second look runs. */
  delayMs?: number;
}

/**
 * The row's age is judged against this process's clock while the row carries
 * the database's; the second look waits this much past the window so a small
 * difference between the two does not make it find the same row too new again.
 */
const REPLAY_CLOCK_SLACK_MS = 250;
/** Past this many conversations waiting, a kept-back report is not remembered (bounds memory). */
const MAX_PENDING_REPLAYS = 5_000;

type ReplayInput = Parameters<typeof applyAgentModelSeen>[0];

// replica-local: a Computer's reports arrive on one socket, so on one replica.
// Lost on restart: the position then waits for the agent's next read or report.
const pendingReplays = new Map<string, { seqs: Set<number>; timer: ReturnType<typeof setTimeout> }>();

/** Test seam: how many conversations have a second look pending. */
export function pendingAgentModelSeenReplayCount(): number {
  return pendingReplays.size;
}

/** Test seam: forget every pending second look. */
export function __clearAgentModelSeenReplaysForTests(): void {
  for (const pending of pendingReplays.values()) clearTimeout(pending.timer);
  pendingReplays.clear();
}

/**
 * Apply one conversation's report, and look once more at what the settle
 * window kept back. A daemon reports each message once, so without the second
 * look a report that arrives within READ_POSITION_SETTLE_MS of its message is
 * lost for the read position.
 *
 * The seqs kept back are remembered per (agent, conversation). They are tried
 * again with the agent's next report for that conversation, or by one timer
 * after the window when no report comes. The second look is the same
 * `applyAgentModelSeen`: it re-reads the position, so it only moves forward
 * and running it twice changes nothing; a message that was not shown still
 * stops it. The timer's look is the last one: what it cannot move is dropped.
 */
export async function applyAgentModelSeenWithReplay(
  input: ReplayInput,
  deps: AgentModelSeenReplayDeps = {},
): Promise<AgentModelSeenOutcome> {
  const apply = deps.apply ?? applyAgentModelSeen;
  const key = `${input.agentId}:${input.channelId}`;
  const pending = pendingReplays.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingReplays.delete(key);
  }
  const heldBefore = pending ? [...pending.seqs] : [];
  const result = await apply(pending ? { ...input, seqs: [...new Set([...heldBefore, ...input.seqs])] } : input);
  if (pending) recordReplay(deps, input, "next_report", heldBefore, result);
  const held = result.unsettledSeqs ?? [];
  if (held.length === 0) return result;
  // A report that came in while this one was applied left its own entry: join it.
  const racing = pendingReplays.get(key);
  if (racing) clearTimeout(racing.timer);
  else if (pendingReplays.size >= MAX_PENDING_REPLAYS) return result;
  const seqs = new Set([...(racing?.seqs ?? []), ...held].sort((a, b) => a - b).slice(0, MAX_SEQS_PER_ITEM));
  const timer = setTimeout(() => {
    const entry = pendingReplays.get(key);
    if (!entry || entry.timer !== timer) return;
    pendingReplays.delete(key);
    const kept = [...entry.seqs];
    apply({ ...input, seqs: kept }).then(
      (again) => recordReplay(deps, input, "timer", kept, again),
      () => safeRecord(deps, { outcome: "unchanged", trigger: "timer", reason: "error", agent_id: input.agentId, channel_id: input.channelId, held_count: kept.length }),
    );
  }, deps.delayMs ?? READ_POSITION_SETTLE_MS + REPLAY_CLOCK_SLACK_MS);
  timer.unref?.();
  pendingReplays.set(key, { seqs, timer });
  return result;
}

function recordReplay(
  deps: AgentModelSeenReplayDeps,
  input: ReplayInput,
  trigger: AgentModelSeenReplayTrigger,
  held: readonly number[],
  result: AgentModelSeenOutcome,
): void {
  const base = { trigger, agent_id: input.agentId, channel_id: input.channelId, held_count: held.length };
  // Moved over a kept-back seq, not only over what the new report brought.
  const firstHeld = Math.min(...held);
  if (result.outcome === "advanced" && result.toSeq >= firstHeld) {
    safeRecord(deps, { outcome: "advanced", ...base, from_seq: result.fromSeq, to_seq: result.toSeq });
    return;
  }
  const stillTooNew = Boolean(result.unsettledSeqs?.length);
  // Kept back again alongside a newer report: still waiting, so not an answer yet.
  if (stillTooNew && trigger === "next_report") return;
  const reason = stillTooNew ? "unsettled" : result.outcome === "unchanged" ? result.reason : "gap";
  safeRecord(deps, { outcome: "unchanged", ...base, reason });
}

function safeRecord(deps: AgentModelSeenReplayDeps, event: AgentModelSeenReplayEvent): void {
  try {
    deps.record?.(event);
  } catch {
    // Telemetry never decides whether a read position moves.
  }
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
