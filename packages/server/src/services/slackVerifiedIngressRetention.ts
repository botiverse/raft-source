import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/index";
import { slackVerifiedIngressDedupe, slackVerifiedIngressEvents, slackVerifiedIngressFileFacts, slackVerifiedIngressPartitions,
  slackVerifiedIngressReplayAudits, slackIngressAuthorWakeSignals } from "../db/schema";
import { lockSlackConversations } from "./slackBridgeRowLocks";
import { withSlackIngressProtocol } from "./slackVerifiedIngressRollout";

export const SLACK_INGRESS_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Erase expired corrupt payloads while keeping their reason and receipt. */
export async function expireQuarantinedSlackIngress(input: {
  db: Database; now: Date; registrationId: string; environment: "test" | "production"; limit?: number;
}): Promise<number> {
  const limit = input.limit ?? 50;
  if (!Number.isFinite(input.now.getTime()) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Invalid Slack quarantine retention request");
  }
  const before = new Date(input.now.getTime() - SLACK_INGRESS_TERMINAL_RETENTION_MS);
  const candidates = await input.db.select({ eventId: slackVerifiedIngressEvents.id,
    partition: slackVerifiedIngressPartitions }).from(slackVerifiedIngressEvents)
    .innerJoin(slackVerifiedIngressPartitions, eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId))
    .where(and(eq(slackVerifiedIngressPartitions.appRegistrationId, input.registrationId),
      eq(slackVerifiedIngressPartitions.environment, input.environment), inArray(slackVerifiedIngressEvents.state, ["quarantined", "review_required"]),
      lt(slackVerifiedIngressEvents.heldAt, before)))
    .orderBy(asc(slackVerifiedIngressEvents.heldAt), asc(slackVerifiedIngressEvents.id)).limit(limit);
  let count = 0;
  for (const { eventId, partition } of candidates) {
    const erased = await withSlackIngressProtocol({ db: input.db, purpose: "settle", run: async tx => {
      if (partition.partitionKind === "conversation") await lockSlackConversations(tx, [{
        registrationId: partition.appRegistrationId, providerAuthorityId: partition.providerAuthorityId,
        providerConversationId: partition.providerConversationId,
      }]);
      const [currentPartition] = await tx.select().from(slackVerifiedIngressPartitions)
        .where(eq(slackVerifiedIngressPartitions.id, partition.id)).limit(1).for("update");
      if (!currentPartition || currentPartition.appRegistrationId !== input.registrationId
        || currentPartition.environment !== input.environment
        || currentPartition.partitionKind !== partition.partitionKind
        || currentPartition.providerAuthorityId !== partition.providerAuthorityId
        || currentPartition.providerConversationId !== partition.providerConversationId) return false;
      const [event] = await tx.select().from(slackVerifiedIngressEvents).where(and(
        eq(slackVerifiedIngressEvents.id, eventId), eq(slackVerifiedIngressEvents.partitionId, partition.id),
        inArray(slackVerifiedIngressEvents.state, ["quarantined", "review_required"]), lt(slackVerifiedIngressEvents.heldAt, before),
      )).limit(1).for("update");
      if (!event) return false;
      await tx.update(slackVerifiedIngressEvents).set({ state: "discarded", encryptedPayload: null,
        envelopeKeyId: null, heldAt: null, outcomeReason: "quarantine_retention_expired", updatedAt: input.now })
        .where(eq(slackVerifiedIngressEvents.id, event.id));
      return true;
    } });
    if (erased) count++;
  }
  return count;
}

/** Compact a bounded page of terminal receipts without removing duplicate
 * evidence. Unresolved, audited, and attachment-provenance events remain. */
export async function compactTerminalSlackIngress(input: {
  db: Database; now: Date; registrationId: string; environment: "test" | "production"; limit?: number;
}): Promise<number> {
  const limit = input.limit ?? 50;
  if (!Number.isFinite(input.now.getTime()) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Invalid Slack ingress retention request");
  }
  const before = new Date(input.now.getTime() - SLACK_INGRESS_TERMINAL_RETENTION_MS);
  const candidates = await input.db.select({ eventId: slackVerifiedIngressEvents.id,
    registrationId: slackVerifiedIngressPartitions.appRegistrationId,
    authorityId: slackVerifiedIngressPartitions.providerAuthorityId,
    conversationId: slackVerifiedIngressPartitions.providerConversationId,
    partitionKind: slackVerifiedIngressPartitions.partitionKind,
  }).from(slackVerifiedIngressEvents).innerJoin(slackVerifiedIngressPartitions,
    eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId)).where(and(
    eq(slackVerifiedIngressPartitions.appRegistrationId, input.registrationId),
    eq(slackVerifiedIngressPartitions.environment, input.environment),
    inArray(slackVerifiedIngressEvents.state, ["completed", "discarded"]),
    sql`${slackVerifiedIngressEvents.outcomeReason} <> 'quarantine_retention_expired'`,
    lt(slackVerifiedIngressEvents.updatedAt, before),
    sql`NOT EXISTS (SELECT 1 FROM ${slackVerifiedIngressReplayAudits} a WHERE a.event_id = ${slackVerifiedIngressEvents.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${slackVerifiedIngressFileFacts} f WHERE f.raw_event_id = ${slackVerifiedIngressEvents.id})`,
  )).orderBy(asc(slackVerifiedIngressEvents.updatedAt), asc(slackVerifiedIngressEvents.id)).limit(limit);
  let count = 0;
  for (const candidate of candidates) {
    const moved = await withSlackIngressProtocol({ db: input.db, purpose: "settle", run: async tx => {
      if (candidate.partitionKind === "conversation") await lockSlackConversations(tx, [{ registrationId: candidate.registrationId,
        providerAuthorityId: candidate.authorityId, providerConversationId: candidate.conversationId }]);
      const [row] = await tx.select({ event: slackVerifiedIngressEvents, partition: slackVerifiedIngressPartitions })
        .from(slackVerifiedIngressEvents).innerJoin(slackVerifiedIngressPartitions,
          eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId)).where(and(
          eq(slackVerifiedIngressEvents.id, candidate.eventId),
          eq(slackVerifiedIngressPartitions.appRegistrationId, candidate.registrationId),
          eq(slackVerifiedIngressPartitions.environment, input.environment),
          eq(slackVerifiedIngressPartitions.providerAuthorityId, candidate.authorityId),
          eq(slackVerifiedIngressPartitions.providerConversationId, candidate.conversationId),
          eq(slackVerifiedIngressPartitions.partitionKind, candidate.partitionKind),
          inArray(slackVerifiedIngressEvents.state, ["completed", "discarded"]),
          sql`${slackVerifiedIngressEvents.outcomeReason} <> 'quarantine_retention_expired'`,
          lt(slackVerifiedIngressEvents.updatedAt, before),
        )).limit(1).for("update");
      if (!row || row.event.encryptedPayload || row.event.envelopeKeyId) return false;
      const [audit] = await tx.select({ id: slackVerifiedIngressReplayAudits.id }).from(slackVerifiedIngressReplayAudits)
        .where(eq(slackVerifiedIngressReplayAudits.eventId, row.event.id)).limit(1);
      if (audit) return false;
      // File transfers use the raw-event relation as durable proof. Deleting
      // its parent would cascade that proof and could strand pending transfers.
      const [fileProof] = await tx.select({ id: slackVerifiedIngressFileFacts.factId }).from(slackVerifiedIngressFileFacts)
        .where(eq(slackVerifiedIngressFileFacts.rawEventId, row.event.id)).limit(1);
      if (fileProof) return false;
      const proof = { id: row.event.id, appRegistrationId: row.event.appRegistrationId,
        providerEventId: row.event.providerEventId, providerAppId: row.event.providerAppId,
        environment: row.partition.environment, providerAuthorityId: row.partition.providerAuthorityId,
        providerConversationId: row.partition.providerConversationId, rawDigest: row.event.rawDigest,
        finishedAt: row.event.updatedAt };
      await tx.insert(slackVerifiedIngressDedupe).values(proof).onConflictDoNothing();
      const [stored] = await tx.select().from(slackVerifiedIngressDedupe).where(and(
        eq(slackVerifiedIngressDedupe.appRegistrationId, proof.appRegistrationId),
        eq(slackVerifiedIngressDedupe.providerEventId, proof.providerEventId))).limit(1);
      if (!stored || stored.id !== proof.id || stored.rawDigest !== proof.rawDigest
        || stored.providerAppId !== proof.providerAppId || stored.environment !== proof.environment
        || stored.providerAuthorityId !== proof.providerAuthorityId || stored.providerConversationId !== proof.providerConversationId) {
        throw new Error("Slack ingress retention identity conflict");
      }
      await tx.delete(slackVerifiedIngressEvents).where(eq(slackVerifiedIngressEvents.id, row.event.id));
      return true;
    } });
    if (moved) count++;
  }
  return count;
}

/** Bounded expiry of compact duplicate evidence after the 30-day replay window. */
export async function expireSlackIngressDedupe(input: {
  db: Database; now: Date; registrationId: string; environment: "test" | "production"; limit?: number;
}): Promise<number> {
  const limit = input.limit ?? 50;
  if (!Number.isFinite(input.now.getTime()) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
    || !input.registrationId.trim()) throw new Error("Invalid Slack dedupe retention request");
  const before = new Date(input.now.getTime() - SLACK_INGRESS_TERMINAL_RETENTION_MS);
  return withSlackIngressProtocol({ db: input.db, purpose: "settle", run: async tx => {
    const rows = await tx.select({ id: slackVerifiedIngressDedupe.id }).from(slackVerifiedIngressDedupe)
      .where(and(eq(slackVerifiedIngressDedupe.appRegistrationId, input.registrationId),
        eq(slackVerifiedIngressDedupe.environment, input.environment), lt(slackVerifiedIngressDedupe.finishedAt, before)))
      .orderBy(asc(slackVerifiedIngressDedupe.finishedAt), asc(slackVerifiedIngressDedupe.id))
      .limit(limit).for("update", { skipLocked: true });
    if (rows.length) await tx.delete(slackVerifiedIngressDedupe)
      .where(inArray(slackVerifiedIngressDedupe.id, rows.map(row => row.id)));
    return rows.length;
  } });
}

/** Expire old wake signals only once no matching isolated receipt remains. */
export async function expireSlackAuthorWakeSignals(input: {
  db: Database; now: Date; registrationId: string; limit?: number;
}): Promise<number> {
  const limit = input.limit ?? 50;
  if (!Number.isFinite(input.now.getTime()) || !input.registrationId.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Invalid Slack wake retention request");
  }
  return withSlackIngressProtocol({ db: input.db, purpose: "settle", run: async tx => {
    const rows = await tx.select().from(slackIngressAuthorWakeSignals).where(and(
      eq(slackIngressAuthorWakeSignals.registrationId, input.registrationId), lt(slackIngressAuthorWakeSignals.expiresAt, input.now),
      sql`NOT EXISTS (SELECT 1 FROM slack_verified_ingress_events e WHERE e.app_registration_id = ${slackIngressAuthorWakeSignals.registrationId}
        AND e.pending_author_binding_id = ${slackIngressAuthorWakeSignals.bindingId}
        AND e.pending_author_install_id = ${slackIngressAuthorWakeSignals.installId}
        AND e.pending_author_workspace_id = ${slackIngressAuthorWakeSignals.workspaceId}
        AND e.pending_author_actor_id = ${slackIngressAuthorWakeSignals.actorId}
        AND e.state = 'held' AND e.outcome_reason IN ('actor_identity_pending', 'bot_outbound_pending', 'bot_sync_disabled'))`,
    )).orderBy(asc(slackIngressAuthorWakeSignals.expiresAt)).limit(limit).for("update", { skipLocked: true });
    for (const row of rows) await tx.delete(slackIngressAuthorWakeSignals).where(and(
      eq(slackIngressAuthorWakeSignals.registrationId, row.registrationId), eq(slackIngressAuthorWakeSignals.bindingId, row.bindingId),
      eq(slackIngressAuthorWakeSignals.installId, row.installId), eq(slackIngressAuthorWakeSignals.workspaceId, row.workspaceId),
      eq(slackIngressAuthorWakeSignals.actorId, row.actorId), lt(slackIngressAuthorWakeSignals.expiresAt, input.now),
    ));
    return rows.length;
  } });
}
