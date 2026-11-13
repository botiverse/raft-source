import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/index";
import { externalAppInstalls, externalAppRegistrations, externalChannelBindings,
  slackVerifiedIngressEvents, slackVerifiedIngressPartitions } from "../db/schema";
import { loadSlackChannelDeletionEvidence } from "./slackChannelDeletionEvidence";

/**
 * The discard transaction must already hold the stable conversation lock.
 * This query is valid only after every old pair writer is fenced: an old
 * binary cannot participate in the new advisory-lock protocol. Any revoked
 * or otherwise inactive binding counts as recoverable and prevents discard.
 */
export async function hasNoRecoverableSlackPair(
  tx: DatabaseTransaction,
  partition: typeof slackVerifiedIngressPartitions.$inferSelect,
  event: typeof slackVerifiedIngressEvents.$inferSelect,
): Promise<boolean> {
  if (partition.partitionKind !== "conversation"
    || event.partitionId !== partition.id
    || event.appRegistrationId !== partition.appRegistrationId) return false;
  const [registration] = await tx.select({ id: externalAppRegistrations.id })
    .from(externalAppRegistrations).where(and(
      eq(externalAppRegistrations.id, partition.appRegistrationId),
      eq(externalAppRegistrations.provider, "slack"),
      eq(externalAppRegistrations.environment, partition.environment),
      eq(externalAppRegistrations.providerAppId, event.providerAppId),
    )).limit(1);
  if (!registration) return false;
  const existing = await tx.select({ id: externalChannelBindings.id })
    .from(externalChannelBindings)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
    .where(and(
      eq(externalChannelBindings.registrationId, registration.id),
      eq(externalAppInstalls.registrationId, registration.id),
      eq(externalAppInstalls.providerAuthorityId, partition.providerAuthorityId),
      eq(externalChannelBindings.providerConversationId, partition.providerConversationId),
    )).limit(1);
  return existing.length === 0;
}

/**
 * Consume the same deletion fact as outbound. Legacy provenance is preserved
 * and never rewritten as a signed receipt. Unknown evidence retains the raw
 * receipt.
 */
export async function hasConfirmedSlackChannelDeletion(
  tx: DatabaseTransaction,
  partition: typeof slackVerifiedIngressPartitions.$inferSelect,
  event: typeof slackVerifiedIngressEvents.$inferSelect,
): Promise<boolean> {
  if (partition.partitionKind !== "conversation" || event.partitionId !== partition.id
    || event.appRegistrationId !== partition.appRegistrationId) return false;
  const proof = await loadSlackChannelDeletionEvidence(tx, {
    registrationId: partition.appRegistrationId,
    environment: partition.environment,
    providerAppId: event.providerAppId,
    providerAuthorityId: partition.providerAuthorityId,
    providerConversationId: partition.providerConversationId,
  });
  return proof !== null;
}

/** The raw-inbox runtime must remain disabled until every pair writer is fenced. */
export async function proveSlackVerifiedIngressDiscard(
  tx: DatabaseTransaction,
  partition: typeof slackVerifiedIngressPartitions.$inferSelect,
  reason: "no_recoverable_pair" | "destination_deleted",
  _at: Date,
  event: typeof slackVerifiedIngressEvents.$inferSelect,
): Promise<boolean> {
  if (reason === "no_recoverable_pair") return hasNoRecoverableSlackPair(tx, partition, event);
  // The Slack-channel fact is the only destination-deletion proof wired here.
  // Raft destination deletion requires its own locked proof before enabling.
  return hasConfirmedSlackChannelDeletion(tx, partition, event);
}
