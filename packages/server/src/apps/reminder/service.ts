import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type {
  ReminderEventSummary,
  ReminderEventType,
  ReminderJob,
  ReminderSummary,
  ReminderStatus,
  RaftTargetString,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../db/index.js";
import { agents, reminders, reminderEvents, servers, messages, channels } from "../../db/schema.js";
import { reminderSourceAcknowledgements } from "./sourceAckSchema.js";
import * as channelService from "../../services/channelService.js";
import * as messageService from "../../services/messageService.js";
import type { AgentOrchestrator } from "../../services/agentOrchestrator.js";
import { getConfiguredAppUrl } from "../../config/appUrl.js";
import {
  computeNextFire,
  formatRecurrence,
  isSupportedRecurrence,
  type Recurrence,
} from "../../services/recurrence.js";

const ONBOARDING_OWNER_CHANNEL_NAME = "onboarding-owner";

// TimeProvider seam — lifecycle convergence, arm watchdog, and tests all
// inject. Never read Date.now() directly inside service logic.
export interface TimeProvider {
  now(): Date;
}

export const systemTimeProvider: TimeProvider = {
  now: () => new Date(),
};

export interface CreateReminderInput {
  /**
   * Optional caller-owned stable id. When supplied, reminder creation is
   * idempotent: concurrent/retried inserts return the existing row instead of
   * creating a second reminder.
   */
  id?: string;
  serverId: string;
  ownerAgentId: string;
  targetChannelId?: string | null;
  msgId: string | null;
  title: string;
  fireAt: Date;
  payload: unknown | null;
  recurrence?: Recurrence | null;
  createdBy: { type: "agent" | "human"; id: string };
}

export type ReminderReplaceInput = Omit<CreateReminderInput, "id">;

export interface ReminderRow {
  id: string;
  serverId: string;
  ownerAgentId: string;
  targetChannelId: string | null;
  msgId: string | null;
  title: string;
  fireAt: Date;
  payload: unknown;
  recurrence: unknown; // stored JSON; use isSupportedRecurrence to narrow
  status: ReminderStatus;
  version: number;
  armState: "pending" | "armed" | "not_armed";
  armedVersion: number | null;
  armUpdatedAt: Date | null;
  firedAt: Date | null;
  canceledAt: Date | null;
  createdByType: "agent" | "human";
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReminderEventRow {
  id: string;
  reminderId: string;
  serverId: string;
  ownerAgentId: string;
  actorType: "agent" | "human" | "system";
  actorId: string | null;
  eventType: ReminderEventType;
  occurredAt: Date;
  nextFireAt: Date | null;
  metadata: unknown;
}

export interface ReminderServiceOptions {
  executor?: DatabaseExecutor;
  clock?: TimeProvider;
  /** Internal reconciliation may mutate system-owned reminders; generic APIs may not. */
  allowSystemManaged?: boolean;
  /** Failure injection after row CAS but before source-log event insert. */
  afterFireTransitionForTesting?: () => void;
  /**
   * Runs between the guarded SELECT and the guarded UPDATE, so a test can move
   * the row inside that window. Without this seam the UPDATE's own due guard is
   * unreachable from any test -- it only matters when the row stops being due
   * after we read it -- and an unreddenable guard is exactly what task #674 was.
   *
   * Receives the ACTIVE executor: the fire runs in a transaction, so a write
   * issued on a separate connection would block on this transaction's locks and
   * hang rather than simulate anything.
   */
  beforeFireUpdateForTesting?: (db: DatabaseExecutor) => void | Promise<void>;
  /** Failure injection after ACK owns the reminder row but before it reads fired source events. */
  beforeAckFiredEventsReadForTesting?: (db: DatabaseExecutor) => void | Promise<void>;
}

export type ReminderMutationOptions = ReminderServiceOptions & {
  actor?: { type: "agent" | "human" | "system"; id: string | null };
  /** Row version observed by the caller; every mutation is compare-and-swap. */
  expectedVersion: number;
};

function isSystemManagedReminderPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const payload = value as { kind?: unknown; version?: unknown };
  return (
    (payload.kind === "wiki.incremental_discovery" || payload.kind === "wiki.lint")
    && payload.version === 1
  );
}

function isOnboardingDay2Reminder(row: Pick<ReminderRow, "payload">): boolean {
  if (!row.payload || typeof row.payload !== "object") return false;
  return (row.payload as { kind?: unknown }).kind === "onboarding_d2_recap";
}

async function resolveOnboardingOwnerChannelId(
  row: Pick<ReminderRow, "serverId">,
  opts: ReminderServiceOptions,
): Promise<string | null> {
  const candidates = await getExecutor(opts)
    .select({ id: channels.id, type: channels.type })
    .from(channels)
    .where(and(
      eq(channels.serverId, row.serverId),
      eq(channels.name, ONBOARDING_OWNER_CHANNEL_NAME),
      isNull(channels.deletedAt),
    ));
  return candidates.find((channel) => channel.type === "channel" || channel.type === "private")?.id ?? null;
}

async function resolveReminderTargetChannel(
  row: Pick<ReminderRow, "serverId" | "targetChannelId" | "payload">,
  opts: ReminderServiceOptions,
): Promise<{ id: string; name: string | null; type: string } | null> {
  const channelId = row.targetChannelId
    ?? (isOnboardingDay2Reminder(row) ? await resolveOnboardingOwnerChannelId(row, opts) : null);
  if (!channelId) return null;
  const access = await channelService.resolveChannelAccess({
    serverId: row.serverId,
    channelId,
  });
  if (!access) return null;
  return {
    id: access.channel.id,
    name: access.channel.name,
    type: access.channel.type,
  };
}

function formatTopLevelChannelRef(
  channel: { name: string | null; type: string } | null,
): string | null {
  if (!channel?.name) return null;
  return channel.type === "channel" || channel.type === "private"
    ? `#${channel.name}`
    : null;
}

function isProtectedSystemManagedReminder(row: ReminderRow, opts: ReminderServiceOptions): boolean {
  return isSystemManagedReminderPayload(row.payload) && opts.allowSystemManaged !== true;
}

function getExecutor(opts: ReminderServiceOptions): DatabaseExecutor {
  return opts.executor ?? getDb();
}

function getClock(opts: ReminderServiceOptions): TimeProvider {
  return opts.clock ?? systemTimeProvider;
}

export async function createReminder(
  input: CreateReminderInput,
  opts: ReminderServiceOptions = {},
): Promise<ReminderRow> {
  const db = getExecutor(opts);
  const now = getClock(opts).now();
  const [row] = await db
    .insert(reminders)
    .values({
      ...(input.id ? { id: input.id } : {}),
      serverId: input.serverId,
      ownerAgentId: input.ownerAgentId,
      targetChannelId: input.targetChannelId ?? null,
      msgId: input.msgId,
      title: input.title,
      fireAt: input.fireAt,
      payload: input.payload,
      recurrence: input.recurrence ?? null,
      status: "scheduled",
      version: 1,
      createdByType: input.createdBy.type,
      createdById: input.createdBy.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: reminders.id })
    .returning();
  let reminder = row as ReminderRow | undefined;
  if (!reminder && input.id) {
    const [existing] = await db.select().from(reminders).where(eq(reminders.id, input.id));
    reminder = existing as ReminderRow | undefined;
  }
  if (!reminder) {
    throw new Error("Failed to create reminder");
  }
  // Only the winning insert records the scheduled event. A retry/concurrent
  // loser returns the durable reminder without duplicating its audit event.
  if (!row) return reminder;
  await recordReminderEvent(reminder, "scheduled", input.createdBy, {
    title: reminder.title,
    fireAt: reminder.fireAt.toISOString(),
    recurrence: reminder.recurrence,
  }, opts);
  return reminder;
}

/**
 * Replaces a stable reminder identity without resetting its revision.
 *
 * Wiki uses a stable daily-reminder id while allowing its owning Agent to be
 * rebound. Keeping one monotonically increasing revision lets the old
 * Computer consume a cancel for the replacement revision while the new
 * Computer receives the same revision as an upsert.
 */
export async function replaceReminder(
  reminderId: string,
  input: ReminderReplaceInput,
  opts: ReminderMutationOptions,
): Promise<ReminderRow | null> {
  const db = getExecutor(opts);
  const now = getClock(opts).now();
  const [row] = await db
    .update(reminders)
    .set({
      serverId: input.serverId,
      ownerAgentId: input.ownerAgentId,
      targetChannelId: input.targetChannelId ?? null,
      msgId: input.msgId,
      title: input.title,
      fireAt: input.fireAt,
      payload: input.payload,
      recurrence: input.recurrence ?? null,
      status: "scheduled",
      version: sql`${reminders.version} + 1`,
      armState: "pending",
      armedVersion: null,
      armUpdatedAt: now,
      firedAt: null,
      canceledAt: null,
      createdByType: input.createdBy.type,
      createdById: input.createdBy.id,
      updatedAt: now,
    })
    .where(and(
      eq(reminders.id, reminderId),
      eq(reminders.version, opts.expectedVersion),
    ))
    .returning();
  const replaced = row as ReminderRow | undefined;
  if (!replaced) return null;
  await recordReminderEvent(replaced, "updated", opts.actor ?? input.createdBy, {
    kind: "replacement",
    fireAt: replaced.fireAt.toISOString(),
    recurrence: replaced.recurrence,
  }, opts);
  return replaced;
}

export interface ListRemindersFilter {
  serverId: string;
  ownerAgentId?: string;
  status?: ReminderStatus | ReminderStatus[];
}

export async function listReminders(
  filter: ListRemindersFilter,
  opts: ReminderServiceOptions = {},
): Promise<ReminderRow[]> {
  const db = getExecutor(opts);
  const conds = [eq(reminders.serverId, filter.serverId)];
  if (filter.ownerAgentId) {
    conds.push(eq(reminders.ownerAgentId, filter.ownerAgentId));
  }
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (statuses.length === 1) {
      conds.push(eq(reminders.status, statuses[0]));
    } else {
      conds.push(inArray(reminders.status, statuses));
    }
  }
  const rows = await db
    .select()
    .from(reminders)
    .where(and(...conds))
    .orderBy(asc(reminders.fireAt), desc(reminders.createdAt));
  return rows as ReminderRow[];
}

export async function getReminderById(
  reminderId: string,
  opts: ReminderServiceOptions = {},
): Promise<ReminderRow | null> {
  const db = getExecutor(opts);
  const [row] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
  return (row as ReminderRow | undefined) ?? null;
}

export async function cancelReminder(
  reminderId: string,
  opts: ReminderMutationOptions,
): Promise<ReminderRow | null> {
  const db = getExecutor(opts);
  const now = getClock(opts).now();
  const [current] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
  if (!current || isProtectedSystemManagedReminder(current as ReminderRow, opts)) return null;
  const conditions = [
    eq(reminders.id, reminderId),
    inArray(reminders.status, ["scheduled", "fired"]),
    eq(reminders.version, opts.expectedVersion),
  ];
  const [row] = await db
    .update(reminders)
    .set({
      status: "canceled",
      canceledAt: now,
      updatedAt: now,
      version: sql`${reminders.version} + 1`,
      armState: "pending",
      armedVersion: null,
      armUpdatedAt: now,
    })
    .where(and(...conditions))
    .returning();
  const canceled = row as ReminderRow | undefined;
  if (!canceled) return null;
  await recordReminderEvent(canceled, "canceled", opts.actor ?? { type: "system", id: null }, {
    canceledAt: now.toISOString(),
  }, opts);
  return canceled;
}

export async function snoozeReminder(
  reminderId: string,
  delaySeconds: number,
  opts: ReminderMutationOptions,
): Promise<ReminderRow | null> {
  if (!Number.isFinite(delaySeconds) || !Number.isInteger(delaySeconds) || delaySeconds <= 0) {
    throw new Error("delaySeconds must be a positive integer");
  }
  const db = getExecutor(opts);
  const now = getClock(opts).now();
  const nextFireAt = new Date(now.getTime() + delaySeconds * 1000);
  const [current] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
  if (!current || !["scheduled", "fired"].includes((current as ReminderRow).status)) return null;
  const currentRow = current as ReminderRow;
  if (isProtectedSystemManagedReminder(currentRow, opts)) return null;
  const conditions = [
    eq(reminders.id, reminderId),
    inArray(reminders.status, ["scheduled", "fired"]),
    eq(reminders.version, opts.expectedVersion),
  ];
  const [row] = await db
    .update(reminders)
    .set({
      status: "scheduled",
      fireAt: nextFireAt,
      updatedAt: now,
      version: sql`${reminders.version} + 1`,
      armState: "pending",
      armedVersion: null,
      armUpdatedAt: now,
    })
    .where(and(...conditions))
    .returning();
  const snoozed = row as ReminderRow | undefined;
  if (!snoozed) return null;
  await recordReminderEvent(snoozed, "snoozed", opts.actor ?? { type: "system", id: null }, {
    previousStatus: currentRow.status,
    previousFireAt: currentRow.fireAt.toISOString(),
    delaySeconds,
  }, opts);
  return snoozed;
}

export type ReminderUpdatePatch =
  | { kind: "fireAt"; fireAt: Date }
  | { kind: "delay"; delaySeconds: number }
  | { kind: "recurrence"; recurrence: Recurrence }
  | { kind: "title"; title: string };

export async function updateReminder(
  reminderId: string,
  patch: ReminderUpdatePatch,
  opts: ReminderMutationOptions,
): Promise<ReminderRow | null> {
  const db = getExecutor(opts);
  const now = getClock(opts).now();
  const [current] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
  if (!current || (current as ReminderRow).status !== "scheduled") return null;
  const currentRow = current as ReminderRow;
  if (isProtectedSystemManagedReminder(currentRow, opts)) return null;

  const set: Record<string, unknown> = {
    updatedAt: now,
    version: sql`${reminders.version} + 1`,
    armState: "pending",
    armedVersion: null,
    armUpdatedAt: now,
  };
  const metadata: Record<string, unknown> = { field: patch.kind };

  if (patch.kind === "fireAt") {
    set.fireAt = patch.fireAt;
    metadata.previousFireAt = currentRow.fireAt.toISOString();
    metadata.nextFireAt = patch.fireAt.toISOString();
  } else if (patch.kind === "delay") {
    const nextFireAt = new Date(now.getTime() + patch.delaySeconds * 1000);
    set.fireAt = nextFireAt;
    metadata.previousFireAt = currentRow.fireAt.toISOString();
    metadata.delaySeconds = patch.delaySeconds;
    metadata.nextFireAt = nextFireAt.toISOString();
  } else if (patch.kind === "recurrence") {
    const nextFireAt = computeNextFire(patch.recurrence, now);
    set.recurrence = patch.recurrence;
    set.fireAt = nextFireAt;
    metadata.previousRecurrence = currentRow.recurrence;
    metadata.nextRecurrence = patch.recurrence;
    metadata.previousFireAt = currentRow.fireAt.toISOString();
    metadata.nextFireAt = nextFireAt.toISOString();
  } else {
    set.title = patch.title;
    metadata.previousTitle = currentRow.title;
    metadata.nextTitle = patch.title;
  }

  const conditions = [
    eq(reminders.id, reminderId),
    eq(reminders.status, "scheduled"),
    eq(reminders.version, opts.expectedVersion),
  ];
  const [row] = await db
    .update(reminders)
    .set(set)
    .where(and(...conditions))
    .returning();
  const updated = row as ReminderRow | undefined;
  if (!updated) return null;
  await recordReminderEvent(updated, "updated", opts.actor ?? { type: "system", id: null }, metadata, opts);
  return updated;
}

/**
 * Clock-skew grace on the "is it due yet?" comparison. The Computer decides
 * when to ask; the Server independently re-checks. Both read their own wall
 * clock, so a reminder can be due by a few hundred ms on one and not the other.
 * Without a tolerance that benign skew reads as a premature fire and the fire
 * is refused for no good reason.
 *
 * Deliberate consequence: a Computer running up to 1s fast still gets its fire
 * honoured. That is the intended trade -- a reminder up to 1s early is
 * invisible to a human, while a refused-then-retried fire is not. Do not file
 * that as a regression. The fallback scanner's own sweep is NOT widened by
 * this; it keeps using `now`, so the two gates cannot drift together.
 */
export const FIRE_DUE_TOLERANCE_MS = 1_000;

/** Why a fire request was refused. */
export type FireRejectedReason =
  /** Asked before fireAt (beyond FIRE_DUE_TOLERANCE_MS). */
  | "premature_fire"
  /** Another caller won the version race first. */
  | "version_mismatch"
  /** The row is gone, cancelled, or already fired. */
  | "not_scheduled";

export interface FireRejected {
  ok: false;
  reason: FireRejectedReason;
  now: Date;
  /** The row's fireAt when we could read it; absent when the row was unreadable. */
  fireAt?: Date;
}

export interface FireReminderResult {
  ok: true;
  row: ReminderRow;
  /**
   * True when the receipt represents a supported due occurrence and the
   * Server should publish lifecycle state. The Computer must not materialize
   * or wake until this Server-authorized result reaches it.
   * False for forward-compat skips (unknown recurrence kind written by a
   * newer server).
   */
  fired: boolean;
  /** True if this fire is a catch-up (missed recurring slot). */
  catchup: boolean;
  /** For recurring reminders that keep going, the next scheduled fire. */
  nextFireAt: Date | null;
}

/**
 * Atomically transitions a scheduled reminder out of its current version.
 * Three branches share the same version-guarded UPDATE so the R1/R2
 * exactly-once invariants are preserved uniformly:
 *
 *   single-shot (recurrence=null) → status='fired', firedAt=now
 *   recurring (supported kind)    → fireAt=next, firedAt=now, stays scheduled
 *   recurring (unknown kind)      → fireAt=now+5min (skip + advance)
 *
 * The daemon's `(reminderId, version)` idempotency semantics still hold —
 * stale fire receipts see null and no-op.
 */
export async function fireReminder(
  reminderId: string,
  expectedVersion: number,
  opts: ReminderServiceOptions & { catchup?: boolean } = {},
): Promise<FireReminderResult | FireRejected> {
  const root = getExecutor(opts);
  const now = getClock(opts).now();
  // Widen only the "is it due" comparison, never the version/status guards.
  const dueCutoff = new Date(now.getTime() + FIRE_DUE_TOLERANCE_MS);

  const converge = async (db: DatabaseExecutor): Promise<FireReminderResult | FireRejected> => {

  // Read the row under the same guards we'll enforce on UPDATE, due-time
  // included. The Computer decides when to ask; this is the Server's own,
  // independent check that it really is time (task #674).
  const [current] = await db
    .select()
    .from(reminders)
    .where(and(
      eq(reminders.id, reminderId),
      eq(reminders.status, "scheduled"),
      eq(reminders.version, expectedVersion),
      lte(reminders.fireAt, dueCutoff),
    ));
  if (!current) {
    // Re-read without the guards to say WHICH one refused. A bare null made
    // "too early", "someone else won" and "already gone" indistinguishable --
    // the caller could not tell a bug from a benign race, and neither could
    // anyone reading the logs.
    const [raw] = await db.select().from(reminders).where(eq(reminders.id, reminderId));
    if (!raw) return { ok: false, reason: "not_scheduled", now };
    const rawRow = raw as ReminderRow;
    if (rawRow.status !== "scheduled") {
      return { ok: false, reason: "not_scheduled", now, fireAt: rawRow.fireAt };
    }
    if (rawRow.version !== expectedVersion) {
      return { ok: false, reason: "version_mismatch", now, fireAt: rawRow.fireAt };
    }
    console.warn(
      `[reminderService] refused premature fire for ${reminderId}: fireAt=${rawRow.fireAt.toISOString()} now=${now.toISOString()} (tolerance ${FIRE_DUE_TOLERANCE_MS}ms)`,
    );
    return { ok: false, reason: "premature_fire", now, fireAt: rawRow.fireAt };
  }

  const recurrenceRaw = (current as ReminderRow).recurrence;
  const hasRecurrence = recurrenceRaw != null;

  let update:
    | { kind: "terminal" }
    | { kind: "recurring"; nextFireAt: Date }
    | { kind: "skip-unknown"; nextFireAt: Date };

  if (!hasRecurrence) {
    update = { kind: "terminal" };
  } else if (isSupportedRecurrence(recurrenceRaw)) {
    // Advance from the slot we just consumed, never from an earlier request
    // time (task #806). `dueCutoff` accepts a fire up to FIRE_DUE_TOLERANCE_MS
    // BEFORE fireAt, so on an early-but-accepted fire `now < fireAt`. Anchoring
    // on `now` then lets `nextHM` reselect the very slot being consumed --
    // it only requires a candidate strictly after `from` -- so the row rearms
    // onto its own instant and fires again seconds later.
    //
    // `max` and not plain `fireAt`: a late catch-up must still advance from
    // `now`, so missed slots are skipped rather than replayed one per tick.
    const slotAnchor = (current as ReminderRow).fireAt;
    const anchor = slotAnchor.getTime() > now.getTime() ? slotAnchor : now;
    update = { kind: "recurring", nextFireAt: computeNextFire(recurrenceRaw, anchor) };
  } else {
    // Forward-compat: a newer server wrote a kind we don't understand. Skip
    // this fire and push fire_at 5 min so a reconnect snapshot does not create
    // an immediate local catch-up loop. A roll-forward deploy will pick it up.
    console.warn(
      `[reminderService] reminder ${reminderId} has unsupported recurrence kind; skipping + advancing 5m. Stored: ${JSON.stringify(recurrenceRaw)}`,
    );
    update = { kind: "skip-unknown", nextFireAt: new Date(now.getTime() + 5 * 60 * 1000) };
  }

  await opts.beforeFireUpdateForTesting?.(db);

  let row: ReminderRow | undefined;
  if (update.kind === "terminal") {
    const [updated] = await db
      .update(reminders)
      .set({
        status: "fired",
        firedAt: now,
        updatedAt: now,
        version: sql`${reminders.version} + 1`,
        armState: "pending",
        armedVersion: null,
        armUpdatedAt: now,
      })
      .where(and(
        eq(reminders.id, reminderId),
        eq(reminders.status, "scheduled"),
        eq(reminders.version, expectedVersion),
        lte(reminders.fireAt, dueCutoff),
      ))
      .returning();
    row = updated as ReminderRow | undefined;
  } else if (update.kind === "recurring") {
    const [updated] = await db
      .update(reminders)
      .set({
        fireAt: update.nextFireAt,
        firedAt: now,
        updatedAt: now,
        version: sql`${reminders.version} + 1`,
        armState: "pending",
        armedVersion: null,
        armUpdatedAt: now,
      })
      .where(and(
        eq(reminders.id, reminderId),
        eq(reminders.status, "scheduled"),
        eq(reminders.version, expectedVersion),
        lte(reminders.fireAt, dueCutoff),
      ))
      .returning();
    row = updated as ReminderRow | undefined;
  } else {
    const [updated] = await db
      .update(reminders)
      .set({
        fireAt: update.nextFireAt,
        updatedAt: now,
        version: sql`${reminders.version} + 1`,
        armState: "pending",
        armedVersion: null,
        armUpdatedAt: now,
      })
      .where(and(
        eq(reminders.id, reminderId),
        eq(reminders.status, "scheduled"),
        eq(reminders.version, expectedVersion),
        lte(reminders.fireAt, dueCutoff),
      ))
      .returning();
    row = updated as ReminderRow | undefined;
  }
  // Lost the race between SELECT and UPDATE. The row moved under us, so the
  // version we read is no longer current.
  if (!row) return { ok: false, reason: "version_mismatch", now, fireAt: (current as ReminderRow).fireAt };
  if (update.kind !== "skip-unknown") opts.afterFireTransitionForTesting?.();
  await recordReminderEvent(
    row,
    update.kind === "skip-unknown" ? "updated" : "fired",
    { type: "system", id: null },
    {
      catchup: opts.catchup === true,
      fired: update.kind !== "skip-unknown",
      fireOutcome: update.kind === "skip-unknown" ? "unsupported_recurrence_skipped" : "fired",
      previousFireAt: (current as ReminderRow).fireAt.toISOString(),
      sourceVersion: expectedVersion,
    },
    { ...opts, executor: db },
  );
  return {
    ok: true,
    row,
    fired: update.kind !== "skip-unknown",
    catchup: opts.catchup === true,
    nextFireAt: update.kind === "terminal" ? null : update.nextFireAt,
  };
  };

  // The row transition and its source-log fact are one durable commit. Network
  // push/ack remains outside this transaction and converges idempotently.
  const transaction = (root as DatabaseExecutor & {
    transaction?: <T>(fn: (tx: DatabaseExecutor) => Promise<T>) => Promise<T>;
  }).transaction;
  if (typeof transaction === "function") {
    return transaction.call(root, converge) as Promise<FireReminderResult | FireRejected>;
  }
  // A caller-supplied transaction executor already owns the outer boundary.
  return converge(root);
}

/**
 * Daemon snapshot rebuild: all currently-scheduled reminders for an agent.
 * The daemon replaces its local timer cache with exactly these entries.
 */
export async function getSnapshotForAgent(
  agentId: string,
  opts: ReminderServiceOptions = {},
): Promise<ReminderRow[]> {
  const db = getExecutor(opts);
  const rows = await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.ownerAgentId, agentId), eq(reminders.status, "scheduled")))
    .orderBy(asc(reminders.fireAt));
  return rows as ReminderRow[];
}

/**
 * Machine-connect snapshot coverage: every non-deleted agent on this machine
 * that owns at least one scheduled reminder. The daemon cannot compute this
 * set itself — it only knows agents with running/idle sessions, and an owner
 * outside that set would otherwise never get its reminders loaded (missed
 * fires that never recover until an unrelated upsert forces a snapshot).
 */
export async function listScheduledReminderOwnersForMachine(
  machineId: string,
  opts: ReminderServiceOptions = {},
): Promise<string[]> {
  const db = getExecutor(opts);
  const rows = await db
    .selectDistinct({ ownerAgentId: reminders.ownerAgentId })
    .from(reminders)
    .innerJoin(agents, eq(agents.id, reminders.ownerAgentId))
    .where(and(
      eq(agents.machineId, machineId),
      isNull(agents.deletedAt),
      eq(reminders.status, "scheduled"),
    ));
  return rows.map((row) => row.ownerAgentId);
}

export async function recordReminderArmed(
  reminderId: string,
  ownerAgentId: string,
  expectedVersion: number,
  opts: ReminderServiceOptions = {},
): Promise<ReminderRow | null> {
  const now = getClock(opts).now();
  const [row] = await getExecutor(opts)
    .update(reminders)
    .set({ armState: "armed", armedVersion: expectedVersion, armUpdatedAt: now })
    .where(and(
      eq(reminders.id, reminderId),
      eq(reminders.ownerAgentId, ownerAgentId),
      eq(reminders.status, "scheduled"),
      eq(reminders.version, expectedVersion),
    ))
    .returning();
  return (row as ReminderRow | undefined) ?? null;
}

export async function getReminderArmGaps(
  horizonAt: Date,
  opts: ReminderServiceOptions & { limit?: number } = {},
): Promise<ReminderRow[]> {
  const rows = await getExecutor(opts)
    .select()
    .from(reminders)
    .where(and(
      eq(reminders.status, "scheduled"),
      lte(reminders.fireAt, horizonAt),
      or(
        ne(reminders.armState, "armed"),
        isNull(reminders.armedVersion),
        ne(reminders.armedVersion, reminders.version),
      ),
    ))
    // FAIRNESS / BOUNDED REACH (task #801). Ordering by fireAt alone starves:
    // a row does not leave this predicate by being attempted -- markReminderNotArmed
    // sets armState='not_armed', which still satisfies `armState != 'armed'` -- so a
    // head that keeps failing to arm is re-selected every tick and everything past
    // `limit` is never pushed at all. In production ~800 rows sat behind such a head
    // and fired nothing, silently, for hours.
    //
    // armUpdatedAt is stamped by markReminderNotArmed on every attempt, so ordering
    // by it least-recent-first rotates an attempted row to the back. NULLS FIRST
    // keeps never-attempted rows ahead of retries. fireAt stays as the tiebreak so
    // urgency still orders within a batch -- and it may only tiebreak, because
    // making it primary again is exactly the starvation.
    //
    // WHAT IS AND IS NOT GUARANTEED. State the premise every time; the bound below
    // is conditional and an unconditional reading of it is false.
    //
    //   Frozen eligible set (no new eligible rows arriving): with N eligible rows
    //   and limit L, any eligible row is first selected within ceil(N / L) ticks,
    //   even if the head never arms. This is the computable bound, and it is what
    //   reminderArmWatchdogFairness.contract.test.ts pins.
    //
    //   Dynamic set (rows keep arriving): NO absolute bound is claimed. NULLS FIRST
    //   deliberately puts never-attempted rows AHEAD of retries, so a continuous
    //   stream of new eligible rows can postpone an already-attempted row
    //   indefinitely. Reach is bounded/convergent only while BOTH hold:
    //     (a) long-run arrival rate < effective service capacity (L per tick), and
    //     (b) the attempt cursor advances on every selection -- i.e. each selected
    //         row actually gets armUpdatedAt stamped.
    //   (b) is not free: markReminderNotArmed matches on `version`, so a row whose
    //   version changed between this SELECT and that UPDATE is not stamped and is
    //   re-selected at the same cursor position. That race is self-limiting because
    //   a version bump comes from an update path that pushes its own upsert, but it
    //   is a premise, not a consequence of the ordering.
    //
    // Therefore a production readback must MEASURE arrival rate < capacity and a
    // monotonically decreasing backlog. Neither may be inferred from this ordering:
    // a starved queue and a draining one both show rows being selected every tick.
    .orderBy(sql`${reminders.armUpdatedAt} ASC NULLS FIRST`, asc(reminders.fireAt))
    .limit(opts.limit ?? 100);
  return rows as ReminderRow[];
}

export async function markReminderNotArmed(
  reminderId: string,
  ownerAgentId: string,
  expectedVersion: number,
  opts: ReminderServiceOptions = {},
): Promise<ReminderRow | null> {
  const now = getClock(opts).now();
  const [row] = await getExecutor(opts)
    .update(reminders)
    .set({ armState: "not_armed", armedVersion: null, armUpdatedAt: now })
    .where(and(
      eq(reminders.id, reminderId),
      eq(reminders.ownerAgentId, ownerAgentId),
      eq(reminders.status, "scheduled"),
      eq(reminders.version, expectedVersion),
      or(
        ne(reminders.armState, "armed"),
        isNull(reminders.armedVersion),
        ne(reminders.armedVersion, expectedVersion),
      ),
    ))
    .returning();
  return (row as ReminderRow | undefined) ?? null;
}

export async function listReminderEvents(
  reminderId: string,
  opts: ReminderServiceOptions = {},
): Promise<ReminderEventRow[]> {
  const db = getExecutor(opts);
  const rows = await db
    .select()
    .from(reminderEvents)
    .where(eq(reminderEvents.reminderId, reminderId))
    .orderBy(desc(reminderEvents.occurredAt));
  return rows as ReminderEventRow[];
}

/**
 * Historical source-read scope. Event ownership is captured at occurrence
 * time, so an owner transfer never grants the old owner the new owner's
 * current reminder row, title, or later events.
 */
export async function listReminderEventsForOwner(
  reminderId: string,
  serverId: string,
  ownerAgentId: string,
  opts: ReminderServiceOptions = {},
): Promise<ReminderEventRow[]> {
  const rows = await getExecutor(opts)
    .select()
    .from(reminderEvents)
    .where(and(
      eq(reminderEvents.reminderId, reminderId),
      eq(reminderEvents.serverId, serverId),
      eq(reminderEvents.ownerAgentId, ownerAgentId),
    ))
    .orderBy(desc(reminderEvents.occurredAt));
  return rows as ReminderEventRow[];
}

/** Durable replay fact for one Server-authorized due transition. */
export async function findAuthorizedReminderFire(
  reminderId: string,
  serverId: string,
  ownerAgentId: string,
  sourceVersion: number,
  opts: ReminderServiceOptions = {},
): Promise<{ fired: boolean; catchup: boolean } | null> {
  const events = await listReminderEventsForOwner(reminderId, serverId, ownerAgentId, opts);
  for (const event of events) {
    const metadata = event.metadata && typeof event.metadata === "object"
      ? event.metadata as Record<string, unknown>
      : null;
    if (metadata?.sourceVersion !== sourceVersion) continue;
    if (event.eventType === "fired") {
      return { fired: true, catchup: metadata.catchup === true };
    }
    if (
      event.eventType === "updated"
      && metadata.fireOutcome === "unsupported_recurrence_skipped"
    ) {
      return { fired: false, catchup: metadata.catchup === true };
    }
  }
  return null;
}

export type ReminderSourceAckResult =
  | {
      ok: true;
      reminderId: string;
      sourceVersion: number;
      ownerAgentId: string;
      sourceEventId: string;
      ackAttemptId: string;
      replayed: boolean;
    }
  | {
      ok: false;
      reason:
        | "reminder_not_found"
        | "target_not_fired"
        | "stale_source_revision";
      latestFiredSourceVersion?: number;
    };

function firedSourceVersion(event: ReminderEventRow): number | null {
  if (event.eventType !== "fired") return null;
  const metadata = event.metadata && typeof event.metadata === "object"
    ? event.metadata as Record<string, unknown>
    : null;
  if (metadata?.fired !== true) return null;
  const sourceVersion = metadata.sourceVersion;
  return Number.isSafeInteger(sourceVersion) && Number(sourceVersion) > 0
    ? Number(sourceVersion)
    : null;
}

/**
 * Server-authoritative exact acknowledgement for one fired Reminder source.
 *
 * The local daemon cannot use App Inbox item persistence as current-world
 * authority. This helper linearizes against the Reminder row, binds the exact
 * fired event, and only lets a same-attempt replay bypass a newer fired event
 * after the Server already accepted that exact operation.
 */
export async function ackAuthorizedReminderFire(input: {
  serverId: string;
  actingAgentId: string;
  reminderId: string;
  sourceVersion: number;
  ackAttemptId: string;
  opts?: ReminderServiceOptions;
}): Promise<ReminderSourceAckResult> {
  const opts = input.opts ?? {};
  const root = getExecutor(opts);
  const now = getClock(opts).now();

  const acknowledge = async (db: DatabaseExecutor): Promise<ReminderSourceAckResult> => {
    const [row] = await db
      .select({ id: reminders.id, serverId: reminders.serverId })
      .from(reminders)
      .where(and(
        eq(reminders.id, input.reminderId),
        eq(reminders.serverId, input.serverId),
      ))
      .limit(1)
      .for("update");
    if (!row) return { ok: false, reason: "reminder_not_found" };

    const [existingAck] = await db
      .select()
      .from(reminderSourceAcknowledgements)
      .where(and(
        eq(reminderSourceAcknowledgements.serverId, input.serverId),
        eq(reminderSourceAcknowledgements.ownerAgentId, input.actingAgentId),
        eq(reminderSourceAcknowledgements.reminderId, input.reminderId),
        eq(reminderSourceAcknowledgements.sourceVersion, input.sourceVersion),
      ))
      .limit(1);

    if (existingAck?.ackAttemptId === input.ackAttemptId) {
      return {
        ok: true,
        reminderId: input.reminderId,
        sourceVersion: input.sourceVersion,
        ownerAgentId: input.actingAgentId,
        sourceEventId: existingAck.sourceEventId,
        ackAttemptId: input.ackAttemptId,
        replayed: true,
      };
    }

    await opts.beforeAckFiredEventsReadForTesting?.(db);

    const events = await listReminderEventsForOwner(
      input.reminderId,
      input.serverId,
      input.actingAgentId,
      { ...opts, executor: db },
    );
    let targetEvent: ReminderEventRow | null = null;
    let latestFiredSourceVersion = 0;
    for (const event of events) {
      const sourceVersion = firedSourceVersion(event);
      if (sourceVersion === null) continue;
      latestFiredSourceVersion = Math.max(latestFiredSourceVersion, sourceVersion);
      if (sourceVersion === input.sourceVersion) targetEvent = event;
    }

    if (latestFiredSourceVersion > input.sourceVersion) {
      return {
        ok: false,
        reason: "stale_source_revision",
        latestFiredSourceVersion,
      };
    }
    if (!targetEvent || latestFiredSourceVersion !== input.sourceVersion) {
      return {
        ok: false,
        reason: "target_not_fired",
        latestFiredSourceVersion: latestFiredSourceVersion || undefined,
      };
    }
    if (existingAck) {
      return {
        ok: true,
        reminderId: input.reminderId,
        sourceVersion: input.sourceVersion,
        ownerAgentId: input.actingAgentId,
        sourceEventId: existingAck.sourceEventId,
        ackAttemptId: input.ackAttemptId,
        replayed: true,
      };
    }

    await db.insert(reminderSourceAcknowledgements).values({
      serverId: input.serverId,
      ownerAgentId: input.actingAgentId,
      reminderId: input.reminderId,
      sourceVersion: input.sourceVersion,
      sourceEventId: targetEvent.id,
      acknowledgedByAgentId: input.actingAgentId,
      ackAttemptId: input.ackAttemptId,
      acknowledgedAt: now,
    });

    return {
      ok: true,
      reminderId: input.reminderId,
      sourceVersion: input.sourceVersion,
      ownerAgentId: input.actingAgentId,
      sourceEventId: targetEvent.id,
      ackAttemptId: input.ackAttemptId,
      replayed: false,
    };
  };

  const transaction = (root as DatabaseExecutor & {
    transaction?: <T>(fn: (tx: DatabaseExecutor) => Promise<T>) => Promise<T>;
  }).transaction;
  if (typeof transaction === "function") {
    return transaction.call(root, acknowledge) as Promise<ReminderSourceAckResult>;
  }
  return acknowledge(root);
}

export async function resolveHistoricalReminderIdForOwner(
  idOrPrefix: string,
  serverId: string,
  ownerAgentId: string,
  opts: ReminderServiceOptions = {},
): Promise<{ kind: "resolved"; reminderId: string } | { kind: "not_found" | "ambiguous" }> {
  const prefix = idOrPrefix.trim();
  if (!prefix) return { kind: "not_found" };
  const rows = await getExecutor(opts)
    .select({ reminderId: reminderEvents.reminderId })
    .from(reminderEvents)
    .where(and(
      eq(reminderEvents.serverId, serverId),
      eq(reminderEvents.ownerAgentId, ownerAgentId),
    ))
    .groupBy(reminderEvents.reminderId);
  const matches = rows.map((row) => row.reminderId).filter((id) => id.startsWith(prefix));
  if (matches.length === 0) return { kind: "not_found" };
  if (matches.length > 1) return { kind: "ambiguous" };
  return { kind: "resolved", reminderId: matches[0]! };
}

async function recordReminderEvent(
  row: ReminderRow,
  eventType: ReminderEventType,
  actor: { type: "agent" | "human" | "system"; id: string | null },
  metadata: Record<string, unknown> | null,
  opts: ReminderServiceOptions,
): Promise<void> {
  const db = getExecutor(opts);
  await db.insert(reminderEvents).values({
    reminderId: row.id,
    serverId: row.serverId,
    ownerAgentId: row.ownerAgentId,
    actorType: actor.type,
    actorId: actor.id,
    eventType,
    occurredAt: getClock(opts).now(),
    nextFireAt: row.status === "scheduled" ? row.fireAt : null,
    metadata,
  });
}

// ── Mixed-version wake adapter ─────────────────────────────────────────────

export interface DeliverLegacyReminderWakeOptions extends ReminderServiceOptions {
  catchup?: boolean;
}

/**
 * Transitional owner-only wake for daemon 1.0.14/1.0.15 fire_attempt frames.
 * New daemons mint a typed local Inbox item and never call this path. The
 * app-owned ingress adapter's capability/version gate is the sole
 * production caller.
 */
export async function deliverLegacyReminderWake(
  orchestrator: AgentOrchestrator,
  row: ReminderRow,
  opts: DeliverLegacyReminderWakeOptions = {},
): Promise<boolean> {
  try {
    const wakeMessage = await buildLegacyReminderWakeMessage(row, opts);
    if (!wakeMessage) return false;
    await messageService.deliverSystemNoticeToAgent(
      orchestrator,
      row.ownerAgentId,
      wakeMessage,
      { transient: true, intrinsic: true },
    );
    return true;
  } catch (err) {
    console.error(`[reminderService] Failed to deliver legacy reminder wake for ${row.id}:`, err);
    return false;
  }
}

async function buildLegacyReminderWakeMessage(
  row: ReminderRow,
  opts: DeliverLegacyReminderWakeOptions,
): Promise<{
  channel_id: string;
  channel_name: string;
  channel_type: "channel" | "dm" | "thread" | "private" | "joint";
  serverId: string;
  content: string;
  timestamp: string;
} | null> {
  const channelId = await resolveLegacyReminderWakeChannelId(row, opts);
  if (!channelId) return null;
  const channel = await channelService.getChannel(channelId);
  if (!channel) return null;

  const { content, additionalAgentContent } = await buildLegacyReminderWakeContent(row, opts);
  const channelType = channel.type === "thread"
    ? "thread"
    : channel.type === "dm"
      ? "dm"
      : channel.type === "joint"
        ? "joint"
        : channel.type === "private"
          ? "private"
          : "channel";
  return {
    serverId: channel.serverId,
    channel_id: channelId,
    channel_name: channel.name,
    channel_type: channelType,
    content: additionalAgentContent ? `${content}\n${additionalAgentContent}` : content,
    timestamp: getClock(opts).now().toISOString(),
  };
}

async function resolveLegacyReminderWakeChannelId(
  row: ReminderRow,
  opts: DeliverLegacyReminderWakeOptions,
): Promise<string | null> {
  if (row.targetChannelId) return row.targetChannelId;
  if (isOnboardingDay2Reminder(row)) return resolveOnboardingOwnerChannelId(row, opts);
  if (!row.msgId) return null;
  const [anchor] = await getExecutor(opts)
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, row.msgId));
  return anchor?.channelId ?? null;
}

async function buildLegacyReminderWakeContent(
  row: ReminderRow,
  opts: DeliverLegacyReminderWakeOptions,
): Promise<{ content: string; additionalAgentContent: string }> {
  const prefix = opts.catchup
    ? `🔔 Reminder #${row.id.slice(0, 8)} (catchup · ${formatReminderTypeTag(row)})`
    : `🔔 Reminder #${row.id.slice(0, 8)} (${formatReminderTypeTag(row)})`;
  const title = messageService.summarizeForSystemMessage(row.title);
  const lines = [`${prefix} — "${title}"`];
  if (isSupportedRecurrence(row.recurrence)) lines.push(`Next iteration: ${row.fireAt.toISOString()}`);

  const explicitTargetRef = formatTopLevelChannelRef(await resolveReminderTargetChannel(row, opts));
  if (explicitTargetRef) {
    lines[0] = `${prefix} — ${explicitTargetRef} — "${title}"`;
  } else if (row.msgId) {
    const [serverRow] = await getExecutor(opts)
      .select({ slug: servers.slug })
      .from(servers)
      .where(eq(servers.id, row.serverId));
    const anchors = await resolveAnchors([row], {
      serverSlug: serverRow?.slug ?? "",
      appUrl: getConfiguredAppUrl(),
    }, opts);
    const anchor = anchors.get(row.id);
    if (anchor?.msgRef) lines[0] = `${prefix} — ${anchor.msgRef} — "${title}"`;
  }

  const hints = [
    buildLegacyOnboardingWakeHint(row),
    isSupportedRecurrence(row.recurrence)
      ? "(to snooze/update/cancel: raft reminder --help)"
      : "(to snooze/cancel: raft reminder --help)",
  ].filter((hint): hint is string => !!hint);
  return { content: lines.join("\n"), additionalAgentContent: hints.join("\n") };
}

function buildLegacyOnboardingWakeHint(row: ReminderRow): string | null {
  const payload = row.payload;
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { kind?: unknown; timezone?: unknown };
  if (candidate.kind !== "onboarding_d2_recap" || typeof candidate.timezone !== "string") return null;
  const timezone = candidate.timezone.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    return null;
  }
  if (!row.msgId) return null;
  return `(target: post top-level in #${ONBOARDING_OWNER_CHANNEL_NAME}, never a thread or DM; owner timezone: ${timezone}; only after explicit yes run: raft reminder schedule --title "Daily recap" --repeat daily@10:00 --tz ${timezone} --channel #${ONBOARDING_OWNER_CHANNEL_NAME} --message-id ${row.msgId.slice(0, 8)}; no or no-answer creates nothing)`;
}

// ── Shape helpers ──────────────────────────────────────────────────────────

export function toReminderJob(row: ReminderRow): ReminderJob {
  return {
    reminderId: row.id,
    ownerAgentId: row.ownerAgentId,
    msgId: row.msgId,
    title: row.title,
    fireAt: row.fireAt.toISOString(),
    version: row.version,
    recurrence: summarizeRecurrence(row.recurrence),
  };
}

interface PermalinkContext {
  serverSlug: string;
  appUrl: string | null; // absolute origin e.g. "https://app.slock.ai"
}

interface MessageAnchor {
  messageId: string;
  channelId: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  channelName: string | null;
  parentMessageId: string | null;
  parentChannelId: string | null;
  parentChannelType: "channel" | "private" | "joint" | "dm" | "thread" | null;
  parentChannelName: string | null;
}

/**
 * Resolves msgRef + msgPermalink for a batch of reminders. Reminders with
 * null msgId or whose anchor message is deleted get null for both fields.
 * Threads are resolved by joining channel.parentMessageId → parent message →
 * parent channel so the permalink lives on the parent surface.
 */
export async function resolveAnchors(
  rows: ReminderRow[],
  ctx: PermalinkContext,
  opts: ReminderServiceOptions = {},
): Promise<Map<string, { msgRef: string | null; msgPermalink: string | null }>> {
  const db = getExecutor(opts);
  const result = new Map<string, { msgRef: string | null; msgPermalink: string | null }>();
  for (const r of rows) result.set(r.id, { msgRef: null, msgPermalink: null });

  const msgIds = rows.map((r) => r.msgId).filter((x): x is string => x !== null);
  if (msgIds.length === 0) return result;

  const parentMessages = alias(messages, "parent_messages");
  const parentChannels = alias(channels, "parent_channels");

  const anchors = await db
    .select({
      messageId: messages.id,
      channelId: messages.channelId,
      channelType: channels.type,
      channelName: channels.name,
      channelDeletedAt: channels.deletedAt,
      parentMessageId: channels.parentMessageId,
      parentChannelId: parentMessages.channelId,
      parentChannelType: parentChannels.type,
      parentChannelName: parentChannels.name,
      parentChannelDeletedAt: parentChannels.deletedAt,
    })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(parentMessages, eq(parentMessages.id, channels.parentMessageId))
    .leftJoin(parentChannels, eq(parentChannels.id, parentMessages.channelId))
    .where(inArray(messages.id, msgIds));

  const byMsgId = new Map<string, MessageAnchor>();
  for (const a of anchors) {
    if (a.channelDeletedAt) continue;
    if (a.channelType === "thread" && a.parentChannelDeletedAt) continue;
    byMsgId.set(a.messageId, {
      messageId: a.messageId,
      channelId: a.channelId,
      channelType: a.channelType as "channel" | "private" | "joint" | "dm" | "thread",
      channelName: a.channelName,
      parentMessageId: a.parentMessageId,
      parentChannelId: a.parentChannelId,
      parentChannelType: a.parentChannelType as "channel" | "private" | "joint" | "dm" | "thread" | null,
      parentChannelName: a.parentChannelName,
    });
  }

  for (const r of rows) {
    if (!r.msgId) continue;
    const anchor = byMsgId.get(r.msgId);
    if (!anchor) continue;
    result.set(r.id, {
      msgRef: formatMsgRef(anchor, r.msgId),
      msgPermalink: formatMsgPermalink(anchor, r.msgId, ctx),
    });
  }
  return result;
}

function formatMsgRef(anchor: MessageAnchor, messageId: string): RaftTargetString {
  const shortId = messageId.slice(0, 8);
  if ((anchor.channelType === "channel" || anchor.channelType === "private") && anchor.channelName) {
    return `#${anchor.channelName}:${shortId}`;
  }
  if (anchor.channelType === "thread") {
    if (anchor.parentMessageId && anchor.parentChannelName) {
      const parentShortId = anchor.parentMessageId.slice(0, 8);
      return anchor.parentChannelType === "dm"
        ? `dm:@${anchor.parentChannelName}:${parentShortId}`
        : `#${anchor.parentChannelName}:${parentShortId}`;
    }
    return `#thread:${shortId}`;
  }
  return `#dm:${shortId}`;
}

function formatMsgPermalink(
  anchor: MessageAnchor,
  messageId: string,
  ctx: PermalinkContext,
): string | null {
  if (!ctx.appUrl) return null;
  const base = ctx.appUrl.replace(/\/$/, "");
  if (anchor.channelType === "thread") {
    if (!anchor.parentChannelId || !anchor.parentMessageId || !anchor.parentChannelType) return null;
    const parentBase =
      anchor.parentChannelType === "dm"
        ? `/s/${ctx.serverSlug}/dm/${anchor.parentChannelId}`
        : `/s/${ctx.serverSlug}/channel/${anchor.parentChannelId}`;
    const params = new URLSearchParams({
      thread: `${anchor.parentChannelId}:${anchor.parentMessageId}`,
      msg: messageId,
    });
    return `${base}${parentBase}?${params.toString()}`;
  }
  const basePath =
    anchor.channelType === "dm"
      ? `/s/${ctx.serverSlug}/dm/${anchor.channelId}`
      : `/s/${ctx.serverSlug}/channel/${anchor.channelId}`;
  const params = new URLSearchParams({ msg: messageId });
  return `${base}${basePath}?${params.toString()}`;
}

export async function toReminderSummaries(
  rows: ReminderRow[],
  serverId: string,
  opts: ReminderServiceOptions = {},
): Promise<ReminderSummary[]> {
  if (rows.length === 0) return [];
  const db = getExecutor(opts);
  const [serverRow] = await db
    .select({ slug: servers.slug })
    .from(servers)
    .where(eq(servers.id, serverId));
  const ctx: PermalinkContext = {
    serverSlug: serverRow?.slug ?? "",
    appUrl: getConfiguredAppUrl(),
  };
  const anchors = await resolveAnchors(rows, ctx, opts);
  const targetChannels = new Map<string, { id: string; name: string | null; type: string } | null>();
  await Promise.all(rows.map(async (row) => {
    if (!row.targetChannelId && !isOnboardingDay2Reminder(row)) return;
    targetChannels.set(row.id, await resolveReminderTargetChannel(row, opts));
  }));
  return rows.map((r) => {
    const a = anchors.get(r.id) ?? { msgRef: null, msgPermalink: null };
    const targetChannel = targetChannels.get(r.id);
    const targetRef = formatTopLevelChannelRef(targetChannel ?? null);
    if (targetChannel && targetRef) {
      const base = ctx.appUrl?.replace(/\/$/, "");
      return {
        reminderId: r.id,
        ownerAgentId: r.ownerAgentId,
        title: r.title,
        fireAt: r.fireAt.toISOString(),
        firedAt: r.firedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        status: r.status,
        msgRef: targetRef,
        msgPermalink: base
          ? `${base}/s/${ctx.serverSlug}/channel/${targetChannel.id}`
          : null,
        recurrence: summarizeRecurrence(r.recurrence),
      };
    }
    return {
      reminderId: r.id,
      ownerAgentId: r.ownerAgentId,
      title: r.title,
      fireAt: r.fireAt.toISOString(),
      firedAt: r.firedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      status: r.status,
      msgRef: a.msgRef,
      msgPermalink: a.msgPermalink,
      recurrence: summarizeRecurrence(r.recurrence),
    };
  });
}

/**
 * Wire-shape recurrence descriptor for API clients. Returns null when the
 * reminder is single-shot, or the stored rule is an unsupported kind written
 * by a newer server (forward-compat behavior: callers treat unknown as "no
 * recurrence info available" rather than crashing).
 */
function summarizeRecurrence(raw: unknown): ReminderSummary["recurrence"] {
  if (raw == null) return null;
  if (!isSupportedRecurrence(raw)) {
    return { kind: "unsupported", description: "unknown recurrence" };
  }
  return {
    kind: raw.rule.kind,
    description: formatRecurrence(raw),
  };
}

function formatReminderTypeTag(row: ReminderRow): string {
  if (!isSupportedRecurrence(row.recurrence)) return "one-time";
  return `recurring · ${formatRecurrence(row.recurrence)}`;
}

export function toReminderEventSummaries(rows: ReminderEventRow[]): ReminderEventSummary[] {
  return rows.map((row) => ({
    eventId: row.id,
    reminderId: row.reminderId,
    eventType: row.eventType,
    actorType: row.actorType,
    actorId: row.actorId,
    occurredAt: row.occurredAt.toISOString(),
    nextFireAt: row.nextFireAt?.toISOString() ?? null,
    metadata: row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : null,
  }));
}
