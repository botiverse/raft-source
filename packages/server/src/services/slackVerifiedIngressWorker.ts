import { withSlackIngressProtocol } from "./slackVerifiedIngressRollout";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/index";
import { externalAttachmentMessageFacts, externalInboundEvents, externalReactionFacts,
  slackVerifiedIngressEvents, slackVerifiedIngressPartitions, slackVerifiedIngressReplayAudits } from "../db/schema";
import { enqueueExternalInboundEvent, type ExternalInboundRuntimeAuthority } from "./externalInboundWorkerService";
import { CONFIRMED_THREAD_ROOT_MISSING } from "./externalProviderPreparation";
import { lockSlackConversations } from "./slackBridgeRowLocks";
import { SLACK_REPEAT_FALLBACK_WAIT_MS } from "./slackFallbackPolicy";

/**
 * Claim the head of one available partition. The same partition lock is taken
 * by admission, so positions are assigned before a worker can pass them.
 * SKIP LOCKED is applied to partitions only, never to individual event rows.
 */
export type SlackVerifiedIngressClaimInput = {
  db: Database;
  leaseOwner: string;
  leaseMs: number;
  now: () => Date;
  /** Runtime keys are registration-scoped; never claim another key's data. */
  scope?: { registrationId: string; environment: "test" | "production" };
};

export async function claimSlackVerifiedIngressHeads(input: SlackVerifiedIngressClaimInput & { limit: number }) {
  const { db, leaseOwner, leaseMs } = input;
  const clock = input.now;
  const now = new Date(clock().getTime());
  if (!leaseOwner.trim() || Buffer.byteLength(leaseOwner, "utf8") > 160
    || /[\r\n\0]/u.test(leaseOwner)
    || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 10 * 60_000
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 16
    || !Number.isFinite(now.getTime())
    || (input.scope && (!input.scope.registrationId.trim() || Buffer.byteLength(input.scope.registrationId, "utf8") > 320
      || /[\r\n\0]/u.test(input.scope.registrationId)
      || !["test", "production"].includes(input.scope.environment)))) throw new Error("Invalid Slack ingress claim");
  return withSlackIngressProtocol({ db, purpose: "claim", run: async (tx) => {
    const partitions = await tx.select().from(slackVerifiedIngressPartitions).where(and(
      input.scope ? eq(slackVerifiedIngressPartitions.appRegistrationId, input.scope.registrationId) : undefined,
      input.scope ? eq(slackVerifiedIngressPartitions.environment, input.scope.environment) : undefined,
      sql`
      EXISTS (
        SELECT 1 FROM slack_verified_ingress_events e
        WHERE e.partition_id = ${slackVerifiedIngressPartitions.id}
          AND e.position = (
            SELECT min(h.position) FROM slack_verified_ingress_events h
            WHERE h.partition_id = ${slackVerifiedIngressPartitions.id}
              AND h.state IN ('queued', 'processing', 'materialized')
          )
          AND ((e.state IN ('queued', 'materialized') AND e.next_attempt_at <= ${now})
            OR (e.state = 'processing' AND e.lease_expires_at <= ${now}))
      )
    `)).orderBy(sql`${slackVerifiedIngressPartitions.lastServedOrdinal} ASC NULLS FIRST`, asc(slackVerifiedIngressPartitions.id))
      .limit(input.limit).for("update", { skipLocked: true });
    const claims: { event: typeof slackVerifiedIngressEvents.$inferSelect; partition: typeof slackVerifiedIngressPartitions.$inferSelect }[] = [];
    for (const partition of partitions) {
      const [head] = await tx.select().from(slackVerifiedIngressEvents).where(and(
        eq(slackVerifiedIngressEvents.partitionId, partition.id),
        inArray(slackVerifiedIngressEvents.state, ["queued", "processing", "materialized"]),
      )).orderBy(asc(slackVerifiedIngressEvents.position)).limit(1).for("update");
      const claimedAt = new Date(clock().getTime());
      const expiresAt = new Date(claimedAt.getTime() + leaseMs);
      if (!Number.isFinite(claimedAt.getTime()) || !Number.isFinite(expiresAt.getTime())) throw new Error("Invalid Slack ingress claim");
      if (!head || ((head.state === "queued" || head.state === "materialized") && head.nextAttemptAt > claimedAt)
        || (head.state === "processing" && (!head.leaseExpiresAt || head.leaseExpiresAt > claimedAt))) {
        continue;
      }
      const markServed = () => tx.update(slackVerifiedIngressPartitions).set({
        lastServedAt: claimedAt,
        lastServedOrdinal: sql`nextval('slack_verified_ingress_served_seq')`,
      }).where(eq(slackVerifiedIngressPartitions.id, partition.id));
      if (head.state === "materialized") {
        const [normalized] = head.materializedInboundEventId
          ? await tx.select().from(externalInboundEvents)
            .where(eq(externalInboundEvents.id, head.materializedInboundEventId)).limit(1).for("update")
          : [];
        const sameIdentity = normalized && normalized.provider === "slack"
          && normalized.appRegistrationId === head.appRegistrationId
          && normalized.environment === partition.environment
          && normalized.providerAuthorityId === partition.providerAuthorityId
          && normalized.providerConversationId === partition.providerConversationId
          && normalized.providerEventId === head.providerEventId;
        if (sameIdentity && normalized.status === "dead"
          && (normalized.outcomeReason === CONFIRMED_THREAD_ROOT_MISSING || normalized.outcomeReason === "edit_target_unverified"
            || normalized.outcomeReason === "provider_self_echo_without_link")) {
          await tx.update(slackVerifiedIngressEvents).set({
            state: "discarded", encryptedPayload: null, envelopeKeyId: null,
            outcomeReason: normalized.outcomeReason, updatedAt: claimedAt,
          }).where(eq(slackVerifiedIngressEvents.id, head.id));
        } else if (sameIdentity && ["committed", "duplicate", "echo"].includes(normalized.status)) {
          await tx.update(slackVerifiedIngressEvents).set({
            state: "completed", encryptedPayload: null, envelopeKeyId: null,
            outcomeReason: normalized.outcomeReason?.startsWith("provider_inbound_fallback_")
              ? normalized.outcomeReason : `normalized_${normalized.status}`, updatedAt: claimedAt,
          }).where(eq(slackVerifiedIngressEvents.id, head.id));
        } else if (sameIdentity && normalized.status === "quarantined" && normalized.outcomeReason === "payload_invalid") {
          // Payload parsing failed before any message or attachment side effect.
          // Retry from the encrypted raw receipt; after three failures isolate
          // just this event. Keep the normalized terminal row for uniqueness and
          // later authorized replay, rather than deleting its evidence.
          const failures = head.parseFailureCount + 1;
          if (failures > 3 || normalized.committedMessageId !== null) throw new Error("Invalid normalized quarantine state");
          const held = failures === 3;
          const tombstone = createHash("sha256").update(JSON.stringify(["external-inbound-payload-tombstone", "v1",
            normalized.id, normalized.normalizedPayloadDigest, "quarantined", "isolated_normalization_failure"])).digest("hex");
          await tx.update(externalInboundEvents).set({ outcomeReason: "isolated_normalization_failure",
            payloadTombstoneDigest: tombstone, updatedAt: claimedAt })
            .where(eq(externalInboundEvents.id, normalized.id));
          await tx.update(slackVerifiedIngressEvents).set({ state: held ? "quarantined" : "queued",
            materializedInboundEventId: null, parseFailureCount: failures,
            firstParseFailureAt: head.firstParseFailureAt ?? claimedAt, heldAt: held ? claimedAt : null,
            lastIsolatedNormalizedId: normalized.id, lastIsolatedNormalizedDigest: normalized.normalizedPayloadDigest,
            ...(held ? { lastIsolationReason: "normalized_payload_invalid", lastIsolatedAt: claimedAt } : {}),
            outcomeReason: "normalized_payload_invalid", nextAttemptAt: new Date(claimedAt.getTime() + 60_000),
            updatedAt: claimedAt }).where(eq(slackVerifiedIngressEvents.id, head.id));
        } else if (sameIdentity && ["dead", "quarantined", "revoked"].includes(normalized.status)) {
          // A terminal failure linked to an authenticated raw receipt is a
          // single-event problem. Preserve the raw ciphertext and move it off
          // the FIFO rather than allowing this row to strand the conversation.
          // A committed side effect remains an explicit conflict and cannot be
          // silently rebuilt by replay.
          const reason = normalized.committedMessageId
            ? `normalized_conflict_${normalized.status}` : `normalized_terminal_${normalized.status}`;
          if (!normalized.committedMessageId) {
            const tombstone = createHash("sha256").update(JSON.stringify(["external-inbound-payload-tombstone", "v1",
              normalized.id, normalized.normalizedPayloadDigest, "quarantined", "isolated_normalization_failure"])).digest("hex");
            await tx.update(externalInboundEvents).set({ status: "quarantined", outcomeReason: "isolated_normalization_failure",
              payloadTombstoneDigest: tombstone, updatedAt: claimedAt }).where(eq(externalInboundEvents.id, normalized.id));
          }
          await tx.update(slackVerifiedIngressEvents).set({ state: "review_required", materializedInboundEventId: null,
            parseFailureCount: 3, firstParseFailureAt: head.firstParseFailureAt ?? claimedAt, heldAt: claimedAt,
            lastIsolatedNormalizedId: normalized.id, lastIsolatedNormalizedDigest: normalized.normalizedPayloadDigest,
            lastIsolationReason: reason, lastIsolatedAt: claimedAt, outcomeReason: reason, updatedAt: claimedAt,
          }).where(eq(slackVerifiedIngressEvents.id, head.id));
        } else {
          // Retain the raw encrypted body and keep the head in place while the
          // normalized event is pending, failed, or has conflicting identity.
          // The scheduled interval is retained in the two timestamps on the
          // locked head, so multiple workers and restarts share the same backoff.
          // Materialization starts with a zero interval; malformed or stale
          // timestamps safely restart at the minimum.
          const previousDelay = head.nextAttemptAt.getTime() - head.updatedAt.getTime();
          const delay = Number.isSafeInteger(previousDelay) && previousDelay > 0 && previousDelay <= 30_000
            ? Math.min(previousDelay * 2, 30_000) : 250;
          await tx.update(slackVerifiedIngressEvents).set({
            nextAttemptAt: new Date(claimedAt.getTime() + delay),
            outcomeReason: sameIdentity ? "normalized_pending" : "normalized_identity_conflict",
            updatedAt: claimedAt,
          }).where(eq(slackVerifiedIngressEvents.id, head.id));
        }
        await markServed();
        continue;
      }
      const [claimed] = await tx.update(slackVerifiedIngressEvents).set({
        state: "processing",
        leaseOwner,
        leaseExpiresAt: expiresAt,
        leaseGeneration: sql`${slackVerifiedIngressEvents.leaseGeneration} + 1`,
        updatedAt: claimedAt,
      }).where(eq(slackVerifiedIngressEvents.id, head.id)).returning();
      if (!claimed || !Number.isSafeInteger(claimed.leaseGeneration)) {
        throw new Error("Slack ingress lease generation overflow");
      }
      await markServed();
      claims.push({ event: claimed, partition });
    }
    return claims;
  } });
}

export async function claimSlackVerifiedIngressHead(input: SlackVerifiedIngressClaimInput): Promise<{
  event: typeof slackVerifiedIngressEvents.$inferSelect; partition: typeof slackVerifiedIngressPartitions.$inferSelect;
} | null> {
  return (await claimSlackVerifiedIngressHeads({ ...input, limit: 1 }))[0] ?? null;
}

/** Release only the current unexpired lease; keep the encrypted body for retry. */
export async function deferSlackVerifiedIngressClaim(input: {
  db: Database;
  partitionId: string;
  eventId: string;
  leaseOwner: string;
  leaseGeneration: number;
  now: () => Date;
  retryAt: Date;
  reason: string;
}): Promise<boolean> {
  const { db, partitionId, eventId, leaseOwner, leaseGeneration, reason } = input;
  const clock = input.now;
  const now = new Date(clock().getTime());
  const retryAt = new Date(input.retryAt.getTime());
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(retryAt.getTime())
    || retryAt < now || !Number.isSafeInteger(leaseGeneration) || leaseGeneration <= 0
    || !/^[a-z][a-z0-9_]{0,159}$/u.test(reason)) throw new Error("Invalid Slack ingress deferral");
  return withSlackIngressProtocol({ db, purpose: "settle", run: async (tx) => {
    const [partition] = await tx.select({ id: slackVerifiedIngressPartitions.id })
      .from(slackVerifiedIngressPartitions).where(eq(slackVerifiedIngressPartitions.id, partitionId))
      .limit(1).for("update");
    if (!partition) return false;
    const [event] = await tx.select().from(slackVerifiedIngressEvents).where(and(
      eq(slackVerifiedIngressEvents.id, eventId),
      eq(slackVerifiedIngressEvents.partitionId, partition.id),
    )).limit(1).for("update");
    const checkedAt = new Date(clock().getTime());
    if (!Number.isFinite(checkedAt.getTime()) || retryAt < checkedAt) throw new Error("Invalid Slack ingress deferral");
    if (!event || event.state !== "processing" || event.leaseOwner !== leaseOwner
      || event.leaseGeneration !== leaseGeneration
      || !event.leaseExpiresAt || event.leaseExpiresAt <= checkedAt) return false;
    await tx.update(slackVerifiedIngressEvents).set({
      state: "queued", leaseOwner: null, leaseExpiresAt: null,
      nextAttemptAt: retryAt, outcomeReason: reason, updatedAt: checkedAt,
    }).where(eq(slackVerifiedIngressEvents.id, event.id));
    return true;
  } });
}

class SlackVerifiedIngressLeaseLost extends Error {}

/**
 * Link a normalized event under the same transaction as the raw head. The
 * caller must prepare its sealed payload outside the transaction and supply a
 * DB-only authority revalidation that locks the current destination boundary.
 * The raw ciphertext stays until the normalized event actually completes.
 */
export async function materializeSlackVerifiedIngressClaim(input: {
  db: Database;
  partitionId: string;
  eventId: string;
  leaseOwner: string;
  leaseGeneration: number;
  now: () => Date;
  authority: ExternalInboundRuntimeAuthority;
  normalizedPayloadDigest: string;
  encryptedPayload: string;
  envelopeKeyId: string;
  payloadSchemaVersion: 1 | 2 | 3 | 4;
  orderedActorId?: string;
  payloadExpiresAt: Date;
  validateCurrentAuthority: (tx: DatabaseTransaction, authority: ExternalInboundRuntimeAuthority, at: Date) => Promise<boolean>;
  finalizeCurrentAuthority?: (tx: DatabaseTransaction, receivedAt: Date, at: Date) => Promise<boolean>;
}): Promise<boolean | "author_wait"> {
  const { db, partitionId, eventId, leaseOwner, leaseGeneration, now, validateCurrentAuthority,
    normalizedPayloadDigest, encryptedPayload, envelopeKeyId, payloadSchemaVersion } = input;
  const authority = { ...input.authority };
  const payloadExpiresAt = new Date(input.payloadExpiresAt.getTime());
  try {
    return await withSlackIngressProtocol({ db, purpose: "settle", run: async (tx) => {
      // Take the pair-existence lock before the partition and before the
      // authority callback can lock an install or binding row. The partition
      // identity is checked below before any normalized event is written.
      if (authority.provider !== "slack" || !authority.providerConversationId) {
        throw new Error("Slack ingress normalized authority mismatch");
      }
      await lockSlackConversations(tx, [{
        registrationId: authority.appRegistrationId,
        providerAuthorityId: authority.providerAuthorityId,
        providerConversationId: authority.providerConversationId,
      }]);
      // The callback locks install, binding, registration and grant in the
      // established order. Do this before the partition: receipt admission
      // also needs those authority rows before its partition lock.
      const authorityCheckedAt = new Date(now().getTime());
      if (!Number.isFinite(authorityCheckedAt.getTime())
        || !await validateCurrentAuthority(tx, authority, authorityCheckedAt)) return false;
      const [partition] = await tx.select().from(slackVerifiedIngressPartitions)
        .where(eq(slackVerifiedIngressPartitions.id, partitionId)).limit(1).for("update");
      if (!partition) return false;
      const [earliest] = await tx.select({ id: slackVerifiedIngressEvents.id }).from(slackVerifiedIngressEvents).where(and(
        eq(slackVerifiedIngressEvents.partitionId, partition.id),
        inArray(slackVerifiedIngressEvents.state, ["queued", "processing", "materialized"]),
      )).orderBy(asc(slackVerifiedIngressEvents.position)).limit(1);
      if (!earliest || earliest.id !== eventId) return false;
      const [head] = await tx.select().from(slackVerifiedIngressEvents).where(and(
        eq(slackVerifiedIngressEvents.id, eventId), eq(slackVerifiedIngressEvents.partitionId, partition.id),
      )).limit(1).for("update");
      const checkedAt = new Date(now().getTime());
      if (!Number.isFinite(checkedAt.getTime()) || !head || head.state !== "processing"
        || head.leaseOwner !== leaseOwner || head.leaseGeneration !== leaseGeneration
        || !head.leaseExpiresAt || head.leaseExpiresAt <= checkedAt) return false;
      if (partition.partitionKind !== "conversation" || authority.provider !== "slack"
        || authority.appRegistrationId !== head.appRegistrationId || authority.environment !== partition.environment
        || authority.providerAuthorityId !== partition.providerAuthorityId
        || authority.workspaceId !== partition.providerAuthorityId
        || authority.providerConversationId !== partition.providerConversationId) {
        throw new Error("Slack ingress normalized authority mismatch");
      }
      // Check the decrypted author under the partition lock both before and
      // after a wake signal. Other authors remain free to make progress.
      if (input.orderedActorId) {
        const [olderSameAuthor] = await tx.select({ id: slackVerifiedIngressEvents.id, reason: slackVerifiedIngressEvents.outcomeReason }).from(slackVerifiedIngressEvents).where(and(
          eq(slackVerifiedIngressEvents.partitionId, partition.id), eq(slackVerifiedIngressEvents.state, "held"),
          inArray(slackVerifiedIngressEvents.outcomeReason, ["actor_identity_pending", "bot_outbound_pending", "bot_sync_disabled"]), sql`${slackVerifiedIngressEvents.position} < ${head.position}`,
          eq(slackVerifiedIngressEvents.pendingAuthorBindingId, authority.bindingId),
          eq(slackVerifiedIngressEvents.pendingAuthorInstallId, authority.installId),
          eq(slackVerifiedIngressEvents.pendingAuthorWorkspaceId, authority.workspaceId),
          eq(slackVerifiedIngressEvents.pendingAuthorActorId, input.orderedActorId),
        )).orderBy(asc(slackVerifiedIngressEvents.position)).limit(1);
        if (olderSameAuthor) {
          // Do not leave this receipt as the active head: another author in
          // the same conversation must be able to proceed while it waits.
          const holdReason = olderSameAuthor.reason === "bot_outbound_pending" || olderSameAuthor.reason === "bot_sync_disabled"
            ? olderSameAuthor.reason : "actor_identity_pending";
          const preserveBotPending = head.lastIsolationReason === "bot_outbound_pending" && head.lastIsolatedAt
            && (holdReason === "bot_outbound_pending" || holdReason === "bot_sync_disabled");
          await tx.update(slackVerifiedIngressEvents).set({ state: "held", parseFailureCount: 3, outcomeReason: holdReason,
            lastIsolationReason: preserveBotPending ? head.lastIsolationReason : holdReason,
            lastIsolatedAt: preserveBotPending ? head.lastIsolatedAt : checkedAt, heldAt: checkedAt,
            pendingAuthorBindingId: authority.bindingId, pendingAuthorInstallId: authority.installId,
            pendingAuthorWorkspaceId: authority.workspaceId, pendingAuthorActorId: input.orderedActorId,
            firstParseFailureAt: head.firstParseFailureAt ?? checkedAt,
            nextAttemptAt: new Date(checkedAt.getTime() + (holdReason === "bot_sync_disabled"
              ? 60_000 : pendingAuthorBackoffMs(head.receivedAt, checkedAt))), leaseOwner: null, leaseExpiresAt: null,
            updatedAt: checkedAt }).where(eq(slackVerifiedIngressEvents.id, head.id));
          return "author_wait";
        }
      }
      if (input.finalizeCurrentAuthority && !await input.finalizeCurrentAuthority(tx, head.receivedAt, checkedAt)) {
        throw new SlackVerifiedIngressLeaseLost();
      }
      // A previously isolated payload-invalid row must be rebuilt from the
      // retained raw ciphertext, not accepted as a normal duplicate. Lock the
      // exact prior row and refuse replacement if any side effect references
      // it; the row lock also excludes concurrent FK insertions.
      const [prior] = await tx.select().from(externalInboundEvents).where(and(
        eq(externalInboundEvents.provider, "slack"),
        eq(externalInboundEvents.appRegistrationId, head.appRegistrationId),
        eq(externalInboundEvents.providerEventId, head.providerEventId),
      )).limit(1).for("update");
      let recovered: typeof externalInboundEvents.$inferSelect | null = null;
      if (prior?.status === "quarantined" && prior.outcomeReason === "isolated_normalization_failure") {
        if (!/^[0-9a-f]{64}$/u.test(normalizedPayloadDigest) || !encryptedPayload.trim()
          || encryptedPayload.length > 1_000_000 || !envelopeKeyId.trim() || envelopeKeyId.length > 320
          || ![1, 2, 3, 4].includes(payloadSchemaVersion) || !Number.isFinite(payloadExpiresAt.getTime())
          || payloadExpiresAt <= head.receivedAt) throw new Error("Invalid Slack isolated recovery payload");
        if ((head.parseFailureCount === 0 && head.replayCount === 0)
          || prior.id !== head.lastIsolatedNormalizedId || prior.normalizedPayloadDigest !== head.lastIsolatedNormalizedDigest
          || prior.environment !== partition.environment || prior.providerAuthorityId !== partition.providerAuthorityId
          || prior.providerConversationId !== partition.providerConversationId || prior.raftChannelId !== authority.raftChannelId
          || prior.committedMessageId !== null) {
          throw new Error("Slack isolated normalized identity mismatch");
        }
        const [reaction] = await tx.select({ id: externalReactionFacts.id }).from(externalReactionFacts)
          .where(eq(externalReactionFacts.inboundEventId, prior.id)).limit(1);
        const [attachment] = await tx.select({ id: externalAttachmentMessageFacts.id }).from(externalAttachmentMessageFacts)
          .where(eq(externalAttachmentMessageFacts.inboundEventId, prior.id)).limit(1);
        if (reaction || attachment) throw new Error("Slack isolated normalized event has side effects");
        // The writer fence deliberately prohibits deleting unresolved rows.
        // Restore this exact identity instead, under the same transaction and
        // after current authority and absence of side effects are established.
        const [restored] = await tx.update(externalInboundEvents).set({
          installId: authority.installId, workspaceId: authority.workspaceId,
          bindingId: authority.bindingId, bindingEpoch: authority.bindingEpoch,
          connectionEpoch: authority.connectionEpoch, runtimeRevision: authority.runtimeRevision,
          privacyClass: authority.privacyClass, normalizedPayloadDigest, encryptedPayload, envelopeKeyId,
          payloadSchemaVersion, payloadExpiresAt, payloadErasedAt: null, payloadTombstoneDigest: null,
          status: "queued", outcomeReason: null, leaseOwner: null, leaseExpiresAt: null,
          updatedAt: checkedAt,
        }).where(eq(externalInboundEvents.id, prior.id)).returning();
        if (!restored) throw new Error("Slack isolated normalized event disappeared");
        recovered = restored;
      }
      const normalized = recovered ? { event: recovered, duplicate: false } : await enqueueExternalInboundEvent({
        db: tx, authority, providerEventId: head.providerEventId, normalizedPayloadDigest,
        encryptedPayload, envelopeKeyId, payloadSchemaVersion, payloadExpiresAt, receivedAt: head.receivedAt,
      });
      if (!["queued", "processing", "committed", "duplicate", "echo"].includes(normalized.event.status)) {
        throw new Error("Slack ingress normalized event needs recovery");
      }
      const committedAt = new Date(now().getTime());
      if (!Number.isFinite(committedAt.getTime()) || head.leaseExpiresAt <= committedAt) {
        throw new SlackVerifiedIngressLeaseLost();
      }
      await tx.update(slackVerifiedIngressEvents).set({
        state: "materialized", materializedInboundEventId: normalized.event.id,
        normalizationSource: "verified_raw",
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: committedAt,
        outcomeReason: "normalized_pending", updatedAt: committedAt,
      }).where(eq(slackVerifiedIngressEvents.id, head.id));
      return true;
    } });
  } catch (error) {
    if (error instanceof SlackVerifiedIngressLeaseLost) return false;
    throw error;
  }
}

/**
 * Finish a claimed raw receipt only after a transaction-local, authoritative
 * proof that no current or recoverable pair exists, or the destination was
 * deleted. The caller supplies a transaction-local verifier; the stable
 * conversation lock is acquired here before any related rows. A failed or
 * incomplete query is not proof, and revoked history remains recoverable.
 * No runtime caller may use this until that verifier is implemented and wired.
 */
export async function discardSlackVerifiedIngressClaim(input: {
  db: Database;
  partitionId: string;
  eventId: string;
  leaseOwner: string;
  leaseGeneration: number;
  now: () => Date;
  reason: "no_recoverable_pair" | "destination_deleted";
  proveDefinitiveAbsence: (tx: DatabaseTransaction, partition: typeof slackVerifiedIngressPartitions.$inferSelect,
    reason: "no_recoverable_pair" | "destination_deleted", at: Date,
    event: typeof slackVerifiedIngressEvents.$inferSelect) => Promise<boolean>;
}): Promise<boolean> {
  const { db, partitionId, eventId, leaseOwner, leaseGeneration, reason, now, proveDefinitiveAbsence } = input;
  if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration <= 0
    || !leaseOwner.trim() || Buffer.byteLength(leaseOwner, "utf8") > 160 || /[\r\n\0]/u.test(leaseOwner)
    || (reason !== "no_recoverable_pair" && reason !== "destination_deleted")) {
    throw new Error("Invalid Slack ingress discard claim");
  }
  // Discover the immutable coordinates without locking a row first. All
  // writers of pair existence must acquire this same advisory lock before
  // their install/binding rows; reversing that order can deadlock a proof
  // against a concurrent pair creation. Re-read and compare under row lock
  // after acquiring it: a missing or changed partition is not proof.
  const [observed] = await db.select({
    appRegistrationId: slackVerifiedIngressPartitions.appRegistrationId,
    environment: slackVerifiedIngressPartitions.environment,
    providerAuthorityId: slackVerifiedIngressPartitions.providerAuthorityId,
    providerConversationId: slackVerifiedIngressPartitions.providerConversationId,
    partitionKind: slackVerifiedIngressPartitions.partitionKind,
  }).from(slackVerifiedIngressPartitions).where(eq(slackVerifiedIngressPartitions.id, partitionId)).limit(1);
  if (!observed || observed.partitionKind !== "conversation") return false;
  try {
    return await withSlackIngressProtocol({ db, purpose: "settle", run: async (tx) => {
      await lockSlackConversations(tx, [{
        registrationId: observed.appRegistrationId,
        providerAuthorityId: observed.providerAuthorityId,
        providerConversationId: observed.providerConversationId,
      }]);
      const [partition] = await tx.select().from(slackVerifiedIngressPartitions)
        .where(eq(slackVerifiedIngressPartitions.id, partitionId)).limit(1).for("update");
      if (!partition || partition.partitionKind !== "conversation"
        || partition.appRegistrationId !== observed.appRegistrationId
        || partition.environment !== observed.environment
        || partition.providerAuthorityId !== observed.providerAuthorityId
        || partition.providerConversationId !== observed.providerConversationId) return false;
      const [head] = await tx.select().from(slackVerifiedIngressEvents).where(and(
        eq(slackVerifiedIngressEvents.partitionId, partition.id),
        inArray(slackVerifiedIngressEvents.state, ["queued", "processing", "materialized"]),
      )).orderBy(asc(slackVerifiedIngressEvents.position)).limit(1).for("update");
      const checkedAt = new Date(now().getTime());
      if (!Number.isFinite(checkedAt.getTime()) || !head || head.id !== eventId || head.state !== "processing"
        || head.leaseOwner !== leaseOwner || head.leaseGeneration !== leaseGeneration
        || !head.leaseExpiresAt || head.leaseExpiresAt <= checkedAt) return false;
      if (!await proveDefinitiveAbsence(tx, partition, reason, checkedAt, head)) return false;
      const settledAt = new Date(now().getTime());
      if (!Number.isFinite(settledAt.getTime()) || head.leaseExpiresAt <= settledAt) {
        throw new SlackVerifiedIngressLeaseLost();
      }
      await tx.update(slackVerifiedIngressEvents).set({
        state: "discarded", outcomeReason: reason, encryptedPayload: null, envelopeKeyId: null,
        leaseOwner: null, leaseExpiresAt: null, updatedAt: settledAt,
      }).where(eq(slackVerifiedIngressEvents.id, head.id));
      return true;
    } });
  } catch (error) {
    if (error instanceof SlackVerifiedIngressLeaseLost) return false;
    throw error;
  }
}

/** Settle a known unsupported signed payload under its original live lease. */
export async function discardClassifiedSlackIngressClaim(input: {
  db: Database; partitionId: string; eventId: string; rawDigest: string; leaseOwner: string;
  leaseGeneration: number; now: () => Date;
  reason: "provider_loop_suppressed" | "provider_self_echo" | "provider_bot_sync_disabled" | "unsupported_message_subtype" | "unsupported_event" | "reaction_author_unavailable" | "edit_author_unavailable";
  validate?: (tx: DatabaseTransaction, receivedAt: Date, at: Date) => Promise<boolean>;
}): Promise<boolean> {
  if (!input.leaseOwner.trim() || !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0
    || !/^[0-9a-f]{64}$/u.test(input.rawDigest)
    || !["provider_loop_suppressed", "provider_self_echo", "provider_bot_sync_disabled", "unsupported_message_subtype", "unsupported_event", "reaction_author_unavailable", "edit_author_unavailable"].includes(input.reason)
    || ((input.reason === "reaction_author_unavailable" || input.reason === "edit_author_unavailable" || input.reason === "provider_bot_sync_disabled") && !input.validate)) {
    throw new Error("Invalid classified Slack discard");
  }
  const [observed] = await input.db.select({ partition: slackVerifiedIngressPartitions, event: slackVerifiedIngressEvents })
    .from(slackVerifiedIngressEvents).innerJoin(slackVerifiedIngressPartitions,
      eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId))
    .where(and(eq(slackVerifiedIngressEvents.id, input.eventId), eq(slackVerifiedIngressEvents.partitionId, input.partitionId))).limit(1);
  if (!observed) return false;
  return withSlackIngressProtocol({ db: input.db, purpose: "settle", run: async tx => {
    if (input.validate) {
      if (observed.partition.partitionKind !== "conversation") return false;
      await lockSlackConversations(tx, [{ registrationId: observed.partition.appRegistrationId,
        providerAuthorityId: observed.partition.providerAuthorityId,
        providerConversationId: observed.partition.providerConversationId }]);
      if (!await input.validate(tx, observed.event.receivedAt, input.now())) return false;
    }
    const [partition] = await tx.select().from(slackVerifiedIngressPartitions)
      .where(eq(slackVerifiedIngressPartitions.id, input.partitionId)).limit(1).for("update");
    if (!partition || partition.appRegistrationId !== observed.partition.appRegistrationId
      || partition.environment !== observed.partition.environment || partition.partitionKind !== observed.partition.partitionKind
      || partition.providerAuthorityId !== observed.partition.providerAuthorityId
      || partition.providerConversationId !== observed.partition.providerConversationId) return false;
    const [head] = await tx.select().from(slackVerifiedIngressEvents).where(and(
      eq(slackVerifiedIngressEvents.partitionId, partition.id),
      inArray(slackVerifiedIngressEvents.state, ["queued", "processing", "materialized"]),
    )).orderBy(asc(slackVerifiedIngressEvents.position)).limit(1).for("update");
    const at = input.now();
    if (!Number.isFinite(at.getTime()) || !head || head.id !== input.eventId || head.rawDigest !== input.rawDigest
      || head.state !== "processing" || head.leaseOwner !== input.leaseOwner
      || head.leaseGeneration !== input.leaseGeneration || !head.leaseExpiresAt || head.leaseExpiresAt <= at
      || head.receivedAt.getTime() !== observed.event.receivedAt.getTime()) return false;
    const settledAt = input.now();
    if (!Number.isFinite(settledAt.getTime()) || head.leaseExpiresAt <= settledAt) return false;
    await tx.update(slackVerifiedIngressEvents).set({ state: "discarded", outcomeReason: input.reason,
      encryptedPayload: null, envelopeKeyId: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: settledAt })
      .where(eq(slackVerifiedIngressEvents.id, head.id));
    return true;
  } });
}

/** Match unresolved-author retry cadence without letting older bot receipts
 * monopolize the worker. Uses receipt age, not provider-supplied time. */
function pendingAuthorBackoffMs(receivedAt: Date, at: Date): number {
  const age = Math.max(0, at.getTime() - receivedAt.getTime());
  return Math.min(30 * 60_000, Math.max(60_000, Math.floor(age / 2)));
}

const MAX_SLACK_PARSE_FAILURES = 3;
export type SlackUnrecognizedEventReason = "unsupported_event_format" | "invalid_event_shape" | "bot_identity_pending" | "bot_outbound_pending" | "actor_identity_pending" | "verified_payload_invalid";

/**
 * Retry a single unrecognized event a bounded number of times. When its own
 * format remains unprocessable, preserve its ciphertext off the active queue:
 * the following messages can then progress. Authority and channel failures
 * must use the ordinary FIFO deferral, never this path.
 */
export async function deferUnrecognizedSlackIngressClaim(input: {
  db: Database;
  partitionId: string;
  eventId: string;
  leaseOwner: string;
  leaseGeneration: number;
  now: () => Date;
  retryAt: Date;
  reason: SlackUnrecognizedEventReason;
  immediate?: boolean;
  authorHoldUntil?: Date;
  pendingAuthor?: { installId: string; workspaceId: string; bindingId: string; actorId: string };
  validatePendingAuthor?: (tx: DatabaseTransaction, at: Date) => Promise<boolean>;
}): Promise<"retry" | "held" | "quarantined" | "lease_lost"> {
  const { db, partitionId, eventId, leaseOwner, leaseGeneration, reason, now } = input;
  if (!leaseOwner.trim() || Buffer.byteLength(leaseOwner, "utf8") > 160 || /[\r\n\0]/u.test(leaseOwner)
    || !Number.isSafeInteger(leaseGeneration) || leaseGeneration <= 0
    || (reason !== "unsupported_event_format" && reason !== "invalid_event_shape"
      && reason !== "bot_identity_pending" && reason !== "bot_outbound_pending" && reason !== "actor_identity_pending" && reason !== "verified_payload_invalid")) {
    throw new Error("Invalid Slack unrecognized event claim");
  }
  const retryAt = new Date(input.retryAt.getTime());
  const pending = input.pendingAuthor;
  if (input.authorHoldUntil && (reason !== "actor_identity_pending" || !input.immediate || !pending
    || !Number.isFinite(input.authorHoldUntil.getTime()))) throw new Error("Invalid Slack author hold deadline");
  if (pending && ((reason !== "actor_identity_pending" && reason !== "bot_outbound_pending") || !input.validatePendingAuthor
    || [pending.installId, pending.bindingId, pending.workspaceId, pending.actorId].some(value =>
      !value.trim() || /[\r\n\0]/u.test(value) || Buffer.byteLength(value, "utf8") > 160))) {
    throw new Error("Invalid Slack pending author identity");
  }
  if ((!pending && input.validatePendingAuthor) || ((reason === "actor_identity_pending" || reason === "bot_outbound_pending") && !pending)) {
    throw new Error("Invalid Slack pending author identity");
  }
  const [observed] = pending ? await db.select().from(slackVerifiedIngressPartitions)
    .where(eq(slackVerifiedIngressPartitions.id, partitionId)).limit(1) : [];
  if (pending && (!observed || observed.partitionKind !== "conversation" || observed.providerAuthorityId !== pending.workspaceId)) return "lease_lost";
  return withSlackIngressProtocol({ db, purpose: "settle", run: async (tx) => {
    if (pending && observed) {
      await lockSlackConversations(tx, [{ registrationId: observed.appRegistrationId,
        providerAuthorityId: observed.providerAuthorityId, providerConversationId: observed.providerConversationId }]);
      if (!await input.validatePendingAuthor!(tx, now())) return "lease_lost";
    }
    const [partition] = await tx.select({ id: slackVerifiedIngressPartitions.id,
      appRegistrationId: slackVerifiedIngressPartitions.appRegistrationId, environment: slackVerifiedIngressPartitions.environment,
      providerAuthorityId: slackVerifiedIngressPartitions.providerAuthorityId,
      providerConversationId: slackVerifiedIngressPartitions.providerConversationId }).from(slackVerifiedIngressPartitions)
      .where(eq(slackVerifiedIngressPartitions.id, partitionId)).limit(1).for("update");
    if (!partition || (observed && (partition.appRegistrationId !== observed.appRegistrationId
      || partition.environment !== observed.environment || partition.providerAuthorityId !== observed.providerAuthorityId
      || partition.providerConversationId !== observed.providerConversationId))) return "lease_lost";
    const [head] = await tx.select().from(slackVerifiedIngressEvents).where(and(
      eq(slackVerifiedIngressEvents.partitionId, partition.id),
      inArray(slackVerifiedIngressEvents.state, ["queued", "processing", "materialized"]),
    )).orderBy(asc(slackVerifiedIngressEvents.position)).limit(1).for("update");
    const at = new Date(now().getTime());
    if (!Number.isFinite(at.getTime()) || !Number.isFinite(retryAt.getTime()) || retryAt < at) {
      throw new Error("Invalid Slack unrecognized event retry time");
    }
    if (!head || head.id !== eventId || head.state !== "processing" || head.leaseOwner !== leaseOwner
      || head.leaseGeneration !== leaseGeneration || !head.leaseExpiresAt || head.leaseExpiresAt <= at) return "lease_lost";
    if (input.authorHoldUntil && input.authorHoldUntil.getTime() !== head.receivedAt.getTime() + SLACK_REPEAT_FALLBACK_WAIT_MS) {
      throw new Error("Invalid Slack author hold deadline");
    }
    const failures = input.immediate ? MAX_SLACK_PARSE_FAILURES : head.parseFailureCount + 1;
    if (failures > MAX_SLACK_PARSE_FAILURES) throw new Error("Invalid Slack parse failure count");
    const held = failures === MAX_SLACK_PARSE_FAILURES;
    const state = held ? (reason === "verified_payload_invalid" || reason === "invalid_event_shape" ? "quarantined" : "held") : "queued";
    const deadline = head.receivedAt.getTime() + 24 * 60 * 60_000;
    const authorBackoff = pendingAuthorBackoffMs(head.receivedAt, at);
    const nextAttemptAt = held && reason === "bot_outbound_pending"
      ? new Date(at.getTime() + authorBackoff)
      : held && input.authorHoldUntil
      ? new Date(Math.max(at.getTime(), input.authorHoldUntil.getTime()))
      : held && reason === "actor_identity_pending"
      ? new Date(deadline > at.getTime() ? Math.min(at.getTime() + authorBackoff, deadline) : at.getTime() + authorBackoff) : retryAt;
    // Preserve when this event first waited for an uncertain outbound send;
    // later retries must not erase the evidence needed to record an operator skip.
    const preserveBotPending = head.lastIsolationReason === "bot_outbound_pending" && head.lastIsolatedAt
      && reason === "bot_outbound_pending";
    await tx.update(slackVerifiedIngressEvents).set({ state, parseFailureCount: failures,
      ...(pending ? { pendingAuthorInstallId: pending.installId, pendingAuthorWorkspaceId: pending.workspaceId,
        pendingAuthorBindingId: pending.bindingId, pendingAuthorActorId: pending.actorId } : {}),
      firstParseFailureAt: head.firstParseFailureAt ?? at, heldAt: held ? at : null,
      ...(held ? { lastIsolationReason: preserveBotPending ? head.lastIsolationReason : reason,
        lastIsolatedAt: preserveBotPending ? head.lastIsolatedAt : at } : {}), outcomeReason: reason, nextAttemptAt,
      leaseOwner: null, leaseExpiresAt: null, updatedAt: at }).where(eq(slackVerifiedIngressEvents.id, head.id));
    return held ? state as "held" | "quarantined" : "retry";
  } });
}

/** Restore one due unresolved author at its original position. */
export async function requeueDueSlackActor(input: {
  db: Database; registrationId: string; environment: "test" | "production"; now: Date;
}): Promise<boolean> {
  if (!Number.isFinite(input.now.getTime())) throw new Error("Invalid Slack author retry time");
  return withSlackIngressProtocol({ db: input.db, purpose: "settle", run: async tx => {
    const [partition] = await tx.select().from(slackVerifiedIngressPartitions).where(and(
      eq(slackVerifiedIngressPartitions.appRegistrationId, input.registrationId),
      eq(slackVerifiedIngressPartitions.environment, input.environment), sql`EXISTS (
        SELECT 1 FROM slack_verified_ingress_events e WHERE e.partition_id = ${slackVerifiedIngressPartitions.id}
        AND e.state = 'held' AND e.outcome_reason IN ('actor_identity_pending', 'bot_outbound_pending', 'bot_sync_disabled') AND (e.next_attempt_at <= ${input.now}
          OR EXISTS (SELECT 1 FROM slack_ingress_author_wake_signals s WHERE s.registration_id = e.app_registration_id
            AND s.binding_id = e.pending_author_binding_id AND s.install_id = e.pending_author_install_id
            AND s.workspace_id = e.pending_author_workspace_id AND s.actor_id = e.pending_author_actor_id
            AND e.held_at < s.signaled_at))
      )`,
    )).orderBy(asc(slackVerifiedIngressPartitions.updatedAt), asc(slackVerifiedIngressPartitions.id))
      .limit(1).for("update", { skipLocked: true });
    if (!partition) return false;
    const [event] = await tx.select().from(slackVerifiedIngressEvents).where(and(
      eq(slackVerifiedIngressEvents.partitionId, partition.id), eq(slackVerifiedIngressEvents.state, "held"),
      inArray(slackVerifiedIngressEvents.outcomeReason, ["actor_identity_pending", "bot_outbound_pending", "bot_sync_disabled"]),
      sql`(${slackVerifiedIngressEvents.nextAttemptAt} <= ${input.now} OR EXISTS (
        SELECT 1 FROM slack_ingress_author_wake_signals s WHERE s.registration_id = ${slackVerifiedIngressEvents.appRegistrationId}
          AND s.binding_id = ${slackVerifiedIngressEvents.pendingAuthorBindingId} AND s.install_id = ${slackVerifiedIngressEvents.pendingAuthorInstallId}
          AND s.workspace_id = ${slackVerifiedIngressEvents.pendingAuthorWorkspaceId} AND s.actor_id = ${slackVerifiedIngressEvents.pendingAuthorActorId}
          AND ${slackVerifiedIngressEvents.heldAt} < s.signaled_at))`,
    )).orderBy(asc(slackVerifiedIngressEvents.position), asc(slackVerifiedIngressEvents.id)).limit(1).for("update");
    if (!event) return false;
    // Automatic author retries retain their original reserved position. Manual
    // operator replay is a separate, explicitly audited tail operation.
    await tx.update(slackVerifiedIngressPartitions).set({ updatedAt: input.now })
      .where(eq(slackVerifiedIngressPartitions.id, partition.id));
    await tx.update(slackVerifiedIngressEvents).set({ state: "queued", parseFailureCount: 0,
      firstParseFailureAt: null, heldAt: null, outcomeReason: null, nextAttemptAt: input.now, updatedAt: input.now })
      .where(eq(slackVerifiedIngressEvents.id, event.id));
    return true;
  } });
}

/** Reinsert a held receipt at the tail once an authorized operator chooses to replay it. */
export async function replayHeldSlackIngress(input: {
  db: Database;
  partitionId: string;
  eventId?: string;
  /** Batch selection is bounded to one event per transaction and reason. */
  reason?: string;
  excludeEventIds?: readonly string[];
  now: () => Date;
  /** Revalidate and lock the requesting manager after the conversation key. */
  lockRequester?: (tx: DatabaseTransaction) => Promise<void>;
  authorize: (tx: DatabaseTransaction, partition: typeof slackVerifiedIngressPartitions.$inferSelect,
    event: typeof slackVerifiedIngressEvents.$inferSelect, at: Date) => Promise<{ kind: "human" | "system"; id: string } | null>;
}): Promise<boolean> {
  const { db, partitionId, eventId, reason, now, authorize } = input;
  if ((eventId === undefined) === (reason === undefined)
    || (reason !== undefined && !/^[a-z][a-z0-9_]{0,159}$/u.test(reason))) {
    throw new Error("Invalid Slack ingress replay selector");
  }
  // The authorizer can lock current install/binding rows. Obtain the same
  // stable conversation lock as all pair writers before any row locks.
  const [observed] = await db.select().from(slackVerifiedIngressPartitions)
    .where(eq(slackVerifiedIngressPartitions.id, partitionId)).limit(1);
  if (!observed) return false;
  return withSlackIngressProtocol({ db, purpose: "settle", run: async (tx) => {
    if (observed.partitionKind === "conversation") {
      await lockSlackConversations(tx, [{ registrationId: observed.appRegistrationId,
        providerAuthorityId: observed.providerAuthorityId, providerConversationId: observed.providerConversationId }]);
    }
    if (input.lockRequester) await input.lockRequester(tx);
    // Authorizers lock install, binding, registration and grant. They must do
    // so before partition/event rows, as receipt and materialization do.
    const [candidate] = await tx.select().from(slackVerifiedIngressEvents).where(and(
      eq(slackVerifiedIngressEvents.partitionId, observed.id), inArray(slackVerifiedIngressEvents.state, ["held", "quarantined", "review_required"]),
      eventId ? eq(slackVerifiedIngressEvents.id, eventId) : eq(slackVerifiedIngressEvents.outcomeReason, reason!),
      input.excludeEventIds?.length ? notInArray(slackVerifiedIngressEvents.id, [...input.excludeEventIds]) : undefined,
    )).orderBy(asc(slackVerifiedIngressEvents.position), asc(slackVerifiedIngressEvents.id)).limit(1);
    const at = new Date(now().getTime());
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid Slack ingress replay time");
    if (!candidate || !["held", "quarantined", "review_required"].includes(candidate.state)) return false;
    const actor = await authorize(tx, observed, candidate, at);
    if (!actor) return false;
    const [partition] = await tx.select().from(slackVerifiedIngressPartitions)
      .where(eq(slackVerifiedIngressPartitions.id, partitionId)).limit(1).for("update");
    if (!partition || partition.partitionKind !== observed.partitionKind
      || partition.appRegistrationId !== observed.appRegistrationId || partition.environment !== observed.environment
      || partition.providerAuthorityId !== observed.providerAuthorityId
      || partition.providerConversationId !== observed.providerConversationId) return false;
    const [event] = await tx.select().from(slackVerifiedIngressEvents).where(and(
      eq(slackVerifiedIngressEvents.id, candidate.id), eq(slackVerifiedIngressEvents.partitionId, partition.id),
    )).limit(1).for("update");
    if (!event || event.state !== candidate.state || event.position !== candidate.position
      || event.rawDigest !== candidate.rawDigest || event.providerEventId !== candidate.providerEventId
      || event.outcomeReason !== candidate.outcomeReason || event.replayCount !== candidate.replayCount) return false;
    if (event.lastIsolatedNormalizedId) {
      // A terminal normalized row may already have produced a message, a
      // reaction, or attachment facts. Keep it held for operator resolution;
      // requeueing it would either duplicate those effects or strand the FIFO.
      const [prior] = await tx.select().from(externalInboundEvents)
        .where(eq(externalInboundEvents.id, event.lastIsolatedNormalizedId)).limit(1).for("update");
      if (!prior || prior.normalizedPayloadDigest !== event.lastIsolatedNormalizedDigest
        || prior.status !== "quarantined" || prior.outcomeReason !== "isolated_normalization_failure"
        || prior.committedMessageId !== null) return false;
      const [reaction] = await tx.select({ id: externalReactionFacts.id }).from(externalReactionFacts)
        .where(eq(externalReactionFacts.inboundEventId, prior.id)).limit(1);
      const [attachment] = await tx.select({ id: externalAttachmentMessageFacts.id }).from(externalAttachmentMessageFacts)
        .where(eq(externalAttachmentMessageFacts.inboundEventId, prior.id)).limit(1);
      if (reaction || attachment) return false;
    }
    if ((actor.kind !== "human" && actor.kind !== "system") || !actor.id.trim()
      || Buffer.byteLength(actor.id, "utf8") > 160 || /[\r\n\0]/u.test(actor.id)
      || !event.outcomeReason || !/^[a-z][a-z0-9_]{0,159}$/u.test(event.outcomeReason)) {
      throw new Error("Invalid Slack ingress replay audit");
    }
    if (!Number.isSafeInteger(event.replayCount) || event.replayCount >= 2_147_483_647) {
      throw new Error("Slack ingress replay count overflow");
    }
    if (!Number.isSafeInteger(partition.lastPosition) || partition.lastPosition >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Slack ingress partition position overflow");
    }
    const position = partition.lastPosition + 1;
    await tx.insert(slackVerifiedIngressReplayAudits).values({ eventId: event.id, partitionId: partition.id,
      previousPosition: event.position, replayPosition: position, actorKind: actor.kind, actorId: actor.id,
      isolationReason: event.outcomeReason, replayedAt: at });
    await tx.update(slackVerifiedIngressPartitions).set({ lastPosition: position, updatedAt: at })
      .where(eq(slackVerifiedIngressPartitions.id, partition.id));
    await tx.update(slackVerifiedIngressEvents).set({ state: "queued", position, parseFailureCount: 0,
      firstParseFailureAt: null, heldAt: null, outcomeReason: null, nextAttemptAt: at,
      replayCount: sql`${slackVerifiedIngressEvents.replayCount} + 1`, lastReplayedAt: at, updatedAt: at,
    }).where(eq(slackVerifiedIngressEvents.id, event.id));
    return true;
  } });
}

/** Count held parser failures and their oldest first failure for one exact pair. */
export async function readHeldSlackIngressSummary(input: {
  db: Database;
  registrationId: string;
  environment: "test" | "production";
  providerAuthorityId: string;
  providerConversationId: string;
}): Promise<{ count: number; oldestFirstFailureAt: Date | null }> {
  const [result] = await input.db.select({
    count: sql<number>`count(*)::integer`,
    oldest: sql<string | Date | null>`min(${slackVerifiedIngressEvents.firstParseFailureAt})`,
  }).from(slackVerifiedIngressEvents).innerJoin(slackVerifiedIngressPartitions,
    eq(slackVerifiedIngressEvents.partitionId, slackVerifiedIngressPartitions.id)).where(and(
      eq(slackVerifiedIngressPartitions.appRegistrationId, input.registrationId),
      eq(slackVerifiedIngressPartitions.environment, input.environment),
      eq(slackVerifiedIngressPartitions.providerAuthorityId, input.providerAuthorityId),
      eq(slackVerifiedIngressPartitions.partitionKind, "conversation"),
      eq(slackVerifiedIngressPartitions.providerConversationId, input.providerConversationId),
      inArray(slackVerifiedIngressEvents.state, ["held", "quarantined", "review_required"]),
    ));
  const oldest = result?.oldest == null ? null : new Date(result.oldest);
  if (oldest && !Number.isFinite(oldest.getTime())) throw new Error("Invalid Slack held-event timestamp");
  return { count: result?.count ?? 0, oldestFirstFailureAt: oldest };
}

/** Internal operator listing: no ciphertext, sender data or message contents. */
export async function listHeldSlackIngress(input: {
  db: Database;
  partitionId: string;
  limit: number;
}): Promise<{ id: string; reason: string | null; firstFailureAt: Date | null; heldAt: Date | null }[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Invalid Slack held-event listing limit");
  }
  return input.db.select({ id: slackVerifiedIngressEvents.id, reason: slackVerifiedIngressEvents.outcomeReason,
    firstFailureAt: slackVerifiedIngressEvents.firstParseFailureAt, heldAt: slackVerifiedIngressEvents.heldAt })
    .from(slackVerifiedIngressEvents).where(and(
      eq(slackVerifiedIngressEvents.partitionId, input.partitionId), inArray(slackVerifiedIngressEvents.state, ["held", "quarantined", "review_required"]),
    )).orderBy(asc(slackVerifiedIngressEvents.firstParseFailureAt), asc(slackVerifiedIngressEvents.id)).limit(input.limit);
}
