// Focus, part 1 (flag `agent_focus_v0`): the conversations an agent keeps in
// focus, in `agent_focus_targets`. This file is the state only: which
// conversations, in what order they are let go. Nothing here delivers or
// marks anything read; the routes (routes/agentFocusRoutes.ts) resolve the
// target and check that the agent can read it before calling in.
//
// At most AGENT_FOCUS_LIMIT conversations per agent. One more lets go of
// exactly enough to be back at the limit: entries Raft focused by itself
// (`auto`) first, least recently active first; an entry the agent focused
// (`manual`) only when no `auto` one is left. The conversation being focused
// is never the one let go. Entries the agent can no longer read are dropped
// first, under the same lock, so a dead entry never costs a live one its place.
//
// A row whose `unfocused_at` is set is not an entry. It is what is left of an
// entry the agent unfocused, kept so that Raft does not focus that
// conversation by itself again (docs/contracts/agent-focus.md, "Auto-focus").
// Every read here leaves such rows out, and every other reader of the table
// must too.
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { AGENT_FOCUS_FEATURE_FLAG_KEY as SHARED_AGENT_FOCUS_FEATURE_FLAG_KEY, AGENT_FOCUS_LIMIT, asChannelId, type AgentFocusSource, type ChannelId } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentFocusTargets } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { forgetFocusSets } from "./agentFocusDelivery";
import { evaluateFeatureFlag } from "./featureFlagService";

export { AGENT_FOCUS_LIMIT };

export type AgentFocusEntry = {
  id: string;
  agentId: string;
  /** The conversation's own channel row: a thread, a DM or a task conversation. */
  channelId: ChannelId;
  source: AgentFocusSource;
  focusedAt: Date;
  lastActiveAt: Date;
};

export type AgentFocusResult = {
  focused: AgentFocusEntry;
  /** True when the conversation was already focused: only its last-active time (and maybe its source) moved. */
  alreadyFocused: boolean;
  /** What was let go to stay within the limit, in the order it was chosen. */
  evicted: AgentFocusEntry[];
  /** Everything focused now, most recently active first. */
  entries: AgentFocusEntry[];
};

/** Whether Focus is on for this server (an evaluation failure reads as off). */
export async function agentFocusEnabled(serverId: string): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: SHARED_AGENT_FOCUS_FEATURE_FLAG_KEY, serverId })).enabled === true;
  } catch (err) {
    console.error("[AgentFocus] flag evaluation failed; reading it as off", serializeErrorForLog(err));
    return false;
  }
}

function toEntry(row: typeof agentFocusTargets.$inferSelect): AgentFocusEntry {
  return {
    id: row.id,
    agentId: row.agentId,
    channelId: asChannelId(row.channelId),
    source: row.source,
    focusedAt: row.focusedAt,
    lastActiveAt: row.lastActiveAt,
  };
}

/** Least recently active first; ties by when it was focused, then by id, so the order is total. */
function byLeastRecentlyActive(a: AgentFocusEntry, b: AgentFocusEntry): number {
  return a.lastActiveAt.getTime() - b.lastActiveAt.getTime()
    || a.focusedAt.getTime() - b.focusedAt.getTime()
    || a.id.localeCompare(b.id);
}

/** Most recently active first (the list order). */
export function orderFocusEntries(entries: readonly AgentFocusEntry[]): AgentFocusEntry[] {
  return [...entries].sort((a, b) => byLeastRecentlyActive(b, a));
}

/** A source never goes back from `manual` to `auto`. */
export function mergeFocusSource(current: AgentFocusSource, requested: AgentFocusSource): AgentFocusSource {
  return current === "manual" || requested === "manual" ? "manual" : "auto";
}

/**
 * Which entries to let go so that at most `limit` stay: exactly the excess,
 * `auto` ones first and then `manual` ones, least recently active first
 * within each, and never `keepChannelId`.
 */
export function pickFocusEvictions(
  entries: readonly AgentFocusEntry[],
  keepChannelId: ChannelId,
  limit: number = AGENT_FOCUS_LIMIT,
): AgentFocusEntry[] {
  const excess = entries.length - limit;
  if (excess <= 0) return [];
  const candidates = entries.filter((entry) => entry.channelId !== keepChannelId);
  const auto = candidates.filter((entry) => entry.source === "auto").sort(byLeastRecentlyActive);
  const manual = candidates.filter((entry) => entry.source === "manual").sort(byLeastRecentlyActive);
  return [...auto, ...manual].slice(0, excess);
}

/** At most this many unfocused conversations are remembered per agent; the oldest are forgotten first. */
export const AGENT_UNFOCUS_MEMORY = 20;

const agentLock = (agentId: string) => sql`hashtextextended(${`agent-focus:${agentId}`}, 0)`;

type FocusOptions = {
  now?: Date;
  stillReadable?: (channelIds: readonly ChannelId[], executor: DatabaseExecutor) => Promise<boolean[]>;
};

/** Why an auto-focus focused nothing: another call holds the agent's lock, or the agent unfocused the conversation. */
export type AutoFocusRefusal = "busy" | "unfocused" | "full";

/**
 * Focus a conversation, or refresh it when it is focused already. One
 * transaction under a per-agent lock, so two calls at once cannot leave more
 * than the limit. A conversation the agent had unfocused is focused again.
 *
 * `stillReadable` answers, per conversation, whether the agent can read it
 * now. Entries it says no to are deleted before anything is counted: they
 * are not reported as evicted, and they push nothing out. It is handed this
 * transaction and reads through it, so the check runs on the connection that
 * holds the lock whatever the caller's own database handle is, and never
 * waits for a second connection while other callers queue on the lock.
 */
export async function focus(agentId: string, channelId: ChannelId, source: AgentFocusSource, opts: FocusOptions = {}): Promise<AgentFocusResult> {
  return await focusLocked(agentId, channelId, source, { ...opts, wait: true }) as AgentFocusResult;
}

/**
 * How Raft focuses by itself: focus() with source `auto`, and two
 * differences, both so that it can run beside a delivery:
 * - it never waits for the agent's lock. When another call holds it the
 *   answer is `busy` and nothing is written;
 * - a conversation the agent unfocused stays unfocused (`unfocused`) unless
 *   `unfocusLifted` says the agent has come back to it since. It gets the
 *   time of the unfocus and this transaction;
 * - it never lets go of an entry the agent focused by hand. When every place
 *   is taken by a `manual` entry the answer is `full` and nothing is written:
 *   what the agent chose holds until the agent acts again, as an unfocus does.
 */
export async function autoFocus(
  agentId: string,
  channelId: ChannelId,
  opts: FocusOptions & { unfocusLifted?: (unfocusedAt: Date, executor: DatabaseExecutor) => Promise<boolean> } = {},
): Promise<AgentFocusResult | AutoFocusRefusal> {
  return focusLocked(agentId, channelId, "auto", { ...opts, wait: false });
}

async function focusLocked(
  agentId: string,
  channelId: ChannelId,
  source: AgentFocusSource,
  opts: Parameters<typeof autoFocus>[2] & { wait: boolean },
): Promise<AgentFocusResult | AutoFocusRefusal> {
  const now = opts.now ?? new Date();
  const changed = new Set<string>([channelId]);
  const result = await getDb().transaction(async (tx): Promise<AgentFocusResult | AutoFocusRefusal> => {
    if (!opts.wait) {
      const got = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${agentLock(agentId)}) AS locked`);
      if ((got.rows[0] as { locked?: boolean } | undefined)?.locked !== true) return "busy";
    } else {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${agentLock(agentId)})`);
    }
    const rows = await tx.select().from(agentFocusTargets).where(eq(agentFocusTargets.agentId, agentId));
    // What is left of an unfocus of this conversation, if anything.
    const unfocusedRow = rows.find((row) => row.channelId === channelId && row.unfocusedAt !== null);
    if (unfocusedRow && !opts.wait && !(await opts.unfocusLifted?.(unfocusedRow.unfocusedAt!, tx))) return "unfocused";
    const stored = rows.filter((row) => row.unfocusedAt === null).map(toEntry);
    // The conversation being focused was checked by the caller just now.
    const others = stored.filter((entry) => entry.channelId !== channelId);
    const readable = opts.stillReadable && others.length > 0
      ? await opts.stillReadable(others.map((entry) => entry.channelId), tx)
      : others.map(() => true);
    const dead = others.filter((_, index) => !readable[index]);
    if (dead.length > 0) {
      await tx.delete(agentFocusTargets).where(inArray(agentFocusTargets.id, dead.map((entry) => entry.id)));
    }
    for (const entry of dead) changed.add(entry.channelId);
    const deadIds = new Set(dead.map((entry) => entry.id));
    const before = stored.filter((entry) => !deadIds.has(entry.id));
    const existing = before.find((entry) => entry.channelId === channelId);
    // Raft focusing by itself takes a free place or an `auto` entry's place, never a `manual` one's.
    if (!opts.wait && !existing && before.length >= AGENT_FOCUS_LIMIT && before.every((entry) => entry.source === "manual")) return "full";
    let focused: AgentFocusEntry;
    if (existing) {
      const [row] = await tx.update(agentFocusTargets)
        .set({ lastActiveAt: now, source: mergeFocusSource(existing.source, source) })
        .where(eq(agentFocusTargets.id, existing.id))
        .returning();
      focused = toEntry(row!);
    } else if (unfocusedRow) {
      // The same row becomes an entry again, as if it were new.
      const [row] = await tx.update(agentFocusTargets)
        .set({ source, focusedAt: now, lastActiveAt: now, unfocusedAt: null })
        .where(eq(agentFocusTargets.id, unfocusedRow.id))
        .returning();
      focused = toEntry(row!);
    } else {
      const [row] = await tx.insert(agentFocusTargets)
        .values({ agentId, channelId, source, focusedAt: now, lastActiveAt: now })
        .returning();
      focused = toEntry(row!);
    }
    const all = [...before.filter((entry) => entry.id !== focused.id), focused];
    // Let go by the limit: the row is deleted, so only a deliberate unfocus is remembered.
    const evicted = pickFocusEvictions(all, channelId);
    if (evicted.length > 0) {
      await tx.delete(agentFocusTargets).where(inArray(agentFocusTargets.id, evicted.map((entry) => entry.id)));
    }
    for (const entry of evicted) changed.add(entry.channelId);
    const gone = new Set(evicted.map((entry) => entry.id));
    return {
      focused,
      alreadyFocused: Boolean(existing),
      evicted,
      entries: orderFocusEntries(all.filter((entry) => !gone.has(entry.id))),
    };
  });
  // After the commit: the delivery tag re-reads these conversations' focus sets.
  if (typeof result !== "string") forgetFocusSets(changed);
  return result;
}

/**
 * Move a focused conversation's last-active time, and nothing else: one
 * statement, no lock, and no wait (a row another transaction holds is
 * skipped). False when nothing was moved.
 */
export async function touch(agentId: string, channelId: ChannelId, now: Date = new Date()): Promise<boolean> {
  const touched = await getDb().execute(sql`
    UPDATE agent_focus_targets SET last_active_at = ${now.toISOString()}::timestamptz
    WHERE id = (
      SELECT id FROM agent_focus_targets
      WHERE agent_id = ${agentId}::uuid AND channel_id = ${channelId}::uuid AND unfocused_at IS NULL
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  return touched.rows.length > 0;
}

/**
 * The agent stops focusing a conversation. Idempotent: `wasFocused` is false
 * when it was not focused, and then nothing is written. The entry's row
 * stays, marked unfocused, so that Raft does not focus the conversation by
 * itself again; at most AGENT_UNFOCUS_MEMORY such rows are kept per agent.
 */
export async function unfocus(agentId: string, channelId: ChannelId, opts: { now?: Date } = {}): Promise<{ wasFocused: boolean }> {
  const wasFocused = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${agentLock(agentId)})`);
    const marked = await tx.update(agentFocusTargets)
      .set({ unfocusedAt: opts.now ?? new Date() })
      .where(and(eq(agentFocusTargets.agentId, agentId), eq(agentFocusTargets.channelId, channelId), isNull(agentFocusTargets.unfocusedAt)))
      .returning({ id: agentFocusTargets.id });
    if (marked.length === 0) return false;
    const remembered = await tx.select({ id: agentFocusTargets.id }).from(agentFocusTargets)
      .where(and(eq(agentFocusTargets.agentId, agentId), isNotNull(agentFocusTargets.unfocusedAt)))
      .orderBy(desc(agentFocusTargets.unfocusedAt), desc(agentFocusTargets.id));
    const forgotten = remembered.slice(AGENT_UNFOCUS_MEMORY).map((row) => row.id);
    if (forgotten.length > 0) await tx.delete(agentFocusTargets).where(inArray(agentFocusTargets.id, forgotten));
    return true;
  });
  forgetFocusSets([channelId]);
  return { wasFocused };
}

/** Remove an entry the agent can no longer read. Nothing is remembered: this is not the agent's choice. */
export async function drop(agentId: string, channelId: ChannelId): Promise<void> {
  await getDb().delete(agentFocusTargets)
    .where(and(eq(agentFocusTargets.agentId, agentId), eq(agentFocusTargets.channelId, channelId), isNull(agentFocusTargets.unfocusedAt)));
  forgetFocusSets([channelId]);
}

/** What the agent has in focus, most recently active first. */
export async function list(agentId: string): Promise<AgentFocusEntry[]> {
  const rows = await getDb().select().from(agentFocusTargets)
    .where(and(eq(agentFocusTargets.agentId, agentId), isNull(agentFocusTargets.unfocusedAt)));
  return orderFocusEntries(rows.map(toEntry));
}
