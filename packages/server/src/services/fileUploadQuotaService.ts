import { and, eq, sql } from "drizzle-orm";
import { FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, canUseProBillingFeatures, currentDate, type ServerPlan } from "@botiverse/raft-shared";
import type { DatabaseTransaction } from "../db/index.js";
import { getDb } from "../db/index.js";
import { serverFileUploadUsageMonths, servers } from "../db/schema.js";
import { getAppUrl } from "../config/appUrl.js";
import { refreshSubscriptionForServerIfStale } from "./billingService.js";
import { getServerBillingEntitlement, withServerResourceLock } from "./planService.js";

const FILE_UPLOAD_QUOTA_LOCK_NAMESPACE = 4;

export interface FileUploadQuotaSummary {
  month: string;
  plan: ServerPlan;
  limited: boolean;
  enforced: boolean;
  limitBytes: number;
  usedBytes: number;
  reservedBytes: number;
  remainingBytes: number;
}

export interface FileUploadQuotaReservation {
  serverId: string;
  month: string;
  bytes: number;
  limited: boolean;
}

export class FileUploadQuotaExceededError extends Error {
  readonly errorCode = "FILE_UPLOAD_QUOTA_EXCEEDED";
  readonly status = 403;

  constructor(readonly summary: FileUploadQuotaSummary, readonly requestedBytes: number) {
    super(`Monthly file upload quota exceeded (${summary.usedBytes}/${summary.limitBytes} bytes used; requested ${requestedBytes} bytes)`);
  }
}

export interface FileUploadQuotaExceededResponse {
  error: string;
  errorCode: string;
  requestedBytes: number;
  quota: FileUploadQuotaSummary;
  billingUrl: string;
  suggestedNextAction: string;
}

export const FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE =
  "Monthly file upload quota exceeded. Free includes 100 MB of file uploads per month; upgrade to Pro for higher file upload limits.";

export async function buildFileUploadQuotaExceededResponse(
  serverId: string,
  err: FileUploadQuotaExceededError,
): Promise<FileUploadQuotaExceededResponse> {
  const [server] = await getDb()
    .select({ slug: servers.slug })
    .from(servers)
    .where(eq(servers.id, serverId));
  const billingPath = server
    ? `/s/${encodeURIComponent(server.slug)}/settings/billing`
    : "/settings/billing";
  const billingUrl = new URL(billingPath, getAppUrl()).toString();
  return {
    error: FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE,
    errorCode: err.errorCode,
    requestedBytes: err.requestedBytes,
    quota: err.summary,
    billingUrl,
    suggestedNextAction: `Ask a server owner to open Settings > Billing and upgrade to Pro: ${billingUrl}`,
  };
}

export function billingUsageMonth(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

async function getUsageBytes(tx: DatabaseTransaction, serverId: string, month: string): Promise<{ usedBytes: number; reservedBytes: number }> {
  const [row] = await tx
    .select({
      usedBytes: serverFileUploadUsageMonths.usedBytes,
      reservedBytes: serverFileUploadUsageMonths.reservedBytes,
    })
    .from(serverFileUploadUsageMonths)
    .where(and(
      eq(serverFileUploadUsageMonths.serverId, serverId),
      eq(serverFileUploadUsageMonths.month, month),
    ));
  return {
    usedBytes: row?.usedBytes ?? 0,
    reservedBytes: row?.reservedBytes ?? 0,
  };
}

function summarize(plan: ServerPlan, month: string, usedBytes: number, reservedBytes = 0, now = new Date()): FileUploadQuotaSummary {
  const limited = plan === "free";
  const enforced = limited && !canUseProBillingFeatures(plan, now);
  const limitBytes = limited ? FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES : -1;
  return {
    month,
    plan,
    limited,
    enforced,
    limitBytes,
    usedBytes,
    reservedBytes: limited ? reservedBytes : 0,
    remainingBytes: limited ? Math.max(0, limitBytes - usedBytes - reservedBytes) : -1,
  };
}

export async function getFileUploadQuotaSummary(serverId: string, now = new Date()): Promise<FileUploadQuotaSummary> {
  const db = getDb();
  const month = billingUsageMonth(now);
  await refreshSubscriptionForServerIfStale(serverId, now);
  const entitlement = await getServerBillingEntitlement(db, serverId);
  const [row] = await db
    .select({
      usedBytes: serverFileUploadUsageMonths.usedBytes,
      reservedBytes: serverFileUploadUsageMonths.reservedBytes,
    })
    .from(serverFileUploadUsageMonths)
    .where(and(
      eq(serverFileUploadUsageMonths.serverId, serverId),
      eq(serverFileUploadUsageMonths.month, month),
    ));
  return summarize(entitlement.plan, month, row?.usedBytes ?? 0, row?.reservedBytes ?? 0, now);
}

export async function reserveFileUploadQuotaForSession<T>(
  serverId: string,
  requestedBytes: number,
  work: (tx: DatabaseTransaction, reservation: FileUploadQuotaReservation) => Promise<T>,
  now = currentDate(),
): Promise<T> {
  const safeRequestedBytes = Math.max(0, Math.ceil(requestedBytes));
  const month = billingUsageMonth(now);
  await refreshSubscriptionForServerIfStale(serverId, now);
  return withServerResourceLock(serverId, FILE_UPLOAD_QUOTA_LOCK_NAMESPACE, month, async (tx) => {
    const entitlement = await getServerBillingEntitlement(tx, serverId);
    const usage = await getUsageBytes(tx, serverId, month);
    const summary = summarize(entitlement.plan, month, usage.usedBytes, usage.reservedBytes, now);

    if (summary.enforced && safeRequestedBytes > summary.remainingBytes) {
      throw new FileUploadQuotaExceededError(summary, safeRequestedBytes);
    }

    if (summary.limited && safeRequestedBytes > 0) {
      await tx
        .insert(serverFileUploadUsageMonths)
        .values({
          serverId,
          month,
          usedBytes: 0,
          reservedBytes: safeRequestedBytes,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [serverFileUploadUsageMonths.serverId, serverFileUploadUsageMonths.month],
          set: {
            reservedBytes: sql`${serverFileUploadUsageMonths.reservedBytes} + ${safeRequestedBytes}`,
            updatedAt: new Date(),
          },
        });
    }

    const reservation = {
      serverId,
      month,
      bytes: safeRequestedBytes,
      limited: summary.limited,
    };
    return work(tx, reservation);
  });
}

async function reserveFileUploadQuota(serverId: string, requestedBytes: number, now = new Date()): Promise<FileUploadQuotaReservation> {
  return reserveFileUploadQuotaForSession(serverId, requestedBytes, async (_tx, reservation) => reservation, now);
}

export async function withFileUploadQuotaReservationLock<T>(
  reservation: FileUploadQuotaReservation,
  work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return withServerResourceLock(
    reservation.serverId,
    FILE_UPLOAD_QUOTA_LOCK_NAMESPACE,
    reservation.month,
    work,
  );
}

export async function finalizeFileUploadQuotaReservationInTransaction(
  tx: DatabaseTransaction,
  reservation: FileUploadQuotaReservation,
): Promise<void> {
  if (!reservation.limited || reservation.bytes <= 0) return;
  await tx
    .update(serverFileUploadUsageMonths)
    .set({
      usedBytes: sql`${serverFileUploadUsageMonths.usedBytes} + ${reservation.bytes}`,
      reservedBytes: sql`GREATEST(${serverFileUploadUsageMonths.reservedBytes} - ${reservation.bytes}, 0)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(serverFileUploadUsageMonths.serverId, reservation.serverId),
      eq(serverFileUploadUsageMonths.month, reservation.month),
    ));
}

export async function releaseFileUploadQuotaReservationInTransaction(
  tx: DatabaseTransaction,
  reservation: FileUploadQuotaReservation,
): Promise<void> {
  if (!reservation.limited || reservation.bytes <= 0) return;
  await tx
    .update(serverFileUploadUsageMonths)
    .set({
      reservedBytes: sql`GREATEST(${serverFileUploadUsageMonths.reservedBytes} - ${reservation.bytes}, 0)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(serverFileUploadUsageMonths.serverId, reservation.serverId),
      eq(serverFileUploadUsageMonths.month, reservation.month),
    ));
}

async function finalizeFileUploadQuotaReservation(reservation: FileUploadQuotaReservation): Promise<void> {
  await withFileUploadQuotaReservationLock(reservation, async (tx) => {
    await finalizeFileUploadQuotaReservationInTransaction(tx, reservation);
  });
}

async function releaseFileUploadQuotaReservation(reservation: FileUploadQuotaReservation): Promise<void> {
  await withFileUploadQuotaReservationLock(reservation, async (tx) => {
    await releaseFileUploadQuotaReservationInTransaction(tx, reservation);
  });
}

export async function withFileUploadQuota<T>(
  serverId: string,
  requestedBytes: number,
  work: () => Promise<T>,
  now = new Date(),
): Promise<T> {
  const reservation = await reserveFileUploadQuota(serverId, requestedBytes, now);
  try {
    const result = await work();
    await finalizeFileUploadQuotaReservation(reservation);
    return result;
  } catch (err) {
    await releaseFileUploadQuotaReservation(reservation);
    throw err;
  }
}
