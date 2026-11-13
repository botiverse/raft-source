// Persistent client state across tool calls.
//
// Serverless runtimes (Cloudflare Workers, one tool call per invocation)
// keep nothing in memory between two model steps, so everything the SDK must
// remember lives in one small, versioned JSON value that the integrator
// stores wherever they like (IndexedDB, Durable Object storage, KV, a row in
// their own database). The integrator implements two async methods; the SDK
// loads once per client and saves after each successful operation that
// changed the state.
//
// What is in the state, and why each piece is safe to lose:
// - `cursor`: the last inbox batch the caller COMMITTED as processed. The next
//   pull passes it as `since`, which is what acknowledges that batch on the
//   Server. Lost → the Server re-delivers the last batch once.
// - `pendingCursor`: the cursor of the batch most recently returned but not yet
//   committed. Saving it acknowledges nothing. `inbox.commit()` with no
//   argument promotes it to `cursor`, so "pull in call N, commit in call N+1"
//   works across processes. Lost → nothing to commit; the batch comes again.
// - `frontier`: what the model has been shown, per conversation (see
//   frontier.ts). Lost → the next send is held once and returns the context.
// - `continuations`: held sends awaiting a resend, keyed by target and a hash
//   of their content, so a resend of the same message reuses the same
//   idempotency key. Capped (per target and in total), oldest dropped. Lost →
//   the resend gets a fresh key; the Server's hold still applies.
//
// Rules:
// - The SDK NEVER commits a cursor on its own. Pulling only records
//   `pendingCursor`.
// - Saving is best effort: one attempt, no retry. A failed or stale save never
//   fails the operation; it is reported to `onStateSaveError`.
// - Compare-and-set is optional. `save(state, { expectedVersion })` passes the
//   `version` this client loaded (`undefined` when the store was empty); a
//   store that can compare inside a transaction throws on mismatch, others
//   ignore it and the later save wins. No lock is held across awaits.

import { canonicalMessageCardJson } from "../messageCard";
import { SeenFrontier, type SeenFrontierSnapshot } from "./frontier";

export const RAFT_STATE_SCHEMA = "raft-sdk-state.v1" as const;

export interface RaftStateContinuation {
  target: string;
  idempotencyKey: string;
  /** Hex SHA-256 of target, content and attachment ids; a resend with the same hash is the same logical message. */
  contentHash: string;
  /** ISO time the send was held. */
  heldAt: string;
}

export interface RaftState {
  schema: typeof RAFT_STATE_SCHEMA;
  /** Revision, incremented on every save by this SDK. Compare-and-set stores compare against it. */
  version: number;
  /** Last committed inbox cursor; the next pull passes it as `since`. */
  cursor: number | null;
  /** Cursor of the batch returned but not yet committed. */
  pendingCursor: number | null;
  frontier: SeenFrontierSnapshot;
  continuations?: RaftStateContinuation[];
}

export interface RaftStateStore {
  load(): Promise<RaftState | null>;
  /**
   * Persist `state`. `expectedVersion` is the version this client loaded
   * (`undefined` when the store was empty). Throw to reject a stale write;
   * stores without compare-and-set may ignore it.
   */
  save(state: RaftState, options: { expectedVersion: number | undefined }): Promise<void>;
}

/** Called when loading (`phase: "load"`) or saving (`phase: "save"`) the state fails or is rejected as stale. */
export type RaftStateErrorHandler = (error: unknown, context: { phase: "load" | "save"; version: number | undefined }) => void;
/** @deprecated Use `RaftStateErrorHandler` (same signature; it covers loads too). Removed in 1.0. */
export type RaftStateSaveErrorHandler = RaftStateErrorHandler;

export const RAFT_STATE_CONTINUATIONS_PER_TARGET = 3;
export const RAFT_STATE_CONTINUATIONS_TOTAL = 20;

function isNullableCursor(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

/** Validate a loaded value; anything unrecognised is treated as an empty store (safe: see file header). */
export function parseRaftState(value: unknown): RaftState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== RAFT_STATE_SCHEMA) return null;
  if (typeof v.version !== "number" || !Number.isInteger(v.version) || v.version < 0) return null;
  if (!isNullableCursor(v.cursor ?? null) || !isNullableCursor(v.pendingCursor ?? null)) return null;
  const frontier = v.frontier as SeenFrontierSnapshot | undefined;
  const continuations = Array.isArray(v.continuations)
    ? (v.continuations as unknown[]).filter((c): c is RaftStateContinuation => {
      const r = c as Record<string, unknown> | null;
      return Boolean(r) && typeof r!.target === "string" && typeof r!.idempotencyKey === "string"
        && typeof r!.contentHash === "string" && typeof r!.heldAt === "string";
    })
    : [];
  return {
    schema: RAFT_STATE_SCHEMA,
    version: v.version,
    cursor: (v.cursor as number | null | undefined) ?? null,
    pendingCursor: (v.pendingCursor as number | null | undefined) ?? null,
    frontier: frontier && frontier.version === 1 ? frontier : { version: 1, targets: {}, aliases: {} },
    continuations,
  };
}

/**
 * Hex SHA-256 identifying one logical message (WebCrypto; Workers-safe). A
 * card message's card is part of it (RFC 082), by value whatever its key
 * order; a message without one hashes the bytes it always did.
 */
export async function hashRaftSendContent(target: string, content: string, attachmentIds: readonly string[] = [], card?: unknown): Promise<string> {
  const cardPart = card === undefined ? "" : `\ncard:${canonicalMessageCardJson(card)}`;
  const bytes = new TextEncoder().encode(`${target}\n${[...attachmentIds].sort().join(",")}\n${content}${cardPart}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One client's view of the persisted state: loads once, holds the working
 * copy, saves on request. Also used without a store (memory only), so the
 * pending/committed cursor flow behaves the same with or without persistence.
 */
export class RaftStateSession {
  readonly frontier: SeenFrontier;
  cursor: number | null = null;
  pendingCursor: number | null = null;
  private continuations: RaftStateContinuation[] = [];
  private loadedVersion: number | undefined = undefined;
  private loading: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly store: RaftStateStore | undefined,
    frontier: SeenFrontier,
    private readonly onError?: RaftStateErrorHandler,
  ) {
    this.frontier = frontier;
  }

  get persistent(): boolean {
    return this.store !== undefined;
  }

  /** The version loaded from (or last saved to) the store; `undefined` before the first save of an empty store. */
  get version(): number | undefined {
    return this.loadedVersion;
  }

  /** Load once. A failed or unreadable load starts from an empty state (reported, not thrown). */
  ensureLoaded(): Promise<void> {
    if (!this.store) return Promise.resolve();
    this.loading ??= (async () => {
      let raw: unknown = null;
      try {
        raw = await this.store!.load();
      } catch (error) {
        this.onError?.(error, { phase: "load", version: undefined });
        return;
      }
      const state = parseRaftState(raw);
      if (!state) return;
      this.loadedVersion = state.version;
      this.cursor = state.cursor;
      this.pendingCursor = state.pendingCursor;
      this.frontier.absorb(state.frontier);
      this.continuations = state.continuations ?? [];
    })();
    return this.loading;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Record the cursor of a batch just returned. Acknowledges nothing. */
  setPending(cursor: number | null): void {
    if (cursor === null || cursor === this.pendingCursor) return;
    this.pendingCursor = cursor;
    this.dirty = true;
  }

  /**
   * Promote a cursor to committed. With no argument, commits `pendingCursor`.
   * Returns the committed cursor, or null when there was nothing to commit.
   * Never moves the committed cursor backwards.
   */
  commit(cursor?: number | null): number | null {
    const next = cursor === undefined ? this.pendingCursor : cursor;
    if (next === null || next === undefined) return null;
    if (this.cursor === null || next > this.cursor) this.cursor = next;
    if (this.pendingCursor !== null && this.pendingCursor <= this.cursor) this.pendingCursor = null;
    this.dirty = true;
    return this.cursor;
  }

  findContinuation(target: string, contentHash: string): RaftStateContinuation | undefined {
    return this.continuations.find((c) => c.target === target && c.contentHash === contentHash);
  }

  rememberContinuation(entry: RaftStateContinuation): void {
    this.continuations = this.continuations.filter((c) => !(c.target === entry.target && c.contentHash === entry.contentHash));
    this.continuations.push(entry);
    const perTarget = this.continuations.filter((c) => c.target === entry.target);
    for (const drop of perTarget.slice(0, Math.max(0, perTarget.length - RAFT_STATE_CONTINUATIONS_PER_TARGET))) {
      this.continuations.splice(this.continuations.indexOf(drop), 1);
    }
    if (this.continuations.length > RAFT_STATE_CONTINUATIONS_TOTAL) {
      this.continuations.splice(0, this.continuations.length - RAFT_STATE_CONTINUATIONS_TOTAL);
    }
    this.dirty = true;
  }

  forgetContinuation(target: string, contentHash: string): void {
    const before = this.continuations.length;
    this.continuations = this.continuations.filter((c) => !(c.target === target && c.contentHash === contentHash));
    if (this.continuations.length !== before) this.dirty = true;
  }

  snapshot(nextVersion = (this.loadedVersion ?? 0) + 1): RaftState {
    return {
      schema: RAFT_STATE_SCHEMA,
      version: nextVersion,
      cursor: this.cursor,
      pendingCursor: this.pendingCursor,
      frontier: this.frontier.snapshot(),
      continuations: [...this.continuations],
    };
  }

  /**
   * Save if anything changed (or `force`). One attempt; a failure is reported
   * and swallowed. Returns whether the save succeeded (true when nothing to save).
   */
  async save(options: { force?: boolean } = {}): Promise<boolean> {
    if (!this.store) return true;
    if (!this.dirty && !options.force) return true;
    const expectedVersion = this.loadedVersion;
    const state = this.snapshot();
    try {
      await this.store.save(state, { expectedVersion });
    } catch (error) {
      this.onError?.(error, { phase: "save", version: expectedVersion });
      return false;
    }
    this.loadedVersion = state.version;
    this.dirty = false;
    return true;
  }
}
