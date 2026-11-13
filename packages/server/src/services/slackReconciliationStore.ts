import { and, asc, eq, gt } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { externalDeliveryAttempts, externalOutboundDeliveries } from "../db/schema";
import type { SlackReconciliationScan } from "./slackReconciliationScan";

/** The caller's claim, never ownership reconstructed from a subsequently read row. */
export interface SlackReconciliationClaim {
  deliveryId: string;
  leaseOwner: string;
  leaseGeneration: number;
}

export async function loadSlackReconciliationEvidence(db: DatabaseExecutor, claim: SlackReconciliationClaim, now: Date) {
  const [delivery] = await db.select().from(externalOutboundDeliveries).where(and(
    eq(externalOutboundDeliveries.id, claim.deliveryId), eq(externalOutboundDeliveries.state, "dispatching"),
    eq(externalOutboundDeliveries.leaseOwner, claim.leaseOwner),
    eq(externalOutboundDeliveries.leaseGeneration, claim.leaseGeneration),
    gt(externalOutboundDeliveries.leaseExpiresAt, now),
  )).limit(1);
  if (!delivery || delivery.providerAttempts < 1) return null;
  // firstDispatchedAt is a planner/budget field and old workers rewrite it on
  // completion or lease recovery. The ledger's I/O start is immutable, including
  // already-stored attempts. No attempt evidence means no safe bounded scan.
  const [first] = await db.select({ at: externalDeliveryAttempts.providerIoStartedAt })
    .from(externalDeliveryAttempts).where(eq(externalDeliveryAttempts.deliveryId, claim.deliveryId))
    .orderBy(asc(externalDeliveryAttempts.providerIoStartedAt)).limit(1);
  return first ? { delivery, firstAttemptAt: first.at } : null;
}

export async function saveSlackReconciliationScan(db: DatabaseExecutor, input: SlackReconciliationClaim & {
  providerAttempt: number; scan: SlackReconciliationScan | null; now: Date;
}): Promise<void> {
  const saved = await db.update(externalOutboundDeliveries).set({ reconciliationScan: input.scan }).where(and(
    eq(externalOutboundDeliveries.id, input.deliveryId), eq(externalOutboundDeliveries.state, "dispatching"),
    eq(externalOutboundDeliveries.leaseOwner, input.leaseOwner),
    eq(externalOutboundDeliveries.leaseGeneration, input.leaseGeneration),
    eq(externalOutboundDeliveries.providerAttempts, input.providerAttempt),
    gt(externalOutboundDeliveries.leaseExpiresAt, input.now),
  )).returning({ id: externalOutboundDeliveries.id });
  if (saved.length !== 1) throw new Error("Reconciliation scan lost its delivery lease");
}
