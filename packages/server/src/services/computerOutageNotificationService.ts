import { clearClockInterval, currentDate, setClockInterval } from "@botiverse/raft-shared";
import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import { getDb, type Database, type DatabaseExecutor } from "../db/index.js";
import {
  computerLifecycleOperations,
  computerOutageOccurrences,
  computers,
} from "../db/schema.js";
import { emitAppFacingNotificationEvent } from "./appNotificationDeliveryService.js";

export const COMPUTER_OUTAGE_ALERT_DWELL_MS = 60_000;
const COMPUTER_OUTAGE_DRAIN_BATCH_SIZE = 25;

type ComputerOutageOccurrence = typeof computerOutageOccurrences.$inferSelect;
type ShutdownIntent = { reason: string } | null | undefined;

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

async function findActiveComputerForMachine(
  input: { serverId: string; machineId: string },
  executor: DatabaseExecutor,
): Promise<{ id: string } | null> {
  const [computer] = await executor.select({ id: computers.id })
    .from(computers)
    .where(and(
      eq(computers.serverId, input.serverId),
      eq(computers.machineId, input.machineId),
      isNull(computers.revokedAt),
    ))
    .limit(1);
  return computer ?? null;
}

async function hasPlannedLifecycleOperation(
  input: { serverId: string; machineId: string; connectionEpochId: string },
  executor: DatabaseExecutor,
): Promise<boolean> {
  const [operation] = await executor.select({ id: computerLifecycleOperations.id })
    .from(computerLifecycleOperations)
    .where(and(
      eq(computerLifecycleOperations.serverId, input.serverId),
      eq(computerLifecycleOperations.machineId, input.machineId),
      eq(computerLifecycleOperations.connectionEpochBefore, input.connectionEpochId),
      inArray(computerLifecycleOperations.action, ["stop", "restart", "upgrade"]),
      inArray(computerLifecycleOperations.status, ["pending", "completed", "unconfirmed"]),
    ))
    .limit(1);
  return Boolean(operation);
}

function outageProvenance(occurrence: Pick<ComputerOutageOccurrence, "id">): Record<string, unknown> {
  return {
    source: "machine_connection_transition",
    outage_occurrence_id: occurrence.id,
  };
}

function recoveryProvenance(occurrence: Pick<ComputerOutageOccurrence, "id" | "offlineEventId">): Record<string, unknown> {
  return {
    ...outageProvenance(occurrence),
    recovery_for_event_id: occurrence.offlineEventId,
  };
}

async function emitOfflineEvent(
  occurrence: ComputerOutageOccurrence,
  executor: DatabaseExecutor,
): Promise<void> {
  await emitAppFacingNotificationEvent({
    id: occurrence.offlineEventId,
    serverId: occurrence.serverId,
    eventType: "computer.offline",
    subjectType: "computer",
    subjectId: occurrence.computerId,
    occurredAt: occurrence.firstOfflineAt,
    provenance: outageProvenance(occurrence),
  }, executor);
}

async function emitOnlineEvent(
  occurrence: ComputerOutageOccurrence,
  now: Date,
  executor: DatabaseExecutor,
): Promise<void> {
  await emitAppFacingNotificationEvent({
    id: occurrence.onlineEventId,
    serverId: occurrence.serverId,
    eventType: "computer.online",
    subjectType: "computer",
    subjectId: occurrence.computerId,
    occurredAt: now,
    provenance: recoveryProvenance(occurrence),
  }, executor);
}

async function promotePendingOccurrence(
  occurrence: ComputerOutageOccurrence,
  now: Date,
  executor: DatabaseExecutor,
): Promise<ComputerOutageOccurrence | null> {
  const [promoted] = await executor.update(computerOutageOccurrences).set({
    state: "notified",
    offlineNotifiedAt: now,
    updatedAt: now,
  }).where(and(
    eq(computerOutageOccurrences.id, occurrence.id),
    eq(computerOutageOccurrences.state, "pending"),
    lte(computerOutageOccurrences.notifyAfter, now),
  )).returning();
  if (!promoted) return null;
  await emitOfflineEvent(promoted, executor);
  return promoted;
}

async function findOccurrenceById(
  occurrenceId: string,
  executor: DatabaseExecutor,
): Promise<ComputerOutageOccurrence | null> {
  const [occurrence] = await executor.select().from(computerOutageOccurrences)
    .where(eq(computerOutageOccurrences.id, occurrenceId))
    .limit(1);
  return occurrence ?? null;
}

export async function recordComputerOfflineTransition(input: {
  serverId: string;
  machineId: string;
  connectionEpochId: string;
  shutdownIntent?: ShutdownIntent;
  now?: Date;
  dwellMs?: number;
  executor?: Database;
}): Promise<
  | { status: "created"; occurrenceId: string }
  | { status: "duplicate" }
  | { status: "ignored_unmanaged" }
  | { status: "suppressed_planned"; reason: "machine_shutdown" | "lifecycle_operation" }
> {
  const db = input.executor ?? getDb();
  const now = input.now ?? currentDate();
  const dwellMs = input.dwellMs ?? COMPUTER_OUTAGE_ALERT_DWELL_MS;
  return db.transaction(async (tx) => {
    const computer = await findActiveComputerForMachine(input, tx);
    if (!computer) return { status: "ignored_unmanaged" as const };
    if (input.shutdownIntent) {
      return { status: "suppressed_planned" as const, reason: "machine_shutdown" as const };
    }
    if (await hasPlannedLifecycleOperation(input, tx)) {
      return { status: "suppressed_planned" as const, reason: "lifecycle_operation" as const };
    }
    const [created] = await tx.insert(computerOutageOccurrences).values({
      serverId: input.serverId,
      computerId: computer.id,
      machineId: input.machineId,
      connectionEpochId: input.connectionEpochId,
      firstOfflineAt: now,
      notifyAfter: addMs(now, dwellMs),
    }).onConflictDoNothing().returning({ id: computerOutageOccurrences.id });
    return created
      ? { status: "created" as const, occurrenceId: created.id }
      : { status: "duplicate" as const };
  });
}

export async function drainDueComputerOutageNotifications(input: {
  now?: Date;
  batchSize?: number;
  executor?: Database;
} = {}): Promise<{ claimed: number; offlineEmitted: number }> {
  const db = input.executor ?? getDb();
  const now = input.now ?? currentDate();
  const candidates = await db.select().from(computerOutageOccurrences)
    .where(and(
      eq(computerOutageOccurrences.state, "pending"),
      lte(computerOutageOccurrences.notifyAfter, now),
    ))
    .orderBy(asc(computerOutageOccurrences.notifyAfter))
    .limit(input.batchSize ?? COMPUTER_OUTAGE_DRAIN_BATCH_SIZE);
  let claimed = 0;
  let offlineEmitted = 0;
  for (const candidate of candidates) {
    const promoted = await db.transaction((tx) => promotePendingOccurrence(candidate, now, tx));
    if (!promoted) continue;
    claimed += 1;
    offlineEmitted += 1;
  }
  return { claimed, offlineEmitted };
}

export async function recordComputerOnlineTransition(input: {
  serverId: string;
  machineId: string;
  now?: Date;
  executor?: Database;
}): Promise<{ recovered: number; suppressedFlaps: number; offlineEmitted: number; onlineEmitted: number }> {
  const db = input.executor ?? getDb();
  const now = input.now ?? currentDate();
  return db.transaction(async (tx) => {
    const openOccurrences = await tx.select().from(computerOutageOccurrences)
      .where(and(
        eq(computerOutageOccurrences.serverId, input.serverId),
        eq(computerOutageOccurrences.machineId, input.machineId),
        inArray(computerOutageOccurrences.state, ["pending", "notified"]),
      ))
      .orderBy(asc(computerOutageOccurrences.firstOfflineAt));

    let recovered = 0;
    let suppressedFlaps = 0;
    let offlineEmitted = 0;
    let onlineEmitted = 0;
    for (const occurrence of openOccurrences) {
      let notified: ComputerOutageOccurrence | null = occurrence.state === "notified" ? occurrence : null;
      if (occurrence.state === "pending" && occurrence.notifyAfter.getTime() > now.getTime()) {
        const [suppressed] = await tx.update(computerOutageOccurrences).set({
          state: "suppressed",
          suppressedAt: now,
          suppressReason: "recovered_before_dwell",
          updatedAt: now,
        }).where(and(
          eq(computerOutageOccurrences.id, occurrence.id),
          eq(computerOutageOccurrences.state, "pending"),
        )).returning({ id: computerOutageOccurrences.id });
        if (suppressed) {
          suppressedFlaps += 1;
          continue;
        }

        const current = await findOccurrenceById(occurrence.id, tx);
        if (current?.state !== "notified") continue;
        notified = current;
      }

      if (!notified && occurrence.state === "pending") {
        notified = await promotePendingOccurrence(occurrence, now, tx);
        if (notified) {
          offlineEmitted += 1;
        } else {
          const current = await findOccurrenceById(occurrence.id, tx);
          if (current?.state !== "notified") continue;
          notified = current;
        }
      }
      if (!notified) continue;

      const [closed] = await tx.update(computerOutageOccurrences).set({
        state: "recovered",
        recoveredAt: now,
        updatedAt: now,
      }).where(and(
        eq(computerOutageOccurrences.id, notified.id),
        eq(computerOutageOccurrences.state, "notified"),
      )).returning();
      if (!closed) continue;
      await emitOnlineEvent(closed, now, tx);
      recovered += 1;
      onlineEmitted += 1;
    }
    return { recovered, suppressedFlaps, offlineEmitted, onlineEmitted };
  });
}

export function startComputerOutageNotificationWorker(input: {
  intervalMs?: number;
  batchSize?: number;
  scheduleEvery?: (fn: () => void, intervalMs: number) => unknown;
  clear?: (handle: unknown) => void;
} = {}) {
  const intervalMs = input.intervalMs ?? 15_000;
  const batchSize = input.batchSize ?? COMPUTER_OUTAGE_DRAIN_BATCH_SIZE;
  const run = () => {
    drainDueComputerOutageNotifications({ batchSize }).catch((error) => {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("[ComputerOutageNotifications] drain failed", message.slice(0, 500));
    });
  };
  run();
  const handle = (input.scheduleEvery ?? setClockInterval)(run, intervalMs);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  return {
    stop() {
      (input.clear ?? clearClockInterval)(handle);
    },
  };
}
