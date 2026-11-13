import { and, eq, sql } from "drizzle-orm";
import { APPSUMO_PLAN_LIMITS, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, canUseProBillingFeatures, currentDate, type BillingEntitlementProjection, type ServerPlan } from "@botiverse/raft-shared";
import type { DatabaseExecutor, DatabaseTransaction } from "../db/index";
import { getDb } from "../db/index";
import { serverFileUploadUsageMonths, servers } from "../db/schema";
import { getAppUrl } from "../config/appUrl";
import { refreshSubscriptionForServerIfStale } from "./billingService";
import { getServerBillingEntitlement, lockServerResourceInTransaction, withServerResourceLock } from "./planService";

const FILE_UPLOAD_QUOTA_LOCK_NAMESPACE = 4;

export interface FileUploadQuotaSummary {
  month: string;
  plan: ServerPlan;
  appsumo?: BillingEntitlementProjection["appsumo"];
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

export const FILE_UPLOAD_APPSUMO_QUOTA_EXCEEDED_MESSAGE =
  "The AppSumo plan monthly file upload limit has been reached. The allowance resets next UTC calendar month.";

export const FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE =
  "Monthly file upload quota exceeded. Free includes 100 MB of file uploads per month; upgrade to Pro for higher file upload limits.";

/**
 * Who reads a quota refusal's next action: a person (the web app's upload
 * route) or an agent (the agent API's uploads, through
 * agentFileUploadQuotaExceededResponse, and the workspace Artifacts agent API
 * the CLI and SDK call).
 */
export type FileUploadQuotaRefusalReader = "human" | "agent";

/**
 * The quota refusal's next action. A person is told to ask an owner to
 * upgrade. An agent without an upgrade card to offer (agentUploadUpgradeHint)
 * says why the file wasn't uploaded and may suggest Pro: Raft never requires
 * payment (cindyz).
 */
function fileUploadQuotaNextAction(reader: FileUploadQuotaRefusalReader, billingUrl: string): string {
  return reader === "agent"
    ? `Say in the conversation that the file wasn't uploaded and why. If upgrading to Pro would help the person here, you can suggest that a server owner look at Settings > Billing: ${billingUrl}`
    : `Ask a server owner to open Settings > Billing and upgrade to Pro: ${billingUrl}`;
}

export async function buildFileUploadQuotaExceededResponse(
  serverId: string,
  err: FileUploadQuotaExceededError,
  reader: FileUploadQuotaRefusalReader,
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
    error: Boolean(err.summary.appsumo)
      ? FILE_UPLOAD_APPSUMO_QUOTA_EXCEEDED_MESSAGE
      : FILE_UPLOAD_QUOTA_EXCEEDED_MESSAGE,
    errorCode: err.errorCode,
    requestedBytes: err.requestedBytes,
    quota: err.summary,
    billingUrl,
    suggestedNextAction: Boolean(err.summary.appsumo)
      ? `Ask the server owner to review the AppSumo plan and monthly usage in Settings > Billing: ${billingUrl}`
      : fileUploadQuotaNextAction(reader, billingUrl),
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

function summarize(entitlement: BillingEntitlementProjection, month: string, usedBytes: number, reservedBytes = 0, now = new Date()): FileUploadQuotaSummary {
  const { plan, appsumo } = entitlement;
  const limited = plan === "free" || Boolean(appsumo);
  const enforced = Boolean(appsumo) || (limited && !canUseProBillingFeatures(plan, now));
  const limitBytes = appsumo ? APPSUMO_PLAN_LIMITS[appsumo.tier].monthlyUploadBytes : limited ? FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES : -1;
  return {
    month,
    plan,
    ...(appsumo ? { appsumo } : {}),
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
  return summarize(entitlement, month, row?.usedBytes ?? 0, row?.reservedBytes ?? 0, now);
}

/**
 * Throws FileUploadQuotaExceededError when `requestedBytes` would not fit in
 * what is left this month; reserves nothing. A refusal before any work (a
 * request's bytes counted up front): the reservation still decides.
 */
export async function assertFileUploadQuotaAvailable(serverId: string, requestedBytes: number, now = currentDate()): Promise<void> {
  const safeRequestedBytes = Math.max(0, Math.ceil(requestedBytes));
  if (safeRequestedBytes === 0) return;
  const summary = await getFileUploadQuotaSummary(serverId, now);
  if (summary.enforced && safeRequestedBytes > summary.remainingBytes) {
    throw new FileUploadQuotaExceededError(summary, safeRequestedBytes);
  }
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
    const summary = summarize(entitlement, month, usage.usedBytes, usage.reservedBytes, now);

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

export async function reserveFileUploadQuota(serverId: string, requestedBytes: number, now = new Date()): Promise<FileUploadQuotaReservation> {
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

/**
 * finalizeFileUploadQuotaReservationInTransaction in the caller's
 * transaction, under the reservation's lock taken there: the bytes become
 * used exactly when the caller's write commits (object files: with the row
 * that names them).
 */
export async function finalizeFileUploadQuotaReservationWith(
  tx: DatabaseTransaction,
  reservation: FileUploadQuotaReservation,
): Promise<void> {
  if (!reservation.limited || reservation.bytes <= 0) return;
  await lockServerResourceInTransaction(tx, reservation.serverId, FILE_UPLOAD_QUOTA_LOCK_NAMESPACE, reservation.month);
  await finalizeFileUploadQuotaReservationInTransaction(tx, reservation);
}

/**
 * Give `bytes` counted as used in `month` back to `serverId`, in the caller's
 * transaction under that month's lock (never below 0). The caller makes it
 * once per upload: object files refund in the statement that lets the
 * upload go, conditioned on its state (services/objectFiles.ts sweep).
 */
export async function refundFileUploadQuotaWith(tx: DatabaseExecutor, serverId: string, month: string, bytes: number): Promise<void> {
  const safeBytes = Math.max(0, Math.floor(bytes));
  if (safeBytes === 0) return;
  await lockServerResourceInTransaction(tx, serverId, FILE_UPLOAD_QUOTA_LOCK_NAMESPACE, month);
  await tx
    .update(serverFileUploadUsageMonths)
    .set({
      usedBytes: sql`GREATEST(${serverFileUploadUsageMonths.usedBytes} - ${safeBytes}, 0)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(serverFileUploadUsageMonths.serverId, serverId),
      eq(serverFileUploadUsageMonths.month, month),
    ));
}

export async function finalizeFileUploadQuotaReservation(reservation: FileUploadQuotaReservation): Promise<void> {
  await withFileUploadQuotaReservationLock(reservation, async (tx) => {
    await finalizeFileUploadQuotaReservationInTransaction(tx, reservation);
  });
}

export async function releaseFileUploadQuotaReservation(reservation: FileUploadQuotaReservation): Promise<void> {
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
