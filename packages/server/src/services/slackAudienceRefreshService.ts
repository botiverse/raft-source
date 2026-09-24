import { and, eq } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  channelHumans,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstalls,
  externalAppRegistrations,
  externalChannelBindings,
  serverMembers,
} from "../db/schema.js";
import {
  listSlackProviderConversationMembers,
  type SlackBridgeCredentialHandle,
  type SlackProviderAuthorityFence,
  type SlackProviderAuthorityQuarantineSink,
  type SlackWebApiTransport,
} from "./slackProviderAdapter.js";
import {
  reconcileSlackPrivateAudience,
  type SlackAudienceObservation,
} from "./slackBindingLifecycleService.js";

const DEFAULT_AUDIENCE_FRESHNESS_MS = 30 * 60_000;

type UnavailableReason = Extract<
  SlackAudienceObservation,
  { kind: "unavailable" }
>["reason"];

interface SlackPrivateAudienceAuthority {
  serverId: string;
  channelId: string;
  bindingId: string;
  registrationId: string;
  installId: string;
  providerAppId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  providerBotUserId: string | null;
  connectionEpoch: number;
  credentialRevision: number;
  bindingEpoch: number;
  audienceRevision: number;
  raftAuthorizedProviderMemberIds: string[];
}

type SlackAudienceAuthorityDecision =
  | { kind: "ready"; authority: SlackPrivateAudienceAuthority }
  | {
      kind: "unavailable";
      authority: Omit<SlackPrivateAudienceAuthority, "raftAuthorizedProviderMemberIds">;
      reason: UnavailableReason;
    }
  | { kind: "not_private" }
  | { kind: "missing" };

export interface SlackAudienceCredentialResolver {
  resolve(input: {
    authority: SlackProviderAuthorityFence;
    now: Date;
  }): Promise<SlackBridgeCredentialHandle | null>;
}

export type SlackAudienceRaftPrincipal = {
  kind: "human";
  id: string;
};

export type SlackAudienceIdentityMapping = SlackAudienceRaftPrincipal & {
  projectionId: string;
};

export interface SlackAudienceIdentityAuthority {
  /**
   * Resolve only from a current, explicit principal-to-provider identity
   * authority. External actor/addressability projections are candidates to
   * validate after this call; they are never Raft membership or identity
   * authority by themselves.
   */
  resolve(input: {
    executor: DatabaseExecutor;
    serverId: string;
    channelId: string;
    bindingId: string;
    registrationId: string;
    installId: string;
    providerAuthorityId: string;
    providerConversationId: string;
    connectionEpoch: number;
    bindingEpoch: number;
    principals: readonly SlackAudienceRaftPrincipal[];
    now: Date;
  }): Promise<
    | { kind: "resolved"; mappings: readonly SlackAudienceIdentityMapping[] }
    | { kind: "unavailable" }
  >;
}

export interface SlackAudienceRefreshDependencies {
  transport: SlackWebApiTransport;
  quarantineSink: SlackProviderAuthorityQuarantineSink;
  credentialResolver: SlackAudienceCredentialResolver;
  identityAuthority: SlackAudienceIdentityAuthority;
  withReadSnapshot?<T>(fn: (executor: DatabaseExecutor) => Promise<T>): Promise<T>;
  now?(): Date;
  freshnessMs?: number;
}

export type SlackAudienceRefreshReceipt =
  | {
      kind: "recorded";
      bindingId: string;
      audienceStatus: "matched" | "mismatch" | "unavailable";
      observedAtMs: number;
      reason?: UnavailableReason;
      revision: number;
    }
  | {
      kind: "skipped_public" | "binding_missing" | "fence_mismatch";
      bindingId: string;
      audienceStatus: "matched" | "unavailable";
      observedAtMs: number;
      reason?: UnavailableReason;
    };

function positiveSafeInteger(value: number | null): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

async function loadSlackPrivateAudienceAuthority(
  bindingId: string,
  now: Date,
  executor: DatabaseExecutor,
  identityAuthority: SlackAudienceIdentityAuthority,
): Promise<SlackAudienceAuthorityDecision> {
  const rows = await executor.select({
    serverId: externalChannelBindings.serverId,
    channelId: externalChannelBindings.channelId,
    bindingId: externalChannelBindings.id,
    registrationId: externalChannelBindings.registrationId,
    installId: externalChannelBindings.installId,
    providerConversationId: externalChannelBindings.providerConversationId,
    privacyClass: externalChannelBindings.privacyClass,
    bindingState: externalChannelBindings.state,
    connectionEpoch: externalChannelBindings.connectionEpoch,
    bindingEpoch: externalChannelBindings.bindingEpoch,
    audienceRevision: externalChannelBindings.audienceRevision,
    registrationState: externalAppRegistrations.state,
    provider: externalAppRegistrations.provider,
    registrationProviderAppId: externalAppRegistrations.providerAppId,
    installState: externalAppInstalls.state,
    installProviderAppId: externalAppInstalls.providerAppId,
    providerAuthorityId: externalAppInstalls.providerAuthorityId,
    providerBotUserId: externalAppInstalls.botUserId,
    installConnectionEpoch: externalAppInstalls.connectionEpoch,
    installCredentialRevision: externalAppInstalls.credentialRevision,
    credentialState: externalAppCredentials.state,
    credentialRevision: externalAppCredentials.credentialRevision,
  }).from(externalChannelBindings)
    .innerJoin(
      externalAppInstalls,
      eq(externalAppInstalls.id, externalChannelBindings.installId),
    )
    .innerJoin(
      externalAppRegistrations,
      eq(externalAppRegistrations.id, externalChannelBindings.registrationId),
    )
    .leftJoin(
      externalAppCredentials,
      eq(externalAppCredentials.installId, externalAppInstalls.id),
    )
    .where(eq(externalChannelBindings.id, bindingId))
    .limit(2);
  if (rows.length !== 1) return { kind: "missing" };
  const row = rows[0]!;
  if (row.privacyClass !== "private") return { kind: "not_private" };
  if (!positiveSafeInteger(row.audienceRevision)) return { kind: "missing" };

  const baseAuthority = {
    serverId: row.serverId,
    channelId: row.channelId,
    bindingId: row.bindingId,
    registrationId: row.registrationId,
    installId: row.installId,
    providerAppId: row.registrationProviderAppId,
    providerAuthorityId: row.providerAuthorityId,
    providerConversationId: row.providerConversationId,
    providerBotUserId: row.providerBotUserId,
    connectionEpoch: row.connectionEpoch,
    credentialRevision: row.installCredentialRevision,
    bindingEpoch: row.bindingEpoch,
    audienceRevision: row.audienceRevision,
  };
  if (row.credentialState === null || row.credentialRevision === null) {
    return {
      kind: "unavailable",
      authority: baseAuthority,
      reason: "credential_unavailable",
    };
  }
  if (
    row.provider !== "slack"
    || row.bindingState !== "active"
    || row.registrationState !== "active"
    || row.installState !== "active"
    || row.credentialState !== "active"
    || row.installProviderAppId !== row.registrationProviderAppId
    || row.installConnectionEpoch !== row.connectionEpoch
    || row.credentialRevision !== row.installCredentialRevision
  ) {
    return {
      kind: "unavailable",
      authority: baseAuthority,
      reason: "authority_quarantined",
    };
  }

  const humanRows = await executor.select({
    id: channelHumans.userId,
  }).from(channelHumans)
    .innerJoin(
      serverMembers,
      and(
        eq(serverMembers.serverId, row.serverId),
        eq(serverMembers.userId, channelHumans.userId),
      ),
    )
    .where(eq(channelHumans.channelId, row.channelId));
  // Product contract A: Slack private-channel audience reconciliation compares
  // only humans with explicit Slack identity links. Raft agents share the app's
  // bot transport identity; channelAgents are deliberately not queried or
  // passed to the identity authority, rather than being excluded accidentally
  // because an agent happens to lack a mapping.
  const principals: SlackAudienceRaftPrincipal[] = [
    ...humanRows.map(({ id }) => ({ kind: "human" as const, id })),
  ].sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  if (principals.length === 0) {
    return {
      kind: "unavailable",
      authority: baseAuthority,
      reason: "identity_mapping_unavailable",
    };
  }

  const identityDecision = await identityAuthority.resolve({
    executor,
    serverId: row.serverId,
    channelId: row.channelId,
    bindingId: row.bindingId,
    registrationId: row.registrationId,
    installId: row.installId,
    providerAuthorityId: row.providerAuthorityId,
    providerConversationId: row.providerConversationId,
    connectionEpoch: row.connectionEpoch,
    bindingEpoch: row.bindingEpoch,
    principals,
    now,
  });
  if (identityDecision.kind !== "resolved") {
    return {
      kind: "unavailable",
      authority: baseAuthority,
      reason: "identity_mapping_unavailable",
    };
  }
  const principalKeys = principals.map((principal) =>
    `${principal.kind}:${principal.id}`);
  const resolvedPrincipalKeys = identityDecision.mappings.map((mapping) =>
    `${mapping.kind}:${mapping.id}`);
  if (
    resolvedPrincipalKeys.length !== principalKeys.length
    || new Set(resolvedPrincipalKeys).size !== resolvedPrincipalKeys.length
    || new Set(identityDecision.mappings.map((mapping) => mapping.projectionId)).size
      !== identityDecision.mappings.length
    || [...resolvedPrincipalKeys].sort().some((key, index) =>
      key !== principalKeys[index])
  ) {
    return {
      kind: "unavailable",
      authority: baseAuthority,
      reason: "identity_mapping_unavailable",
    };
  }

  const mappings = await executor.select({
    projectionId: externalActorProjections.id,
    externalActorId: externalActorProjections.externalActorId,
    actorKind: externalActorProjections.actorKind,
    actorState: externalActorProjections.state,
    actorDeactivated: externalActorProjections.deactivated,
    actorProvider: externalActorProjections.provider,
    actorRegistrationId: externalActorProjections.appRegistrationId,
    actorInstallId: externalActorProjections.installId,
    actorWorkspaceId: externalActorProjections.workspaceId,
    addressState: externalAddressabilityProjections.state,
    addressProvider: externalAddressabilityProjections.provider,
    addressRegistrationId: externalAddressabilityProjections.appRegistrationId,
    addressInstallId: externalAddressabilityProjections.installId,
    addressWorkspaceId: externalAddressabilityProjections.workspaceId,
    addressConnectionEpoch: externalAddressabilityProjections.connectionEpoch,
    addressBindingEpoch: externalAddressabilityProjections.bindingEpoch,
    addressConversationId: externalAddressabilityProjections.conversationId,
    expiresAt: externalAddressabilityProjections.expiresAt,
  }).from(externalAddressabilityProjections)
    .innerJoin(
      externalActorProjections,
      eq(externalActorProjections.id, externalAddressabilityProjections.projectionId),
    )
    .where(and(
      eq(externalAddressabilityProjections.bindingId, row.bindingId),
      eq(externalAddressabilityProjections.connectionEpoch, row.connectionEpoch),
      eq(externalAddressabilityProjections.bindingEpoch, row.bindingEpoch),
      eq(externalAddressabilityProjections.conversationId, row.providerConversationId),
    ));
  const mappingsByProjectionId = new Map(
    mappings.map((mapping) => [mapping.projectionId, mapping]),
  );
  const selectedMappings = identityDecision.mappings.map((mapping) =>
    mappingsByProjectionId.get(mapping.projectionId));
  if (
    mappingsByProjectionId.size !== mappings.length
    || selectedMappings.some((mapping) => !mapping)
    || selectedMappings.some((mapping) =>
      mapping === undefined
      || mapping.actorProvider !== "slack"
      || mapping.actorRegistrationId !== row.registrationId
      || mapping.actorInstallId !== row.installId
      || mapping.actorWorkspaceId !== row.providerAuthorityId
      || mapping.actorState !== "active"
      || mapping.actorDeactivated
      || !["human", "guest", "remote"].includes(mapping.actorKind)
      || mapping.addressProvider !== "slack"
      || mapping.addressRegistrationId !== row.registrationId
      || mapping.addressInstallId !== row.installId
      || mapping.addressWorkspaceId !== row.providerAuthorityId
      || mapping.addressConnectionEpoch !== row.connectionEpoch
      || mapping.addressBindingEpoch !== row.bindingEpoch
      || mapping.addressConversationId !== row.providerConversationId
      || mapping.addressState !== "active"
      || mapping.expiresAt <= now
    )
  ) {
    return {
      kind: "unavailable",
      authority: baseAuthority,
      reason: "identity_mapping_unavailable",
    };
  }
  const raftAuthorizedProviderMemberIds = [
    ...new Set(identityDecision.mappings.map((identityMapping) =>
      mappingsByProjectionId.get(identityMapping.projectionId)!.externalActorId)),
  ].sort();
  if (raftAuthorizedProviderMemberIds.length !== identityDecision.mappings.length) {
    return {
      kind: "unavailable",
      authority: baseAuthority,
      reason: "identity_mapping_unavailable",
    };
  }
  return {
    kind: "ready",
    authority: {
      ...baseAuthority,
      raftAuthorizedProviderMemberIds,
    },
  };
}

function providerFence(
  authority: Omit<SlackPrivateAudienceAuthority, "raftAuthorizedProviderMemberIds">,
): SlackProviderAuthorityFence {
  return {
    installId: authority.installId,
    providerAppId: authority.providerAppId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    connectionEpoch: authority.connectionEpoch,
    credentialRevision: authority.credentialRevision,
    bindingId: authority.bindingId,
    bindingEpoch: authority.bindingEpoch,
  };
}

function unavailableReceipt(input: {
  bindingId: string;
  observedAt: Date;
  kind: "binding_missing" | "fence_mismatch";
  reason: UnavailableReason;
}): SlackAudienceRefreshReceipt {
  return {
    kind: input.kind,
    bindingId: input.bindingId,
    audienceStatus: "unavailable",
    observedAtMs: input.observedAt.getTime(),
    reason: input.reason,
  };
}

/**
 * Composes the audience refresh seam. It reads one exact authority snapshot,
 * performs a complete read-only Slack member enumeration, and then appends a
 * digest-only audience snapshot under the frozen epochs/revision.
 *
 * The caller must supply the production principal-to-provider identity
 * authority. This module deliberately provides no fallback from external
 * projections: without that authority, the only valid result is unavailable.
 */
export function createSlackPrivateAudienceRefresher(
  dependencies: SlackAudienceRefreshDependencies,
): (input: { bindingId: string }) => Promise<SlackAudienceRefreshReceipt> {
  const withReadSnapshot = dependencies.withReadSnapshot
    ?? (<T>(fn: (executor: DatabaseExecutor) => Promise<T>) =>
      getDb().transaction(async (tx) => fn(tx), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      }));
  const freshnessMs = dependencies.freshnessMs ?? DEFAULT_AUDIENCE_FRESHNESS_MS;
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs <= 0) {
    throw new Error("Slack audience freshness must be positive");
  }

  return async ({ bindingId }) => {
    const observedAt = dependencies.now?.() ?? currentDate();
    if (!Number.isFinite(observedAt.getTime())) {
      throw new Error("Slack audience refresh clock is invalid");
    }
    if (!bindingId.trim()) {
      return unavailableReceipt({
        kind: "binding_missing",
        bindingId,
        observedAt,
        reason: "identity_mapping_unavailable",
      });
    }
    const decision = await withReadSnapshot((executor) =>
      loadSlackPrivateAudienceAuthority(
        bindingId,
        observedAt,
        executor,
        dependencies.identityAuthority,
      ));
    if (decision.kind === "missing") {
      return unavailableReceipt({
        kind: "binding_missing",
        bindingId,
        observedAt,
        reason: "identity_mapping_unavailable",
      });
    }
    if (decision.kind === "not_private") {
      return {
        kind: "skipped_public",
        bindingId,
        audienceStatus: "matched",
        observedAtMs: observedAt.getTime(),
      };
    }

    const authority = decision.authority;
    let observation: SlackAudienceObservation;
    if (decision.kind === "unavailable") {
      observation = { kind: "unavailable", reason: decision.reason };
    } else {
      const readyAuthority = decision.authority;
      const fence = providerFence(readyAuthority);
      const provider = await listSlackProviderConversationMembers({
        transport: dependencies.transport,
        quarantineSink: dependencies.quarantineSink,
        credentialHandleForPage: () => dependencies.credentialResolver.resolve({
          authority: fence,
          now: observedAt,
        }),
        authority: fence,
        providerConversationId: authority.providerConversationId,
        now: observedAt,
      });
      if (provider.kind === "fact") {
        const providerMembers = provider.fact.providerMemberIds.filter(
          (memberId) => memberId !== authority.providerBotUserId,
        );
        observation = {
          kind: "observed",
          externalMemberIds: providerMembers,
          raftAuthorizedProviderMemberIds:
            readyAuthority.raftAuthorizedProviderMemberIds,
        };
      } else if (provider.kind === "rate_limited") {
        observation = { kind: "unavailable", reason: "provider_rate_limited" };
      } else {
        observation = {
          kind: "unavailable",
          reason: provider.reason === "authority_quarantined"
            ? "authority_quarantined"
            : provider.reason === "credential_unavailable"
              ? "credential_unavailable"
              : "provider_unavailable",
        };
      }
    }

    const reconciled = await reconcileSlackPrivateAudience({
      serverId: authority.serverId,
      bindingId: authority.bindingId,
      expectedConnectionEpoch: authority.connectionEpoch,
      expectedBindingEpoch: authority.bindingEpoch,
      expectedAudienceRevision: authority.audienceRevision,
      observation,
      observedAt,
      expiresAt: new Date(observedAt.getTime() + freshnessMs),
    });
    if (reconciled.kind !== "recorded") {
      return unavailableReceipt({
        kind: "fence_mismatch",
        bindingId,
        observedAt,
        reason: "identity_mapping_unavailable",
      });
    }
    return {
      kind: "recorded",
      bindingId,
      audienceStatus: reconciled.status,
      observedAtMs: observedAt.getTime(),
      ...(observation.kind === "unavailable" ? { reason: observation.reason } : {}),
      revision: reconciled.audienceRevision,
    };
  };
}
