import { withSlackIngressProtocol } from "./slackVerifiedIngressRollout";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/index";
import {
  externalInboundEvents,
  externalAppInstalls,
  externalChannelBindings,
  slackVerifiedIngressDedupe,
  slackVerifiedIngressEvents,
  slackVerifiedIngressPartitions,
} from "../db/schema";
import { isSlackVerifiedIngressAad, type SlackVerifiedIngressAad } from "./slackVerifiedIngressContracts";
import { CONFIRMED_THREAD_ROOT_MISSING } from "./externalProviderPreparation";
import { isSlackVerifiedIngressEnvelope } from "./slackVerifiedIngressCrypto";
import { lockSlackConversations, SlackInstallLockSetChanged } from "./slackBridgeRowLocks";
import { createHash } from "node:crypto";

export type SlackVerifiedIngressEnqueue =
  | { kind: "receipt"; id: string; duplicate: boolean }
  | { kind: "legacy"; id: string; state: string; outcomeReason: string | null; committedMessageId: string | null };

function logDigestConflict(eventId: string, previousDigest: string, incomingDigest: string): void {
  if (previousDigest === incomingDigest) return;
  // A normal provider event ID is safe to record; hash unexpected shapes so a
  // malformed coordinate cannot smuggle user content into operational logs.
  const safeEventId = /^Ev[A-Za-z0-9]+$/u.test(eventId) ? eventId : createHash("sha256").update(eventId).digest("hex");
  console.warn("[Slack Bridge] signed event digest conflict", { eventId: safeEventId, previousDigest, incomingDigest });
}

/**
 * Persist an already signature-verified and sealed event. This service does not
 * verify Slack signatures. Its caller must keep the writer gate off until no
 * legacy writer can race the cross-table identity check.
 */
export async function enqueueSlackVerifiedIngress(input: {
  db: Database;
  aad: SlackVerifiedIngressAad;
  rawDigest: string;
  encryptedPayload: string;
  envelopeKeyId: string;
  now: Date;
  validateEndpoint: (tx: DatabaseTransaction) => Promise<boolean>;
}): Promise<SlackVerifiedIngressEnqueue> {
  const aad = { ...input.aad };
  const { db, rawDigest, encryptedPayload, envelopeKeyId, validateEndpoint } = input;
  const now = new Date(input.now.getTime());
  if (!isSlackVerifiedIngressAad(aad)
    || !/^[0-9a-f]{64}$/u.test(rawDigest)
    || !isSlackVerifiedIngressEnvelope(encryptedPayload)
    || !envelopeKeyId.trim() || /[\r\n\0]/u.test(envelopeKeyId)
    || Buffer.byteLength(envelopeKeyId, "utf8") > 320
    || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid verified Slack ingress receipt");
  }
  const partitionKind = aad.providerConversationId === null ? "authority" : "conversation";
  const conversationId = aad.providerConversationId ?? "";
  for (let attempt = 0; ; attempt++) {
    try {
      return await withSlackIngressProtocol({ db, purpose: "receive", run: async (tx) => {
    // The receipt does not require an installation or a pair to exist. When
    // they do exist, serialize against lifecycle/OAuth writers before taking
    // endpoint and partition locks. Authority-wide events lock every known
    // conversation; a channel event locks only its own stable coordinate.
    const installs = await tx.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.registrationId, aad.registrationId),
      eq(externalAppInstalls.providerAuthorityId, aad.providerAuthorityId),
    )).orderBy(asc(externalAppInstalls.id));
    const installIds = installs.map((row) => row.id);
    const readBindings = () => installIds.length ? tx.select().from(externalChannelBindings).where(and(
      inArray(externalChannelBindings.installId, installIds),
      aad.providerConversationId === null ? undefined : eq(externalChannelBindings.providerConversationId, aad.providerConversationId),
    )).orderBy(asc(externalChannelBindings.id)) : Promise.resolve([]);
    const bindings = await readBindings();
    const conversationIds = new Set(bindings.map((binding) => binding.providerConversationId));
    if (aad.providerConversationId !== null) conversationIds.add(aad.providerConversationId);
    await lockSlackConversations(tx, [...conversationIds].map((providerConversationId) => ({
      registrationId: aad.registrationId, providerAuthorityId: aad.providerAuthorityId, providerConversationId,
    })));
    const lockedInstalls = installIds.length ? await tx.select().from(externalAppInstalls)
      .where(inArray(externalAppInstalls.id, installIds)).orderBy(asc(externalAppInstalls.id)).for("share") : [];
    const lockedBindings = bindings.length ? await tx.select().from(externalChannelBindings)
      .where(inArray(externalChannelBindings.id, bindings.map((binding) => binding.id)))
      .orderBy(asc(externalChannelBindings.id)).for("update") : [];
    const currentInstalls = await tx.select({ id: externalAppInstalls.id }).from(externalAppInstalls).where(and(
      eq(externalAppInstalls.registrationId, aad.registrationId),
      eq(externalAppInstalls.providerAuthorityId, aad.providerAuthorityId),
    )).orderBy(asc(externalAppInstalls.id));
    const currentBindings = await readBindings();
    if (lockedInstalls.length !== installs.length || lockedInstalls.some((row, index) =>
      row.id !== installs[index]!.id || row.registrationId !== aad.registrationId || row.providerAuthorityId !== aad.providerAuthorityId)
      || currentInstalls.length !== installIds.length || currentInstalls.some((row, index) => row.id !== installIds[index])
      || lockedBindings.length !== bindings.length || currentBindings.length !== bindings.length
      || currentBindings.some((row, index) => row.id !== bindings[index]!.id
        || row.installId !== bindings[index]!.installId || row.providerConversationId !== bindings[index]!.providerConversationId)) {
      throw new SlackInstallLockSetChanged();
    }
    // Hold current endpoint/secret authority until the receipt commits.
    if (!await validateEndpoint(tx)) throw new Error("Slack ingress endpoint authority changed");
    const [compacted] = await tx.select().from(slackVerifiedIngressDedupe).where(and(
      eq(slackVerifiedIngressDedupe.appRegistrationId, aad.registrationId),
      eq(slackVerifiedIngressDedupe.providerEventId, aad.providerEventId),
    )).limit(1);
    if (compacted) {
      logDigestConflict(aad.providerEventId, compacted.rawDigest, rawDigest);
      if (compacted.providerAppId !== aad.providerAppId || compacted.environment !== aad.environment
        || compacted.providerAuthorityId !== aad.providerAuthorityId || compacted.providerConversationId !== conversationId
        || compacted.rawDigest !== rawDigest) throw new Error("Slack ingress compacted identity conflict");
      return { kind: "receipt" as const, id: compacted.id, duplicate: true };
    }
    const [legacy] = await tx.select().from(externalInboundEvents).where(and(
      eq(externalInboundEvents.provider, "slack"),
      eq(externalInboundEvents.appRegistrationId, aad.registrationId),
      eq(externalInboundEvents.providerEventId, aad.providerEventId),
    )).limit(1);
    let failedLegacyId: string | null = null;
    if (legacy) {
      const [raw] = await tx.select({
        id: slackVerifiedIngressEvents.id, state: slackVerifiedIngressEvents.state,
        materializedId: slackVerifiedIngressEvents.materializedInboundEventId,
        lastIsolatedNormalizedId: slackVerifiedIngressEvents.lastIsolatedNormalizedId,
        digest: slackVerifiedIngressEvents.rawDigest, providerAppId: slackVerifiedIngressEvents.providerAppId,
        environment: slackVerifiedIngressPartitions.environment,
        authorityId: slackVerifiedIngressPartitions.providerAuthorityId,
        partitionKind: slackVerifiedIngressPartitions.partitionKind,
        conversationId: slackVerifiedIngressPartitions.providerConversationId,
      }).from(slackVerifiedIngressEvents).innerJoin(slackVerifiedIngressPartitions,
        eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId)).where(and(
        eq(slackVerifiedIngressEvents.appRegistrationId, aad.registrationId),
        eq(slackVerifiedIngressEvents.providerEventId, aad.providerEventId),
      )).limit(1);
      if (legacy.environment !== aad.environment || legacy.providerAuthorityId !== aad.providerAuthorityId
        || legacy.providerConversationId !== aad.providerConversationId) {
        throw new Error("Slack ingress legacy identity conflict");
      }
      if (raw) {
        logDigestConflict(aad.providerEventId, raw.digest, rawDigest);
        const linked = ["materialized", "completed", "discarded"].includes(raw.state) && raw.materializedId === legacy.id;
        // During bounded recovery the corrupt normalized row is still the
        // same event, while its signed raw receipt remains in durable custody.
        // A Slack retry must receive the existing receipt, not a spurious 503.
        const isolated = ["queued", "processing", "held", "quarantined", "review_required"].includes(raw.state)
          && legacy.status === "quarantined" && legacy.outcomeReason === "isolated_normalization_failure"
          && raw.lastIsolatedNormalizedId === legacy.id;
        if ((!linked && !isolated)
          || raw.digest !== rawDigest || raw.providerAppId !== aad.providerAppId
          || raw.environment !== aad.environment || raw.authorityId !== aad.providerAuthorityId
          || raw.partitionKind !== partitionKind || raw.conversationId !== conversationId) {
          throw new Error("Slack ingress cross-version identity conflict");
        }
        return { kind: "receipt" as const, id: raw.id, duplicate: true };
      }
      if (["queued", "processing", "committed", "duplicate", "echo"].includes(legacy.status)
        || (legacy.status === "dead" && legacy.outcomeReason === CONFIRMED_THREAD_ROOT_MISSING)) {
        // A legacy receipt has no raw digest; the caller still classifies its
        // outcome before acknowledging the Slack retry.
        return { kind: "legacy" as const, id: legacy.id, state: legacy.status,
          outcomeReason: legacy.outcomeReason, committedMessageId: legacy.committedMessageId };
      }
      // The old row may already have erased its payload. Keep this authenticated
      // retry until the old outcome has been safely resolved; do not guess that
      // a failed/unknown event was never delivered.
      failedLegacyId = legacy.id;
    }
    await tx.insert(slackVerifiedIngressPartitions).values({
      appRegistrationId: aad.registrationId,
      environment: aad.environment,
      providerAuthorityId: aad.providerAuthorityId,
      partitionKind,
      providerConversationId: conversationId,
      updatedAt: now,
    }).onConflictDoNothing();
    const [partition] = await tx.select().from(slackVerifiedIngressPartitions).where(and(
      eq(slackVerifiedIngressPartitions.appRegistrationId, aad.registrationId),
      eq(slackVerifiedIngressPartitions.environment, aad.environment),
      eq(slackVerifiedIngressPartitions.providerAuthorityId, aad.providerAuthorityId),
      eq(slackVerifiedIngressPartitions.partitionKind, partitionKind),
      eq(slackVerifiedIngressPartitions.providerConversationId, conversationId),
    )).for("update").limit(1);
    if (!partition) throw new Error("Slack ingress partition unavailable");

    const findReceipt = async () => {
      const [existing] = await tx.select({
        id: slackVerifiedIngressEvents.id,
        rawDigest: slackVerifiedIngressEvents.rawDigest,
        providerAppId: slackVerifiedIngressEvents.providerAppId,
        partitionId: slackVerifiedIngressEvents.partitionId,
      }).from(slackVerifiedIngressEvents).where(and(
        eq(slackVerifiedIngressEvents.appRegistrationId, aad.registrationId),
        eq(slackVerifiedIngressEvents.providerEventId, aad.providerEventId),
      )).limit(1);
      if (!existing) return null;
      logDigestConflict(aad.providerEventId, existing.rawDigest, rawDigest);
      if (existing.rawDigest !== rawDigest || existing.providerAppId !== aad.providerAppId
        || existing.partitionId !== partition.id) throw new Error("Slack ingress event identity conflict");
      return { kind: "receipt" as const, id: existing.id, duplicate: true };
    };
    const prior = await findReceipt();
    if (prior) return prior;
    const [advanced] = await tx.update(slackVerifiedIngressPartitions).set({
      lastPosition: sql`${slackVerifiedIngressPartitions.lastPosition} + 1`,
      updatedAt: now,
    }).where(eq(slackVerifiedIngressPartitions.id, partition.id)).returning();
    if (!advanced || !Number.isSafeInteger(advanced.lastPosition) || advanced.lastPosition <= 0) {
      throw new Error("Slack ingress partition position overflow");
    }
    const [created] = await tx.insert(slackVerifiedIngressEvents).values({
      partitionId: partition.id,
      position: advanced.lastPosition,
      appRegistrationId: aad.registrationId,
      providerEventId: aad.providerEventId,
      providerAppId: aad.providerAppId,
      rawDigest,
      encryptedPayload,
      envelopeKeyId,
      state: failedLegacyId ? "materialized" : "queued",
      materializedInboundEventId: failedLegacyId,
      outcomeReason: failedLegacyId ? "legacy_recovery_pending" : null,
      receivedAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    }).onConflictDoNothing({ target: [slackVerifiedIngressEvents.appRegistrationId, slackVerifiedIngressEvents.providerEventId] })
      .returning({ id: slackVerifiedIngressEvents.id });
    if (created) return { kind: "receipt", id: created.id, duplicate: false };
    // A concurrent event under a different partition can race the unique key.
    // Reject it and roll back this partition's allocation rather than choosing
    // an arbitrary conversation for the same provider event ID.
    const concurrent = await findReceipt();
    if (concurrent) return concurrent;
    throw new Error("Slack ingress event identity conflict");
      } });
    } catch (error) {
      if (!(error instanceof SlackInstallLockSetChanged) || attempt >= 2) throw error;
    }
  }
}
