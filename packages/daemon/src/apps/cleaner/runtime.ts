import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  clearClockTimeout,
  currentTimeMs,
  setClockTimeout,
  type AgentInboxAppItem,
} from "@botiverse/raft-shared";
import {
  appConfigTraceAttrs,
  appInboxItemTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace.js";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_BOUNDS,
  CLEANER_NOTIFICATION_CLASS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";
import type { AgentAppInboxStore } from "../../agentAppInbox.js";
import {
  createSystemCleanerInboxStore,
  deriveCleanerNextThreshold,
} from "./definition.js";

const CONFIG_KEYS = new Set([
  "appId",
  "ownerAgentId",
  "enabled",
  "thresholdBytes",
  "intervalMs",
  "revision",
]);

export interface CleanerConfigEnvelope {
  appId: typeof CLEANER_APP_ID;
  ownerAgentId: string;
  enabled: boolean;
  thresholdBytes: number;
  intervalMs: number;
  revision: number;
}

export type CleanerMeasurement =
  | { kind: "measured"; bytes: number }
  | {
      kind: "not_established";
      reason: "missing" | "not_regular_file" | "permission_denied" | "timeout" | "read_failed";
    };

export type CleanerTrace = (
  name: string,
  attrs: Readonly<Record<string, unknown>>,
  status?: "ok" | "error",
) => void;

export interface CleanerClock {
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}

const systemCleanerClock: CleanerClock = {
  now: currentTimeMs,
  schedule: setClockTimeout,
  cancel: clearClockTimeout,
};

export interface CleanerRuntimeOptions {
  agentsDataDir: string;
  clock?: CleanerClock;
  measurementTimeoutMs?: number;
  measureMemoryFile?: (input: {
    ownerAgentId: string;
    literalFileName: "MEMORY.md";
    absolutePath: string;
  }) => Promise<CleanerMeasurement>;
  wake: (ownerAgentId: string, item: AgentInboxAppItem) => void | Promise<void>;
  /** Production shares Core's per-owner typed Inbox; tests may use the fallback. */
  getInbox?: (ownerAgentId: string) => AgentAppInboxStore;
  trace?: CleanerTrace;
  idFactory?: () => string;
}

export interface CleanerSchemaBounds {
  minimumThresholdBytes: number;
  maximumThresholdBytes: number;
  minimumIntervalMs: number;
  maximumIntervalMs: number;
}

const CLEANER_SCHEMA_BOUNDS: CleanerSchemaBounds = {
  minimumThresholdBytes: CLEANER_CONFIG_BOUNDS.thresholdBytes.min,
  maximumThresholdBytes: CLEANER_CONFIG_BOUNDS.thresholdBytes.max,
  minimumIntervalMs: CLEANER_CONFIG_BOUNDS.intervalMs.min,
  maximumIntervalMs: CLEANER_CONFIG_BOUNDS.intervalMs.max,
};

interface AppliedConfigState {
  config: CleanerConfigEnvelope;
  timer: unknown | null;
  timerToken: symbol | null;
  nextFireAtMs: number | null;
}

export type CleanerConfigApplyResult =
  | { kind: "applied"; activeSchedules: 0 | 1 }
  | { kind: "stale"; currentRevision: number }
  | { kind: "invalid"; reason: string };

const DEFAULT_MEASUREMENT_TIMEOUT_MS = 10_000;

/**
 * Computer-local system.cleaner runtime.
 *
 * Config is a process-local mirror of durable server source state. Measurement,
 * item and schedule state are intentionally transient; a restart receives a
 * fresh config snapshot, arms one timer per owner and remeasures next period.
 */
export class SystemCleanerRuntime {
  /** Test fallback only; production uses getInbox(owner). */
  readonly inbox: AgentAppInboxStore;

  private readonly states = new Map<string, AppliedConfigState>();
  private readonly pendingRuns = new Set<Promise<void>>();
  private readonly clock: CleanerClock;
  private readonly measurementTimeoutMs: number;
  private readonly measureMemoryFile: NonNullable<CleanerRuntimeOptions["measureMemoryFile"]>;
  private readonly wake: CleanerRuntimeOptions["wake"];
  private readonly trace: CleanerTrace;
  private readonly agentsDataDir: string;
  private readonly schemaBounds: CleanerSchemaBounds;
  private readonly getInbox: (ownerAgentId: string) => AgentAppInboxStore;

  constructor(options: CleanerRuntimeOptions) {
    assertCleanerSchemaBounds(CLEANER_SCHEMA_BOUNDS);
    this.clock = options.clock ?? systemCleanerClock;
    this.measurementTimeoutMs = options.measurementTimeoutMs ?? DEFAULT_MEASUREMENT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.measurementTimeoutMs) || this.measurementTimeoutMs <= 0) {
      throw new Error("CLEANER_MEASUREMENT_TIMEOUT_INVALID");
    }
    this.agentsDataDir = path.resolve(options.agentsDataDir);
    this.schemaBounds = { ...CLEANER_SCHEMA_BOUNDS };
    this.measureMemoryFile = options.measureMemoryFile ?? defaultMeasureMemoryFile;
    this.wake = options.wake;
    this.trace = options.trace ?? (() => {});
    this.inbox = createSystemCleanerInboxStore({
      nowMs: () => this.clock.now(),
      idFactory: options.idFactory,
      resolveAppliedConfig: (ownerAgentId) => {
        const config = this.states.get(ownerAgentId)?.config;
        return config
          ? {
              thresholdBytes: config.thresholdBytes,
              maximumThresholdBytes: this.schemaBounds.maximumThresholdBytes,
            }
          : null;
      },
    });
    this.getInbox = options.getInbox ?? (() => this.inbox);
  }

  applyConfig(raw: unknown): CleanerConfigApplyResult {
    const parsed = parseCleanerConfigEnvelope(raw, this.schemaBounds);
    if (!parsed.ok) {
      this.trace("daemon.cleaner.config.rejected", { reason: parsed.reason });
      return { kind: "invalid", reason: parsed.reason };
    }
    const incoming = parsed.config;
    const existing = this.states.get(incoming.ownerAgentId);
    if (existing && existing.config.revision > incoming.revision) {
      return { kind: "stale", currentRevision: existing.config.revision };
    }
    if (existing && existing.config.revision === incoming.revision) {
      if (!sameConfig(existing.config, incoming)) {
        this.trace("daemon.cleaner.config.rejected", {
          ownerAgentId: incoming.ownerAgentId,
          revision: incoming.revision,
          reason: "revision_conflict",
        });
        return { kind: "invalid", reason: "revision_conflict" };
      }
      return { kind: "stale", currentRevision: existing.config.revision };
    }

    this.cancelStateTimer(existing);
    const dropped = this.dropCurrentOwnerItem(incoming.ownerAgentId);
    const state: AppliedConfigState = {
      config: incoming,
      timer: null,
      timerToken: null,
      nextFireAtMs: null,
    };
    this.states.set(incoming.ownerAgentId, state);
    if (incoming.enabled) this.arm(state);
    this.trace("daemon.cleaner.config.applied", {
      ...appConfigTraceAttrs(incoming),
      ownerAgentId: incoming.ownerAgentId,
      revision: incoming.revision,
      enabled: incoming.enabled,
      activeSchedules: state.timer === null ? 0 : 1,
      droppedItems: dropped,
    });
    return { kind: "applied", activeSchedules: state.timer === null ? 0 : 1 };
  }

  /** Authoritative reconnect snapshot; validation is all-or-nothing. */
  replaceSnapshot(rows: readonly unknown[]): CleanerConfigApplyResult[] | { kind: "invalid"; reason: string } {
    const parsedRows: CleanerConfigEnvelope[] = [];
    const owners = new Set<string>();
    for (const raw of rows) {
      const parsed = parseCleanerConfigEnvelope(raw, this.schemaBounds);
      if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };
      if (owners.has(parsed.config.ownerAgentId)) {
        return { kind: "invalid", reason: "duplicate_owner" };
      }
      owners.add(parsed.config.ownerAgentId);
      parsedRows.push(parsed.config);
    }
    for (const [ownerAgentId, state] of this.states) {
      if (owners.has(ownerAgentId)) continue;
      this.cancelStateTimer(state);
      this.dropCurrentOwnerItem(ownerAgentId);
      this.states.delete(ownerAgentId);
    }
    return parsedRows.map((row) => this.applyConfig(row));
  }

  /**
   * Authoritative snapshot for exactly one owner. Server snapshot messages are
   * owner-scoped; replacing A must never retire B's schedule/item.
   */
  replaceOwnerSnapshot(
    ownerAgentId: string,
    raw: unknown | null,
  ): CleanerConfigApplyResult | { kind: "removed"; activeSchedules: 0 } {
    if (!isSafeOwnerId(ownerAgentId)) return { kind: "invalid", reason: "owner_agent_id_invalid" };
    if (raw === null) {
      const existing = this.states.get(ownerAgentId);
      this.cancelStateTimer(existing);
      this.dropCurrentOwnerItem(ownerAgentId);
      this.states.delete(ownerAgentId);
      return { kind: "removed", activeSchedules: 0 };
    }
    const parsed = parseCleanerConfigEnvelope(raw, this.schemaBounds);
    if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };
    if (parsed.config.ownerAgentId !== ownerAgentId) {
      return { kind: "invalid", reason: "owner_agent_id_mismatch" };
    }
    return this.applyConfig(parsed.config);
  }

  activeScheduleCount(ownerAgentId: string): 0 | 1 {
    return this.states.get(ownerAgentId)?.timer === null || !this.states.has(ownerAgentId) ? 0 : 1;
  }

  getAppliedConfig(ownerAgentId: string): CleanerConfigEnvelope | null {
    const config = this.states.get(ownerAgentId)?.config;
    return config ? { ...config } : null;
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingRuns.size > 0) {
      await Promise.all([...this.pendingRuns]);
    }
  }

  clear(): void {
    const ownerAgentIds = [...this.states.keys()];
    for (const state of this.states.values()) this.cancelStateTimer(state);
    for (const ownerAgentId of ownerAgentIds) {
      this.dropCurrentOwnerItem(ownerAgentId, "process_boundary");
    }
    this.states.clear();
  }

  private arm(state: AppliedConfigState): void {
    const token = Symbol("cleaner-period");
    const delayMs = state.config.intervalMs;
    state.timerToken = token;
    state.nextFireAtMs = this.clock.now() + delayMs;
    state.timer = this.clock.schedule(() => this.startRun(state.config.ownerAgentId, token), delayMs);
  }

  private startRun(ownerAgentId: string, token: symbol): void {
    const run = this.runPeriod(ownerAgentId, token).catch(() => {
      // runPeriod converts all expected measurement/wake failures into typed
      // trace decisions. This guard prevents an injected seam bug from breaking
      // the daemon timer loop.
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "runtime_failure" });
    });
    this.pendingRuns.add(run);
    void run.finally(() => this.pendingRuns.delete(run));
  }

  private async runPeriod(ownerAgentId: string, token: symbol): Promise<void> {
    const state = this.states.get(ownerAgentId);
    if (!state || state.timerToken !== token) {
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "stale_timer" });
      return;
    }
    state.timer = null;
    state.timerToken = null;
    state.nextFireAtMs = null;

    // Reread current mirror before any effect. Disabled means zero re-arm,
    // measurement, item or wake even when the callback was already dequeued.
    const config = state.config;
    const configTrace = appConfigTraceAttrs(config);
    this.trace("daemon.cleaner.run", {
      ...configTrace,
      ownerAgentId,
      revision: config.revision,
    });
    if (!config.enabled) {
      this.dropCurrentOwnerItem(ownerAgentId);
      this.trace("daemon.cleaner.decision", {
        ...configTrace,
        ownerAgentId,
        decision: "disabled",
      });
      return;
    }

    // Rearm first so missing/timeout/failure still converges to a later retry.
    this.arm(state);
    const scheduledNextFireAtMs = state.nextFireAtMs;
    const measurement = await this.measureWithTimeout(ownerAgentId);

    // A config update may cancel/replace the next timer while I/O is in flight.
    // Never publish a result derived from the obsolete snapshot.
    const current = this.states.get(ownerAgentId);
    if (!current || current.config.revision !== config.revision || !current.config.enabled) {
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "stale_measurement" });
      return;
    }

    if (measurement.kind === "not_established") {
      const dropped = this.dropCurrentOwnerItem(ownerAgentId);
      this.trace("daemon.cleaner.measurement", {
        ...configTrace,
        ownerAgentId,
        established: false,
        reason: measurement.reason,
      });
      this.trace("daemon.cleaner.decision", {
        ...configTrace,
        ownerAgentId,
        decision: "not_established",
        droppedItems: dropped,
      });
      return;
    }

    this.trace("daemon.cleaner.measurement", {
      ...configTrace,
      ownerAgentId,
      established: true,
      bytes: measurement.bytes,
      thresholdBytes: config.thresholdBytes,
    });
    if (measurement.bytes <= config.thresholdBytes) {
      const dropped = this.dropCurrentOwnerItem(ownerAgentId);
      this.trace("daemon.cleaner.decision", {
        ...configTrace,
        ownerAgentId,
        decision: "under_threshold",
        droppedItems: dropped,
      });
      return;
    }

    const next = deriveCleanerNextThreshold({
      thresholdBytes: config.thresholdBytes,
      maximumThresholdBytes: this.schemaBounds.maximumThresholdBytes,
    });
    if (!next || scheduledNextFireAtMs === null) {
      this.dropCurrentOwnerItem(ownerAgentId);
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "action_config_invalid" });
      return;
    }
    const title = `MEMORY.md is ${formatBytes(measurement.bytes)}, over ${formatBytes(config.thresholdBytes)}`;
    const actionCopy = next.copyKind === "doubles"
      ? "Action doubles threshold (or set lower)"
      : next.copyKind === "raises_to_maximum"
        ? "Action raises to maximum (or set lower)"
        : "Already at maximum; you can set it lower";
    const summary = `Loaded each session; keep an index and move details to notes. ${actionCopy}; recheck in ${formatInterval(config.intervalMs)}.`;
    const minted = this.getInbox(ownerAgentId).mint({
      appId: CLEANER_APP_ID,
      notificationClass: CLEANER_NOTIFICATION_CLASS,
      sourceRef: { kind: "memory_hint", agentId: ownerAgentId },
      title,
      summary,
    });
    if (!minted.ok) {
      this.trace("daemon.cleaner.drop", {
        ownerAgentId,
        reason: "mint_rejected",
        code: minted.code,
      });
      return;
    }
    this.trace("daemon.cleaner.decision", {
      ...configTrace,
      ownerAgentId,
      decision: "over_threshold",
    });
    this.trace("daemon.cleaner.present", {
      ...configTrace,
      item_correlation_id: appInboxItemTraceAttrs(ownerAgentId, minted.item)
        .app_correlation_id,
      ownerAgentId,
      itemId: minted.item.itemId,
      nextFireAtMs: scheduledNextFireAtMs,
    });
    try {
      await this.wake(ownerAgentId, minted.item);
    } catch {
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "wake_failed" });
    }
  }

  private async measureWithTimeout(ownerAgentId: string): Promise<CleanerMeasurement> {
    const absolutePath = path.join(this.agentsDataDir, ownerAgentId, "MEMORY.md");
    let timer: unknown | null = null;
    return new Promise<CleanerMeasurement>((resolve) => {
      let settled = false;
      const finish = (result: CleanerMeasurement) => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.clock.cancel(timer);
        resolve(result);
      };
      timer = this.clock.schedule(
        () => finish({ kind: "not_established", reason: "timeout" }),
        this.measurementTimeoutMs,
      );
      void this.measureMemoryFile({
        ownerAgentId,
        literalFileName: "MEMORY.md",
        absolutePath,
      }).then(finish, () => finish({ kind: "not_established", reason: "read_failed" }));
    });
  }

  private cancelStateTimer(state: AppliedConfigState | undefined): void {
    if (!state?.timer) return;
    this.clock.cancel(state.timer);
    state.timer = null;
    state.timerToken = null;
    state.nextFireAtMs = null;
  }

  private dropCurrentOwnerItem(
    ownerAgentId: string,
    reason: "superseded" | "process_boundary" = "superseded",
  ): number {
    let dropped = 0;
    const inbox = this.getInbox(ownerAgentId);
    for (const item of inbox.list()) {
      if (
        item.appId === CLEANER_APP_ID
        && item.notificationClass === CLEANER_NOTIFICATION_CLASS
        && item.sourceRef.kind === "memory_hint"
        && item.sourceRef.id === ownerAgentId
        && inbox.ack(item.itemId)
      ) {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason, count: dropped });
    }
    return dropped;
  }
}

function parseCleanerConfigEnvelope(
  raw: unknown,
  bounds: CleanerSchemaBounds,
): { ok: true; config: CleanerConfigEnvelope } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "envelope_not_object" };
  }
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).some((key) => !CONFIG_KEYS.has(key))) {
    return { ok: false, reason: "envelope_unknown_field" };
  }
  if (row.appId !== CLEANER_APP_ID) return { ok: false, reason: "app_id_mismatch" };
  if (typeof row.ownerAgentId !== "string" || !isSafeOwnerId(row.ownerAgentId)) {
    return { ok: false, reason: "owner_agent_id_invalid" };
  }
  if (typeof row.enabled !== "boolean") return { ok: false, reason: "enabled_invalid" };
  if (
    !Number.isSafeInteger(row.thresholdBytes)
    || (row.thresholdBytes as number) < bounds.minimumThresholdBytes
    || (row.thresholdBytes as number) > bounds.maximumThresholdBytes
  ) {
    return { ok: false, reason: "threshold_bytes_invalid" };
  }
  if (
    !Number.isSafeInteger(row.intervalMs)
    || (row.intervalMs as number) < bounds.minimumIntervalMs
    || (row.intervalMs as number) > bounds.maximumIntervalMs
  ) {
    return { ok: false, reason: "interval_ms_invalid" };
  }
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) {
    return { ok: false, reason: "revision_invalid" };
  }
  return { ok: true, config: row as unknown as CleanerConfigEnvelope };
}

function assertCleanerSchemaBounds(bounds: CleanerSchemaBounds): void {
  const values = [
    bounds.minimumThresholdBytes,
    bounds.maximumThresholdBytes,
    bounds.minimumIntervalMs,
    bounds.maximumIntervalMs,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || bounds.minimumThresholdBytes > bounds.maximumThresholdBytes
    || bounds.minimumIntervalMs > bounds.maximumIntervalMs
  ) {
    throw new Error("CLEANER_SCHEMA_BOUNDS_INVALID");
  }
}

function sameConfig(left: CleanerConfigEnvelope, right: CleanerConfigEnvelope): boolean {
  return left.appId === right.appId
    && left.ownerAgentId === right.ownerAgentId
    && left.enabled === right.enabled
    && left.thresholdBytes === right.thresholdBytes
    && left.intervalMs === right.intervalMs
    && left.revision === right.revision;
}

function isSafeOwnerId(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && value !== "."
    && value !== ".."
    && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

async function defaultMeasureMemoryFile(input: {
  ownerAgentId: string;
  literalFileName: "MEMORY.md";
  absolutePath: string;
}): Promise<CleanerMeasurement> {
  try {
    const info = await lstat(input.absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      return { kind: "not_established", reason: "not_regular_file" };
    }
    return { kind: "measured", bytes: info.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { kind: "not_established", reason: "missing" };
    if (code === "EACCES" || code === "EPERM") {
      return { kind: "not_established", reason: "permission_denied" };
    }
    if (code === "ETIMEDOUT" || code === "ABORT_ERR") {
      return { kind: "not_established", reason: "timeout" };
    }
    return { kind: "not_established", reason: "read_failed" };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function formatInterval(intervalMs: number): string {
  if (intervalMs % (7 * 24 * 60 * 60 * 1_000) === 0) return `${intervalMs / (7 * 24 * 60 * 60 * 1_000)}w`;
  if (intervalMs % (24 * 60 * 60 * 1_000) === 0) return `${intervalMs / (24 * 60 * 60 * 1_000)}d`;
  if (intervalMs % (60 * 60 * 1_000) === 0) return `${intervalMs / (60 * 60 * 1_000)}h`;
  if (intervalMs % (60 * 1_000) === 0) return `${intervalMs / (60 * 1_000)}m`;
  return `${Math.ceil(intervalMs / 1_000)}s`;
}
