import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { getDb, type Database } from "../db/index";
import {
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppInstalls,
  externalAppRegistrations,
  externalChannelBindings,
  externalInboundEvents,
} from "../db/schema";
import {
  resolveExternalBindingAuthority,
} from "./externalAppControlPlaneService";
import type { ExternalIngressRuntimeResolver } from "./externalAppIngressService";
import type { ExternalInboundWorkerDependencies } from "./externalInboundWorkerService";
import { evaluateFeatureFlag } from "./featureFlagService";

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
    channelId: authority.channelId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    // audienceRevision is refresh metadata, not an authority coordinate:
    // including it would make a routine member refresh invalidate queued
    // inbound events. privacyClass is excluded for the same reason: either
    // side flipping public/private must not invalidate queued events
    // (yezizp, task #241 — visibility belongs to each platform). Both are
    // deliberately out of the revision hash and the coordinate checks.
  };
}

export function slackBridgeDatabaseRuntimeRevision(authority: ActiveAuthority): string {
  return createHash("sha256")
    .update(JSON.stringify({
      schema: "slack-bridge-database-runtime-authority.v2",
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
    && current.channelId === expected.channelId
    && current.providerAuthorityId === expected.providerAuthorityId
    && current.providerConversationId === expected.providerConversationId
    && current.installGrantReceiptRevision === expected.installGrantReceiptRevision;
}

function sameFrozenAuthorityCoordinates(
  current: ActiveAuthority,
  frozen: Parameters<ExternalInboundWorkerDependencies["resolveCurrentRuntime"]>[0]["frozenAuthority"],
): boolean {
  return current.provider === frozen.provider
    && current.environment === frozen.environment
    && current.providerAuthorityId === frozen.workspaceId
    && current.providerAuthorityId === frozen.providerAuthorityId
    && current.providerConversationId === frozen.providerConversationId
    && current.channelId === frozen.raftChannelId;
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
            // expiresAt is a directory-refresh TTL, not a delivery boundary:
            // an address observed active stays valid until a refresh sees it
            // removed or the binding authority itself stops. A failed or
            // overdue refresh degrades to the last observation and must not
            // block message ingress.
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
    if (!input.eventId || input.signal?.aborted || input.frozenAuthority.provider !== "slack") return null;
    const observedAt = now?.();
    if (observedAt && !validNow(observedAt)) return null;
    const frozen = input.frozenAuthority;
    const runtimeDb = db ?? getDb();
    return runtimeDb.transaction(async (tx) => {
      // The original sealed custody row proves admission; its version hash
      // is historical context, not the current installation authority.
      const [stored] = await tx.select().from(externalInboundEvents).where(
        sql`${externalInboundEvents.id}::text = ${input.eventId}`,
      ).limit(1);
      if (!stored || (Object.keys(frozen) as (keyof typeof frozen)[]).some((key) => stored[key] !== frozen[key])) return null;
      const candidates = await tx.select({ binding: externalChannelBindings }).from(externalChannelBindings)
        .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
        .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalChannelBindings.registrationId))
        .where(and(
          sql`${externalChannelBindings.registrationId}::text = ${frozen.appRegistrationId}`,
          eq(externalChannelBindings.channelId, frozen.raftChannelId),
          eq(externalChannelBindings.providerConversationId, frozen.providerConversationId),
          eq(externalChannelBindings.state, "active"),
          eq(externalAppInstalls.providerAuthorityId, frozen.providerAuthorityId),
          eq(externalAppInstalls.state, "active"),
          eq(externalAppRegistrations.provider, "slack"),
          eq(externalAppRegistrations.environment, frozen.environment),
        )).limit(2);
      if (candidates.length !== 1) return null;
      const binding = candidates[0]!.binding;
      const decision = await resolveExternalBindingAuthority({
        serverId: binding.serverId, bindingId: binding.id,
        expectedConnectionEpoch: binding.connectionEpoch, expectedBindingEpoch: binding.bindingEpoch,
        ...(observedAt ? { now: observedAt } : {}),
      }, tx as ReturnType<typeof getDb>);
      if (!decision.active || !sameFrozenAuthorityCoordinates(decision.fact, frozen)) return null;
      const launch = await evaluateFeatureFlag({
        key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
        serverId: decision.fact.serverId,
      }, tx as ReturnType<typeof getDb>);
      if (!launch.enabled) return null;
      const a = decision.fact;
      const operationAuthority = { runtimeRevision: slackBridgeDatabaseRuntimeRevision(a), provider: a.provider,
        environment: a.environment, appRegistrationId: a.registrationId, installId: a.installId,
        workspaceId: a.providerAuthorityId, providerAuthorityId: a.providerAuthorityId,
        providerConversationId: a.providerConversationId, bindingId: a.bindingId,
        bindingEpoch: a.bindingEpoch, connectionEpoch: a.connectionEpoch,
        raftChannelId: a.channelId, privacyClass: a.privacyClass };
      const changed = (["appRegistrationId", "installId", "bindingId", "bindingEpoch", "connectionEpoch"] as const)
        .some((key) => frozen[key] !== operationAuthority[key]);
      return { ...frozen, ...(changed ? { operationAuthority } : {}) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  };
}


