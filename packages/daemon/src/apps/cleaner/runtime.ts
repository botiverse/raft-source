import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  clearClockTimeout,
  currentTimeMs,
  isMachineDiskLow,
  setClockTimeout,
  type AgentInboxAppItem,
  type AgentMigrationReadiness,
} from "@botiverse/raft-shared";
import {
  appConfigTraceAttrs,
  appInboxItemTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_BOUNDS,
  CLEANER_NOTIFICATION_CLASS,
  CLEANER_DISK_NOTIFICATION_CLASS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol";
import type { AgentAppInboxStore } from "../../agentAppInbox";
import { AGENT_MIGRATION_BACKUP_IGNORE_FILE } from "../../agentMigrationExport";
import { readVolumeCapacity } from "../../volumeCapacity";
import {
  CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS,
  CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS,
  CLEANER_BACKUP_IGNORE_REMINDER_TITLE,
  CLEANER_BACKUP_IGNORE_URGENT_MIN_SPACING_MS,
  CLEANER_REMINDER_LARGEST_PREFIX,
  CLEANER_REMINDER_TOP_PATHS_PREFIX,
  CLEANER_WORKSPACE_MEASURE_BUDGET_MS,
  CLEANER_WORKSPACE_MEASURE_MAX_ENTRIES,
  CLEANER_WORKSPACE_SCAN_MAX_ENTRIES,
  CLEANER_WORKSPACE_SCAN_TIMEOUT_MS,
  CLEANER_WORKSPACE_TIDY_TITLE,
  backupIgnoreReminderSummary,
  defaultMeasureWorkspaceDirectories,
  defaultScanWorkspaceRoot,
  defaultStatIgnoreFile,
  diskReason,
  createFileReminderStateStore,
  forgetClearedSignals,
  formatBytes,
  hasNewSizeFailure,
  initialSignalMemory,
  largestDirectoryNames,
  namedFoldersStillMove,
  newReminderSignals,
  normalizeMigrationReadiness,
  parsePersistedReminderState,
  readinessBand,
  readinessRatio,
  reminderNamesSource,
  reminderSignalsCleared,
  sameIgnoreFileStamp,
  signalMemoryAfterReminder,
  sizeFailureRetryHint,
  type CleanerDirectorySize,
  type CleanerIgnoreFileStamp,
  type CleanerPersistedReminderState,
  type CleanerPresentedReminder,
  type CleanerReminderStateStore,
  type CleanerProviderQuota,
  type CleanerReminderNamesSource,
  type CleanerReminderSignal,
  type CleanerReminderTier,
  type CleanerReminderTrigger,
  type CleanerSignalMemory,
  type CleanerSignalSnapshot,
  type CleanerWorkspaceScan,
} from "./backupIgnoreReminder";

export * from "./backupIgnoreReminder";
import {
  createSystemCleanerInboxStore,
  deriveCleanerNextThreshold,
} from "./definition";

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

export type CleanerDiskMeasurement =
  | { kind: "measured"; availableBytes: number; totalBytes: number }
  | { kind: "not_established"; reason: "timeout" | "read_failed" };

// The local trace sink drops id-shaped keys outside its allowlist, and it
// allowlists the snake_case spellings (owner_agent_id, item_id, app_id), not
// the camelCase ones the call sites below use. Renaming here, at the one seam,
// keeps every cleaner event attributable to its owner agent in ScopeDB.
const CLEANER_TRACE_KEY_RENAMES: Readonly<Record<string, string>> = {
  ownerAgentId: "owner_agent_id",
  itemId: "item_id",
};

export function cleanerTraceAttrs(attrs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { app_id: CLEANER_APP_ID };
  for (const [key, value] of Object.entries(attrs)) {
    out[CLEANER_TRACE_KEY_RENAMES[key] ?? key] = value;
  }
  return out;
}

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
  measureDiskSpace?: (absolutePath: string) => Promise<CleanerDiskMeasurement>;
  /** Top-level scan for the .raftbackupignore reminder; `shouldStop` turns true at the time budget. */
  scanWorkspaceRoot?: (input: {
    absolutePath: string;
    maxEntries: number;
    shouldStop: () => boolean;
  }) => Promise<CleanerWorkspaceScan>;
  /** Tests only: a smaller entry cap than CLEANER_WORKSPACE_SCAN_MAX_ENTRIES. */
  workspaceScanMaxEntries?: number;
  /**
   * Size estimate of the scan's folders, for naming the largest; `shouldStop`
   * turns true at the time budget, and what was counted by then is returned.
   */
  measureWorkspaceDirectories?: (input: {
    absolutePath: string;
    directoryNames: readonly string[];
    maxEntries: number;
    shouldStop: () => boolean;
  }) => Promise<CleanerDirectorySize[]>;
  statIgnoreFile?: (absolutePath: string) => Promise<CleanerIgnoreFileStamp>;
  /** Bounded measurement of Raft's own files, traced with a low-disk decision. */
  measureRaftDiskFootprint?: () => Promise<Readonly<Record<string, unknown>>>;
  /**
   * Advisory notice for a running agent, called right after the agent went from
   * Working to Idle. Production never starts a stopped agent for it and never
   * writes into a turn that started meanwhile; the item then waits in the Inbox
   * for the next idle drain or wake. The urgent reminder passes
   * `interrupt: true`: production then also writes into a running turn (the
   * busy app Inbox notice), still never starting a stopped agent.
   */
  wake: (ownerAgentId: string, item: AgentInboxAppItem, options?: { interrupt?: boolean }) => void | Promise<void>;
  /** Per-agent reminder state across restarts; default a JSON file per agent (createFileReminderStateStore). */
  reminderStateStore?: CleanerReminderStateStore;
  /** Other idle work presented before the Cleaner's at the same transition (the idle task reminder). */
  beforeIdlePresent?: (ownerAgentId: string) => Promise<void>;
  /** Whether another delivery is queued for the agent; undefined where the host cannot tell. */
  deliveryPending?: (ownerAgentId: string) => boolean | undefined;
  /**
   * The agent's provider quota (production: AgentProcessManager.providerQuota,
   * from Claude's rate_limit_event); undefined means no reading.
   */
  providerQuota?: (ownerAgentId: string) => CleanerProviderQuota | undefined;
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
 * Workspace tip: a separate item asking the agent to delete workspace files it
 * is sure it no longer needs and to ask its owner or creator about the ones it
 * is unsure of. It rides along with the MEMORY.md hint at most once per agent
 * per week, and low disk space may add one more per low-disk episode. Nothing
 * scans the workspace for it; the agent decides (merged into the
 * .raftbackupignore reminder, that reminder may name the largest folders). It
 * reuses the disk hint's
 * notification class, which the Server manifest already declares.
 */
export const CLEANER_WORKSPACE_CLEANUP_TIP_TITLE =
  "When you have time: delete workspace files you are sure are unneeded; ask your owner or creator about unsure ones";
export const CLEANER_WORKSPACE_CLEANUP_TIP_SUMMARY =
  `Ask only about files new since you last asked. Also keep ${AGENT_MIGRATION_BACKUP_IGNORE_FILE} up to date.`;
export const CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

type CleanerWorkspaceTipTrigger = "memory_hint" | "disk_low";

/** Per-owner reminder state, persisted per agent (reminderStateStore) except the follow-up. */
interface CleanerBackupIgnoreState {
  lastReminderAtMs?: number;
  /** .raftbackupignore at the last reminder (or the last update taken as one). */
  stamp?: CleanerIgnoreFileStamp | "unknown";
  signals: CleanerSignalMemory;
  /** The last reminder, checked once at the next Working → Idle. */
  followUp?: { atMs: number; stamp: CleanerIgnoreFileStamp | "unknown"; tier: CleanerReminderTier };
  /**
   * What the reminder whose item is in the Inbox was about, until the item is
   * withdrawn or found gone (withdrawClearedReminder). In memory only, like
   * the item.
   */
  presented?: CleanerPresentedReminder;
}

/** Why a reminder's item was withdrawn (withdrawClearedReminder). */
type CleanerReminderWithdrawalRule = "named_folders_handled" | "ignore_file_changed" | "signals_cleared";

/** What a reminder names (reminderNames), with the trace attributes that describe how it was found. */
interface CleanerReminderNaming {
  source: CleanerReminderNamesSource["kind"];
  names: { prefix: string; items: readonly string[] } | null;
  traceAttrs: Readonly<Record<string, unknown>>;
}

/** A reminder decided on, minted by mintReminder (alone or merged with the workspace tip). */
interface CleanerReminderDecision {
  tier: CleanerReminderTier;
  trigger: CleanerReminderTrigger;
  reasons: string[];
  namesSource: CleanerReminderNamesSource["kind"];
  names: { prefix: string; items: readonly string[] } | null;
  /** Ends the summary: the retry hint of a new size failure (sizeFailureRetryHint). */
  trailer: string | null;
  presented: boolean;
  traceAttrs: Readonly<Record<string, unknown>>;
  /** Records the reminder: called once it is minted, with what its item showed. */
  commit: (shown: Pick<CleanerPresentedReminder, "names" | "tip">) => void;
  /** False once the agent's record was replaced or dropped (its workspace was deleted) since the decision. */
  stillCurrent: () => boolean;
}

/**
 * The MEMORY.md hint is advisory. Once presented, it is not presented (or
 * woken for) again for a day unless MEMORY.md grew markedly, so an agent that
 * read the hint but did not act is not interrupted every period. Dropping
 * under the threshold resets this.
 */
export const CLEANER_MEMORY_HINT_REWAKE_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
export const CLEANER_MEMORY_HINT_REWAKE_GROWTH_RATIO = 1.25;

type CleanerWakeReason = "first" | "cooldown_elapsed" | "grew";

/** A hint the period decided on; it is presented when the agent next goes from Working to Idle. */
interface CleanerDueHints {
  memory?: CleanerWakeReason;
  disk?: { availableBytes: number; totalBytes: number };
}

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
  private readonly measureDiskSpace: NonNullable<CleanerRuntimeOptions["measureDiskSpace"]>;
  private readonly measureRaftDiskFootprint: CleanerRuntimeOptions["measureRaftDiskFootprint"];
  private readonly wake: CleanerRuntimeOptions["wake"];
  private readonly trace: CleanerTrace;
  private readonly agentsDataDir: string;
  private readonly schemaBounds: CleanerSchemaBounds;
  private readonly getInbox: (ownerAgentId: string) => AgentAppInboxStore;
  /** Process-local, like the rest of the runtime: a restart may repeat the tip once early. */
  private readonly workspaceCleanupTipAtMs = new Map<string, number>();
  /** Last low-disk tip per owner, and owners already tipped in the current low-disk episode. */
  private readonly diskWorkspaceTipAtMs = new Map<string, number>();
  private readonly diskLowTipped = new Set<string>();
  /** Hints waiting for the owner's next Working → Idle transition. */
  private readonly due = new Map<string, CleanerDueHints>();
  /** Last MEMORY.md hint per owner; process-local as above. */
  private readonly memoryHintPresented = new Map<string, { atMs: number; bytes: number }>();
  private readonly backupIgnore = new Map<string, CleanerBackupIgnoreState>();
  private readonly readiness = new Map<string, AgentMigrationReadiness>();
  private readonly providerLimitAtMs = new Map<string, number>();
  /** The machine's last established disk measurement (one disk for all owners). */
  private lastDisk: { availableBytes: number; totalBytes: number } | null = null;
  private readonly beforeIdlePresent: CleanerRuntimeOptions["beforeIdlePresent"];
  private readonly deliveryPending: CleanerRuntimeOptions["deliveryPending"];
  private readonly providerQuota: CleanerRuntimeOptions["providerQuota"];
  private readonly reminderStateStore: CleanerReminderStateStore;
  private readonly backupIgnoreChain = new Map<string, Promise<void>>();
  private readonly scanWorkspaceRoot: NonNullable<CleanerRuntimeOptions["scanWorkspaceRoot"]>;
  private readonly workspaceScanMaxEntries: number;
  private readonly measureWorkspaceDirectories: NonNullable<CleanerRuntimeOptions["measureWorkspaceDirectories"]>;
  private readonly statIgnoreFile: NonNullable<CleanerRuntimeOptions["statIgnoreFile"]>;

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
    this.measureDiskSpace = options.measureDiskSpace ?? defaultMeasureDiskSpace;
    this.measureRaftDiskFootprint = options.measureRaftDiskFootprint;
    this.scanWorkspaceRoot = options.scanWorkspaceRoot ?? defaultScanWorkspaceRoot;
    this.workspaceScanMaxEntries = Math.min(
      options.workspaceScanMaxEntries ?? CLEANER_WORKSPACE_SCAN_MAX_ENTRIES,
      CLEANER_WORKSPACE_SCAN_MAX_ENTRIES,
    );
    this.measureWorkspaceDirectories = options.measureWorkspaceDirectories ?? defaultMeasureWorkspaceDirectories;
    this.statIgnoreFile = options.statIgnoreFile ?? defaultStatIgnoreFile;
    this.beforeIdlePresent = options.beforeIdlePresent;
    this.deliveryPending = options.deliveryPending;
    this.providerQuota = options.providerQuota;
    this.reminderStateStore = options.reminderStateStore ?? createFileReminderStateStore(this.agentsDataDir);
    this.wake = options.wake;
    const trace = options.trace;
    this.trace = trace ? (name, attrs, status) => trace(name, cleanerTraceAttrs(attrs), status) : () => {};
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
      this.forgetOwner(ownerAgentId);
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
      this.forgetOwner(ownerAgentId);
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
    this.workspaceCleanupTipAtMs.clear();
    this.diskWorkspaceTipAtMs.clear();
    this.diskLowTipped.clear();
    this.due.clear();
    this.backupIgnore.clear();
    this.readiness.clear();
    this.providerLimitAtMs.clear();
    this.lastDisk = null;
  }

  /**
   * The owner just went from Working to Idle: present whatever the period
   * decided is due, and the .raftbackupignore reminder if one is due. Only an
   * urgent reminder (presentUrgentReminder) reaches an agent mid-turn; an
   * agent that stays idle or stopped is not interrupted for anything else.
   */
  onAgentWorkingToIdle(ownerAgentId: string): void {
    const due = this.due.get(ownerAgentId);
    if (due) this.due.delete(ownerAgentId);
    const state = this.states.get(ownerAgentId);
    if (!state || !state.config.enabled) return;
    this.track(this.presentIdle(ownerAgentId, state, due), ownerAgentId);
  }

  /** The Server sent the agent's config (agent:start or agent:config): its migrationReadiness, if any. */
  noteMigrationReadiness(ownerAgentId: string, raw: unknown): void {
    if (!isSafeOwnerId(ownerAgentId)) return;
    const readiness = normalizeMigrationReadiness(raw);
    if (readiness) this.readiness.set(ownerAgentId, readiness);
    else this.readiness.delete(ownerAgentId);
    const state = this.states.get(ownerAgentId);
    if (state?.config.enabled) this.track(this.presentUrgentReminder(ownerAgentId, state), ownerAgentId);
  }

  /** The agent's workspace was deleted: its reminder state goes with it. */
  onAgentWorkspaceDeleted(ownerAgentId: string): void {
    if (!isSafeOwnerId(ownerAgentId)) return;
    this.backupIgnore.delete(ownerAgentId);
    this.readiness.delete(ownerAgentId);
    this.providerLimitAtMs.delete(ownerAgentId);
    try {
      this.reminderStateStore.remove(ownerAgentId);
    } catch {
      this.trace("daemon.cleaner.backup_ignore.state_remove_failed", { ownerAgentId });
    }
  }

  /** The agent's own provider credential hit a usage limit just now. */
  noteProviderLimitHit(ownerAgentId: string): void {
    if (!isSafeOwnerId(ownerAgentId)) return;
    this.providerLimitAtMs.set(ownerAgentId, this.clock.now());
  }

  private isCurrent(ownerAgentId: string, state: AppliedConfigState): boolean {
    return this.states.get(ownerAgentId) === state && state.config.enabled;
  }

  /**
   * Order at one transition: other idle work first (the idle task reminder,
   * `beforeIdlePresent`), then the Cleaner's due hints, then the reminder,
   * merged with the workspace tip when both are due. One wake for all of it.
   */
  private async presentIdle(ownerAgentId: string, state: AppliedConfigState, due: CleanerDueHints | undefined): Promise<void> {
    if (this.beforeIdlePresent) {
      try {
        await this.beforeIdlePresent(ownerAgentId);
      } catch {
        // The other app traces its own failures; the Cleaner still presents.
      }
    }
    if (!this.isCurrent(ownerAgentId, state)) return;
    // A low-disk workspace tip due now is merged into the reminder (presentDue), with its disk line.
    const reminder = await this.decideIdleReminder(ownerAgentId, state, due?.disk !== undefined);
    if (!this.isCurrent(ownerAgentId, state)) return;
    const minted = due ? await this.presentDue(ownerAgentId, state, due, reminder) : [];
    if (!this.isCurrent(ownerAgentId, state)) return;
    if (reminder && !reminder.presented) {
      const item = this.mintReminder(ownerAgentId, state, reminder, null);
      if (item) minted.push(item);
    }
    if (minted.length > 0) await this.wakeFor(ownerAgentId, minted[0]!, false);
  }

  private async wakeFor(ownerAgentId: string, item: AgentInboxAppItem, interrupt: boolean): Promise<void> {
    try {
      await this.wake(ownerAgentId, item, { interrupt });
    } catch {
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "wake_failed" });
    }
  }

  /** Loaded lazily from the persisted state; missing or corrupt: a fresh one. */
  private backupIgnoreRecord(ownerAgentId: string): CleanerBackupIgnoreState {
    let record = this.backupIgnore.get(ownerAgentId);
    if (!record) {
      let persisted: CleanerPersistedReminderState | null = null;
      try {
        persisted = parsePersistedReminderState(this.reminderStateStore.load(ownerAgentId));
      } catch {
        persisted = null;
      }
      record = persisted
        ? {
            ...(persisted.lastReminderAtMs === undefined ? {} : { lastReminderAtMs: persisted.lastReminderAtMs }),
            ...(persisted.stamp === undefined ? {} : { stamp: persisted.stamp }),
            signals: persisted.signals,
          }
        : { signals: initialSignalMemory() };
      this.backupIgnore.set(ownerAgentId, record);
    }
    return record;
  }

  private persistBackupIgnoreRecord(ownerAgentId: string, record: CleanerBackupIgnoreState): void {
    const state: CleanerPersistedReminderState = {
      version: 1,
      ...(record.lastReminderAtMs === undefined ? {} : { lastReminderAtMs: record.lastReminderAtMs }),
      ...(record.stamp === undefined ? {} : { stamp: record.stamp }),
      signals: record.signals,
      // Always null: see CleanerPersistedReminderState.
      names: null,
    };
    try {
      this.reminderStateStore.save(ownerAgentId, state);
    } catch {
      // Kept in memory; a restart then behaves as one without the file.
      this.trace("daemon.cleaner.backup_ignore.state_write_failed", { ownerAgentId });
    }
  }

  private signalSnapshot(ownerAgentId: string): CleanerSignalSnapshot {
    let quota: CleanerProviderQuota | undefined;
    try {
      quota = this.providerQuota?.(ownerAgentId);
    } catch {
      quota = undefined;
    }
    return {
      disk: this.lastDisk ?? null,
      readiness: this.readiness.get(ownerAgentId) ?? null,
      quota,
      providerLimitAtMs: this.providerLimitAtMs.get(ownerAgentId) ?? null,
    };
  }

  /** One reminder evaluation per owner at a time; a later one runs after it, on the state it left. */
  private withReminderSlot<T>(ownerAgentId: string, run: () => Promise<T | null>): Promise<T | null> {
    const previous = this.backupIgnoreChain.get(ownerAgentId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(() => undefined, () => undefined);
    this.backupIgnoreChain.set(ownerAgentId, settled);
    void settled.then(() => {
      if (this.backupIgnoreChain.get(ownerAgentId) === settled) this.backupIgnoreChain.delete(ownerAgentId);
    });
    return next;
  }

  /**
   * Follows up on the last reminder, withdraws its item when what it was
   * about is over (withdrawClearedReminder), then decides on a baseline or
   * early one (backupIgnoreReminder.ts). Nothing is recorded until it is minted.
   * `diskLowInText`: the low-disk workspace tip is due at this transition and
   * will be merged into the reminder. Traces carry counts and enums only:
   * names and paths can be private.
   */
  private decideIdleReminder(
    ownerAgentId: string,
    state: AppliedConfigState,
    diskLowInText: boolean,
  ): Promise<CleanerReminderDecision | null> {
    return this.withReminderSlot(ownerAgentId, async () => {
      const record = this.backupIgnoreRecord(ownerAgentId);
      const workspace = path.join(this.agentsDataDir, ownerAgentId);
      const ignorePath = path.join(workspace, AGENT_MIGRATION_BACKUP_IGNORE_FILE);
      const isCurrent = () => this.isCurrent(ownerAgentId, state) && this.backupIgnore.get(ownerAgentId) === record;
      // One stat serves the follow-up and the withdrawal.
      let ignoreStamp: Promise<CleanerIgnoreFileStamp | "unknown"> | null = null;
      const stampNow = () => (ignoreStamp ??= this.stampIgnoreFile(ignorePath));

      if (record.followUp) {
        const followUp = record.followUp;
        record.followUp = undefined;
        const stamp = await stampNow();
        if (!isCurrent()) return null;
        const outcome = stamp === "unknown" || followUp.stamp === "unknown"
          ? "not_established"
          : sameIgnoreFileStamp(stamp, followUp.stamp) ? "unchanged" : "changed";
        this.trace("daemon.cleaner.backup_ignore.followup", {
          ownerAgentId,
          outcome,
          tier: followUp.tier,
          ...(outcome === "not_established" ? {} : { ignore_file_changed: outcome === "changed" }),
          ...(stamp === "unknown" ? {} : { ignore_file_present: stamp !== null }),
          elapsed_ms: this.clock.now() - followUp.atMs,
        });
      }

      if (record.presented) {
        await this.withdrawClearedReminder(ownerAgentId, record, workspace, stampNow, isCurrent);
        if (!isCurrent()) return null;
      }

      const nowMs = this.clock.now();
      const firstReminder = record.lastReminderAtMs === undefined;
      const sinceLastMs = firstReminder ? Number.POSITIVE_INFINITY : nowMs - record.lastReminderAtMs!;
      const baselineDue = sinceLastMs >= CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS;
      const earlyAllowed = sinceLastMs >= CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS;
      const snapshot = this.signalSnapshot(ownerAgentId);
      forgetClearedSignals(record.signals, snapshot);
      const signals = newReminderSignals(record.signals, snapshot, nowMs);
      // Urgent signals keep the same spacing, except a size failure not reminded of yet.
      const spacingAllows = earlyAllowed || hasNewSizeFailure(signals);
      // Between baselines only a new signal sends a reminder (the first one is a baseline).
      if (!baselineDue && !(signals.length > 0 && spacingAllows)) return null;

      // A cheap check, where the host can tell: another delivery is waiting,
      // so this transition is not the agent's pause. The next one decides again.
      let deliveryPending: boolean | undefined;
      try {
        deliveryPending = this.deliveryPending?.(ownerAgentId);
      } catch {
        deliveryPending = undefined;
      }
      if (deliveryPending === true) {
        this.trace("daemon.cleaner.backup_ignore.skipped", { ownerAgentId, reason: "delivery_pending" });
        return null;
      }

      // A reminder is going out. One read of the workspace root comes first,
      // also when no folder will be named: without a readable root there is no
      // workspace to remind about. Its folders are measured only for names.
      const scan = await this.scanWorkspace(workspace);
      if (!isCurrent()) return null;
      const skip = (reason: string) => {
        this.trace("daemon.cleaner.backup_ignore.skipped", {
          ownerAgentId,
          reason,
          scan_outcome: scan.kind === "established" ? "established" : scan.reason,
        });
        return null;
      };
      // No readable workspace root: nothing of the agent's to move here.
      if (scan.kind === "not_established" && scan.reason === "read_failed") return skip("scan_not_established");

      const stamp = await this.stampIgnoreFile(ignorePath);
      if (!isCurrent()) return null;
      // Only a plain baseline (no new signal) is skipped when the agent kept
      // the file up to date since the last reminder; that update counts as one.
      if (!firstReminder && signals.length === 0 && stamp !== "unknown" && record.stamp !== undefined
        && record.stamp !== "unknown" && !sameIgnoreFileStamp(stamp, record.stamp)) {
        record.lastReminderAtMs = nowMs;
        record.stamp = stamp;
        this.persistBackupIgnoreRecord(ownerAgentId, record);
        return skip("ignore_file_updated");
      }
      const naming = await this.reminderNames(workspace, reminderNamesSource(signals, snapshot, diskLowInText), scan);
      if (!isCurrent()) return null;
      const tier: CleanerReminderTier = baselineDue ? "baseline" : "early";
      const trigger: CleanerReminderTrigger = firstReminder ? "first" : signals[0]?.trigger ?? "rhythm";
      return this.reminderDecision(ownerAgentId, record, {
        tier,
        trigger,
        signals,
        snapshot,
        stamp,
        nowMs,
        firstReminder,
        naming,
      });
    });
  }

  /**
   * Urgent reminder: a move refused for its size, critically low disk, or a
   * provider quota nearly used up, new since the last reminder. Evaluated on
   * the periodic tick and when the Server sends readiness; presented at once,
   * also into a running turn (the busy app Inbox notice), once per signal
   * state. The workspace is read only to name its largest folders.
   */
  private presentUrgentReminder(ownerAgentId: string, state: AppliedConfigState): Promise<void> {
    return this.withReminderSlot(ownerAgentId, async () => {
      const record = this.backupIgnoreRecord(ownerAgentId);
      const isCurrent = () => this.isCurrent(ownerAgentId, state) && this.backupIgnore.get(ownerAgentId) === record;
      const snapshot = this.signalSnapshot(ownerAgentId);
      forgetClearedSignals(record.signals, snapshot);
      const nowMs = this.clock.now();
      const signals = newReminderSignals(record.signals, snapshot, nowMs);
      if (!signals.some((signal) => signal.urgent)) return null;
      if (record.lastReminderAtMs !== undefined
        && nowMs - record.lastReminderAtMs < CLEANER_BACKUP_IGNORE_URGENT_MIN_SPACING_MS
        && !hasNewSizeFailure(signals)) {
        this.trace("daemon.cleaner.backup_ignore.skipped", { ownerAgentId, reason: "urgent_spacing" });
        return null;
      }
      const workspace = path.join(this.agentsDataDir, ownerAgentId);
      const stamp = await this.stampIgnoreFile(path.join(workspace, AGENT_MIGRATION_BACKUP_IGNORE_FILE));
      if (!isCurrent()) return null;
      const naming = await this.reminderNames(workspace, reminderNamesSource(signals, snapshot, false), null);
      if (!isCurrent()) return null;
      const decision = this.reminderDecision(ownerAgentId, record, {
        tier: "urgent",
        trigger: signals[0]!.trigger,
        signals,
        snapshot,
        stamp,
        nowMs,
        firstReminder: record.lastReminderAtMs === undefined,
        naming,
      });
      const item = this.mintReminder(ownerAgentId, state, decision, null);
      if (item) await this.wakeFor(ownerAgentId, item, true);
      return null;
    }).then(() => undefined);
  }

  /** The workspace root's folders a reminder may name: one bounded read (scanWorkspaceRoot). */
  private async scanWorkspace(workspace: string): Promise<CleanerWorkspaceScan> {
    let stopped = false;
    const scan = await this.measureWithTimeout<CleanerWorkspaceScan>(
      () => this.scanWorkspaceRoot({
        absolutePath: workspace,
        maxEntries: this.workspaceScanMaxEntries,
        shouldStop: () => stopped,
      }),
      CLEANER_WORKSPACE_SCAN_TIMEOUT_MS,
    );
    stopped = true;
    return scan;
  }

  /**
   * What a reminder that is going out names, with the trace attributes for
   * it. The workspace is measured only for `source.kind === "largest"`: the
   * `scan` already made (or one made here) gives the folders, and their size
   * estimate ranks them. A scan that is not established names nothing.
   */
  private async reminderNames(
    workspace: string,
    source: CleanerReminderNamesSource,
    scan: CleanerWorkspaceScan | null,
  ): Promise<CleanerReminderNaming> {
    const candidates = scan ?? (source.kind === "largest" ? await this.scanWorkspace(workspace) : null);
    const traceAttrs: Record<string, unknown> = {
      names_source: source.kind,
      scan_outcome: candidates === null ? "not_scanned" : candidates.kind === "established" ? "established" : candidates.reason,
      top_path_count: source.kind === "top_paths" ? source.paths.length : 0,
    };
    if (source.kind === "top_paths") {
      return { source: source.kind, names: { prefix: CLEANER_REMINDER_TOP_PATHS_PREFIX, items: source.paths }, traceAttrs };
    }
    if (source.kind === "none" || candidates?.kind !== "established" || candidates.directoryNames.length === 0) {
      return { source: source.kind, names: null, traceAttrs };
    }
    // The walk stops itself at the budget and returns what it counted; the
    // cut-off after it only guards against a read that never returns.
    let stopped = false;
    const budget = this.clock.schedule(() => { stopped = true; }, CLEANER_WORKSPACE_MEASURE_BUDGET_MS);
    const measured = await this.measureWithTimeout<{ kind: "measured"; sizes: CleanerDirectorySize[] }>(
      async () => ({
        kind: "measured",
        sizes: await this.measureWorkspaceDirectories({
          absolutePath: workspace,
          directoryNames: candidates.directoryNames,
          maxEntries: CLEANER_WORKSPACE_MEASURE_MAX_ENTRIES,
          shouldStop: () => stopped,
        }),
      }),
      CLEANER_WORKSPACE_MEASURE_BUDGET_MS + CLEANER_WORKSPACE_SCAN_TIMEOUT_MS,
    );
    stopped = true;
    this.clock.cancel(budget);
    traceAttrs.candidate_count = candidates.directoryNames.length;
    if (measured.kind !== "measured") {
      traceAttrs.measure_outcome = measured.reason;
      return { source: source.kind, names: null, traceAttrs };
    }
    traceAttrs.measure_outcome = measured.sizes.every((size) => size.complete) ? "complete" : "partial";
    traceAttrs.ranked_by = source.by;
    const largest = largestDirectoryNames(measured.sizes, source.by);
    return {
      source: source.kind,
      names: largest.length > 0
        ? { prefix: CLEANER_REMINDER_LARGEST_PREFIX, items: largest.map((name) => `${name}/`) }
        : null,
      traceAttrs,
    };
  }

  /** The reminder's item in the owner's Inbox, if it is there (the workspace tip's own item is another kind). */
  private reminderItem(ownerAgentId: string): AgentInboxAppItem | undefined {
    return this.getInbox(ownerAgentId).list().find((item) =>
      item.appId === CLEANER_APP_ID
      && item.notificationClass === CLEANER_DISK_NOTIFICATION_CLASS
      && item.sourceRef.kind === "backup_ignore_hint"
      && item.sourceRef.id === ownerAgentId);
  }

  /**
   * Takes the reminder's item back once what it was about is measurably over,
   * at a Working → Idle transition (with the follow-up), by the first of:
   * - `signals_cleared`: every signal it was sent for is gone from the signal
   *   snapshot (reminderSignalsCleared);
   * - `ignore_file_changed`: size was not its reason, so it had no names to
   *   give (names source `none`), and .raftbackupignore exists and differs
   *   from the file it was presented with;
   * - `named_folders_handled`: it named the largest folders that still move,
   *   and each is now skipped by an ignore file, marked `# keep:`, or gone
   *   (namedFoldersStillMove: the ignore files and one stat per folder, no
   *   walk).
   * The item merged with the low-disk workspace tip stays while the disk is
   * still low (or not measured), and the one merged with the weekly tip
   * stays: that tip has no condition to measure. Only the reminder's item is
   * dropped (the tip's own `disk_hint` item shares its class). Nothing about
   * the next reminder changes: the rhythm and the signal memory are as they
   * were, so a withdrawal never sends one.
   */
  private async withdrawClearedReminder(
    ownerAgentId: string,
    record: CleanerBackupIgnoreState,
    workspace: string,
    stampNow: () => Promise<CleanerIgnoreFileStamp | "unknown">,
    isCurrent: () => boolean,
  ): Promise<void> {
    const presented = record.presented;
    if (!presented) return;
    let held: boolean;
    try {
      held = this.reminderItem(ownerAgentId) !== undefined;
    } catch {
      // The Inbox cannot be read now: nothing is known about the item. The next transition looks again.
      return;
    }
    if (!held) {
      // The agent dismissed it, or it went with the owner's config: nothing to withdraw.
      record.presented = undefined;
      return;
    }
    // The merged item also carries the workspace tip, which must be over too.
    if (presented.tip === "memory_hint") return;
    if (presented.tip === "disk_low" && !(this.lastDisk !== null && !isMachineDiskLow(this.lastDisk))) return;
    const rule = await this.clearedReminderRule(ownerAgentId, presented, workspace, stampNow);
    if (rule === null || !isCurrent() || record.presented !== presented) return;
    let dropped: number;
    try {
      dropped = this.dropCurrentOwnerItem(ownerAgentId, "condition_cleared", CLEANER_DISK_NOTIFICATION_CLASS, "backup_ignore_hint");
    } catch {
      return;
    }
    // A sealed item stays, and is looked at again at the next transition.
    if (dropped === 0) return;
    record.presented = undefined;
    this.trace("daemon.cleaner.backup_ignore.withdrawn", {
      ownerAgentId,
      rule,
      names_source: presented.namesSource,
      named_count: presented.names.length,
      signal_count: presented.triggers.length,
      merged_with_tip: presented.tip !== null,
      elapsed_ms: this.clock.now() - presented.atMs,
    });
  }

  /** The rule by which the presented reminder is over, or null while it still holds. */
  private async clearedReminderRule(
    ownerAgentId: string,
    presented: CleanerPresentedReminder,
    workspace: string,
    stampNow: () => Promise<CleanerIgnoreFileStamp | "unknown">,
  ): Promise<CleanerReminderWithdrawalRule | null> {
    if (reminderSignalsCleared(presented.triggers, this.signalSnapshot(ownerAgentId), this.clock.now())) {
      return "signals_cleared";
    }
    if (presented.namesSource === "none") {
      // A file that is there now and differs from the one the reminder saw. A
      // deleted file (no stamp) is not an update.
      const stamp = await stampNow();
      return stamp !== "unknown" && stamp !== null && presented.stamp !== "unknown"
        && !sameIgnoreFileStamp(stamp, presented.stamp)
        ? "ignore_file_changed"
        : null;
    }
    // Only folders measured here are checked: the Server's largest paths of a
    // failed move say why it failed, and a reminder whose names did not fit
    // its summary showed none to check.
    if (presented.namesSource !== "largest" || presented.names.length === 0) return null;
    const checked = await this.measureWithTimeout<{ kind: "measured"; stillMove: boolean }>(
      async () => ({ kind: "measured", stillMove: await namedFoldersStillMove(workspace, presented.names) }),
      CLEANER_WORKSPACE_SCAN_TIMEOUT_MS,
    );
    return checked.kind === "measured" && !checked.stillMove ? "named_folders_handled" : null;
  }

  private reminderDecision(
    ownerAgentId: string,
    record: CleanerBackupIgnoreState,
    input: {
      tier: CleanerReminderTier;
      trigger: CleanerReminderTrigger;
      signals: CleanerReminderSignal[];
      snapshot: CleanerSignalSnapshot;
      stamp: CleanerIgnoreFileStamp | "unknown";
      nowMs: number;
      firstReminder: boolean;
      naming: CleanerReminderNaming;
    },
  ): CleanerReminderDecision {
    const trailer = sizeFailureRetryHint(input.signals, input.snapshot, input.nowMs);
    return {
      tier: input.tier,
      trigger: input.trigger,
      reasons: input.signals.map((signal) => signal.reason),
      namesSource: input.naming.source,
      names: input.naming.names,
      trailer,
      presented: false,
      traceAttrs: {
        tier: input.tier,
        trigger: input.trigger,
        first_reminder: input.firstReminder,
        signal_count: input.signals.length,
        urgent_signal_count: input.signals.filter((signal) => signal.urgent).length,
        ...input.naming.traceAttrs,
        retry_hint: trailer !== null,
        readiness_band: readinessBand(readinessRatio(input.snapshot.readiness)?.ratio),
        ...(input.stamp === "unknown" ? {} : { ignore_file_present: input.stamp !== null }),
      },
      stillCurrent: () => this.backupIgnore.get(ownerAgentId) === record,
      commit: (shown) => {
        // A workspace deleted while the reminder was being prepared dropped
        // this record; writing it back would undo that cleanup.
        if (this.backupIgnore.get(ownerAgentId) !== record) return;
        record.lastReminderAtMs = input.nowMs;
        record.signals = signalMemoryAfterReminder(record.signals, input.snapshot);
        record.stamp = input.stamp;
        record.followUp = { atMs: input.nowMs, stamp: input.stamp, tier: input.tier };
        record.presented = {
          atMs: input.nowMs,
          namesSource: input.naming.source,
          names: shown.names,
          triggers: [...new Set(input.signals.map((signal) => signal.trigger))],
          tip: shown.tip,
          stamp: input.stamp,
        };
        this.persistBackupIgnoreRecord(ownerAgentId, record);
      },
    };
  }

  /** `tip`: the workspace cleanup tip due at the same transition, merged into this one item. */
  private mintReminder(
    ownerAgentId: string,
    state: AppliedConfigState,
    decision: CleanerReminderDecision,
    tip: { disk: CleanerDueHints["disk"] } | null,
  ): AgentInboxAppItem | null {
    if (!decision.stillCurrent()) {
      this.trace("daemon.cleaner.backup_ignore.skipped", { ownerAgentId, reason: "record_replaced" });
      return null;
    }
    decision.presented = true;
    const reasons = tip?.disk && !decision.reasons.some((reason) => reason.startsWith("Disk is low"))
      ? [diskReason(tip.disk.availableBytes), ...decision.reasons]
      : decision.reasons;
    const { summary, namedCount } = backupIgnoreReminderSummary(reasons, decision.names, decision.trailer);
    const minted = this.getInbox(ownerAgentId).mint({
      appId: CLEANER_APP_ID,
      notificationClass: CLEANER_DISK_NOTIFICATION_CLASS,
      sourceRef: { kind: "backup_ignore_hint", agentId: ownerAgentId },
      title: tip ? CLEANER_WORKSPACE_TIDY_TITLE : CLEANER_BACKUP_IGNORE_REMINDER_TITLE,
      summary,
    });
    if (!minted.ok) {
      this.trace("daemon.cleaner.drop", {
        ownerAgentId,
        notificationClass: CLEANER_DISK_NOTIFICATION_CLASS,
        reason: "mint_rejected",
        code: minted.code,
      });
      return null;
    }
    decision.commit({
      // The names its summary showed; a folder measured here is shown with a `/` after its name.
      names: (decision.names?.items ?? []).slice(0, namedCount)
        .map((name) => (decision.namesSource === "largest" ? name.replace(/\/+$/, "") : name)),
      tip: tip === null ? null : tip.disk ? "disk_low" : "memory_hint",
    });
    this.trace("daemon.cleaner.backup_ignore.reminder", {
      ...appConfigTraceAttrs(state.config),
      item_correlation_id: appInboxItemTraceAttrs(ownerAgentId, minted.item).app_correlation_id,
      ownerAgentId,
      itemId: minted.item.itemId,
      notificationClass: CLEANER_DISK_NOTIFICATION_CLASS,
      ...decision.traceAttrs,
      named_count: namedCount,
      merged_with_tip: tip !== null,
    });
    return minted.item;
  }

  private async stampIgnoreFile(absolutePath: string): Promise<CleanerIgnoreFileStamp | "unknown"> {
    const result = await this.measureWithTimeout<{ kind: "measured"; stamp: CleanerIgnoreFileStamp }>(
      async () => ({ kind: "measured", stamp: await this.statIgnoreFile(absolutePath) }),
      CLEANER_WORKSPACE_SCAN_TIMEOUT_MS,
    );
    return result.kind === "measured" ? result.stamp : "unknown";
  }

  private forgetOwner(ownerAgentId: string): void {
    this.backupIgnore.delete(ownerAgentId);
    this.readiness.delete(ownerAgentId);
    this.providerLimitAtMs.delete(ownerAgentId);
    this.workspaceCleanupTipAtMs.delete(ownerAgentId);
    this.diskWorkspaceTipAtMs.delete(ownerAgentId);
    this.diskLowTipped.delete(ownerAgentId);
    this.due.delete(ownerAgentId);
  }

  private markDue(ownerAgentId: string, hints: CleanerDueHints): void {
    this.due.set(ownerAgentId, { ...this.due.get(ownerAgentId), ...hints });
  }

  private clearDue(ownerAgentId: string, kind: keyof CleanerDueHints): void {
    const due = this.due.get(ownerAgentId);
    if (!due) return;
    delete due[kind];
    if (due.memory === undefined && due.disk === undefined) this.due.delete(ownerAgentId);
  }

  private track(work: Promise<void>, ownerAgentId: string): void {
    const run = work.catch(() => {
      // Expected measurement/wake failures become typed trace decisions. This
      // guard keeps an injected seam bug from breaking the daemon timer loop.
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "runtime_failure" });
    });
    this.pendingRuns.add(run);
    void run.finally(() => this.pendingRuns.delete(run));
  }

  private arm(state: AppliedConfigState): void {
    const token = Symbol("cleaner-period");
    const delayMs = state.config.intervalMs;
    state.timerToken = token;
    state.nextFireAtMs = this.clock.now() + delayMs;
    state.timer = this.clock.schedule(() => this.startRun(state.config.ownerAgentId, token), delayMs);
  }

  private startRun(ownerAgentId: string, token: symbol): void {
    this.track(this.runPeriod(ownerAgentId, token), ownerAgentId);
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
      this.due.delete(ownerAgentId);
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
    await Promise.all([
      this.checkMemory(ownerAgentId, state, scheduledNextFireAtMs),
      this.checkDisk(ownerAgentId, state),
    ]);
    if (this.isCurrent(ownerAgentId, state)) await this.presentUrgentReminder(ownerAgentId, state);
  }

  private measureMemory(ownerAgentId: string) {
    return this.measureWithTimeout<CleanerMeasurement>(() => this.measureMemoryFile({
      ownerAgentId,
      literalFileName: "MEMORY.md",
      absolutePath: path.join(this.agentsDataDir, ownerAgentId, "MEMORY.md"),
    }));
  }

  private async checkMemory(ownerAgentId: string, state: AppliedConfigState, scheduledNextFireAtMs: number | null): Promise<void> {
    const config = state.config;
    const configTrace = appConfigTraceAttrs(config);
    const measurement = await this.measureMemory(ownerAgentId);

    // A config update may cancel/replace the next timer while I/O is in flight.
    // Never publish a result derived from the obsolete snapshot.
    const current = this.states.get(ownerAgentId);
    if (current !== state || !current.config.enabled) {
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "stale_measurement" });
      return;
    }

    if (measurement.kind === "not_established") {
      this.clearDue(ownerAgentId, "memory");
      const dropped = this.dropCurrentOwnerItem(ownerAgentId, "superseded", CLEANER_NOTIFICATION_CLASS);
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
      this.clearDue(ownerAgentId, "memory");
      const dropped = this.dropCurrentOwnerItem(ownerAgentId, "superseded", CLEANER_NOTIFICATION_CLASS);
      this.trace("daemon.cleaner.decision", {
        ...configTrace,
        ownerAgentId,
        decision: "under_threshold",
        droppedItems: dropped,
      });
      return;
    }

    if (!deriveCleanerNextThreshold({
      thresholdBytes: config.thresholdBytes,
      maximumThresholdBytes: this.schemaBounds.maximumThresholdBytes,
    }) || scheduledNextFireAtMs === null) {
      this.clearDue(ownerAgentId, "memory");
      this.dropCurrentOwnerItem(ownerAgentId, "superseded", CLEANER_NOTIFICATION_CLASS);
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "action_config_invalid" });
      return;
    }
    const wakeReason = this.memoryHintWakeReason(ownerAgentId, measurement.bytes, this.clock.now());
    this.trace("daemon.cleaner.decision", {
      ...configTrace,
      ownerAgentId,
      decision: "over_threshold",
    });
    if (wakeReason === null) {
      this.trace("daemon.cleaner.drop", {
        ownerAgentId,
        notificationClass: CLEANER_NOTIFICATION_CLASS,
        reason: "rewake_cooldown",
      });
      return;
    }
    this.markDue(ownerAgentId, { memory: wakeReason });
    this.trace("daemon.cleaner.hint_due", {
      ...configTrace,
      ownerAgentId,
      notificationClass: CLEANER_NOTIFICATION_CLASS,
      wake_reason: wakeReason,
    });
  }

  /** Mints the due hints (the tip merged into `reminder` when both are due); presentIdle wakes for them. */
  private async presentDue(
    ownerAgentId: string,
    state: AppliedConfigState,
    due: CleanerDueHints,
    reminder: CleanerReminderDecision | null,
  ): Promise<AgentInboxAppItem[]> {
    const minted: AgentInboxAppItem[] = [];
    const memoryItem = due.memory === undefined ? null : await this.presentMemoryHint(ownerAgentId, state, due.memory);
    if (this.states.get(ownerAgentId) !== state || !state.config.enabled) return minted;
    if (memoryItem) minted.push(memoryItem);

    const nowMs = this.clock.now();
    const lastTipAtMs = this.workspaceCleanupTipAtMs.get(ownerAgentId);
    const weeklyTipAllowed = lastTipAtMs === undefined
      || nowMs - lastTipAtMs >= CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS;
    const trigger: CleanerWorkspaceTipTrigger | null = due.disk !== undefined
      ? "disk_low"
      : memoryItem && weeklyTipAllowed ? "memory_hint" : null;
    if (memoryItem) {
      this.trace("daemon.cleaner.present", {
        ...appConfigTraceAttrs(state.config),
        item_correlation_id: appInboxItemTraceAttrs(ownerAgentId, memoryItem).app_correlation_id,
        ownerAgentId,
        itemId: memoryItem.itemId,
        notificationClass: CLEANER_NOTIFICATION_CLASS,
        nextFireAtMs: state.nextFireAtMs,
        wake_reason: due.memory,
        workspace_cleanup_tip: trigger !== null,
        // The hint still presented; only the tip was held back. Not a drop.
        ...(trigger !== null ? {} : { workspace_cleanup_tip_skipped: "weekly_cap" }),
      });
    }
    if (trigger !== null) {
      const tipItem = reminder
        ? this.mintMergedTip(ownerAgentId, state, reminder, trigger, due.disk)
        : this.presentWorkspaceTip(ownerAgentId, state, trigger, due.disk);
      if (tipItem) {
        minted.push(tipItem);
        this.workspaceCleanupTipAtMs.set(ownerAgentId, nowMs);
        if (trigger === "disk_low") this.diskWorkspaceTipAtMs.set(ownerAgentId, nowMs);
      }
    }
    return minted;
  }

  /** Remeasures, since the agent may have trimmed MEMORY.md during the turn. */
  private async presentMemoryHint(
    ownerAgentId: string,
    state: AppliedConfigState,
    wakeReason: CleanerWakeReason,
  ): Promise<AgentInboxAppItem | null> {
    const measurement = await this.measureMemory(ownerAgentId);
    if (this.states.get(ownerAgentId) !== state || !state.config.enabled) {
      this.trace("daemon.cleaner.drop", { ownerAgentId, reason: "stale_measurement" });
      return null;
    }
    const config = state.config;
    const configTrace = appConfigTraceAttrs(config);
    const next = deriveCleanerNextThreshold({
      thresholdBytes: config.thresholdBytes,
      maximumThresholdBytes: this.schemaBounds.maximumThresholdBytes,
    });
    if (measurement.kind === "not_established" || measurement.bytes <= config.thresholdBytes || !next) {
      const dropped = this.dropCurrentOwnerItem(ownerAgentId, "superseded", CLEANER_NOTIFICATION_CLASS);
      this.trace("daemon.cleaner.decision", {
        ...configTrace,
        ownerAgentId,
        decision: measurement.kind === "not_established"
          ? "not_established"
          : !next ? "action_config_invalid" : "under_threshold",
        checked_at: "idle_transition",
        droppedItems: dropped,
      });
      return null;
    }
    const title = memoryHintTitle(measurement.bytes, config.thresholdBytes, config.intervalMs);
    const actionCopy = next.copyKind === "doubles"
      ? "Action doubles threshold (or set lower)"
      : next.copyKind === "raises_to_maximum"
        ? "Action raises to maximum (or set lower)"
        : "Already at maximum; you can set it lower";
    const summary = `Keep an index; move details to notes; remove outdated information. ${actionCopy}.`;
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
      return null;
    }
    this.memoryHintPresented.set(ownerAgentId, { atMs: this.clock.now(), bytes: measurement.bytes });
    return minted.item;
  }

  private mintMergedTip(
    ownerAgentId: string,
    state: AppliedConfigState,
    reminder: CleanerReminderDecision,
    trigger: CleanerWorkspaceTipTrigger,
    disk: CleanerDueHints["disk"],
  ): AgentInboxAppItem | null {
    const item = this.mintReminder(ownerAgentId, state, reminder, { disk });
    if (!item) return null;
    this.trace("daemon.cleaner.present", {
      ...appConfigTraceAttrs(state.config),
      item_correlation_id: appInboxItemTraceAttrs(ownerAgentId, item).app_correlation_id,
      ownerAgentId,
      itemId: item.itemId,
      notificationClass: CLEANER_DISK_NOTIFICATION_CLASS,
      workspace_tip_trigger: trigger,
      merged_with_backup_ignore_reminder: true,
      ...(disk ? { disk_available_bytes: disk.availableBytes, disk_total_bytes: disk.totalBytes } : {}),
    });
    return item;
  }

  private presentWorkspaceTip(
    ownerAgentId: string,
    state: AppliedConfigState,
    trigger: CleanerWorkspaceTipTrigger,
    disk: CleanerDueHints["disk"],
  ): AgentInboxAppItem | null {
    const minted = this.getInbox(ownerAgentId).mint({
      appId: CLEANER_APP_ID,
      notificationClass: CLEANER_DISK_NOTIFICATION_CLASS,
      sourceRef: { kind: "disk_hint", agentId: ownerAgentId },
      title: CLEANER_WORKSPACE_CLEANUP_TIP_TITLE,
      summary: workspaceTipSummary(disk?.availableBytes),
    });
    if (!minted.ok) {
      this.trace("daemon.cleaner.drop", {
        ownerAgentId,
        notificationClass: CLEANER_DISK_NOTIFICATION_CLASS,
        reason: "mint_rejected",
        code: minted.code,
      });
      return null;
    }
    this.trace("daemon.cleaner.present", {
      ...appConfigTraceAttrs(state.config),
      item_correlation_id: appInboxItemTraceAttrs(ownerAgentId, minted.item).app_correlation_id,
      ownerAgentId,
      itemId: minted.item.itemId,
      notificationClass: CLEANER_DISK_NOTIFICATION_CLASS,
      workspace_tip_trigger: trigger,
      ...(disk ? { disk_available_bytes: disk.availableBytes, disk_total_bytes: disk.totalBytes } : {}),
    });
    return minted.item;
  }

  private async checkDisk(ownerAgentId: string, state: AppliedConfigState): Promise<void> {
    const measurement = await this.measureWithTimeout<CleanerDiskMeasurement>(() =>
      this.measureDiskSpace(this.agentsDataDir));
    if (this.states.get(ownerAgentId) !== state) return;
    const traceAttrs = { ...appConfigTraceAttrs(state.config), ownerAgentId, notificationClass: CLEANER_DISK_NOTIFICATION_CLASS };
    if (measurement.kind === "not_established") {
      this.trace("daemon.cleaner.measurement", { ...traceAttrs, established: false, reason: measurement.reason });
      return;
    }
    const { availableBytes, totalBytes } = measurement;
    if (!Number.isFinite(availableBytes) || availableBytes < 0
      || !Number.isFinite(totalBytes) || totalBytes <= 0 || availableBytes > totalBytes) {
      this.trace("daemon.cleaner.measurement", { ...traceAttrs, established: false, reason: "invalid_disk_measurement" });
      return;
    }
    this.trace("daemon.cleaner.measurement", { ...traceAttrs, established: true, availableBytes, totalBytes });
    this.lastDisk = { availableBytes, totalBytes };
    if (!isMachineDiskLow({ availableBytes, totalBytes })) {
      // The episode is over; the next one may tip again.
      this.diskLowTipped.delete(ownerAgentId);
      this.clearDue(ownerAgentId, "disk");
      return;
    }
    // Low disk space is a machine condition most agents cannot fix, so there
    // is no disk warning for agents. It may add one workspace tip per low-disk
    // episode (at most one a week), presented at the next Working → Idle.
    const lastDiskTipAtMs = this.diskWorkspaceTipAtMs.get(ownerAgentId);
    const diskTipAllowed = !this.diskLowTipped.has(ownerAgentId)
      && (lastDiskTipAtMs === undefined
        || this.clock.now() - lastDiskTipAtMs >= CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS);
    if (diskTipAllowed) {
      this.diskLowTipped.add(ownerAgentId);
      this.markDue(ownerAgentId, { disk: { availableBytes, totalBytes } });
    }
    const footprint = this.measureRaftDiskFootprint
      ? await this.measureRaftDiskFootprint().catch(() => ({ measure_outcome: "failed" }))
      : {};
    if (this.states.get(ownerAgentId) !== state) return;
    this.trace("daemon.cleaner.decision", {
      ...traceAttrs,
      decision: "disk_low",
      disk_available_bytes: availableBytes,
      disk_total_bytes: totalBytes,
      workspace_tip_due: diskTipAllowed,
      ...footprint,
    });
  }

  private memoryHintWakeReason(ownerAgentId: string, bytes: number, nowMs: number): CleanerWakeReason | null {
    const last = this.memoryHintPresented.get(ownerAgentId);
    if (!last) return "first";
    if (nowMs - last.atMs >= CLEANER_MEMORY_HINT_REWAKE_COOLDOWN_MS) return "cooldown_elapsed";
    if (bytes >= last.bytes * CLEANER_MEMORY_HINT_REWAKE_GROWTH_RATIO) return "grew";
    return null;
  }

  private measureWithTimeout<T extends { kind: string }>(
    measure: () => Promise<T>,
    timeoutMs = this.measurementTimeoutMs,
  ): Promise<T | { kind: "not_established"; reason: "timeout" | "read_failed" }> {
    type Result = T | { kind: "not_established"; reason: "timeout" | "read_failed" };
    let timer: unknown | null = null;
    return new Promise<Result>((resolve) => {
      let settled = false;
      const finish = (result: Result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.clock.cancel(timer);
        resolve(result);
      };
      timer = this.clock.schedule(
        () => finish({ kind: "not_established", reason: "timeout" }),
        timeoutMs,
      );
      void Promise.resolve().then(measure).then(finish, () => finish({ kind: "not_established", reason: "read_failed" }));
    });
  }

  private cancelStateTimer(state: AppliedConfigState | undefined): void {
    if (!state?.timer) return;
    this.clock.cancel(state.timer);
    state.timer = null;
    state.timerToken = null;
    state.nextFireAtMs = null;
  }

  /**
   * `notificationClass` and `sourceRefKind` narrow what is dropped: the
   * reminder and the workspace tip share a class and differ by kind.
   */
  private dropCurrentOwnerItem(
    ownerAgentId: string,
    reason: "superseded" | "process_boundary" | "condition_cleared" = "superseded",
    notificationClass?: string,
    sourceRefKind?: string,
  ): number {
    // Retracting the hint means its condition cleared (or the owner's config
    // changed), so the next occurrence is presented as new.
    if (notificationClass === undefined || notificationClass === CLEANER_NOTIFICATION_CLASS) {
      this.memoryHintPresented.delete(ownerAgentId);
    }
    let dropped = 0;
    const inbox = this.getInbox(ownerAgentId);
    for (const item of inbox.list()) {
      if (
        item.appId === CLEANER_APP_ID
        && (item.notificationClass === CLEANER_NOTIFICATION_CLASS || item.notificationClass === CLEANER_DISK_NOTIFICATION_CLASS)
        && (notificationClass === undefined || item.notificationClass === notificationClass)
        && (sourceRefKind === undefined || item.sourceRef.kind === sourceRefKind)
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

async function defaultMeasureDiskSpace(absolutePath: string): Promise<CleanerDiskMeasurement> {
  const capacity = await readVolumeCapacity(absolutePath);
  return capacity
    ? { kind: "measured", ...capacity }
    : { kind: "not_established", reason: "read_failed" };
}

export function memoryHintTitle(bytes: number, thresholdBytes: number, intervalMs: number): string {
  return `MEMORY.md is ${formatBytes(bytes)}, over ${formatBytes(thresholdBytes)}; recheck in ${formatInterval(intervalMs)}`;
}

export function workspaceTipSummary(diskAvailableBytes?: number): string {
  return diskAvailableBytes === undefined
    ? CLEANER_WORKSPACE_CLEANUP_TIP_SUMMARY
    : `Disk is low (${formatBytes(diskAvailableBytes)} free). ${CLEANER_WORKSPACE_CLEANUP_TIP_SUMMARY}`;
}

export function formatInterval(intervalMs: number): string {
  if (intervalMs % (7 * 24 * 60 * 60 * 1_000) === 0) return `${intervalMs / (7 * 24 * 60 * 60 * 1_000)}w`;
  if (intervalMs % (24 * 60 * 60 * 1_000) === 0) return `${intervalMs / (24 * 60 * 60 * 1_000)}d`;
  if (intervalMs % (60 * 60 * 1_000) === 0) return `${intervalMs / (60 * 60 * 1_000)}h`;
  if (intervalMs % (60 * 1_000) === 0) return `${intervalMs / (60 * 1_000)}m`;
  return `${Math.ceil(intervalMs / 1_000)}s`;
}
