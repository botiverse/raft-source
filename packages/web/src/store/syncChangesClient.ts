/**
 * Web client of GET /api/sync/changes (contract: @botiverse/raft-shared
 * syncChanges.ts). One session per main-layout bridge, i.e. per server.
 *
 * v1 applies a change as "reload what it touches", coalesced per snapshot:
 * a few changes cost one list read each, an unchanged list costs nothing.
 * A `conversation` change that carries the row's current state (read / done /
 * follow, Activity multi-device spec v3 §4.2) is patched in place instead,
 * when the client can; otherwise it falls back to those reloads. A change that lands while a reload
 * of its list is running marks that list dirty and it is read again once that
 * reload has landed, and a list reload never joins a request sent before the
 * change (settleInFlight). Single channel rows (ensureChannel) and channel
 * rosters (useChannelMembers) still join an in-flight read: a known gap,
 * covered in practice by realtime pushes and the next change.
 *
 * A `message` change (RFC 082 §4.4: a card message's update, a Slack-bridged
 * edit) carries the message as the viewer's message list holds it: it
 * replaces that message in the store by id (applyMessage), newest per id;
 * a message the store does not hold is left alone.
 *
 * Order (contract): take the cursor first, then the snapshots, then pull from
 * the cursor. A failed pull keeps or drops the cursor by the contract's
 * "Pull failures" rule (@botiverse/raft-shared syncChanges.ts, shared with
 * mobile 1.23): a kept cursor is pulled again once 30–60 s later (or by the
 * next trigger, whichever is first); a dropped one makes the caller fall back
 * to the full reloads (onCursorDropped) and the next connect take a new cursor.
 */
import type {
  SyncChange,
  SyncChangesCursor,
  SyncChangesResponse,
  SyncSnapshotName,
} from "@botiverse/raft-shared";

import { isAxiosError } from "axios";

import api from "../api/client";
import { applyChannelScopeChange } from "./channelAccessLoss";
import type { ListFetchReason } from "./listFetchReason";
import type { Message } from "./messageStore";

/**
 * Reload one snapshot. `settleInFlight` lets a load already in flight land
 * first. `reason`: why a whole list is read (X-Raft-Fetch-Reason), when known.
 */
export type SyncSnapshotLoader = {
  settleInFlight?: () => Promise<void>;
  load: (reason?: ListFetchReason) => Promise<void> | void;
};

export type SyncSnapshotLoaders = Record<SyncSnapshotName, SyncSnapshotLoader>;

export type SyncChangesPlan = {
  snapshots: Set<SyncSnapshotName>;
  /** Channel rows to re-read one by one (upserts). */
  channelIds: Set<string>;
  /** Channels whose member roster changed. */
  memberChannelIds: Set<string>;
  /** Conversations whose current state came with the change, newest per id. */
  conversations: Map<string, SyncConversationState>;
  /** Why a snapshot is read again, where the plan knows (AndyLok's fetch reasons). */
  reasons: Map<SyncSnapshotName, ListFetchReason>;
  /** Channels the viewer gained or lost, the latest op per id. */
  channelScopes: Map<string, "added" | "removed">;
  /** Messages changed in place (`message` upserts), their current row, newest per id. */
  messages: Map<string, Message>;
};

/**
 * The viewer's current state of one conversation, as a `conversation` change
 * carries it (Activity multi-device spec v3): one part per kind of state that
 * changed in the window (the server folds a conversation's changes into one),
 * each read when the server answers, so at least as new as the change.
 * Additive: an older server sends none and the change stays a plain "reload".
 */
export type SyncConversationState = {
  /** markedUnread: the scope is marked unread with no count (absent: not marked). */
  read?: { readSeq: number; readStateVersion: number; markedUnread?: true };
  done?: { done: boolean; doneFrontierSeq: string | null };
  follow?: { followed: boolean; threadDone: boolean };
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? value as Record<string, unknown> : null;

/**
 * The state a change carries, or null when it carries none this client can
 * use. A part that is present but malformed makes the whole change a reload:
 * dropping it would leave that kind of state unapplied.
 */
export function readSyncConversationState(change: object): SyncConversationState | null {
  const fields = change as Record<string, unknown>;
  const state: SyncConversationState = {};
  if (fields.read !== undefined) {
    const read = asRecord(fields.read);
    if (!read || !isNonNegativeInteger(read.readSeq) || !isNonNegativeInteger(read.readStateVersion)) return null;
    state.read = {
      readSeq: read.readSeq,
      readStateVersion: read.readStateVersion,
      ...(read.markedUnread === true ? { markedUnread: true as const } : {}),
    };
  }
  if (fields.done !== undefined) {
    const done = asRecord(fields.done);
    const frontier = done?.doneFrontierSeq;
    if (!done || typeof done.done !== "boolean") return null;
    if (frontier != null && (typeof frontier !== "string" || !/^[0-9]+$/.test(frontier))) return null;
    state.done = { done: done.done, doneFrontierSeq: frontier ?? null };
  }
  if (fields.follow !== undefined) {
    const follow = asRecord(fields.follow);
    if (!follow || typeof follow.followed !== "boolean" || typeof follow.threadDone !== "boolean") return null;
    state.follow = { followed: follow.followed, threadDone: follow.threadDone };
  }
  return state.read || state.done || state.follow ? state : null;
}

/** More channel upserts than this in one pull: read the channel lists instead. */
export const SYNC_CHANNEL_ROW_REFRESH_LIMIT = 20;

/** Pages of one pull before giving up and taking every snapshot. */
export const SYNC_MAX_PAGES = 20;

const ROW_ENTITY_SNAPSHOT: Record<string, SyncSnapshotName> = {
  channel: "channels",
  channel_member: "channel_members",
  server_member: "server_members",
  agent: "agents",
  machine: "machines",
  sidebar_order: "sidebar_order",
  server_order: "server_order",
};

const CONVERSATION_SNAPSHOTS: SyncSnapshotName[] = ["inbox", "unread", "followed_threads"];

/** Every snapshot this client knows (the loaders map is keyed by them). */
const KNOWN_SNAPSHOTS: ReadonlySet<string> = new Set<SyncSnapshotName>([
  "channels", "channel_members", "server_members", "agents", "inbox",
  "unread", "followed_threads", "machines", "sidebar_order", "server_order",
]);

/**
 * Snapshot names from the server: a name this client doesn't know yet (the
 * contract adds them over time) means "take every snapshot".
 */
function addSnapshotNames(plan: SyncChangesPlan, names: unknown): void {
  if (!Array.isArray(names)) return;
  for (const name of names) {
    if (typeof name === "string" && KNOWN_SNAPSHOTS.has(name)) plan.snapshots.add(name as SyncSnapshotName);
    else for (const known of KNOWN_SNAPSHOTS) plan.snapshots.add(known as SyncSnapshotName);
  }
}

export function emptySyncChangesPlan(): SyncChangesPlan {
  return { snapshots: new Set(), channelIds: new Set(), memberChannelIds: new Set(), conversations: new Map(), reasons: new Map(), channelScopes: new Map(), messages: new Map() };
}

/** What a page of changes asks the client to reload. Pure. */
export function planSyncChanges(changes: readonly SyncChange[], plan: SyncChangesPlan = emptySyncChangesPlan()): SyncChangesPlan {
  for (const change of changes as ReadonlyArray<SyncChange | { entity: string; op: string; id: string }>) {
    if (change.entity === "conversation") {
      const state = change.op === "stale" ? readSyncConversationState(change) : null;
      if (state) {
        // Each page carries only the kinds that changed in it: merge per
        // kind, the later page's part being newer.
        const previous = plan.conversations.get(change.id);
        plan.conversations.delete(change.id);
        plan.conversations.set(change.id, { ...previous, ...state });
        continue;
      }
      // No state, or an op this client doesn't know (= resnapshot): reload.
      for (const name of CONVERSATION_SNAPSHOTS) {
        plan.snapshots.add(name);
        plan.reasons.set(name, "legacy_no_fields");
      }
      continue;
    }
    if (change.entity === "scope") {
      const scope = change as Extract<SyncChange, { entity: "scope" }>;
      addSnapshotNames(plan, scope.snapshots);
      if (scope.scopeKind === "channel" && (scope.op === "added" || scope.op === "removed")) {
        plan.channelScopes.delete(scope.id);
        plan.channelScopes.set(scope.id, scope.op);
      }
      // Removed: drop what was held under it. v1 holds it in the lists, so
      // reading them again drops it.
      if (scope.op !== "added") {
        if (scope.scopeKind === "server") plan.snapshots.add("server_order");
        else for (const name of ["channels", "inbox", "unread"] as const) plan.snapshots.add(name);
      }
      continue;
    }
    if (change.entity === "message") {
      // Upserts only (contract), each the message list's row. A row that is
      // not this message's is dropped: the live update or the next read brings it.
      const row = change.op === "upsert" ? asRecord((change as { row?: unknown }).row) : null;
      if (row && row.id === change.id && typeof row.channelId === "string") {
        plan.messages.delete(change.id);
        plan.messages.set(change.id, row as unknown as Message);
      }
      continue;
    }
    const snapshot = ROW_ENTITY_SNAPSHOT[change.entity];
    // Unknown entity: skip (contract).
    if (!snapshot) continue;
    // Known entity, unknown op: resnapshot that entity (contract).
    if (change.op !== "upsert" && change.op !== "delete") {
      plan.snapshots.add(snapshot);
      continue;
    }
    if (change.entity === "channel") {
      if (change.op === "upsert") plan.channelIds.add(change.id);
      else plan.snapshots.add("channels");
      continue;
    }
    if (change.entity === "channel_member") {
      const channelId = change.id.split(":")[0];
      if (channelId) {
        plan.memberChannelIds.add(channelId);
        // The channel row carries the member count.
        plan.channelIds.add(channelId);
      }
      continue;
    }
    plan.snapshots.add(snapshot);
  }
  if (plan.channelIds.size > SYNC_CHANNEL_ROW_REFRESH_LIMIT) {
    plan.snapshots.add("channels");
    plan.channelIds.clear();
  }
  return plan;
}

export type SyncChangesFetch = (serverId: string, since: SyncChangesCursor | null) => Promise<SyncChangesResponse>;

/** A hung request must not hold the loads that wait for it; past this the caller falls back. */
export const SYNC_CHANGES_TIMEOUT_MS = 5_000;

const defaultFetch: SyncChangesFetch = async (serverId, since) => {
  const { data } = await api.get<SyncChangesResponse>("/sync/changes", {
    params: since ? { since } : {},
    headers: { "X-Server-Id": serverId },
    timeout: SYNC_CHANGES_TIMEOUT_MS,
  });
  return data;
};

/**
 * What a pull did. `applied`: the changes are applied (or deferred). `kept`: it
 * failed transiently and the cursor stays, nothing to reload; one delayed pull
 * is scheduled. `dropped`: no cursor (any more): the caller reloads in full.
 */
export type SyncPullResult = "applied" | "kept" | "dropped";

/** Consecutive transient failures on one cursor before it is dropped. */
export const SYNC_PULL_FAILURES_TO_DROP = 2;

/**
 * After a `kept` pull, pull once more after MIN + random * SPREAD (30–60 s),
 * unless another pull starts first. The server sends no reminder to pull
 * after a rollout, and a deploy reaches every tab at once: hence the spread.
 */
export const SYNC_PULL_RETRY_MIN_MS = 30_000;
export const SYNC_PULL_RETRY_SPREAD_MS = 30_000;

/**
 * No answer (network, the 5 s timeout) or a server-side failure: the cursor
 * may still be good. Any other answer says it is not (`invalid_cursor` is a
 * 400) or that this client is wrong, which pulling again won't fix.
 */
function isTransientPullError(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status >= 500 || status === 408 || status === 429;
}

export type SyncChangesSessionDeps = {
  serverId: string;
  loaders: SyncSnapshotLoaders;
  refreshChannel: (channelId: string) => Promise<unknown> | void;
  notifyChannelMembers: (channelId: string) => void;
  /**
   * Patch one conversation's Activity / unread / followed-thread rows from its
   * current state. False = this client can't patch it in place (row not
   * loaded, a state it can only get by reading): the lists are read again.
   * Absent: every conversation change reloads them.
   */
  applyConversation?: (channelId: string, state: SyncConversationState) => boolean;
  /** Replace a message the store holds by id with its current row (`message` changes). Absent: they are skipped. */
  applyMessage?: (row: Message) => void;
  /**
   * Run a reset's snapshots later. A reset can reach every client at once
   * (forced, or the server recovering), so the bridge spreads it (0–20 s).
   * Default: at once.
   */
  deferReset?: (run: () => void, snapshots: ReadonlySet<SyncSnapshotName>) => void;
  /**
   * A pull (asked for by the caller or the delayed one after `kept`) ended
   * with no cursor: read every list again. Not called once disposed.
   */
  onCursorDropped?: () => void;
  /** The viewer gained or lost one channel (default: channelAccessLoss, which shows "no longer in this channel"). */
  channelScopeChanged?: (channelId: string, op: "added" | "removed") => void;
  fetch?: SyncChangesFetch;
};

/**
 * Reloads per snapshot, one at a time each: a request asked for while one is
 * running sets `dirty` and runs again after it, so the last read always starts
 * after the last change it has to reflect.
 */
class SnapshotRunner {
  private running = new Map<SyncSnapshotName, Promise<void>>();
  private dirty = new Set<SyncSnapshotName>();
  /** The reason of the newest request per snapshot (a dirty re-run reads for it). */
  private reasons = new Map<SyncSnapshotName, ListFetchReason | undefined>();

  constructor(private readonly loaders: SyncSnapshotLoaders, private readonly isDisposed: () => boolean) {}

  request(name: SyncSnapshotName, reason?: ListFetchReason): Promise<void> {
    this.reasons.set(name, reason);
    const current = this.running.get(name);
    if (current) {
      this.dirty.add(name);
      return current;
    }
    const run = (async () => {
      try {
        do {
          this.dirty.delete(name);
          const loader = this.loaders[name];
          if (!loader || this.isDisposed()) break;
          try {
            await loader.settleInFlight?.();
            if (this.isDisposed()) break;
            await loader.load(this.reasons.get(name));
          } catch {
            // The list keeps what it shows; the next change or reconnect reads again.
          }
        } while (this.dirty.has(name));
      } finally {
        this.running.delete(name);
      }
    })();
    this.running.set(name, run);
    return run;
  }
}

export class SyncChangesSession {
  private cursor: SyncChangesCursor | null = null;
  /** Transient pull failures in a row on `cursor`; reset when it changes or a pull succeeds. */
  private failures = 0;
  private pulling: Promise<SyncPullResult> | null = null;
  private pullAgain = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly runner: SnapshotRunner;
  private readonly fetchChanges: SyncChangesFetch;

  constructor(private readonly deps: SyncChangesSessionDeps) {
    this.runner = new SnapshotRunner(deps.loaders, () => this.disposed);
    this.fetchChanges = deps.fetch ?? defaultFetch;
  }

  get serverId(): string {
    return this.deps.serverId;
  }

  get hasCursor(): boolean {
    return this.cursor !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRetry();
    this.setCursor(null);
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setCursor(cursor: SyncChangesCursor | null): void {
    this.cursor = cursor;
    this.failures = 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Step 2: read every snapshot after the cursor. Each waits for a read of
   * its list already in flight (which may predate the cursor) and sends its own.
   * `except`: lists the caller reads itself after the cursor (not read here).
   */
  resnapshotAll(reason: ListFetchReason, except: readonly SyncSnapshotName[] = []): void {
    if (this.disposed) return;
    for (const name of KNOWN_SNAPSHOTS) {
      if (!except.includes(name as SyncSnapshotName)) void this.runner.request(name as SyncSnapshotName, reason);
    }
  }

  /** Take a cursor (step 1). Resolves false when the server has none for us. */
  async start(): Promise<boolean> {
    try {
      const response = await this.fetchChanges(this.deps.serverId, null);
      if (this.disposed || typeof response?.cursor !== "string") return false;
      this.setCursor(response.cursor);
      return true;
    } catch {
      this.setCursor(null);
      return false;
    }
  }

  /**
   * Pull everything since the cursor and apply it. See SyncPullResult: only
   * `dropped` asks the caller to reload in full. A pull asked for while one
   * runs joins it and, when it applied, pulls once more after it.
   */
  pull(): Promise<SyncPullResult> {
    if (this.pulling) {
      this.pullAgain = true;
      return this.pulling;
    }
    // Any pull replaces the delayed one: at most one is ever pending.
    this.cancelRetry();
    const run = (async () => {
      try {
        let result: SyncPullResult;
        do {
          this.pullAgain = false;
          result = await this.pullOnce();
        } while (result === "applied" && this.pullAgain && !this.disposed);
        if (this.disposed) return result;
        if (result === "dropped") this.deps.onCursorDropped?.();
        // No loop: this cursor has one failure now, so the delayed pull either
        // succeeds or drops it.
        if (result === "kept") {
          const delay = SYNC_PULL_RETRY_MIN_MS + Math.floor(Math.random() * SYNC_PULL_RETRY_SPREAD_MS);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.pull();
          }, delay);
        }
        return result;
      } finally {
        this.pulling = null;
      }
    })();
    this.pulling = run;
    return run;
  }

  private async pullOnce(): Promise<SyncPullResult> {
    if (!this.cursor || this.disposed) return "dropped";
    const plan = emptySyncChangesPlan();
    let wasReset = false;
    // Pages advance a local cursor; the session's moves only once the whole
    // pull succeeded, so a failure on a later page keeps the earlier pages'
    // changes to be pulled again.
    let cursor = this.cursor;
    try {
      let pages = 0;
      for (;;) {
        const response = await this.fetchChanges(this.deps.serverId, cursor);
        if (this.disposed) return "dropped";
        if (typeof response?.cursor !== "string") throw new Error("sync/changes: no cursor");
        if (response.reset) {
          addSnapshotNames(plan, response.reset.snapshots);
          for (const name of plan.snapshots) plan.reasons.set(name, "sync_reset");
          wasReset = true;
          plan.channelIds.clear();
          plan.memberChannelIds.clear();
          plan.conversations.clear();
          // Message rows gathered before the reset stay: no snapshot brings them again.
          cursor = response.cursor;
          break;
        }
        planSyncChanges(response.changes ?? [], plan);
        cursor = response.cursor;
        if (!response.hasMore) break;
        pages += 1;
        if (pages >= SYNC_MAX_PAGES) {
          for (const name of KNOWN_SNAPSHOTS) {
            plan.snapshots.add(name as SyncSnapshotName);
            plan.reasons.set(name as SyncSnapshotName, "sync_reset");
          }
          break;
        }
      }
    } catch (error) {
      if (this.disposed) return "dropped";
      if (isTransientPullError(error) && this.failures + 1 < SYNC_PULL_FAILURES_TO_DROP) {
        this.failures += 1;
        return "kept";
      }
      this.setCursor(null);
      return "dropped";
    }
    this.setCursor(cursor);
    if (wasReset && this.deps.deferReset) {
      this.deps.deferReset(() => {
        if (!this.disposed) this.apply(plan);
      }, plan.snapshots);
    } else {
      this.apply(plan);
    }
    return "applied";
  }

  private apply(plan: SyncChangesPlan): void {
    // Lists read again anyway carry every conversation's state.
    if (!CONVERSATION_SNAPSHOTS.every((name) => plan.snapshots.has(name))) {
      for (const [channelId, state] of plan.conversations) {
        if (this.deps.applyConversation?.(channelId, state)) continue;
        for (const name of CONVERSATION_SNAPSHOTS) {
          plan.snapshots.add(name);
          if (!plan.reasons.has(name)) plan.reasons.set(name, "sync_unpatchable");
        }
        break;
      }
    }
    for (const [channelId, op] of plan.channelScopes) (this.deps.channelScopeChanged ?? applyChannelScopeChange)(channelId, op);
    for (const name of plan.snapshots) void this.runner.request(name, plan.reasons.get(name));
    for (const row of plan.messages.values()) this.deps.applyMessage?.(row);
    if (!plan.snapshots.has("channels")) {
      for (const channelId of plan.channelIds) void this.deps.refreshChannel(channelId);
    }
    if (!plan.snapshots.has("channel_members")) {
      for (const channelId of plan.memberChannelIds) this.deps.notifyChannelMembers(channelId);
    }
  }
}
