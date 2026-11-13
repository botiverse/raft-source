import { createHash } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";

import type { DatabaseExecutor } from "../db/index";
import {
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppInstalls,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
} from "../db/schema";

type Binding = Pick<typeof externalChannelBindings.$inferSelect,
  "id" | "installId" | "registrationId" | "connectionEpoch" | "bindingEpoch" | "providerConversationId">;

function digest(label: string, members: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([label, members])).digest("hex");
}

/** Read the snapshot and its member projections at one PostgreSQL statement snapshot. */
export async function currentConversationAuthorityStatus(
  executor: DatabaseExecutor,
  binding: Binding,
  now: Date,
): Promise<"matched" | "mismatch" | "unavailable"> {
  // A refresh publishes projections and the next revision in one transaction.
  // Separate SELECTs can straddle its commit and falsely compare R with R+1.
  // Both privacy classes observe the newest snapshot in this binding epoch.
  const latest = executor.select().from(externalBindingAudienceSnapshots).where(and(
    eq(externalBindingAudienceSnapshots.bindingId, binding.id),
    eq(externalBindingAudienceSnapshots.bindingEpoch, binding.bindingEpoch),
  )).orderBy(desc(externalBindingAudienceSnapshots.audienceRevision)).limit(1).as("latest_audience");

  const observed = await executor.select({
    status: latest.status,
    expiresAt: latest.expiresAt,
    audienceRevision: latest.audienceRevision,
    externalMemberCount: latest.externalMemberCount,
    raftMemberCount: latest.raftMemberCount,
    externalAudienceDigest: latest.externalAudienceDigest,
    raftAudienceDigest: latest.raftAudienceDigest,
    providerAuthorityId: externalAppInstalls.providerAuthorityId,
    projectionId: externalActorProjections.id,
    externalActorId: externalActorProjections.externalActorId,
    actorProvider: externalActorProjections.provider,
    actorRegistrationId: externalActorProjections.appRegistrationId,
    actorInstallId: externalActorProjections.installId,
    actorWorkspaceId: externalActorProjections.workspaceId,
    actorKind: externalActorProjections.actorKind,
    actorState: externalActorProjections.state,
    actorDeactivated: externalActorProjections.deactivated,
    addressProvider: externalAddressabilityProjections.provider,
    addressRegistrationId: externalAddressabilityProjections.appRegistrationId,
    addressInstallId: externalAddressabilityProjections.installId,
    addressWorkspaceId: externalAddressabilityProjections.workspaceId,
    addressConnectionEpoch: externalAddressabilityProjections.connectionEpoch,
    memberRevision: externalAddressabilityProjections.memberRevision,
    contextRevision: externalAddressabilityProjections.contextRevision,
  }).from(latest)
    .innerJoin(externalAppInstalls, and(
      eq(externalAppInstalls.id, binding.installId),
      eq(externalAppInstalls.registrationId, binding.registrationId),
      eq(externalAppInstalls.connectionEpoch, binding.connectionEpoch),
      eq(externalAppInstalls.state, "active"),
    ))
    .leftJoin(externalAddressabilityProjections, and(
      eq(externalAddressabilityProjections.bindingId, binding.id),
      eq(externalAddressabilityProjections.bindingEpoch, binding.bindingEpoch),
      eq(externalAddressabilityProjections.conversationId, binding.providerConversationId),
      eq(externalAddressabilityProjections.state, "active"),
      gt(externalAddressabilityProjections.expiresAt, now),
    ))
    .leftJoin(externalActorProjections,
      eq(externalActorProjections.id, externalAddressabilityProjections.projectionId));
  const snapshot = observed[0];
  if (!snapshot || snapshot.expiresAt <= now || snapshot.status !== "matched") {
    return snapshot?.status === "mismatch" ? "mismatch" : "unavailable";
  }
  // LEFT JOIN keeps a mismatched/empty snapshot observable. Unmatched actor
  // rows are otherwise omitted exactly as by the former inner-join read.
  const rows = observed.filter((row) => row.projectionId !== null);
  const externalActorIds = rows.map((row) => row.externalActorId ?? "").sort();
  const exactAuthority = rows.length > 0
    && rows.length === snapshot.externalMemberCount
    && rows.length === snapshot.raftMemberCount
    && new Set(rows.map((row) => row.projectionId)).size === rows.length
    && new Set(externalActorIds).size === rows.length
    && rows.every((row) =>
      row.externalActorId !== null
      && row.actorProvider === "slack"
      && row.actorRegistrationId === binding.registrationId
      && row.actorInstallId === binding.installId
      && row.actorWorkspaceId === snapshot.providerAuthorityId
      && ["human", "guest", "remote"].includes(row.actorKind ?? "")
      && row.actorState === "active"
      && row.actorDeactivated === false
      && row.addressProvider === "slack"
      && row.addressRegistrationId === binding.registrationId
      && row.addressInstallId === binding.installId
      && row.addressWorkspaceId === row.actorWorkspaceId
      && row.addressConnectionEpoch === binding.connectionEpoch
      && row.memberRevision === snapshot.audienceRevision
      && row.contextRevision === snapshot.audienceRevision)
    && snapshot.externalAudienceDigest === digest("slack-external-audience", externalActorIds)
    && snapshot.raftAudienceDigest === digest("raft-authorized-provider-audience", externalActorIds);
  return exactAuthority ? "matched" : "unavailable";
}
