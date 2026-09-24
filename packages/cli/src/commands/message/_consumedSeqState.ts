// Local per-target consumed-seq bookkeeping — the external agent's
// model-seen attestation source (FH-EXT-001, task #70).
//
// `message read` prints a contiguous target history slice into the agent's
// context; the max seq returned for that target is therefore an honest
// "I consumed up to here" record. `message send` auto-attests it as
// `seenUpToSeq` so a quiet, already-read channel no longer freshness-holds
// every first send (the server treats an absent boundary as 0 and holds
// conservatively). Sparse drains such as `message check` must not write this
// high-water cursor.
//
// HARD RULE (omit-not-fabricate, FH-EXT-001 #3): cursors are PER-TARGET and
// are never merged across targets — consuming seq N in channel A proves
// nothing about channel B, even though `messages.seq` is server-global.
// A target with no local cursor stays absent → send omits `seenUpToSeq` →
// the server holds (fail-closed), which is correct.
//
// Storage mirrors `_continueDraftState.ts` (user-private per-agent JSON):
// losing this state is safe — the next send simply falls back to a
// conservative hold.
import { legacyStatePath, privateStatePath, readPrivateStateWithLegacyImport, writePrivateState } from "./_privateStateFile.js";

interface ConsumedTargetState {
  seq?: number;
  readOrder?: number;
}

interface ConsumedSeqStateFile {
  targets?: Record<string, number | ConsumedTargetState>;
  nextReadOrder?: number;
}

export interface ConsumedThreadTarget {
  target: string;
  seq: number;
  readOrder: number;
}

const CONSUMED_STATE_NAMESPACE = "slock-cli-consumed-seq";
const CONSUMED_STATE_FILENAME = "consumed-seqs.json";

function stateFilePath(agentId: string): string {
  return privateStatePath(process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR, CONSUMED_STATE_NAMESPACE, agentId, CONSUMED_STATE_FILENAME);
}

interface NormalizedConsumedState {
  targets: Record<string, ConsumedTargetState>;
  nextReadOrder: number;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeState(raw: ConsumedSeqStateFile): NormalizedConsumedState {
  const targets: Record<string, ConsumedTargetState> = {};
  let maxObservedOrder = 0;
  for (const [target, value] of Object.entries(raw.targets ?? {})) {
    if (target.length === 0) continue;
    const seq = typeof value === "number" ? positiveFiniteNumber(value) : positiveFiniteNumber(value?.seq);
    const readOrder = typeof value === "number" ? undefined : positiveFiniteNumber(value?.readOrder);
    if (seq === undefined && readOrder === undefined) continue;
    targets[target] = { seq, readOrder };
    maxObservedOrder = Math.max(maxObservedOrder, readOrder ?? seq ?? 0);
  }
  const rawNextReadOrder = positiveFiniteNumber(raw.nextReadOrder);
  return {
    targets,
    nextReadOrder: Math.max(rawNextReadOrder ?? 1, maxObservedOrder + 1),
  };
}

function readState(agentId: string): NormalizedConsumedState {
  try {
    const parsed = JSON.parse(readPrivateStateWithLegacyImport(
      stateFilePath(agentId),
      legacyStatePath(process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR, CONSUMED_STATE_NAMESPACE, agentId, CONSUMED_STATE_FILENAME),
    )) as ConsumedSeqStateFile;
    return normalizeState(typeof parsed === "object" && parsed ? parsed : {});
  } catch {
    return { targets: {}, nextReadOrder: 1 };
  }
}

function writeState(agentId: string, state: NormalizedConsumedState): void {
  const filePath = stateFilePath(agentId);
  writePrivateState(filePath, JSON.stringify(state));
}

/**
 * Record a full-body read of one target.
 *
 * `seq` remains a per-target high-water mark for server freshness
 * attestation. `readOrder` is independent local recency: an explicit read of
 * a lower-seq parent after a higher-seq thread is still the latest local
 * context.
 */
export function recordConsumedRead(agentId: string, target: string, seq?: number): void {
  if (target.length === 0) return;
  const state = readState(agentId);
  const prior = state.targets[target] ?? {};
  const nextSeq = positiveFiniteNumber(seq);
  const record: ConsumedTargetState = {
    seq: nextSeq !== undefined && (!Number.isFinite(prior.seq) || nextSeq > prior.seq!)
      ? nextSeq
      : prior.seq,
    readOrder: state.nextReadOrder,
  };
  state.targets[target] = record;
  state.nextReadOrder += 1;
  try {
    writeState(agentId, state);
  } catch {
    // Best-effort bookkeeping: failure to persist only means the next send
    // falls back to a conservative server-side hold.
  }
}

/** Record per-target consumed seqs (monotonic max merge), preserving local read order. */
export function recordConsumedSeqs(agentId: string, entries: Record<string, number>): void {
  const updates = Object.entries(entries).filter(([target, seq]) =>
    target.length > 0 && Number.isFinite(seq) && seq > 0,
  );
  if (updates.length === 0) return;
  const state = readState(agentId);
  let changed = false;
  for (const [target, seq] of updates) {
    const prior = state.targets[target] ?? {};
    state.targets[target] = {
      seq: !Number.isFinite(prior.seq) || seq > prior.seq! ? seq : prior.seq,
      readOrder: state.nextReadOrder,
    };
    state.nextReadOrder += 1;
    if (state.targets[target]!.seq !== prior.seq || state.targets[target]!.readOrder !== prior.readOrder) {
      changed = true;
    }
  }
  if (!changed) return;
  try {
    writeState(agentId, state);
  } catch {
    // Best-effort bookkeeping: failure to persist only means the next send
    // falls back to a conservative server-side hold.
  }
}

/** The max seq this agent has actually consumed for EXACTLY this target. */
export function getConsumedSeq(agentId: string, target: string): number | undefined {
  return readState(agentId).targets[target]?.seq;
}

/** The local order in which this exact target was last read, independent of message seq. */
export function getConsumedReadOrder(agentId: string, target: string): number | undefined {
  const record = readState(agentId).targets[target];
  const readOrder = record?.readOrder ?? record?.seq;
  return Number.isFinite(readOrder) && readOrder! > 0 ? readOrder : undefined;
}

export function getParentTargetForThread(target: string): string | null {
  if (target.startsWith("dm:@")) {
    const separatorIndex = target.indexOf(":", "dm:@".length);
    return separatorIndex > 0 ? target.slice(0, separatorIndex) : null;
  }
  if (target.startsWith("#")) {
    const separatorIndex = target.indexOf(":");
    return separatorIndex > 0 ? target.slice(0, separatorIndex) : null;
  }
  return null;
}

export function getMostRecentConsumedThreadForParent(
  agentId: string,
  parentTarget: string,
): ConsumedThreadTarget | undefined {
  let best: ConsumedThreadTarget | undefined;
  for (const [target, record] of Object.entries(readState(agentId).targets)) {
    const seq = record.seq;
    const readOrder = record.readOrder ?? seq;
    if (!Number.isFinite(seq) || seq! <= 0) continue;
    if (!Number.isFinite(readOrder) || readOrder! <= 0) continue;
    if (getParentTargetForThread(target) !== parentTarget) continue;
    if (!best || readOrder! > best.readOrder) {
      best = { target, seq: seq!, readOrder: readOrder! };
    }
  }
  return best;
}
