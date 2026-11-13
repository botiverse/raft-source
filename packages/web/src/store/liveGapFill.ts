/**
 * Holes behind live rows of the open channel (messageStore addMessage /
 * syncGap).
 *
 * Message seqs are server-global (a bigserial over every channel), so nearly
 * every live row "jumps" past the channel's newest seq. The row is shown at
 * once; the hole before it (`holeFrom`, the window tail when it arrived) is
 * filled by a background GET /messages/sync and stays unconfirmed (the
 * channel `hasGap`) until a read from at most `holeFrom`, started after the
 * row arrived (`epoch`), answers. A row that lands while that read is in
 * flight gets a read of its own after it; a failed read is retried with
 * backoff up to a cap, after which the heartbeat, a focus or a reconnect
 * re-reads the scope (socketBridge, heartbeatGate.ts).
 */
import type { Message } from "./messageStore";

/** A failed fill retries after 1, 2, 4, 8 and 16 s, then leaves the hole to the heartbeat. */
export const GAP_FILL_RETRY_BASE_MS = 1_000;
export const GAP_FILL_MAX_RETRIES = 5;

type PendingGapEntry = { message: Message; holeFrom: number; epoch: number };
type GapRead = { rerunSince: number | null; generation: number };
export type GapReadOutcome = "read" | "failed" | "abandoned";

const pendingGapMessages = new Map<string, PendingGapEntry[]>();
let pendingGapEpoch = 0;
/** Bumped by a full reset (server switch, logout): a read started before it asks for nothing after. */
let gapFillGeneration = 0;
/** One /messages/sync per scope at a time; a read asked for meanwhile runs after it, from the lowest seq asked. */
const gapReadsInFlight = new Map<string, GapRead>();
/** One scheduled gap fill per channel (a burst of live rows asks once). */
const gapFillTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Failed gap fills in a row, per channel. */
const gapFillFailures = new Map<string, number>();

let readGap: ((channelId: string, sinceSeq: number) => void) | null = null;

/** messageStore: how a scheduled fill reads (its syncGap). */
export function setGapFillReader(reader: (channelId: string, sinceSeq: number) => void): void {
  readGap = reader;
}

/** The live rows of `channelId` whose hole is still unconfirmed. */
export function getPendingGapMessages(channelId: string): Message[] {
  return (pendingGapMessages.get(channelId) ?? []).map((entry) => entry.message);
}

/** A live row shown across a seq jump from `holeFrom`: fill the hole behind it. */
export function rememberPendingGapMessage(message: Message, holeFrom: number): void {
  if (!message.seq) return;
  const pending = pendingGapMessages.get(message.channelId) ?? [];
  if (pending.some((entry) => entry.message.id === message.id)) return;
  pendingGapEpoch += 1;
  pendingGapMessages.set(message.channelId, [...pending, { message, holeFrom, epoch: pendingGapEpoch }]);
  scheduleGapFill(message.channelId, 0);
}

function cancelGapFill(channelId?: string): void {
  for (const [key, timer] of gapFillTimers) {
    if (channelId !== undefined && key !== channelId) continue;
    clearTimeout(timer);
    gapFillTimers.delete(key);
  }
  if (channelId === undefined) gapFillFailures.clear();
  else gapFillFailures.delete(channelId);
}

/** A window (re)load or a reset: forget the channel's (or every) unconfirmed hole. */
export function clearPendingGapMessages(channelId?: string): void {
  cancelGapFill(channelId);
  if (channelId) {
    pendingGapMessages.delete(channelId);
    return;
  }
  pendingGapMessages.clear();
  gapReadsInFlight.clear();
  gapFillGeneration += 1;
}

/** Drop every unconfirmed hole, scheduled fill and read in flight (tests). */
export function resetGapFillForTests(): void {
  clearPendingGapMessages();
  pendingGapEpoch = 0;
}

/** The seq a read of `channelId` must start from to fill every hole still unconfirmed there, or null. */
export function getGapFillSinceSeq(channelId: string): number | null {
  const pending = pendingGapMessages.get(channelId);
  if (!pending || pending.length === 0) return null;
  return Math.min(...pending.map((entry) => entry.holeFrom));
}

/** Whether `channelId` shows live rows whose hole is not yet confirmed (the heartbeat re-reads it). */
export function channelOwesGapFill(channelId: string): boolean {
  return (pendingGapMessages.get(channelId)?.length ?? 0) > 0;
}

/**
 * A read of `key` asked for from `sinceSeq`: if one is in flight, it runs
 * again after it (from the lowest seq asked) and this returns true.
 */
export function joinGapReadInFlight(key: string, sinceSeq: number): boolean {
  const inFlight = gapReadsInFlight.get(key);
  if (!inFlight) return false;
  inFlight.rerunSince = inFlight.rerunSince === null ? sinceSeq : Math.min(inFlight.rerunSince, sinceSeq);
  return true;
}

/** Start a read of `key`; pending rows that arrived before it are the ones it covers. */
export function startGapRead(key: string): { read: GapRead; startEpoch: number } {
  const read: GapRead = { rerunSince: null, generation: gapFillGeneration };
  gapReadsInFlight.set(key, read);
  return { read, startEpoch: pendingGapEpoch };
}

/**
 * A read from `sinceSeq` that started at `startEpoch` answered: every row it
 * returned, and every pending row it covers (arrived before it started, hole
 * at or after `sinceSeq`), is settled. Returns how many remain.
 */
export function settlePendingGapMessages(channelId: string, sinceSeq: number, startEpoch: number, syncedIds: Set<string>): number {
  const pending = pendingGapMessages.get(channelId);
  if (!pending) return 0;
  const remaining = pending.filter((entry) =>
    !syncedIds.has(entry.message.id) && !(entry.epoch <= startEpoch && entry.holeFrom >= sinceSeq));
  if (remaining.length === 0) pendingGapMessages.delete(channelId);
  else pendingGapMessages.set(channelId, remaining);
  return remaining.length;
}

/**
 * The read of `key` finished: release it, then read again if one was asked
 * for meanwhile (`rerun`, from at most what is still unconfirmed), retry a
 * failed fill with backoff, or fill a row that landed during it.
 */
export function finishGapRead(
  key: string,
  read: GapRead,
  channelId: string | undefined,
  outcome: GapReadOutcome,
  rerun: (sinceSeq: number) => void,
): void {
  if (gapReadsInFlight.get(key) === read) gapReadsInFlight.delete(key);
  // Started before a server switch / logout: its channel belongs to the old
  // server, so it reruns, retries and fills nothing.
  if (read.generation !== gapFillGeneration) return;
  if (channelId && outcome === "read") gapFillFailures.delete(channelId);
  const owedSince = channelId ? getGapFillSinceSeq(channelId) : null;
  if (read.rerunSince !== null) {
    rerun(owedSince === null ? read.rerunSince : Math.min(read.rerunSince, owedSince));
  } else if (channelId && outcome === "failed") {
    scheduleGapFillRetry(channelId);
  } else if (channelId && outcome === "read" && owedSince !== null) {
    scheduleGapFill(channelId, 0);
  }
}

/** Fill the channel's unconfirmed holes after `delayMs` (one timer per channel). */
function scheduleGapFill(channelId: string, delayMs: number): void {
  if (gapFillTimers.has(channelId)) return;
  gapFillTimers.set(channelId, setTimeout(() => {
    gapFillTimers.delete(channelId);
    // A read in flight settles what it covers and asks again for the rest.
    if (gapReadsInFlight.has(channelId)) return;
    const sinceSeq = getGapFillSinceSeq(channelId);
    if (sinceSeq !== null) readGap?.(channelId, sinceSeq);
  }, delayMs));
}

/** A fill failed with holes still unconfirmed: retry with backoff, up to the cap. */
function scheduleGapFillRetry(channelId: string): void {
  if (!channelOwesGapFill(channelId)) return;
  const failures = (gapFillFailures.get(channelId) ?? 0) + 1;
  gapFillFailures.set(channelId, failures);
  // Past the cap the hole stays known (hasGap): the next heartbeat, focus or
  // reconnect re-reads it.
  if (failures > GAP_FILL_MAX_RETRIES) return;
  scheduleGapFill(channelId, GAP_FILL_RETRY_BASE_MS * 2 ** (failures - 1));
}
