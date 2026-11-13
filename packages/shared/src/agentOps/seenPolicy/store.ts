// The per-agent command state store the seen policy (this directory) runs
// over. The CLI backs it with its local SQLite ledger
// (cli/src/state/commandStateStore.ts); `createMemoryCommandStateStore`
// (memoryStore.ts) is the reference implementation of the semantics below.
// A store method may answer synchronously (the CLI's SQLite ledger) or not;
// the policy handles both (maybe.ts).

import type { MaybePromise } from "../../maybePromise";

/** One target's consumption record in the agent's ledger. */
export interface CommandStateStreamEntry {
  /** High-water mark of a contiguous full-body read (server freshness attestation). */
  seq?: number;
  /** Local recency counter: the order in which targets were last read. */
  readOrder?: number;
  /** The model context the record was booked in; null/absent when there was no context signal. */
  contextId?: string | null;
}

/** A held send's draft, one per target, as stored (policy: drafts.ts). */
export interface CommandStateDraftEntry {
  content: string;
  attachmentIds: string[];
  idempotencyKey?: string;
  mentions?: unknown[];
  /** RFC 082: a card message's card, as stored; drafts.ts keeps it only when it is an object. */
  card?: unknown;
  savedAt: number;
  reholdCount: number;
  seenUpToSeq?: number;
  seenExactSeqs?: number[];
  /** As stored; drafts.ts reads it through `savedDraftCauseOf`. */
  cause?: string;
}

/**
 * Per-agent command state at ledger-primitive level: target aliases,
 * per-target consumption (high-water `seq` + sparse exact seqs, both scoped to
 * a model context), held-send drafts and observability counters. One store is
 * bound to one agent.
 *
 * Policy (target canonicalization, context filtering, read-boundary rules,
 * draft TTL) lives in this directory, never in a store.
 *
 * Failure semantics: reads answer "nothing recorded" on a storage failure;
 * stream/exact/alias bookings and counters are best-effort (never throw);
 * draft writes and deletes throw, because callers promise "draft saved".
 */
export interface CommandStateStore {
  /**
   * The model context reads are scoped to (RFC 072 §7.10), or null when there
   * is no context signal (the record is then attested in any context).
   */
  currentContextId(): MaybePromise<string | null>;

  /** Follow the alias chain from `target` to its canonical key (cycle-safe; untrusted destinations stop the walk). */
  resolveCanonicalTarget(target: string): MaybePromise<string>;
  /** Point a typed spelling at its canonical target; latest resolution wins. Ignores untrusted or identical pairs. */
  bookTargetAlias(spelling: string, canonicalTarget: string): MaybePromise<void>;

  /** The target's record, or undefined when it has neither `seq` nor `readOrder`. */
  readStreamEntry(target: string): MaybePromise<CommandStateStreamEntry | undefined>;
  readAllStreamEntries(): MaybePromise<Record<string, CommandStateStreamEntry>>;
  /**
   * Book reads in one atomic step: each target gets the next `readOrder`; its
   * `seq` takes the max with the stored one in the same context, replaces it
   * from another context (an undefined seq keeps the stored one only in the
   * same context); exact seqs from another context are dropped and those at or
   * below the resulting `seq` retired.
   */
  bookStreamEntries(entries: Record<string, number | undefined>, contextId: string | null): MaybePromise<void>;
  /** Exact seqs above the same-context high-water mark, and the context they were booked in. */
  readExactSeqsWithContext(target: string): MaybePromise<{ seqs: number[]; contextId: string | null }>;
  /** Merge sparse exact observations (replace when booked in another context); never moves `seq`. */
  bookExactSeqs(entries: Record<string, number[]>, contextId: string | null): MaybePromise<void>;

  readDraft(target: string): MaybePromise<CommandStateDraftEntry | undefined>;
  writeDraft(target: string, draft: CommandStateDraftEntry): MaybePromise<void>;
  deleteDraft(target: string): MaybePromise<void>;
  /** Delete only the draft saved at `savedAt` (TTL expiry must not drop a fresher draft). */
  deleteDraftIfSavedAt(target: string, savedAt: number): MaybePromise<boolean>;
  /** Delete only the draft carrying this idempotency key. */
  deleteDraftIfIdempotencyKeyMatches(target: string, idempotencyKey: string): MaybePromise<boolean>;

  /** Best-effort observability counter (never read back by behaviour). */
  incrementCounter(key: string): MaybePromise<void>;
}
