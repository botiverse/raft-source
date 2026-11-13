// What this agent has actually consumed per target, used to attest freshness
// on send (moved from the CLI's commands/message/_consumedSeqState.ts; the
// CLI keeps that module as a synchronous facade over its ledger store).
//
// Two dimensions per target:
//   - `seq`         high-water mark of a full-body read (server attestation)
//   - `exactSeqs`   sparse exact observations above the high-water mark
//                   (`--around`, `check`, gapped windows) — never fabricated
//                   into a boundary; retired only by a real high-water read
// plus `readOrder`, an independent local recency counter.
//
// Model-context scope (RFC 072 §7.10): a read only attests freshness inside
// the model context it happened in. With a context signal
// (`store.currentContextId()` non-null), reads are booked under that context
// and a record from another context (or from before the signal existed) is
// withheld: the send then carries no evidence and the server holds it until
// the agent reads again. Without a signal the lifetime of a read is
// unknowable, so the record is attested.

import type { MaybePromise } from "../../maybePromise";
import type { CommandStateStore, CommandStateStreamEntry } from "./store";
import { andThen, mapInOrder } from "./maybe";

/**
 * Sparse exact-seen observations are bounded per target so a long-lived
 * agent cannot grow its state without limit; the newest seqs win.
 */
export const MAX_EXACT_SEQS_PER_TARGET = 2_500;

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A canonical target spelling that can be trusted as an alias destination.
 *
 * Defence against the #8173 regression (task #172): a canonical key was once
 * derived from a rendered row that lacked its channel fields and came out as
 * the literal string "#undefined"; every target then aliased to that one key
 * and their consumption evidence merged — evidence from channel A could
 * attest freshness for channel B. Alias destinations must therefore name a
 * real target: non-empty, and never the JavaScript-undefined spellings.
 */
export function isTrustedCanonicalTarget(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) return false;
  // Case-insensitive on purpose (cross, #8514): "#Undefined" is the same poison.
  if (/^#?undefined(?::|$)/i.test(trimmed) || /^dm:@undefined(?::|$)/i.test(trimmed) || /:undefined$/i.test(trimmed)) return false;
  return true;
}

/** Normalise a candidate exact-seq list: positive integers above `afterSeq`, deduplicated, ascending, bounded. */
export function normalizeExactSeqs(value: unknown, afterSeq = 0): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((seq) => positiveFiniteNumber(seq))
    .filter((seq): seq is number => seq !== undefined && Number.isInteger(seq) && seq > afterSeq))]
    .sort((a, b) => a - b)
    .slice(-MAX_EXACT_SEQS_PER_TARGET);
}

/**
 * Normalize one agent-facing message target before it becomes an evidence key.
 *
 * Deliberately fail-closed (cross, #8514). `#undefined` was emitted by CLI
 * 0.0.28 when it tried to reconstruct target identity from a history message
 * envelope that does not carry channel fields. Once stored as an alias
 * destination it merged unrelated channel, thread and DM evidence. Refuse that
 * sentinel (and its thread-shaped descendants) rather than treating it as a
 * real channel. Stores apply the same predicate on every alias write
 * (`isTrustedCanonicalTarget`), so a poisoned spelling can neither be keyed
 * here nor persisted there.
 */
export function canonicalizeConsumedTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed || trimmed !== target) return null;
  let normalized = target;
  if (/^dm:@/i.test(normalized)) normalized = `dm:@${normalized.slice(4)}`;
  if (normalized === "#" || normalized.toLowerCase() === "dm:@") return null;
  return isTrustedCanonicalTarget(normalized) ? normalized : null;
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

export interface ConsumedThreadTarget {
  target: string;
  seq: number;
  readOrder: number;
}

/**
 * One agent's consumption evidence over a CommandStateStore, for one command
 * run. Holds the run's "withheld for context" set: the targets whose evidence
 * a getter withheld because it was booked in another model context (the send
 * path counts those holds as context switches). A new run starts empty.
 *
 * Every method returns synchronously over a synchronous store.
 */
export class ConsumedSeqLedger {
  private readonly withheldForContext = new Set<string>();

  constructor(private readonly store: CommandStateStore) {}

  /**
   * One target, several legal spellings — `#chan:<parentMsgShortId>` and
   * `#chan:<threadChannelId8>` name the same thread, and `#Chan`/`#chan` differ
   * only in case. Keys are the CANONICAL spelling (the one rendered rows
   * print); any spelling the caller typed is remembered (`recordTargetAlias`)
   * so accessors and recorders meet on the canonical key instead of silently
   * splitting the evidence store in two. Empty string: not a valid key.
   */
  canonicalTargetKey(target: string): MaybePromise<string> {
    const normalizedTarget = canonicalizeConsumedTarget(target);
    if (!normalizedTarget) return "";
    return this.store.resolveCanonicalTarget(normalizedTarget);
  }

  private inThisContext<T extends { contextId?: string | null }>(key: string, entry: T | undefined): MaybePromise<T | undefined> {
    if (!entry) return undefined;
    return andThen(this.store.currentContextId(), (contextId) => {
      if (contextId === null || (entry.contextId ?? null) === contextId) return entry;
      this.withheldForContext.add(key);
      return undefined;
    });
  }

  /** Whether this target's evidence was withheld in this run because it was read in another model context. */
  wasEvidenceWithheldForContext(target: string): MaybePromise<boolean> {
    return andThen(this.canonicalTargetKey(target), (key) => (key ? this.withheldForContext.has(key) : false));
  }

  /**
   * Record that `rawSpelling` resolves to `canonicalTarget`.
   *
   * Idempotent: recording the same pair twice is a no-op. A raw spelling that
   * later resolves to a DIFFERENT canonical target is re-pointed — the latest
   * observed resolution wins, which matches how the resolver answers today.
   */
  recordTargetAlias(rawSpelling: string, canonicalTarget: string): MaybePromise<void> {
    const normalizedSpelling = canonicalizeConsumedTarget(rawSpelling);
    const normalizedCanonical = canonicalizeConsumedTarget(canonicalTarget);
    if (!normalizedSpelling || !normalizedCanonical || normalizedSpelling === normalizedCanonical) return;
    return this.store.bookTargetAlias(normalizedSpelling, normalizedCanonical);
  }

  /**
   * Record a full-body read of one target.
   *
   * `seq` remains a per-target high-water mark for server freshness
   * attestation. `readOrder` is independent local recency: an explicit read of
   * a lower-seq parent after a higher-seq thread is still the latest local
   * context. Exact observations the new mark now covers are retired by the store.
   */
  recordConsumedRead(target: string, seq?: number): MaybePromise<void> {
    return andThen(this.canonicalTargetKey(target), (key) => {
      if (!key) return;
      return andThen(this.store.currentContextId(), (contextId) =>
        this.store.bookStreamEntries({ [key]: positiveFiniteNumber(seq) }, contextId));
    });
  }

  /** Record per-target consumed seqs (monotonic max merge), preserving local read order. */
  recordConsumedSeqs(entries: Record<string, number>): MaybePromise<void> {
    const candidates = Object.entries(entries).filter(([, seq]) => Number.isFinite(seq) && seq > 0);
    return andThen(
      mapInOrder(candidates, ([target, seq]) => andThen(this.canonicalTargetKey(target), (key) => [key, seq] as const)),
      (keyed) => {
        const updates: Record<string, number> = {};
        for (const [key, seq] of keyed) if (key) updates[key] = seq;
        if (Object.keys(updates).length === 0) return;
        return andThen(this.store.currentContextId(), (contextId) => this.store.bookStreamEntries(updates, contextId));
      },
    );
  }

  /** Record sparse full-body observations without fabricating a high-water boundary. */
  recordConsumedExactSeqs(entries: Record<string, number[]>): MaybePromise<void> {
    const candidates = Object.entries(entries).filter(([, seqs]) => Array.isArray(seqs) && seqs.length > 0);
    return andThen(
      mapInOrder(candidates, ([target, seqs]) => andThen(this.canonicalTargetKey(target), (key) => [key, seqs] as const)),
      (keyed) => {
        const updates: Record<string, number[]> = {};
        for (const [key, seqs] of keyed) if (key) updates[key] = seqs;
        if (Object.keys(updates).length === 0) return;
        return andThen(this.store.currentContextId(), (contextId) => this.store.bookExactSeqs(updates, contextId));
      },
    );
  }

  /** The max seq this agent has actually consumed for EXACTLY this target. */
  getConsumedSeq(target: string): MaybePromise<number | undefined> {
    return andThen(this.canonicalTargetKey(target), (key) => {
      if (!key) return undefined;
      return andThen(this.store.readStreamEntry(key), (entry) =>
        andThen(this.inThisContext(key, entry), (inContext) => inContext?.seq));
    });
  }

  /** Exact sparse seqs whose full bodies were rendered for this target. */
  getConsumedExactSeqs(target: string): MaybePromise<number[]> {
    return andThen(this.canonicalTargetKey(target), (key) => {
      if (!key) return [];
      return andThen(this.store.readExactSeqsWithContext(key), (entry) =>
        // `{ seqs: [], contextId: null }` means nothing was ever observed;
        // that is no evidence, not evidence from another context.
        andThen(this.inThisContext(key, entry.seqs.length > 0 ? entry : undefined), (inContext) => inContext?.seqs ?? []));
    });
  }

  /** The local order in which this exact target was last read, independent of message seq. */
  getConsumedReadOrder(target: string): MaybePromise<number | undefined> {
    return andThen(this.canonicalTargetKey(target), (key) => {
      const record: MaybePromise<CommandStateStreamEntry | undefined> = key
        ? andThen(this.store.readStreamEntry(key), (entry) => this.inThisContext(key, entry))
        : undefined;
      return andThen(record, (inContext) => {
        const readOrder = inContext?.readOrder ?? inContext?.seq;
        return readOrder !== undefined && Number.isFinite(readOrder) && readOrder > 0 ? readOrder : undefined;
      });
    });
  }

  /** The thread of `parentTarget` read most recently in this context. Does not mark anything withheld. */
  getMostRecentConsumedThreadForParent(parentTarget: string): MaybePromise<ConsumedThreadTarget | undefined> {
    return andThen(this.store.currentContextId(), (contextId) =>
      andThen(this.store.readAllStreamEntries(), (entries) => {
        let best: ConsumedThreadTarget | undefined;
        for (const [target, record] of Object.entries(entries)) {
          if (contextId !== null && (record.contextId ?? null) !== contextId) continue;
          const seq = record.seq;
          const readOrder = record.readOrder ?? seq;
          if (seq === undefined || !Number.isFinite(seq) || seq <= 0) continue;
          if (readOrder === undefined || !Number.isFinite(readOrder) || readOrder <= 0) continue;
          if (getParentTargetForThread(target) !== parentTarget) continue;
          if (!best || readOrder > best.readOrder) {
            best = { target, seq, readOrder };
          }
        }
        return best;
      }));
  }
}
