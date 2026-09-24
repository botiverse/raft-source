import { randomUUID } from "node:crypto";

import type { ReminderJob } from "@botiverse/raft-shared";
import type { Clock } from "../../connection.js";
import { systemClock } from "../../connection.js";
import { logger } from "../../logger.js";
import type { ScopedAppStorage } from "../../scopedAppStorage.js";

interface ReminderRecord {
  ownerAgentId: string;
  version: number;
  /** null means canceled/already-fired at this version; it must not re-arm. */
  job: ReminderJob | null;
  /** Historical due facts survive later lifecycle revisions until Server ack. */
  receipts: ReminderFireReceipt[];
  timer: unknown | null;
}

interface PersistedReminderRecord {
  ownerAgentId: string;
  version: number;
  job: ReminderJob | null;
  receipts: ReminderFireReceipt[];
}

export const REMINDER_PERSISTED_REJECTION_CODES = [
  "invalid_json",
  "envelope_invalid",
  "records_invalid",
  "record_invalid",
  "record_shape_invalid",
  "job_invalid",
  "receipts_invalid",
  "receipt_invalid",
  "retry_terminal_identity_invalid",
  "owner_scope_invalid",
] as const;

type ReminderPersistedRejectionCode =
  typeof REMINDER_PERSISTED_REJECTION_CODES[number];

class ReminderPersistedRejection extends Error {
  constructor(readonly code: ReminderPersistedRejectionCode) {
    super(
      code === "owner_scope_invalid"
        ? "reminder pending receipt owner scope invalid"
        : `reminder persisted payload rejected: ${code}`,
    );
  }
}

function rejectPersistedPayload(code: ReminderPersistedRejectionCode): never {
  throw new ReminderPersistedRejection(code);
}

export interface ReminderFireReceipt {
  job: ReminderJob;
  /** Identity of one local attempt; late responses cannot affect a successor. */
  requestId: string;
  firedAtClient: string;
  catchup: boolean;
  /** Durable local-side completion; false is replayed until wake enqueue succeeds. */
  wakeEnqueued: boolean;
  /** Durable remote-side completion; true suppresses further Server receipt replay. */
  serverAcked: boolean;
  /** False when Server advanced an unsupported recurrence without firing it. */
  serverFired: boolean;
  /** Durable source-read handoff; suppresses Inbox rematerialization after restart. */
  itemConsumed: boolean;
  /** Durable count of delivery attempts begun for this exact due obligation. */
  retryAttempt: number;
  /** Durable earliest time at which another delivery attempt may begin. */
  retryNextAttemptAt: string | null;
  /** Durable wall-clock ceiling shared by process restarts. */
  retryDeadlineAt: string;
  /**
   * Durable retry exhaustion evidence.
   *
   * Pre-Server failures are terminal because the Server has not consumed the
   * source revision. `inbox_materialization` is different: the Server already
   * accepted that exact due fact and may have independently armed the next
   * recurrence. In that stage this field is an escalation marker, not
   * permission to bury the still-unmaterialized occurrence; replay continues
   * at the capped cadence until Inbox materialization plus wake acceptance.
   */
  retryTerminal: ReminderRetryExhaustion | null;
  /** Durable truth for every phase projected by the bounded delivery alert. */
  phaseTruth: ReminderBoundedAlertPhaseTruth;
}

export const REMINDER_BOUNDED_ALERT_PHASES = [
  "fired",
  "app_item_materialized",
  "wake_request_accepted",
] as const;

export type ReminderBoundedAlertPhase =
  typeof REMINDER_BOUNDED_ALERT_PHASES[number];

export const REMINDER_PHASE_TRANSITION_SOURCES = {
  fired: "on_occurrence_fired",
  app_item_materialized: "agent_inbox_mint",
  wake_request_accepted: "notify_inbox",
} as const satisfies Record<ReminderBoundedAlertPhase, string>;

export type ReminderPhaseTransitionEvidence =
  | { state: false; evidence: "not_reached"; transition: null }
  | { state: true; evidence: "transition_provenance_missing"; transition: null }
  | {
      state: true;
      evidence: "observed";
      transition: {
        occurrenceId: string;
        observedAt: string;
        source: typeof REMINDER_PHASE_TRANSITION_SOURCES[ReminderBoundedAlertPhase];
      };
    };

export type ReminderBoundedAlertPhaseTruth = Readonly<
  Record<ReminderBoundedAlertPhase, ReminderPhaseTransitionEvidence>
>;

function unobservedPhase(): ReminderPhaseTransitionEvidence {
  return { state: false, evidence: "not_reached", transition: null };
}

function missingPhase(state: boolean): ReminderPhaseTransitionEvidence {
  return state
    ? { state: true, evidence: "transition_provenance_missing", transition: null }
    : unobservedPhase();
}

export function createReminderPhaseTruth(input: {
  occurrenceId: string;
  firedAtClient: string;
}): ReminderBoundedAlertPhaseTruth {
  return {
    fired: {
      state: true,
      evidence: "observed",
      transition: {
        occurrenceId: input.occurrenceId,
        observedAt: input.firedAtClient,
        source: REMINDER_PHASE_TRANSITION_SOURCES.fired,
      },
    },
    app_item_materialized: unobservedPhase(),
    wake_request_accepted: unobservedPhase(),
  };
}

function createLegacyReminderPhaseTruth(receipt: Pick<
  ReminderFireReceipt,
  "requestId" | "wakeEnqueued"
>): ReminderBoundedAlertPhaseTruth {
  return {
    // v2-v5 predate phase provenance. firedAtClient is a delivery fact, not
    // proof that this exact transition observation was emitted.
    fired: missingPhase(true),
    app_item_materialized: missingPhase(receipt.wakeEnqueued),
    wake_request_accepted: missingPhase(receipt.wakeEnqueued),
  };
}

function isRetryablePostServerEscalation(receipt: ReminderFireReceipt): boolean {
  return receipt.retryTerminal !== null
    && receipt.serverAcked
    && receipt.serverFired
    && !receipt.wakeEnqueued;
}

function isRetryObligationTerminal(receipt: ReminderFireReceipt): boolean {
  return receipt.retryTerminal !== null
    && !isRetryablePostServerEscalation(receipt);
}

export type ReminderRetryStage = "persistence" | "fire_request" | "inbox_materialization";

export interface ReminderRetryExhaustion {
  code: "REMINDER_DELIVERY_RETRY_EXHAUSTED";
  stage: ReminderRetryStage;
  ownerAgentId: string;
  reminderId: string;
  version: number;
  requestId: string;
  attempts: number;
  deadlineAt: string;
  exhaustedAt: string;
}

declare const reminderDueIdentityBrand: unique symbol;

/** App-local identity for one owner's due fact. Never key a receipt by revision alone. */
export type ReminderDueIdentity = Readonly<{
  ownerAgentId: string;
  reminderId: string;
  version: number;
  [reminderDueIdentityBrand]: true;
}>;

export function createReminderDueIdentity(input: {
  ownerAgentId: string;
  reminderId: string;
  version: number;
}): ReminderDueIdentity {
  return input as ReminderDueIdentity;
}

export interface ReminderFireContext {
  /** True when the durable mirror recovered a deadline that already passed. */
  catchup: boolean;
  firedAtClient: string;
  requestId: string;
  /** Durable wall-clock bound for detecting a fired occurrence without an ack. */
  retryDeadlineAt: string;
  /** True after a prior attempt durably recorded successful local wake enqueue. */
  wakeEnqueued: boolean;
  /** True after the Server acknowledged lifecycle convergence for this due fact. */
  serverAcked: boolean;
  /** Server-authoritative answer for whether this occurrence should surface. */
  serverFired: boolean;
  /** True after the source command acknowledged the durable local Inbox item. */
  itemConsumed: boolean;
  /** Exact prior-attempt phase truth, including typed missing provenance. */
  phaseTruth: ReminderBoundedAlertPhaseTruth;
}

export interface ReminderFireDeliveryResult {
  /** Persist only after the local runtime accepted/enqueued the wake. */
  wakeEnqueued: boolean;
  /** Closed failure stage used only when wakeEnqueued is false. */
  retryStage?: Exclude<ReminderRetryStage, "persistence">;
  /** Updated phase truth produced by the same choke points as observations. */
  phaseTruth?: ReminderBoundedAlertPhaseTruth;
}

export interface ReminderCacheOptions {
  clock?: Clock;
  /** Called only after the due occurrence has a durable scoped receipt. */
  onFire: (
    job: ReminderJob,
    context: ReminderFireContext,
  ) => void | ReminderFireDeliveryResult | Promise<void | ReminderFireDeliveryResult>;
  /** Observation-only seam called exactly when a new local due receipt is created. */
  onOccurrenceFired?: (input: {
    job: ReminderJob;
    requestId: string;
    firedAtClient: string;
    retryDeadlineAt: string;
  }) => ReminderPhaseTransitionEvidence | void;
  /** Max ms ahead we'll schedule a setTimeout. */
  maxDelayMs?: number;
  /** Server/App/Agent-scoped carriers for pending-fire receipts only. */
  storageForAgent?: (agentId: string) => ScopedAppStorage;
  /** Crash-injection seam: durable pending-fire committed, app item not minted yet. */
  afterFireCommitForTesting?: () => void;
  /** Retry cadence for a local Inbox wake that could not yet be enqueued. */
  fireRetryDelayMs?: number;
  /** Maximum delay between attempts after exponential backoff. */
  fireRetryMaxDelayMs?: number;
  /** Maximum delivery attempts for one exact due obligation. */
  fireRetryMaxAttempts?: number;
  /** Wall-clock retry ceiling, persisted across process restarts. */
  fireRetryDeadlineMs?: number;
  /** Typed fail-closed signal for observability; receives no reminder payload. */
  onRetryExhausted?: (exhaustion: ReminderRetryExhaustion) => void;
  /** Test seam for persistence failures; production uses scoped atomic replace. */
  persistForTesting?: (storage: ScopedAppStorage, payload: string) => void;
}

const DEFAULT_MAX_DELAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FIRE_RETRY_DELAY_MS = 1_000;
const DEFAULT_FIRE_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_FIRE_RETRY_MAX_ATTEMPTS = 8;
const DEFAULT_FIRE_RETRY_DEADLINE_MS = 15 * 60 * 1_000;

/**
 * Server-authoritative Reminder cache with a scoped pending-receipt outbox.
 *
 * Schedules and lifecycle tombstones are process-local and remain inert until
 * the first authoritative snapshot for their owner. Only committed due
 * receipts survive restart, via Server/App/Agent-scoped storage.
 */
export class ReminderCache {
  private readonly records = new Map<string, ReminderRecord>();
  private readonly clock: Clock;
  private readonly onFire: ReminderCacheOptions["onFire"];
  private readonly onOccurrenceFired: NonNullable<ReminderCacheOptions["onOccurrenceFired"]> | null;
  private readonly maxDelayMs: number;
  private readonly afterFireCommitForTesting: (() => void) | null;
  private readonly fireRetryDelayMs: number;
  private readonly fireRetryMaxDelayMs: number;
  private readonly fireRetryMaxAttempts: number;
  private readonly fireRetryDeadlineMs: number;
  private readonly onRetryExhausted: ((exhaustion: ReminderRetryExhaustion) => void) | null;
  private readonly persistForTesting: ReminderCacheOptions["persistForTesting"] | null;
  private readonly fireRetryTimers = new Map<string, unknown>();
  private readonly dispatchingReceipts = new Set<string>();
  private readonly synchronizedAgents = new Set<string>();
  private readonly restoredStorageAgents = new Set<string>();
  private readonly knownStorageAgents = new Set<string>();
  private storageForAgent: ((agentId: string) => ScopedAppStorage) | null;
  private started = false;

  constructor(opts: ReminderCacheOptions) {
    this.clock = opts.clock ?? systemClock;
    this.onFire = opts.onFire;
    this.onOccurrenceFired = opts.onOccurrenceFired ?? null;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.storageForAgent = opts.storageForAgent ?? null;
    this.afterFireCommitForTesting = opts.afterFireCommitForTesting ?? null;
    this.fireRetryDelayMs = opts.fireRetryDelayMs ?? DEFAULT_FIRE_RETRY_DELAY_MS;
    this.fireRetryMaxDelayMs = opts.fireRetryMaxDelayMs ?? DEFAULT_FIRE_RETRY_MAX_DELAY_MS;
    this.fireRetryMaxAttempts = opts.fireRetryMaxAttempts ?? DEFAULT_FIRE_RETRY_MAX_ATTEMPTS;
    this.fireRetryDeadlineMs = opts.fireRetryDeadlineMs ?? DEFAULT_FIRE_RETRY_DEADLINE_MS;
    this.onRetryExhausted = opts.onRetryExhausted ?? null;
    this.persistForTesting = opts.persistForTesting ?? null;
    if (
      this.fireRetryDelayMs <= 0
      || this.fireRetryMaxDelayMs < this.fireRetryDelayMs
      || !Number.isSafeInteger(this.fireRetryMaxAttempts)
      || this.fireRetryMaxAttempts < 1
      || this.fireRetryDeadlineMs <= 0
    ) {
      throw new Error("reminder retry policy invalid");
    }
  }

  /** Bind the authenticated Server/App-scoped receipt carrier exactly once. */
  bindStorageProvider(storageForAgent: (agentId: string) => ScopedAppStorage): void {
    if (this.storageForAgent && this.storageForAgent !== storageForAgent) {
      throw new Error("reminder pending receipt storage already bound");
    }
    this.storageForAgent = storageForAgent;
  }

  /** Startup is intentionally empty; schedules wait for a Server snapshot. */
  start(): void {
    if (this.started) return;
    this.started = true;
  }

  upsert(job: ReminderJob): "applied" | "stale" {
    const existing = this.records.get(job.reminderId);
    if (existing && !canApplyJob(existing, job)) {
      logger.info(`[ReminderCache] Stale upsert for ${job.reminderId} (incoming v${job.version} <= cached v${existing.version}) — ignored`);
      return "stale";
    }
    if (existing?.timer) this.clock.clearTimeout(existing.timer);
    const record: ReminderRecord = {
      ownerAgentId: job.ownerAgentId,
      version: job.version,
      job,
      receipts: existing?.receipts ?? [],
      timer: null,
    };
    this.records.set(job.reminderId, record);
    if (this.started && this.synchronizedAgents.has(job.ownerAgentId)) {
      record.timer = this.scheduleTimer(job, job.reminderId);
    }
    return "applied";
  }

  cancel(reminderId: string, version: number, ownerAgentId?: string): "applied" | "stale" {
    const existing = this.records.get(reminderId);
    if (
      existing
      && (
        existing.version > version
        || (ownerAgentId !== undefined && existing.ownerAgentId !== ownerAgentId)
      )
    ) {
      logger.info(
        `[ReminderCache] Stale cancel for ${reminderId} (incoming ${ownerAgentId ?? "unknown-owner"}@v${version}, cached ${existing.ownerAgentId}@v${existing.version}) — ignored`,
      );
      return "stale";
    }
    if (existing?.timer) this.clock.clearTimeout(existing.timer);
    if (!existing && !ownerAgentId) return "stale";
    this.records.set(reminderId, {
      ownerAgentId: existing?.ownerAgentId ?? ownerAgentId!,
      version,
      job: null,
      receipts: existing?.receipts ?? [],
      timer: null,
    });
    return "applied";
  }

  snapshot(agentId: string, jobs: ReminderJob[]): ReadonlyMap<string, "applied" | "stale" | "rejected"> {
    this.restorePendingReceipts(agentId);
    const firstAuthoritativeSnapshot = !this.synchronizedAgents.has(agentId);
    const firstSnapshotResetIds = new Set<string>();
    if (firstAuthoritativeSnapshot) {
      for (const [reminderId, record] of this.records) {
        if (record.ownerAgentId !== agentId) continue;
        if (record.timer) this.clock.clearTimeout(record.timer);
        if (record.receipts.length === 0) {
          // Pre-snapshot pushes and tombstones are not authoritative across the
          // initial sync boundary. Keep an omission fence, but let a matching
          // snapshot entry replace this placeholder and arm below.
          record.job = null;
          record.timer = null;
          firstSnapshotResetIds.add(reminderId);
          continue;
        }
        record.job = null;
        record.timer = null;
        record.version = Math.max(...record.receipts.map((receipt) => receipt.job.version));
      }
    }
    this.synchronizedAgents.add(agentId);
    const incoming = new Map<string, ReminderJob>();
    const outcomes = new Map<string, "applied" | "stale" | "rejected">();
    for (const job of jobs) {
      if (job.ownerAgentId !== agentId) {
        logger.warn(`[ReminderCache] snapshot for agent ${agentId} carried job ${job.reminderId} owned by ${job.ownerAgentId} — skipping`);
        outcomes.set(job.reminderId, "rejected");
        continue;
      }
      incoming.set(job.reminderId, job);
      outcomes.set(job.reminderId, "rejected");
    }
    for (const [reminderId, record] of this.records) {
      if (record.ownerAgentId !== agentId) continue;
      const job = incoming.get(reminderId);
      if (job && firstSnapshotResetIds.has(reminderId)) {
        this.records.delete(reminderId);
        continue;
      }
      if (job && !canApplyJob(record, job)) {
        // A snapshot can race a newer lifecycle push or a locally committed
        // fire/cancel tombstone. Never roll the mirror backward or resurrect
        // the same revision.
        incoming.delete(reminderId);
        outcomes.set(
          reminderId,
          record.ownerAgentId === job.ownerAgentId && record.version === job.version
            ? "stale"
            : "rejected",
        );
        continue;
      }
      if (record.timer) this.clock.clearTimeout(record.timer);
      if (!job) {
        // Authoritative omission is a lifecycle tombstone, not permission to
        // forget the revision fence. Otherwise a same/older replay can re-arm
        // a reminder that the snapshot explicitly removed.
        record.job = null;
        record.timer = null;
        continue;
      }
      // Keep the record until the incoming replacement is installed below.
      // Deleting it here drops restored historical receipts whenever the
      // authoritative snapshot already carries the independently advanced
      // recurring revision while its predecessor is still undelivered.
    }
    for (const job of incoming.values()) {
      const existing = this.records.get(job.reminderId);
      if (existing && !canApplyJob(existing, job)) {
        // In particular, a stale snapshot for the prior owner must not
        // overwrite a newer owner rebind for this stable reminder id.
        outcomes.set(
          job.reminderId,
          existing.ownerAgentId === job.ownerAgentId && existing.version === job.version
            ? "stale"
            : "rejected",
        );
        continue;
      }
      if (existing?.timer) this.clock.clearTimeout(existing.timer);
      const record: ReminderRecord = {
        ownerAgentId: job.ownerAgentId,
        version: job.version,
        job,
        // A later owner/revision does not erase an already-committed due fact
        // from the prior revision. It remains until both local wake and Server
        // convergence have completed.
        receipts: existing?.receipts ?? [],
        timer: null,
      };
      this.records.set(job.reminderId, record);
      if (this.started) record.timer = this.scheduleTimer(job, job.reminderId);
      outcomes.set(job.reminderId, "applied");
    }
    this.persist();
    for (const record of this.records.values()) {
      for (const receipt of record.receipts) {
        if (
          receipt.job.ownerAgentId === agentId
          && !isRetryObligationTerminal(receipt)
          && (!receipt.serverAcked || !receipt.wakeEnqueued)
        ) {
          this.scheduleOrDispatchRestoredReceipt(receipt);
        }
      }
    }
    return outcomes;
  }

  clear(): void {
    this.stop();
    this.records.clear();
    this.persist();
  }

  /** Stop process-local timers without deleting the scoped pending outbox. */
  stop(): void {
    this.started = false;
    for (const record of this.records.values()) {
      if (record.timer) this.clock.clearTimeout(record.timer);
      record.timer = null;
    }
    for (const timer of this.fireRetryTimers.values()) this.clock.clearTimeout(timer);
    this.fireRetryTimers.clear();
    this.dispatchingReceipts.clear();
  }

  size(): number {
    let count = 0;
    for (const record of this.records.values()) if (record.job) count += 1;
    return count;
  }

  /** True after this owner supplied its first authoritative schedule set. */
  isSynchronized(agentId: string): boolean {
    return this.synchronizedAgents.has(agentId);
  }

  getJob(reminderId: string): ReminderJob | null {
    return this.records.get(reminderId)?.job ?? null;
  }

  /** True only when this exact revision has an installed timer/fire intent. */
  isArmed(identity: ReminderDueIdentity): boolean {
    const record = this.records.get(identity.reminderId);
    const receipt = record ? findReceipt(record, identity) : undefined;
    return record?.ownerAgentId === identity.ownerAgentId
      && record.version === identity.version
      && (
        record.timer !== null
        || (receipt !== undefined && !isRetryObligationTerminal(receipt))
      );
  }

  pendingFireReceipts(): readonly ReminderFireReceipt[] {
    return [...this.records.values()].flatMap((record) =>
      record.receipts.filter((receipt) => !receipt.serverAcked && !receipt.retryTerminal)
    );
  }

  /** Re-enter the same budgeted path after transport reconnect. */
  replayPendingFireReceipts(): void {
    for (const receipt of this.pendingFireReceipts()) {
      if (this.synchronizedAgents.has(receipt.job.ownerAgentId)) {
        this.scheduleOrDispatchRestoredReceipt(receipt);
      }
    }
  }

  ackFireReceipt(identity: ReminderDueIdentity): boolean {
    const record = this.records.get(identity.reminderId);
    if (!record) return false;
    const index = record.receipts.findIndex((receipt) =>
      sameDueIdentity(receiptIdentity(receipt), identity)
    );
    if (index < 0) return false;
    const receipt = record.receipts[index]!;
    receipt.serverAcked = true;
    if (receipt.wakeEnqueued && receipt.itemConsumed) {
      record.receipts.splice(index, 1);
      this.clearFireRetry(identity);
    }
    this.persist();
    return true;
  }

  acceptFireRequest(
    identity: ReminderDueIdentity,
    requestId: string,
    result: { fired: boolean; catchup: boolean },
  ): boolean {
    const record = this.records.get(identity.reminderId);
    const receipt = record ? findReceipt(record, identity) : undefined;
    if (!record || !receipt || receipt.requestId !== requestId) return false;
    receipt.serverAcked = true;
    receipt.serverFired = result.fired;
    receipt.catchup = result.catchup;
    this.persist();
    if (!result.fired) {
      record.receipts.splice(record.receipts.indexOf(receipt), 1);
      this.clearFireRetry(identity);
      this.persist();
      return true;
    }
    this.dispatchFire(receipt);
    return true;
  }

  rearmFireRequest(
    identity: ReminderDueIdentity,
    requestId: string,
    retryAfterMs: number,
  ): boolean {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return false;
    const record = this.records.get(identity.reminderId);
    const receipt = record ? findReceipt(record, identity) : undefined;
    if (!record || !receipt || receipt.requestId !== requestId) return false;
    record.receipts.splice(record.receipts.indexOf(receipt), 1);
    this.clearFireRetry(identity);
    if (record.version === identity.version && record.job === null) {
      record.job = receipt.job;
      record.timer = this.started
        ? this.scheduleTimer(
            receipt.job,
            receipt.job.reminderId,
            Math.max(1, Math.min(this.maxDelayMs, retryAfterMs)),
          )
        : null;
    }
    this.persist();
    return true;
  }

  discardFireRequest(identity: ReminderDueIdentity, requestId: string): boolean {
    const record = this.records.get(identity.reminderId);
    const receipt = record ? findReceipt(record, identity) : undefined;
    if (!record || !receipt || receipt.requestId !== requestId) return false;
    record.receipts.splice(record.receipts.indexOf(receipt), 1);
    this.clearFireRetry(identity);
    this.persist();
    return true;
  }

  /** Persist the local source-read before the Inbox store removes its item. */
  ackLocalItem(identity: ReminderDueIdentity): boolean {
    const record = this.records.get(identity.reminderId);
    const receipt = record ? findReceipt(record, identity) : undefined;
    if (!receipt) {
      return record?.ownerAgentId === identity.ownerAgentId
        && record.version === identity.version;
    }
    receipt.itemConsumed = true;
    if (receipt.serverAcked && receipt.wakeEnqueued) {
      record!.receipts.splice(record!.receipts.indexOf(receipt), 1);
      this.clearFireRetry(identity);
    }
    this.persist();
    return true;
  }

  private scheduleTimer(job: ReminderJob, reminderId: string, retryDelayMs?: number): unknown {
    const fireAt = Date.parse(job.fireAt);
    if (Number.isNaN(fireAt)) {
      logger.warn(`[ReminderCache] Invalid fireAt for ${job.reminderId}: ${job.fireAt}`);
      return null;
    }
    const delay = retryDelayMs ?? Math.max(0, Math.min(this.maxDelayMs, fireAt - this.clock.now()));
    return this.clock.setTimeout(() => {
      const current = this.records.get(reminderId);
      if (!current?.job || current.version !== job.version) return;
      if (retryDelayMs === undefined && fireAt > this.clock.now()) {
        current.timer = this.scheduleTimer(job, reminderId);
        return;
      }
      const firedAtClient = new Date(this.clock.now()).toISOString();
      const catchup = fireAt < this.clock.now();
      const requestId = randomUUID();
      current.job = null;
      current.timer = null;
      const receipt: ReminderFireReceipt = {
        job,
        requestId,
        firedAtClient,
        catchup,
        wakeEnqueued: false,
        serverAcked: false,
        serverFired: false,
        itemConsumed: false,
        retryAttempt: 0,
        retryNextAttemptAt: null,
        retryDeadlineAt: new Date(this.clock.now() + this.fireRetryDeadlineMs).toISOString(),
        retryTerminal: null,
        phaseTruth: {
          fired: missingPhase(true),
          app_item_materialized: unobservedPhase(),
          wake_request_accepted: unobservedPhase(),
        },
      };
      current.receipts.push(receipt);
      try {
        const firedEvidence = this.onOccurrenceFired?.({
          job,
          requestId: receipt.requestId,
          firedAtClient: receipt.firedAtClient,
          retryDeadlineAt: receipt.retryDeadlineAt,
        });
        if (firedEvidence?.state === true && firedEvidence.evidence === "observed") {
          receipt.phaseTruth = { ...receipt.phaseTruth, fired: firedEvidence };
        }
      } catch (error) {
        logger.error("[ReminderCache] occurrence observer failed", error);
      }
      try {
        this.persist();
      } catch (error) {
        logger.error(`[ReminderCache] due receipt persistence failed for ${receipt.job.reminderId}`, error);
        this.scheduleFireRetry(receipt, "persistence");
        return;
      }
      this.afterFireCommitForTesting?.();
      this.dispatchFire(receipt);
    }, delay);
  }

  private dispatchFire(receipt: ReminderFireReceipt): void {
    const identity = receiptIdentity(receipt);
    const key = receiptKey(identity);
    if (this.dispatchingReceipts.has(key) || isRetryObligationTerminal(receipt)) return;
    if (
      this.retryBudgetExhausted(receipt)
      && !isRetryablePostServerEscalation(receipt)
    ) {
      this.exhaustRetry(receipt, this.defaultRetryStage(receipt));
      return;
    }
    this.clearFireRetry(identity);
    receipt.retryAttempt += 1;
    if (isRetryablePostServerEscalation(receipt)) {
      // Keep the persisted escalation self-consistent while later recovery
      // attempts continue beyond the original bounded alert threshold.
      receipt.retryTerminal!.attempts = receipt.retryAttempt;
    }
    receipt.retryNextAttemptAt = null;
    try {
      // Write-ahead is the authority edge: no fire-request or Inbox side effect
      // may begin until this attempt is durable.
      this.persist();
    } catch (error) {
      logger.error(`[ReminderCache] retry write-ahead failed for ${receipt.job.reminderId}`, error);
      this.scheduleFireRetry(receipt, "persistence");
      return;
    }
    this.dispatchingReceipts.add(key);
    let delivery: void | ReminderFireDeliveryResult | Promise<void | ReminderFireDeliveryResult>;
    try {
      delivery = this.onFire(receipt.job, {
        catchup: receipt.catchup,
        firedAtClient: receipt.firedAtClient,
        requestId: receipt.requestId,
        retryDeadlineAt: receipt.retryDeadlineAt,
        wakeEnqueued: receipt.wakeEnqueued,
        serverAcked: receipt.serverAcked,
        serverFired: receipt.serverFired,
        itemConsumed: receipt.itemConsumed,
        phaseTruth: receipt.phaseTruth,
      });
    } catch (error) {
      this.dispatchingReceipts.delete(key);
      logger.error(`[ReminderCache] onFire rejected for ${receipt.job.reminderId}`, error);
      this.scheduleFireRetry(receipt, this.defaultRetryStage(receipt));
      return;
    }
    void Promise.resolve(delivery).then((result) => {
      this.dispatchingReceipts.delete(key);
      const current = this.records.get(receipt.job.reminderId);
      const pending = current ? findReceipt(current, identity) : undefined;
      if (!pending) return;
      const wakeEnqueued = result === undefined || result.wakeEnqueued;
      if (result?.phaseTruth !== undefined) pending.phaseTruth = result.phaseTruth;
      if (!wakeEnqueued) {
        this.persist();
        this.scheduleFireRetry(pending, result?.retryStage ?? this.defaultRetryStage(pending));
        return;
      }
      pending.phaseTruth = {
        ...pending.phaseTruth,
        app_item_materialized: pending.phaseTruth.app_item_materialized.state
          ? pending.phaseTruth.app_item_materialized
          : missingPhase(true),
        wake_request_accepted: pending.phaseTruth.wake_request_accepted.state
          ? pending.phaseTruth.wake_request_accepted
          : missingPhase(true),
      };
      pending.wakeEnqueued = true;
      // The durable obligation recovered. The alert already exists in trace;
      // the scoped outbox should now describe the live successful state.
      pending.retryTerminal = null;
      if (pending.serverAcked && pending.itemConsumed) {
        current!.receipts.splice(current!.receipts.indexOf(pending), 1);
        this.clearFireRetry(identity);
      }
      this.persist();
    }).catch((error) => {
      this.dispatchingReceipts.delete(key);
      logger.error(`[ReminderCache] onFire rejected for ${receipt.job.reminderId}`, error);
      this.scheduleFireRetry(receipt, this.defaultRetryStage(receipt));
    });
  }

  private scheduleFireRetry(receipt: ReminderFireReceipt, stage: ReminderRetryStage): void {
    if (
      !this.started
      || isRetryObligationTerminal(receipt)
      || (receipt.wakeEnqueued && receipt.serverAcked)
    ) return;
    const identity = receiptIdentity(receipt);
    const current = this.records.get(receipt.job.reminderId);
    const pending = current ? findReceipt(current, identity) : undefined;
    if (!pending) return;
    if (this.retryBudgetExhausted(pending)) {
      this.exhaustRetry(pending, stage);
      return;
    }
    const key = receiptKey(identity);
    if (this.fireRetryTimers.has(key)) return;
    const delay = Math.min(
      this.fireRetryMaxDelayMs,
      this.fireRetryDelayMs * (2 ** Math.max(0, pending.retryAttempt - 1)),
      Math.max(0, Date.parse(pending.retryDeadlineAt) - this.clock.now()),
    );
    pending.retryNextAttemptAt = new Date(this.clock.now() + delay).toISOString();
    try {
      this.persist();
    } catch (error) {
      // The already-durable deadline still bounds restart replay. In this
      // process the same per-obligation timer/cap continues fail-closed.
      logger.error(`[ReminderCache] retry schedule persistence failed for ${receipt.job.reminderId}`, error);
    }
    const timer = this.clock.setTimeout(() => {
      this.fireRetryTimers.delete(key);
      this.dispatchFire(pending);
    }, delay);
    this.fireRetryTimers.set(key, timer);
  }

  private scheduleOrDispatchRestoredReceipt(receipt: ReminderFireReceipt): void {
    const nextAttemptAt = receipt.retryNextAttemptAt === null
      ? this.clock.now()
      : Date.parse(receipt.retryNextAttemptAt);
    if (nextAttemptAt > this.clock.now()) {
      const identity = receiptIdentity(receipt);
      const key = receiptKey(identity);
      if (this.fireRetryTimers.has(key)) return;
      const timer = this.clock.setTimeout(() => {
        this.fireRetryTimers.delete(key);
        this.dispatchFire(receipt);
      }, isRetryablePostServerEscalation(receipt)
        ? nextAttemptAt - this.clock.now()
        : Math.min(
            nextAttemptAt - this.clock.now(),
            Math.max(0, Date.parse(receipt.retryDeadlineAt) - this.clock.now()),
          ));
      this.fireRetryTimers.set(key, timer);
      return;
    }
    this.dispatchFire(receipt);
  }

  private retryBudgetExhausted(receipt: ReminderFireReceipt): boolean {
    return receipt.retryAttempt >= this.fireRetryMaxAttempts
      || this.clock.now() >= Date.parse(receipt.retryDeadlineAt);
  }

  private defaultRetryStage(receipt: ReminderFireReceipt): Exclude<ReminderRetryStage, "persistence"> {
    return receipt.serverAcked ? "inbox_materialization" : "fire_request";
  }

  private exhaustRetry(receipt: ReminderFireReceipt, stage: ReminderRetryStage): void {
    if (isRetryObligationTerminal(receipt)) return;
    const exhaustion: ReminderRetryExhaustion = {
      code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
      stage,
      ownerAgentId: receipt.job.ownerAgentId,
      reminderId: receipt.job.reminderId,
      version: receipt.job.version,
      requestId: receipt.requestId,
      attempts: receipt.retryAttempt,
      deadlineAt: receipt.retryDeadlineAt,
      exhaustedAt: new Date(this.clock.now()).toISOString(),
    };
    const retryablePostServer = receipt.serverAcked
      && receipt.serverFired
      && !receipt.wakeEnqueued;
    const firstEscalation = receipt.retryTerminal === null;
    if (firstEscalation) receipt.retryTerminal = exhaustion;
    if (retryablePostServer) {
      // The Server may already have advanced the recurring source row. Keep
      // this older due identity as a durable, independently retryable outbox
      // obligation instead of converting a bounded alert into data loss.
      receipt.retryTerminal!.attempts = receipt.retryAttempt;
      receipt.retryNextAttemptAt = new Date(
        this.clock.now() + this.fireRetryMaxDelayMs,
      ).toISOString();
    } else {
      receipt.retryTerminal = exhaustion;
      receipt.retryNextAttemptAt = null;
    }
    const identity = receiptIdentity(receipt);
    this.clearFireRetry(identity);
    try {
      this.persist();
    } catch (error) {
      logger.error(`[ReminderCache] retry exhaustion state persistence failed for ${receipt.job.reminderId}`, error);
    }
    if (firstEscalation) this.onRetryExhausted?.(exhaustion);
    if (retryablePostServer && this.started) {
      const key = receiptKey(identity);
      const timer = this.clock.setTimeout(() => {
        this.fireRetryTimers.delete(key);
        this.dispatchFire(receipt);
      }, this.fireRetryMaxDelayMs);
      this.fireRetryTimers.set(key, timer);
    }
  }

  private clearFireRetry(identity: ReminderDueIdentity): void {
    const key = receiptKey(identity);
    const timer = this.fireRetryTimers.get(key);
    if (this.fireRetryTimers.has(key)) this.clock.clearTimeout(timer);
    this.fireRetryTimers.delete(key);
  }

  private restorePendingReceipts(agentId: string): void {
    if (this.restoredStorageAgents.has(agentId)) return;
    this.knownStorageAgents.add(agentId);
    if (!this.storageForAgent) {
      this.restoredStorageAgents.add(agentId);
      return;
    }
    const storage = this.storageForAgent(agentId);
    storage.assertActive();
    const payload = storage.readText();
    if (payload === null) {
      this.restoredStorageAgents.add(agentId);
      return;
    }
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        rejectPersistedPayload("invalid_json");
      }
      const envelopeVersion = parsed && typeof parsed === "object"
        ? (parsed as { version?: number }).version ?? 0
        : 0;
      if (
        !parsed
        || typeof parsed !== "object"
        || ![2, 3, 4, 5, 6].includes(envelopeVersion)
      ) {
        rejectPersistedPayload("envelope_invalid");
      }
      const records = (parsed as { records?: unknown }).records;
      if (!Array.isArray(records)) rejectPersistedPayload("records_invalid");
      const restoredRecords: Array<PersistedReminderRecord & { reminderId: string }> = [];
      for (const raw of records) {
        const restored = validatePersistedRecord(raw, envelopeVersion);
        for (const receipt of restored.receipts) this.normalizeRetryState(receipt);
        if (restored.receipts.length === 0) continue;
        if (
          restored.ownerAgentId !== agentId
          || restored.receipts.some((receipt) => receipt.job.ownerAgentId !== agentId)
        ) {
          rejectPersistedPayload("owner_scope_invalid");
        }
        restoredRecords.push(restored);
      }
      // Validate the complete scoped payload before installing any receipt. A
      // later invalid record must not leave a valid prefix partially restored.
      for (const restored of restoredRecords) {
        const existing = this.records.get(restored.reminderId);
        if (existing) {
          for (const receipt of restored.receipts) {
            if (!findReceipt(existing, receiptIdentity(receipt))) existing.receipts.push(receipt);
          }
          continue;
        }
        this.records.set(restored.reminderId, {
          ownerAgentId: restored.ownerAgentId,
          version: restored.version,
          // A persisted schedule is legacy/untrusted input. Only occurrence-
          // bound pending receipts survive; Server snapshot owns schedules.
          job: null,
          receipts: restored.receipts,
          timer: null,
        });
      }
      this.restoredStorageAgents.add(agentId);
    } catch (error) {
      storage.reportDataFailure(
        error instanceof ReminderPersistedRejection
          ? "invalid_payload"
          : "internal_error",
      );
      throw error;
    }
  }

  private persist(): void {
    if (!this.storageForAgent) return;
    for (const record of this.records.values()) {
      for (const receipt of record.receipts) {
        this.knownStorageAgents.add(receipt.job.ownerAgentId);
      }
    }
    for (const agentId of this.knownStorageAgents) {
      const records = [...this.records.entries()].flatMap(([reminderId, record]) => {
        const receipts = record.receipts.filter((receipt) => receipt.job.ownerAgentId === agentId);
        if (receipts.length === 0) return [];
        return [{
          reminderId,
          ownerAgentId: agentId,
          version: Math.max(...receipts.map((receipt) => receipt.job.version)),
          // Never persist a full schedule or lifecycle tombstone. The scoped
          // carrier is a pending-fire receipt/outbox only.
          job: null,
          receipts,
        }];
      });
      const payload = `${JSON.stringify({ version: 6, records })}\n`;
      const storage = this.storageForAgent(agentId);
      storage.assertActive();
      if (this.persistForTesting) {
        this.persistForTesting(storage, payload);
      } else {
        storage.writeTextAtomic(payload);
      }
    }
  }

  private normalizeRetryState(receipt: ReminderFireReceipt): void {
    if (!Number.isSafeInteger(receipt.retryAttempt) || receipt.retryAttempt < 0) {
      receipt.retryAttempt = 0;
    }
    if (
      receipt.retryNextAttemptAt !== null
      && (typeof receipt.retryNextAttemptAt !== "string" || Number.isNaN(Date.parse(receipt.retryNextAttemptAt)))
    ) {
      receipt.retryNextAttemptAt = null;
    }
    if (typeof receipt.retryDeadlineAt !== "string" || Number.isNaN(Date.parse(receipt.retryDeadlineAt))) {
      receipt.retryDeadlineAt = new Date(this.clock.now() + this.fireRetryDeadlineMs).toISOString();
    }
    if (!isReminderRetryExhaustion(receipt.retryTerminal)) receipt.retryTerminal = null;
  }
}

function validatePersistedRecord(
  raw: unknown,
  envelopeVersion: number,
): PersistedReminderRecord & { reminderId: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    rejectPersistedPayload("record_invalid");
  }
  const value = raw as Partial<PersistedReminderRecord> & { reminderId?: unknown };
  if (
    typeof value.reminderId !== "string"
    || typeof value.ownerAgentId !== "string"
    || !Number.isSafeInteger(value.version)
    || (value.version ?? 0) < 1
  ) {
    rejectPersistedPayload("record_shape_invalid");
  }
  if (value.job !== null) {
    const job = value.job as Partial<ReminderJob> | undefined;
    if (
      !job
      || job.reminderId !== value.reminderId
      || job.ownerAgentId !== value.ownerAgentId
      || job.version !== value.version
      || typeof job.fireAt !== "string"
      || Number.isNaN(Date.parse(job.fireAt))
    ) {
      rejectPersistedPayload("job_invalid");
    }
  }
  if (!Array.isArray(value.receipts)) {
    rejectPersistedPayload("receipts_invalid");
  }
  for (const rawReceipt of value.receipts) {
    const receipt = rawReceipt as Partial<ReminderFireReceipt> | undefined;
    const v5StateMissing = envelopeVersion >= 5 && (
      receipt?.requestId === undefined
      || receipt.serverFired === undefined
      || receipt.itemConsumed === undefined
      || receipt.retryAttempt === undefined
      || !("retryNextAttemptAt" in (receipt ?? {}))
      || receipt.retryDeadlineAt === undefined
      || !("retryTerminal" in (receipt ?? {}))
    );
    const v6StateMissing = envelopeVersion >= 6 && receipt?.phaseTruth === undefined;
    if (
      !receipt
      || v5StateMissing
      || v6StateMissing
      || receipt.job?.reminderId !== value.reminderId
      || typeof receipt.job.ownerAgentId !== "string"
      || receipt.job.ownerAgentId.length === 0
      || !Number.isSafeInteger(receipt.job.version)
      || receipt.job.version < 1
      || typeof receipt.firedAtClient !== "string"
      || Number.isNaN(Date.parse(receipt.firedAtClient))
      || typeof receipt.catchup !== "boolean"
      || typeof receipt.wakeEnqueued !== "boolean"
      || typeof receipt.serverAcked !== "boolean"
      || (receipt.requestId !== undefined && typeof receipt.requestId !== "string")
      || (receipt.serverFired !== undefined && typeof receipt.serverFired !== "boolean")
      || (receipt.itemConsumed !== undefined && typeof receipt.itemConsumed !== "boolean")
      || (receipt.retryAttempt !== undefined && (!Number.isSafeInteger(receipt.retryAttempt) || receipt.retryAttempt < 0))
      || (
        receipt.retryNextAttemptAt !== undefined
        && receipt.retryNextAttemptAt !== null
        && (typeof receipt.retryNextAttemptAt !== "string" || Number.isNaN(Date.parse(receipt.retryNextAttemptAt)))
      )
      || (
        receipt.retryDeadlineAt !== undefined
        && (typeof receipt.retryDeadlineAt !== "string" || Number.isNaN(Date.parse(receipt.retryDeadlineAt)))
      )
      || (receipt.retryTerminal !== undefined && receipt.retryTerminal !== null && !isReminderRetryExhaustion(receipt.retryTerminal))
      || (
        receipt.phaseTruth !== undefined
        && !isReminderPhaseTruthConsistentWithReceipt(
          receipt.phaseTruth,
          receipt.requestId,
          receipt.wakeEnqueued,
        )
      )
    ) {
      rejectPersistedPayload("receipt_invalid");
    }
    if (
      receipt.retryTerminal
      && (
        receipt.retryTerminal.ownerAgentId !== receipt.job.ownerAgentId
        || receipt.retryTerminal.reminderId !== receipt.job.reminderId
        || receipt.retryTerminal.version !== receipt.job.version
        || receipt.retryTerminal.requestId !== receipt.requestId
        || receipt.retryTerminal.attempts !== receipt.retryAttempt
        || receipt.retryTerminal.deadlineAt !== receipt.retryDeadlineAt
      )
    ) {
      rejectPersistedPayload("retry_terminal_identity_invalid");
    }
  }
  for (const receipt of value.receipts) {
    if ((receipt as Partial<ReminderFireReceipt>).requestId === undefined) {
      (receipt as ReminderFireReceipt).requestId = randomUUID();
    }
    if ((receipt as Partial<ReminderFireReceipt>).serverFired === undefined) {
      (receipt as ReminderFireReceipt).serverFired = (receipt as ReminderFireReceipt).serverAcked;
    }
    if ((receipt as Partial<ReminderFireReceipt>).itemConsumed === undefined) {
      (receipt as ReminderFireReceipt).itemConsumed = false;
    }
    if ((receipt as Partial<ReminderFireReceipt>).phaseTruth === undefined) {
      (receipt as ReminderFireReceipt).phaseTruth = createLegacyReminderPhaseTruth(
        receipt as ReminderFireReceipt,
      );
    }
  }
  return value as PersistedReminderRecord & { reminderId: string };
}

function isReminderBoundedAlertPhaseTruth(
  value: unknown,
  requestId: string | undefined,
): value is ReminderBoundedAlertPhaseTruth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...REMINDER_BOUNDED_ALERT_PHASES].sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  for (const phase of REMINDER_BOUNDED_ALERT_PHASES) {
    const evidence = record[phase];
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
    const entry = evidence as Record<string, unknown>;
    if (entry.state === false) {
      if (entry.evidence !== "not_reached" || entry.transition !== null) return false;
      continue;
    }
    if (entry.state !== true) return false;
    if (entry.evidence === "transition_provenance_missing") {
      if (entry.transition !== null) return false;
      continue;
    }
    if (entry.evidence !== "observed") return false;
    const transition = entry.transition;
    if (!transition || typeof transition !== "object" || Array.isArray(transition)) return false;
    const observed = transition as Record<string, unknown>;
    if (
      observed.occurrenceId !== requestId
      || typeof observed.observedAt !== "string"
      || Number.isNaN(Date.parse(observed.observedAt))
      || observed.source !== REMINDER_PHASE_TRANSITION_SOURCES[phase]
    ) {
      return false;
    }
  }
  const fired = record.fired as ReminderPhaseTransitionEvidence;
  const appItem = record.app_item_materialized as ReminderPhaseTransitionEvidence;
  const wake = record.wake_request_accepted as ReminderPhaseTransitionEvidence;
  return fired.state && (!wake.state || appItem.state);
}

function isReminderPhaseTruthConsistentWithReceipt(
  value: unknown,
  requestId: string | undefined,
  wakeEnqueued: boolean | undefined,
): value is ReminderBoundedAlertPhaseTruth {
  return isReminderBoundedAlertPhaseTruth(value, requestId)
    && value.wake_request_accepted.state === wakeEnqueued;
}

function isReminderRetryExhaustion(value: unknown): value is ReminderRetryExhaustion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const exhaustion = value as Partial<ReminderRetryExhaustion>;
  return exhaustion.code === "REMINDER_DELIVERY_RETRY_EXHAUSTED"
    && ["persistence", "fire_request", "inbox_materialization"].includes(exhaustion.stage ?? "")
    && typeof exhaustion.ownerAgentId === "string"
    && typeof exhaustion.reminderId === "string"
    && Number.isSafeInteger(exhaustion.version)
    && (exhaustion.version ?? 0) >= 1
    && typeof exhaustion.requestId === "string"
    && Number.isSafeInteger(exhaustion.attempts)
    && (exhaustion.attempts ?? -1) >= 0
    && typeof exhaustion.deadlineAt === "string"
    && !Number.isNaN(Date.parse(exhaustion.deadlineAt))
    && typeof exhaustion.exhaustedAt === "string"
    && !Number.isNaN(Date.parse(exhaustion.exhaustedAt));
}

function receiptKey(identity: ReminderDueIdentity): string {
  return JSON.stringify([
    identity.ownerAgentId,
    identity.reminderId,
    identity.version,
  ]);
}

function receiptIdentity(receipt: ReminderFireReceipt): ReminderDueIdentity {
  return createReminderDueIdentity({
    ownerAgentId: receipt.job.ownerAgentId,
    reminderId: receipt.job.reminderId,
    version: receipt.job.version,
  });
}

function sameDueIdentity(a: ReminderDueIdentity, b: ReminderDueIdentity): boolean {
  return a.ownerAgentId === b.ownerAgentId
    && a.reminderId === b.reminderId
    && a.version === b.version;
}

function findReceipt(
  record: ReminderRecord,
  identity: ReminderDueIdentity,
): ReminderFireReceipt | undefined {
  return record.receipts.find((receipt) =>
    sameDueIdentity(receiptIdentity(receipt), identity)
  );
}

/**
 * A stable Reminder id can transfer between owners without spending a second
 * revision for the two Computer deliveries. The old-owner cancel and the
 * new-owner upsert therefore share one revision. On a Computer hosting both
 * owners, accept the equal-version upsert only when it replaces the old
 * owner's tombstone; never let an equal-version snapshot overwrite a live
 * schedule.
 */
function canApplyJob(existing: ReminderRecord, incoming: ReminderJob): boolean {
  if (incoming.version > existing.version) return true;
  return incoming.version === existing.version
    && existing.job === null
    && existing.ownerAgentId !== incoming.ownerAgentId;
}
