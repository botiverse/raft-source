import { createHash } from "node:crypto";

import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb, type Database, type DatabaseExecutor } from "../db/index.js";
import {
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppInstalls,
  externalChannelBindings,
  externalHumanIdentityLinks,
} from "../db/schema.js";
import {
  resolveExternalBindingAuthority,
  type ExternalAuthorPolicyRuntimeAuthority,
} from "./externalAppControlPlaneService.js";
import type { ExternalIngressRuntimeResolver } from "./externalAppIngressService.js";
import type { ExternalInboundWorkerDependencies } from "./externalInboundWorkerService.js";
import { evaluateFeatureFlag } from "./featureFlagService.js";

type ActiveAuthority = Extract<
  Awaited<ReturnType<typeof resolveExternalBindingAuthority>>,
  { active: true }
>["fact"];

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validNow(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function canonicalAuthority(authority: ActiveAuthority): Record<string, unknown> {
  return {
    provider: authority.provider,
    environment: authority.environment,
    registrationId: authority.registrationId,
    serverId: authority.serverId,
    serverGrantId: authority.serverGrantId,
    grantEpoch: authority.grantEpoch,
    installId: authority.installId,
    providerAppId: authority.providerAppId,
    connectionEpoch: authority.connectionEpoch,
    scopeRevision: authority.scopeRevision,
    credentialRevision: authority.credentialRevision,
    bindingId: authority.bindingId,
    bindingEpoch: authority.bindingEpoch,
    privacyClass: authority.privacyClass,
    channelId: authority.channelId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    installGrantReceiptRevision: authority.installGrantReceiptRevision,
    audienceRevision: authority.audienceRevision,
  };
}

export function slackBridgeDatabaseRuntimeRevision(authority: ActiveAuthority): string {
  return createHash("sha256")
    .update(JSON.stringify({
      schema: "slack-bridge-database-runtime-authority.v1",
      authority: canonicalAuthority(authority),
    }), "utf8")
    .digest("hex");
}

function sameIngressAuthority(
  current: ActiveAuthority,
  expected: Parameters<ExternalIngressRuntimeResolver["resolveCurrentRuntime"]>[0]["authority"],
): boolean {
  return current.provider === expected.provider
    && current.environment === expected.environment
    && current.registrationId === expected.registrationId
    && current.serverId === expected.serverId
    && current.serverGrantId === expected.serverGrantId
    && current.grantEpoch === expected.grantEpoch
    && current.installId === expected.installId
    && current.providerAppId === expected.providerAppId
    && current.connectionEpoch === expected.connectionEpoch
    && current.scopeRevision === expected.scopeRevision
    && current.credentialRevision === expected.credentialRevision
    && current.bindingId === expected.bindingId
    && current.bindingEpoch === expected.bindingEpoch
    && current.privacyClass === expected.privacyClass
    && current.channelId === expected.channelId
    && current.providerAuthorityId === expected.providerAuthorityId
    && current.providerConversationId === expected.providerConversationId
    && current.installGrantReceiptRevision === expected.installGrantReceiptRevision
    && current.audienceRevision === expected.audienceRevision;
}

function sameFrozenAuthority(
  current: ActiveAuthority,
  frozen: Parameters<ExternalInboundWorkerDependencies["resolveCurrentRuntime"]>[0]["frozenAuthority"],
): boolean {
  return current.provider === frozen.provider
    && current.environment === frozen.environment
    && current.registrationId === frozen.appRegistrationId
    && current.installId === frozen.installId
    && current.providerAuthorityId === frozen.workspaceId
    && current.providerAuthorityId === frozen.providerAuthorityId
    && current.providerConversationId === frozen.providerConversationId
    && current.bindingId === frozen.bindingId
    && current.bindingEpoch === frozen.bindingEpoch
    && current.connectionEpoch === frozen.connectionEpoch
    && current.channelId === frozen.raftChannelId
    && current.privacyClass === frozen.privacyClass
    && slackBridgeDatabaseRuntimeRevision(current) === frozen.runtimeRevision;
}

export function createSlackDatabaseIngressRuntimeResolver(
  db?: Database,
): ExternalIngressRuntimeResolver {
  return {
    async resolveCurrentRuntime(input) {
      if (
        !validNow(input.now)
        || !positiveInteger(input.actorProjectionRevision)
        || !positiveInteger(input.memberRevision)
        || !positiveInteger(input.contextRevision)
      ) return null;
      const runtimeDb = db ?? getDb();
      return runtimeDb.transaction(async (tx) => {
        const decision = await resolveExternalBindingAuthority({
          serverId: input.authority.serverId,
          bindingId: input.authority.bindingId,
          expectedConnectionEpoch: input.authority.connectionEpoch,
          expectedBindingEpoch: input.authority.bindingEpoch,
          now: input.now,
        }, tx as ReturnType<typeof getDb>);
        if (!decision.active || !sameIngressAuthority(decision.fact, input.authority)) return null;
        const launch = await evaluateFeatureFlag({
          key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
          serverId: decision.fact.serverId,
        }, tx as ReturnType<typeof getDb>);
        if (!launch.enabled) return null;
        if (input.requiredCapabilities?.includes("attachment_transfer")) {
          const attachmentTransfer = await evaluateFeatureFlag({
            key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
            serverId: decision.fact.serverId,
          }, tx as ReturnType<typeof getDb>);
          if (!attachmentTransfer.enabled) return null;
        }
        if (input.requiredCapabilities?.includes("reaction_sync")) {
          const reactionSync = await evaluateFeatureFlag({
            key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync,
            serverId: decision.fact.serverId,
          }, tx as ReturnType<typeof getDb>);
          if (!reactionSync.enabled) return null;
        }
        const projections = await tx.select({ id: externalActorProjections.id })
          .from(externalActorProjections)
          .where(and(
            eq(externalActorProjections.id, input.projectionId),
            eq(externalActorProjections.provider, "slack"),
            eq(externalActorProjections.appRegistrationId, decision.fact.registrationId),
            eq(externalActorProjections.installId, decision.fact.installId),
            eq(externalActorProjections.workspaceId, decision.fact.providerAuthorityId),
            eq(externalActorProjections.externalActorId, input.externalActorId),
            eq(externalActorProjections.projectionRevision, input.actorProjectionRevision),
            eq(externalActorProjections.state, "active"),
            eq(externalActorProjections.deactivated, false),
          )).limit(2);
        if (projections.length !== 1) return null;
        const addressability = await tx.select({ id: externalAddressabilityProjections.id })
          .from(externalAddressabilityProjections)
          .where(and(
            eq(externalAddressabilityProjections.projectionId, input.projectionId),
            eq(externalAddressabilityProjections.provider, "slack"),
            eq(externalAddressabilityProjections.appRegistrationId, decision.fact.registrationId),
            eq(externalAddressabilityProjections.installId, decision.fact.installId),
            eq(externalAddressabilityProjections.workspaceId, decision.fact.providerAuthorityId),
            eq(externalAddressabilityProjections.bindingId, decision.fact.bindingId),
            eq(externalAddressabilityProjections.bindingEpoch, decision.fact.bindingEpoch),
            eq(externalAddressabilityProjections.connectionEpoch, decision.fact.connectionEpoch),
            eq(externalAddressabilityProjections.conversationId, decision.fact.providerConversationId),
            eq(externalAddressabilityProjections.memberRevision, input.memberRevision),
            eq(externalAddressabilityProjections.contextRevision, input.contextRevision),
            eq(externalAddressabilityProjections.state, "active"),
            gt(externalAddressabilityProjections.expiresAt, input.now),
          )).limit(2);
        if (addressability.length !== 1) return null;
        return { runtimeRevision: slackBridgeDatabaseRuntimeRevision(decision.fact) };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}

export function createSlackDatabaseInboundWorkerRuntimeResolver(
  db?: Database,
  now?: () => Date,
): ExternalInboundWorkerDependencies["resolveCurrentRuntime"] {
  return async (input) => {
    if (!input.eventId || input.signal?.aborted) return null;
    const observedAt = now?.();
    if (observedAt && !validNow(observedAt)) return null;
    const frozen = input.frozenAuthority;
    const runtimeDb = db ?? getDb();
    return runtimeDb.transaction(async (tx) => {
      const bindings = await tx.select().from(externalChannelBindings).where(and(
        eq(externalChannelBindings.id, frozen.bindingId),
        eq(externalChannelBindings.registrationId, frozen.appRegistrationId),
        eq(externalChannelBindings.installId, frozen.installId),
        eq(externalChannelBindings.channelId, frozen.raftChannelId),
        eq(externalChannelBindings.providerConversationId, frozen.providerConversationId),
        eq(externalChannelBindings.connectionEpoch, frozen.connectionEpoch),
        eq(externalChannelBindings.bindingEpoch, frozen.bindingEpoch),
      )).limit(2);
      if (bindings.length !== 1) return null;
      const decision = await resolveExternalBindingAuthority({
        serverId: bindings[0]!.serverId,
        bindingId: frozen.bindingId,
        expectedConnectionEpoch: frozen.connectionEpoch,
        expectedBindingEpoch: frozen.bindingEpoch,
        ...(observedAt ? { now: observedAt } : {}),
      }, tx as ReturnType<typeof getDb>);
      if (!decision.active || !sameFrozenAuthority(decision.fact, frozen)) return null;
      const launch = await evaluateFeatureFlag({
        key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
        serverId: decision.fact.serverId,
      }, tx as ReturnType<typeof getDb>);
      if (!launch.enabled) return null;
      if (input.requiredCapabilities?.includes("attachment_transfer")) {
        const attachmentTransfer = await evaluateFeatureFlag({
          key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
          serverId: decision.fact.serverId,
        }, tx as ReturnType<typeof getDb>);
        if (!attachmentTransfer.enabled) return null;
      }
      if (input.requiredCapabilities?.includes("reaction_sync")) {
        const reactionSync = await evaluateFeatureFlag({
          key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync,
          serverId: decision.fact.serverId,
        }, tx as ReturnType<typeof getDb>);
        if (!reactionSync.enabled) return null;
      }
      return { ...frozen };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  };
}

export function createSlackDatabaseAuthorPolicyAuthorityResolver(
  db?: Database,
): (input: { serverId: string; bindingId: string; now: Date }) => Promise<ExternalAuthorPolicyRuntimeAuthority | null> {
  return async (input) => {
    if (!validNow(input.now)) return null;
    const runtimeDb = db ?? getDb();
    return runtimeDb.transaction(async (tx) => {
      const bindings = await tx.select().from(externalChannelBindings).where(and(
        eq(externalChannelBindings.id, input.bindingId),
        eq(externalChannelBindings.serverId, input.serverId),
      )).limit(2);
      if (bindings.length !== 1) return null;
      const binding = bindings[0]!;
      const decision = await resolveExternalBindingAuthority({
        serverId: input.serverId,
        bindingId: input.bindingId,
        expectedConnectionEpoch: binding.connectionEpoch,
        expectedBindingEpoch: binding.bindingEpoch,
        now: input.now,
      }, tx as ReturnType<typeof getDb>);
      if (!decision.active) return null;
      return {
        provider: "slack",
        registrationId: decision.fact.registrationId,
        installId: decision.fact.installId,
        bindingId: decision.fact.bindingId,
        bindingEpoch: decision.fact.bindingEpoch,
        consentRevision: decision.fact.bindingEpoch,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  };
}

export type SlackAudienceIdentityPrincipal = {
  kind: "human" | "agent";
  id: string;
};

export type SlackAudienceIdentityAuthorityDecision =
  | {
      kind: "resolved";
      mappings: readonly {
        kind: "human";
        id: string;
        projectionId: string;
      }[];
    }
  | { kind: "unavailable" };

export interface SlackDatabaseAudienceIdentityAuthority {
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
    principals: readonly SlackAudienceIdentityPrincipal[];
    now: Date;
  }): Promise<SlackAudienceIdentityAuthorityDecision>;
}

/**
 * Resolves private-channel audience identities only from explicit human OAuth
 * links. Raft agents share the install bot transport identity and therefore
 * never enter the Slack member set. External actor projections are joined only
 * after the explicit link; they cannot mint Raft membership or identity.
 */
export function createSlackDatabaseAudienceIdentityAuthority(): SlackDatabaseAudienceIdentityAuthority {
  return {
    async resolve(input) {
      if (
        !validNow(input.now)
        || !positiveInteger(input.connectionEpoch)
        || !positiveInteger(input.bindingEpoch)
        || !input.serverId
        || !input.channelId
        || !input.bindingId
        || !input.registrationId
        || !input.installId
        || !input.providerAuthorityId.trim()
        || !input.providerConversationId.trim()
        || input.principals.some((principal) => principal.kind !== "human" || !principal.id)
      ) return { kind: "unavailable" };
      const userIds = input.principals.map((principal) => principal.id).sort();
      if (new Set(userIds).size !== userIds.length) {
        return { kind: "unavailable" };
      }
      if (userIds.length === 0) return { kind: "resolved", mappings: [] };

      const rows = await input.executor.select({
        userId: externalHumanIdentityLinks.userId,
        providerUserId: externalHumanIdentityLinks.providerUserId,
        projectionId: externalActorProjections.id,
      }).from(externalHumanIdentityLinks)
        .innerJoin(
          externalAppInstalls,
          eq(externalAppInstalls.id, externalHumanIdentityLinks.installId),
        )
        .innerJoin(
          externalActorProjections,
          and(
            eq(externalActorProjections.provider, "slack"),
            eq(externalActorProjections.appRegistrationId, input.registrationId),
            sql`${externalActorProjections.installId} = ${externalHumanIdentityLinks.installId}::text`,
            eq(externalActorProjections.workspaceId, externalHumanIdentityLinks.providerAuthorityId),
            eq(externalActorProjections.externalActorId, externalHumanIdentityLinks.providerUserId),
            eq(externalActorProjections.actorKind, "human"),
            eq(externalActorProjections.state, "active"),
            eq(externalActorProjections.deactivated, false),
          ),
        )
        .innerJoin(
          externalChannelBindings,
          and(
            eq(externalChannelBindings.id, input.bindingId),
            eq(externalChannelBindings.installId, externalHumanIdentityLinks.installId),
          ),
        )
        .where(and(
          eq(externalHumanIdentityLinks.serverId, input.serverId),
          eq(externalHumanIdentityLinks.installId, input.installId),
          eq(externalHumanIdentityLinks.provider, "slack"),
          eq(externalHumanIdentityLinks.providerAuthorityId, input.providerAuthorityId),
          eq(externalHumanIdentityLinks.state, "active"),
          isNull(externalHumanIdentityLinks.revokedAt),
          lte(externalHumanIdentityLinks.observedConnectionEpoch, input.connectionEpoch),
          inArray(externalHumanIdentityLinks.userId, userIds),
          eq(externalAppInstalls.serverId, input.serverId),
          eq(externalAppInstalls.registrationId, input.registrationId),
          eq(externalAppInstalls.providerAuthorityId, input.providerAuthorityId),
          eq(externalAppInstalls.state, "active"),
          eq(externalAppInstalls.connectionEpoch, input.connectionEpoch),
          eq(externalChannelBindings.serverId, input.serverId),
          eq(externalChannelBindings.registrationId, input.registrationId),
          eq(externalChannelBindings.channelId, input.channelId),
          eq(externalChannelBindings.providerConversationId, input.providerConversationId),
          eq(externalChannelBindings.privacyClass, "private"),
          eq(externalChannelBindings.state, "active"),
          eq(externalChannelBindings.connectionEpoch, input.connectionEpoch),
          eq(externalChannelBindings.bindingEpoch, input.bindingEpoch),
        ));
      const byUser = new Map<string, typeof rows>();
      for (const row of rows) {
        byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
      }
      if (
        rows.length !== userIds.length
        || new Set(rows.map((row) => row.providerUserId)).size !== rows.length
        || new Set(rows.map((row) => row.projectionId)).size !== rows.length
        || userIds.some((userId) => byUser.get(userId)?.length !== 1)
      ) return { kind: "unavailable" };

      return {
        kind: "resolved",
        mappings: rows.map((row) => ({
          kind: "human" as const,
          id: row.userId,
          projectionId: row.projectionId,
        })).sort((left, right) => left.id.localeCompare(right.id)),
      };
    },
  };
}
