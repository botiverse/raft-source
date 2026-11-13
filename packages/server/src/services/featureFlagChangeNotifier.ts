/**
 * Realtime "a flag affecting this Server may have changed" notices
 * (`server:features-changed`, contract in packages/shared/src/featuresChanged.ts).
 *
 * Why it polls: Feature Flag Admin is a Cloudflare Worker that writes flags,
 * rules, audiences and Labs straight to Postgres over Hyperdrive; Raft core has
 * no admin route to hook. Every FFA mutation bumps the single
 * `feature_flag_config_versions` row in the same transaction, so that row is the
 * one commit-ordered change signal all writers already share. LISTEN/NOTIFY
 * would need a migration plus a session-pinned connection that the production
 * pooler (Neon PgBouncer, transaction mode) does not keep, so each replica reads
 * that one primary-key row every 2 s instead.
 *
 * Cross-replica: every replica polls the same row, diffs the configuration
 * itself and notifies only its OWN sockets and machine connections, so each
 * connection gets one notice per change wherever it is attached, without a
 * Redis fan-out. Server-side writers that do not bump the cursor (Server Labs)
 * call `notifyServerFeatureFlagsChanged`, which notifies this replica's
 * connections and tells the other replicas through `serverSideEmit`.
 *
 * Which connections: a full per-connection re-evaluation is not possible here
 * (the web evaluates with client facts the socket does not carry), so the diff
 * computes a conservative scope per changed flag instead. Server-allowlist and
 * client rules reach only the listed Servers, user rules and user audience
 * members only those users, percentage changes only the units whose bucket
 * crossed the old/new threshold; flag rows, kill switch, default, plan, lab and
 * audience-rule changes reach every connection. Over-notifying costs a refetch;
 * under-notifying would be the bug.
 *
 * Cost bounds: the poll is one PK read per replica per 2 s. A change is
 * debounced (2 s quiet, at most 10 s), the full config is read only after the
 * cursor moved, and notices are sent in batches of 200 per 250 ms per replica
 * (800/s) so a change that reaches every connection does not make every client
 * refetch in the same instant.
 */
import {
  SERVER_FEATURES_CHANGED_SOCKET_EVENT,
  type ServerFeaturesChangedEvent,
  type ServerFeaturesChangedMachineMessage,
} from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { afterAmbientTransaction } from "../db/ambientTransaction";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  featureFlagAudienceMembers,
  featureFlagAudiences,
  featureFlagRules,
  featureFlags,
  labDefinitions,
} from "../db/schema";
import { isRedisAvailable } from "../redis";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { forgetCachedFlags } from "./featureFlagReadCache";
import {
  computeFeatureFlagBucket,
  getFeatureFlagConfigVersion,
  type FeatureFlagRandomizationUnit,
} from "./featureFlagService";

export const FEATURE_FLAG_CHANGE_POLL_INTERVAL_MS = 2_000;
export const FEATURE_FLAG_CHANGE_QUIET_MS = 2_000;
export const FEATURE_FLAG_CHANGE_MAX_WAIT_MS = 10_000;
export const FEATURE_FLAG_CHANGE_EMIT_BATCH_SIZE = 200;
export const FEATURE_FLAG_CHANGE_EMIT_BATCH_INTERVAL_MS = 250;
/** Replica-to-replica event (socket.io `serverSideEmit`), never sent to clients. */
export const FEATURE_FLAG_PEER_SERVER_CHANGE_EVENT = "features:server-changed";

// ---------------------------------------------------------------------------
// Configuration snapshot and diff (pure)

export type FeatureFlagSnapshotFlag = {
  enabled: boolean;
  killSwitch: boolean;
  randomizationUnit: FeatureFlagRandomizationUnit;
  defaultEnabled: boolean;
  defaultVariant: string | null;
  salt: string;
};

export type FeatureFlagSnapshotRule = {
  flagKey: string;
  stage: string;
  priority: number;
  decision: string;
  values: string[];
  percentageBasisPoints: number | null;
  variant: string | null;
  clientOs: string[] | null;
  minClientBuild: number | null;
  clientBuildTypes: string[] | null;
};

export type FeatureFlagConfigSnapshot = {
  version: number;
  flags: ReadonlyMap<string, FeatureFlagSnapshotFlag>;
  rules: ReadonlyMap<string, FeatureFlagSnapshotRule>;
  /** Audience key -> `kind:targetId` members; absent or disabled audiences match nobody. */
  audiences: ReadonlyMap<string, { enabled: boolean; members: ReadonlySet<string> }>;
  /** Lab key -> state. */
  labs: ReadonlyMap<string, string>;
};

/** Who a change to one flag can affect. */
export type FeatureFlagChangeScope =
  | { kind: "all" }
  /** Every human client connection (platform rules); not Computers. */
  | { kind: "clients" }
  | { kind: "servers"; ids: ReadonlySet<string> }
  | { kind: "users"; ids: ReadonlySet<string> }
  /** Units whose bucket is in [lo, hi). */
  | { kind: "bucket"; flagKey: string; salt: string; unit: FeatureFlagRandomizationUnit; lo: number; hi: number };

export type FeatureFlagChanges = ReadonlyMap<string, readonly FeatureFlagChangeScope[]>;

export type FeatureFlagChangeTarget = {
  serverId: string;
  userId: string | null;
  /** A human client socket (true) or a Computer connection (false). */
  client: boolean;
};

const ALL: FeatureFlagChangeScope = { kind: "all" };

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").sort() : [];
}

function nullableSortedStrings(value: unknown): string[] | null {
  return value == null ? null : sortedStrings(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Rule fields that matching reads; list order never matters to matching. */
function sameRule(a: FeatureFlagSnapshotRule, b: FeatureFlagSnapshotRule): boolean {
  const normalize = (rule: FeatureFlagSnapshotRule) => ({
    ...rule,
    values: [...rule.values].sort(),
    clientOs: rule.clientOs && [...rule.clientOs].sort(),
    clientBuildTypes: rule.clientBuildTypes && [...rule.clientBuildTypes].sort(),
  });
  return sameJson(normalize(a), normalize(b));
}

function union(a: readonly string[] | undefined, b: readonly string[] | undefined): Set<string> {
  return new Set([...(a ?? []), ...(b ?? [])]);
}

function symmetricDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const item of a) if (!b.has(item)) out.push(item);
  for (const item of b) if (!a.has(item)) out.push(item);
  return out;
}

function effectiveAudienceMembers(
  audience: { enabled: boolean; members: ReadonlySet<string> } | undefined,
): ReadonlySet<string> {
  return audience?.enabled ? audience.members : new Set<string>();
}

function ruleScope(
  prev: FeatureFlagSnapshotRule | undefined,
  next: FeatureFlagSnapshotRule | undefined,
  flag: FeatureFlagSnapshotFlag | undefined,
): FeatureFlagChangeScope | null {
  const stage = (next ?? prev)!.stage;
  if (prev && next && prev.stage !== next.stage) return ALL;
  switch (stage) {
    case "user":
      return { kind: "users", ids: union(prev?.values, next?.values) };
    case "server":
    case "client":
      return { kind: "servers", ids: union(prev?.values, next?.values) };
    case "platform":
      return { kind: "clients" };
    case "percentage": {
      if (!flag) return ALL;
      const before = prev?.percentageBasisPoints ?? 0;
      const after = next?.percentageBasisPoints ?? 0;
      const onlyThresholdMoved = Boolean(prev && next)
        && prev!.decision === next!.decision
        && prev!.priority === next!.priority
        && prev!.variant === next!.variant;
      const lo = onlyThresholdMoved ? Math.min(before, after) : 0;
      const hi = Math.max(before, after);
      if (hi <= lo) return null;
      return { kind: "bucket", flagKey: next?.flagKey ?? prev!.flagKey, salt: flag.salt, unit: flag.randomizationUnit, lo, hi };
    }
    default:
      // audience, lab, plan: who matches depends on data outside the rule.
      return ALL;
  }
}

/**
 * Per flag key, who the change from `prev` to `next` may affect. Empty when
 * nothing that evaluation reads changed (for example a description edit or an
 * audit-only cursor bump).
 */
export function diffFeatureFlagConfig(prev: FeatureFlagConfigSnapshot, next: FeatureFlagConfigSnapshot): FeatureFlagChanges {
  const changes = new Map<string, FeatureFlagChangeScope[]>();
  const add = (key: string, scope: FeatureFlagChangeScope | null) => {
    if (!scope) return;
    if (scope.kind === "servers" || scope.kind === "users") {
      if (scope.ids.size === 0) return;
    }
    const list = changes.get(key) ?? [];
    list.push(scope);
    changes.set(key, list);
  };

  for (const key of new Set([...prev.flags.keys(), ...next.flags.keys()])) {
    const a = prev.flags.get(key);
    const b = next.flags.get(key);
    if (!a || !b || !sameJson(a, b)) add(key, ALL);
  }

  for (const id of new Set([...prev.rules.keys(), ...next.rules.keys()])) {
    const a = prev.rules.get(id);
    const b = next.rules.get(id);
    if (a && b && sameRule(a, b)) continue;
    if (a && b && a.flagKey !== b.flagKey) {
      add(a.flagKey, ALL);
      add(b.flagKey, ALL);
      continue;
    }
    const key = (b ?? a)!.flagKey;
    add(key, ruleScope(a, b, next.flags.get(key) ?? prev.flags.get(key)));
  }

  const rulesReferencing = (stage: "audience" | "lab", value: string): string[] => {
    const keys = new Set<string>();
    for (const snapshot of [prev, next]) {
      for (const rule of snapshot.rules.values()) {
        if (rule.stage === stage && rule.values.includes(value)) keys.add(rule.flagKey);
      }
    }
    return [...keys];
  };

  for (const audienceKey of new Set([...prev.audiences.keys(), ...next.audiences.keys()])) {
    const changed = symmetricDifference(
      effectiveAudienceMembers(prev.audiences.get(audienceKey)),
      effectiveAudienceMembers(next.audiences.get(audienceKey)),
    );
    if (changed.length === 0) continue;
    const servers = new Set<string>();
    const users = new Set<string>();
    for (const member of changed) {
      const separator = member.indexOf(":");
      const kind = member.slice(0, separator);
      const id = member.slice(separator + 1);
      (kind === "server" ? servers : users).add(id);
    }
    for (const key of rulesReferencing("audience", audienceKey)) {
      add(key, { kind: "servers", ids: servers });
      add(key, { kind: "users", ids: users });
    }
  }

  for (const labKey of new Set([...prev.labs.keys(), ...next.labs.keys()])) {
    if ((prev.labs.get(labKey) === "open") === (next.labs.get(labKey) === "open")) continue;
    for (const key of rulesReferencing("lab", labKey)) add(key, ALL);
  }

  return changes;
}

/** The changed flag keys that may affect `target`, sorted; empty means "do not notify". */
export function featureFlagKeysAffecting(changes: FeatureFlagChanges, target: FeatureFlagChangeTarget): string[] {
  const keys: string[] = [];
  for (const [key, scopes] of changes) {
    if (scopes.some((scope) => scopeMatches(scope, target))) keys.push(key);
  }
  return keys.sort();
}

function scopeMatches(scope: FeatureFlagChangeScope, target: FeatureFlagChangeTarget): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "clients":
      return target.client;
    case "servers":
      return scope.ids.has(target.serverId);
    case "users":
      return target.userId !== null && scope.ids.has(target.userId);
    case "bucket": {
      const unitId = scope.unit === "server" ? target.serverId : target.userId;
      if (!unitId) return false;
      const bucket = computeFeatureFlagBucket({ key: scope.flagKey, salt: scope.salt, unit: scope.unit, unitId });
      return bucket >= scope.lo && bucket < scope.hi;
    }
  }
}

export async function loadFeatureFlagConfigSnapshot(executor: DatabaseExecutor = getDb()): Promise<FeatureFlagConfigSnapshot> {
  // The cursor is read first: a write that commits while the tables are read
  // bumps it past `version`, so the next poll reloads and diffs the rest.
  const version = await getFeatureFlagConfigVersion(executor);
  const flagRows = await executor.select().from(featureFlags);
  const ruleRows = await executor.select().from(featureFlagRules);
  const audienceRows = await executor
    .select({ key: featureFlagAudiences.key, enabled: featureFlagAudiences.enabled })
    .from(featureFlagAudiences);
  const memberRows = await executor
    .select({
      audienceKey: featureFlagAudienceMembers.audienceKey,
      kind: featureFlagAudienceMembers.kind,
      targetId: featureFlagAudienceMembers.targetId,
    })
    .from(featureFlagAudienceMembers);
  const labRows = await executor.select({ key: labDefinitions.key, state: labDefinitions.state }).from(labDefinitions);

  const flags = new Map<string, FeatureFlagSnapshotFlag>();
  for (const row of flagRows) {
    flags.set(row.key, {
      enabled: row.enabled,
      killSwitch: row.killSwitch,
      randomizationUnit: row.randomizationUnit,
      defaultEnabled: row.defaultEnabled,
      defaultVariant: row.defaultVariant,
      salt: row.salt,
    });
  }
  const rules = new Map<string, FeatureFlagSnapshotRule>();
  for (const row of ruleRows) {
    rules.set(row.id, {
      flagKey: row.flagKey,
      stage: row.stage,
      priority: row.priority,
      decision: row.decision,
      values: sortedStrings(row.values),
      percentageBasisPoints: row.percentageBasisPoints,
      variant: row.variant,
      clientOs: nullableSortedStrings(row.clientOs),
      minClientBuild: row.minClientBuild,
      clientBuildTypes: nullableSortedStrings(row.clientBuildTypes),
    });
  }
  const membersByAudience = new Map<string, Set<string>>();
  for (const row of memberRows) {
    const members = membersByAudience.get(row.audienceKey) ?? new Set<string>();
    members.add(`${row.kind}:${row.targetId}`);
    membersByAudience.set(row.audienceKey, members);
  }
  const audiences = new Map<string, { enabled: boolean; members: ReadonlySet<string> }>();
  for (const row of audienceRows) {
    audiences.set(row.key, { enabled: row.enabled, members: membersByAudience.get(row.key) ?? new Set() });
  }
  return { version, flags, rules, audiences, labs: new Map(labRows.map((row) => [row.key, row.state])) };
}

/** Flag keys with a `lab` rule naming one of `labKeys` (any lab when null). */
export async function listFeatureFlagKeysWithLabRules(
  labKeys: readonly string[] | null,
  executor: DatabaseExecutor = getDb(),
): Promise<string[]> {
  const rows = await executor
    .select({ flagKey: featureFlagRules.flagKey, values: featureFlagRules.values })
    .from(featureFlagRules)
    .where(eq(featureFlagRules.stage, "lab"));
  const keys = new Set<string>();
  for (const row of rows) {
    if (labKeys === null || sortedStrings(row.values).some((value) => labKeys.includes(value))) keys.add(row.flagKey);
  }
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// Delivery

/** This replica's connections, and the channel to the other replicas. */
export interface FeaturesChangedTransport {
  /** Sockets attached to this replica only. */
  localSockets(): Iterable<{ serverId: string | null; userId: string | null; emit(event: ServerFeaturesChangedEvent): void }>;
  /** Machine (Computer) connections attached to this replica only. */
  localMachines(): Iterable<{ serverId: string; send(message: ServerFeaturesChangedMachineMessage): void }>;
  /** Tell every other replica that one Server's flags may have changed. */
  publishServerChange(change: ServerFeaturesChangedEvent): void;
  onPeerServerChange(handler: (change: ServerFeaturesChangedEvent) => void): () => void;
}

export interface LocalMachineDirectory {
  listLocalMachineServers(): Array<{ machineId: string; serverId: string }>;
  sendToLocalMachine(machineId: string, message: ServerFeaturesChangedMachineMessage): boolean;
}

export function socketIoFeaturesChangedTransport(
  io: SocketServer,
  machines: LocalMachineDirectory | null,
): FeaturesChangedTransport {
  return {
    *localSockets() {
      // `of("/").sockets` holds only this replica's sockets.
      for (const socket of io.of("/").sockets.values()) {
        if (!socket.connected) continue;
        yield {
          serverId: typeof socket.data.serverId === "string" ? socket.data.serverId : null,
          userId: typeof socket.data.userId === "string" ? socket.data.userId : null,
          emit: (event) => {
            socket.emit(SERVER_FEATURES_CHANGED_SOCKET_EVENT, event);
          },
        };
      }
    },
    *localMachines() {
      if (!machines) return;
      for (const { machineId, serverId } of machines.listLocalMachineServers()) {
        yield { serverId, send: (message) => { machines.sendToLocalMachine(machineId, message); } };
      }
    },
    publishServerChange(change) {
      // Without the Redis adapter there are no other replicas (and the
      // in-memory adapter does not implement serverSideEmit).
      if (isRedisAvailable()) io.serverSideEmit(FEATURE_FLAG_PEER_SERVER_CHANGE_EVENT, change);
    },
    onPeerServerChange(handler) {
      const listener = (change: unknown) => {
        if (isServerFeaturesChangedEvent(change)) handler(change);
      };
      io.on(FEATURE_FLAG_PEER_SERVER_CHANGE_EVENT, listener);
      return () => {
        io.off(FEATURE_FLAG_PEER_SERVER_CHANGE_EVENT, listener);
      };
    },
  };
}

function isServerFeaturesChangedEvent(value: unknown): value is ServerFeaturesChangedEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.serverId === "string"
    && Array.isArray(record.keys)
    && record.keys.every((key) => typeof key === "string");
}

export interface FeatureFlagChangeNotifierOptions {
  transport: FeaturesChangedTransport;
  pollIntervalMs?: number;
  quietMs?: number;
  maxWaitMs?: number;
  emitBatchSize?: number;
  emitBatchIntervalMs?: number;
  loadVersion?: () => Promise<number>;
  loadSnapshot?: () => Promise<FeatureFlagConfigSnapshot>;
}

export interface FeatureFlagChangeNotifier {
  /** Read the cursor once; schedules a debounced diff when it moved. */
  pollOnce(): Promise<void>;
  /** Coalesce a one-Server change, then notify here and on every other replica. */
  notifyServer(serverId: string, keys: readonly string[]): void;
  /** Resolves when nothing is scheduled, being diffed or waiting to be sent. */
  idle(): Promise<void>;
  stop(): void;
}

export function createFeatureFlagChangeNotifier(options: FeatureFlagChangeNotifierOptions): FeatureFlagChangeNotifier {
  const {
    transport,
    pollIntervalMs = FEATURE_FLAG_CHANGE_POLL_INTERVAL_MS,
    quietMs = FEATURE_FLAG_CHANGE_QUIET_MS,
    maxWaitMs = FEATURE_FLAG_CHANGE_MAX_WAIT_MS,
    emitBatchSize = FEATURE_FLAG_CHANGE_EMIT_BATCH_SIZE,
    emitBatchIntervalMs = FEATURE_FLAG_CHANGE_EMIT_BATCH_INTERVAL_MS,
    loadVersion = () => getFeatureFlagConfigVersion(),
    loadSnapshot = () => loadFeatureFlagConfigSnapshot(),
  } = options;

  let stopped = false;
  let baseline: FeatureFlagConfigSnapshot | null = null;
  let seenVersion: number | null = null;
  let polling: Promise<void> | null = null;
  let diffing: Promise<void> | null = null;
  let firstPendingAt: number | null = null;
  let globalTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingServers = new Map<string, Set<string>>();
  let serverTimer: ReturnType<typeof setTimeout> | null = null;
  const sendQueue: Array<() => void> = [];
  let sendTimer: ReturnType<typeof setTimeout> | null = null;

  const logError = (site: string, error: unknown) => {
    console.error(`[feature-flag-change-notifier] ${site} failed:`, serializeErrorForLog(error));
  };

  const drainSendQueue = () => {
    sendTimer = null;
    if (stopped) return;
    for (const send of sendQueue.splice(0, emitBatchSize)) {
      try {
        send();
      } catch (error) {
        logError("send", error);
      }
    }
    if (sendQueue.length > 0) sendTimer = setTimeout(drainSendQueue, emitBatchIntervalMs);
  };

  const deliverLocally = (changes: FeatureFlagChanges) => {
    if (stopped || changes.size === 0) return;
    // This replica's cached answers for these flags (hot reads) go first.
    forgetCachedFlags(changes.keys());
    for (const socket of transport.localSockets()) {
      const serverId = socket.serverId;
      if (!serverId) continue;
      const keys = featureFlagKeysAffecting(changes, { serverId, userId: socket.userId, client: true });
      // Only the socket's own Server id: never another Server's.
      if (keys.length > 0) sendQueue.push(() => socket.emit({ serverId, keys }));
    }
    for (const machine of transport.localMachines()) {
      const serverId = machine.serverId;
      const keys = featureFlagKeysAffecting(changes, { serverId, userId: null, client: false });
      if (keys.length > 0) {
        sendQueue.push(() => machine.send({ type: SERVER_FEATURES_CHANGED_SOCKET_EVENT, serverId, keys }));
      }
    }
    if (sendQueue.length > 0 && !sendTimer) drainSendQueue();
  };

  const serverChanges = (serverId: string, keys: Iterable<string>): FeatureFlagChanges => {
    const scope: FeatureFlagChangeScope = { kind: "servers", ids: new Set([serverId]) };
    return new Map([...keys].map((key) => [key, [scope]]));
  };

  const runDiff = async () => {
    if (stopped || !baseline) return;
    const next = await loadSnapshot();
    const changes = diffFeatureFlagConfig(baseline, next);
    baseline = next;
    deliverLocally(changes);
  };

  const scheduleDiff = () => {
    if (stopped) return;
    const now = Date.now();
    firstPendingAt ??= now;
    if (globalTimer) clearTimeout(globalTimer);
    const delay = Math.max(0, Math.min(quietMs, firstPendingAt + maxWaitMs - now));
    globalTimer = setTimeout(() => {
      globalTimer = null;
      firstPendingAt = null;
      // Serialized: a diff still running when the next one fires goes first.
      const previous = diffing ?? Promise.resolve();
      const current: Promise<void> = previous
        .then(runDiff)
        .catch((error) => {
          logError("diff", error);
          // Retry the diff on the next poll; the baseline is unchanged.
          seenVersion = null;
        })
        .finally(() => {
          if (diffing === current) diffing = null;
        });
      diffing = current;
    }, delay);
  };

  const pollOnceInner = async () => {
    if (stopped) return;
    if (!baseline) {
      baseline = await loadSnapshot();
      seenVersion = baseline.version;
      return;
    }
    const version = await loadVersion();
    if (version === seenVersion) return;
    seenVersion = version;
    scheduleDiff();
  };

  const pollOnce = () => {
    polling ??= pollOnceInner()
      .catch((error) => logError("poll", error))
      .finally(() => {
        polling = null;
      });
    return polling;
  };

  const flushServers = () => {
    serverTimer = null;
    if (stopped) return;
    const pending = [...pendingServers];
    pendingServers.clear();
    for (const [serverId, keys] of pending) {
      deliverLocally(serverChanges(serverId, keys));
      try {
        transport.publishServerChange({ serverId, keys: [...keys].sort() });
      } catch (error) {
        logError("publish", error);
      }
    }
  };

  const unsubscribePeer = transport.onPeerServerChange((change) => {
    if (change.keys.length > 0) deliverLocally(serverChanges(change.serverId, change.keys));
  });

  const pollTimer = pollIntervalMs > 0 ? setInterval(() => void pollOnce(), pollIntervalMs) : null;
  pollTimer?.unref?.();

  return {
    pollOnce,
    notifyServer(serverId, keys) {
      if (stopped || keys.length === 0) return;
      const pending = pendingServers.get(serverId) ?? new Set<string>();
      for (const key of keys) pending.add(key);
      pendingServers.set(serverId, pending);
      // Fixed window from the first change: a burst of toggles is one notice.
      serverTimer ??= setTimeout(flushServers, quietMs);
    },
    async idle() {
      for (;;) {
        if (polling) await polling;
        if (diffing) await diffing;
        if (!polling && !diffing && !globalTimer && !serverTimer && !sendTimer && sendQueue.length === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      for (const timer of [globalTimer, serverTimer, sendTimer]) if (timer) clearTimeout(timer);
      globalTimer = serverTimer = sendTimer = null;
      sendQueue.length = 0;
      pendingServers.clear();
      unsubscribePeer();
    },
  };
}

let activeNotifier: FeatureFlagChangeNotifier | null = null;

/** Start this replica's notifier (server.ts); one per process. */
export function startFeatureFlagChangeNotifier(options: FeatureFlagChangeNotifierOptions): FeatureFlagChangeNotifier {
  activeNotifier?.stop();
  const created = createFeatureFlagChangeNotifier(options);
  const started: FeatureFlagChangeNotifier = {
    ...created,
    stop() {
      created.stop();
      if (activeNotifier === started) activeNotifier = null;
    },
  };
  activeNotifier = started;
  void started.pollOnce();
  return started;
}

/**
 * A server-side write changed what `serverId` evaluates for `keys` (e.g. a
 * Server Labs toggle). Call after commit. No-op when no notifier runs (tests,
 * scripts).
 */
export function notifyServerFeatureFlagsChanged(serverId: string, keys: readonly string[]): void {
  activeNotifier?.notifyServer(serverId, keys);
}

/**
 * After a committed Server Labs change: the flags with lab rules on `labKey`
 * (any lab when null, i.e. the master access switch) may now evaluate
 * differently for `serverId`.
 */
export function notifyServerLabFeatureFlagsChanged(serverId: string, labKey: string | null): void {
  if (!activeNotifier) return;
  afterAmbientTransaction(() => {
    void listFeatureFlagKeysWithLabRules(labKey === null ? null : [labKey])
      .then((keys) => notifyServerFeatureFlagsChanged(serverId, keys))
      .catch((error) => {
        console.warn("[feature-flag-change-notifier] lab change lookup failed:", serializeErrorForLog(error));
      });
  });
}
