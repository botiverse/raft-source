import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import type { Database, DatabaseTransaction } from "../db/index";
import {
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppInstalls,
  externalAppRegistrations,
  externalChannelBindings,
} from "../db/schema";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import type { ExternalIngressPayloadSealer, ExternalIngressRuntimeResolver } from "./externalAppIngressService";
import { resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";
import { evaluateFeatureFlag } from "./featureFlagService";
import { slackBridgeDatabaseRuntimeRevision } from "./slackBridgeDatabaseRuntimeAuthority";
import type { SlackVerifiedIngressAad } from "./slackVerifiedIngressContracts";
import { hasSlackFallbackAuthor, slackFallbackWaitElapsed, SLACK_REPEAT_FALLBACK_WAIT_MS } from "./slackFallbackPolicy";
import { parseVerifiedSlackMessage, parseVerifiedSlackReaction } from "./slackVerifiedIngressNormalize";
import { prepareSlackVerifiedBot } from "./slackVerifiedIngressBot";
import type { PreparedVerifiedSlackEvent, SlackIngressPreparationContext } from "./slackVerifiedIngressRuntime";

/**
 * Prepare a verified durable message from current provider/binding authority.
 * The raw receipt remains durable until the normalized worker commits. Known
 * unsupported events use the existing product's explicit discard receipts.
 */
export function createSlackVerifiedIngressPreparer(input: {
  db: Database;
  payloadSealer: ExternalIngressPayloadSealer;
  runtimeResolver: ExternalIngressRuntimeResolver;
  now: () => Date;
  /** Enable only after the reviewed protocol-2 fleet and database floor are in place. */
  botSyncEnabled?: boolean;
}): (event: unknown, aad: SlackVerifiedIngressAad, receivedAt: Date, custody?: SlackIngressPreparationContext) => Promise<PreparedVerifiedSlackEvent> {
  return async (event, aad, receivedAt, custody) => {
    const envelope = event && typeof event === "object" && !Array.isArray(event)
      ? event as Record<string, unknown> : null;
    const inner = envelope?.event && typeof envelope.event === "object" && !Array.isArray(envelope.event)
      ? envelope.event as Record<string, unknown> : null;
    const isMessage = inner?.type === "message";
    const isReaction = inner?.type === "reaction_added" || inner?.type === "reaction_removed";
    const message = isMessage ? parseVerifiedSlackMessage(event) : null;
    const reaction = isReaction ? parseVerifiedSlackReaction(event) : null;
    const actorValue = message ? message.author.user : reaction?.externalActorId;
    const anonymous = Boolean(message && (actorValue === undefined || actorValue === null
      || (typeof actorValue === "string" && !actorValue.trim())));
    const actorId = anonymous ? "" : actorValue;
    const messageBody = inner?.subtype === "message_changed" && inner.message && typeof inner.message === "object"
      && !Array.isArray(inner.message) ? inner.message as Record<string, unknown> : inner;
    const isBot = !!messageBody && (messageBody.bot_id != null || messageBody.app_id != null
      || messageBody.bot_profile != null || messageBody.subtype === "bot_message");
    const unsupportedSubtype = isMessage && typeof inner?.subtype === "string"
      && !["message_changed", "file_share", "bot_message"].includes(inner.subtype);
    if (unsupportedSubtype) return { kind: "skip", reason: "unsupported_message_subtype" };
    if (!isMessage && !isReaction) return { kind: "skip", reason: "unsupported_event" };
    const senderMissing = isMessage && !!messageBody && (messageBody.user === undefined || messageBody.user === null
      || (typeof messageBody.user === "string" && !messageBody.user.trim()));
    if (!isBot && senderMissing && (typeof messageBody?.text !== "string" || !messageBody.text.trim())) {
      return { kind: "skip", reason: "unsupported_event" };
    }
    const earlyReason = (isMessage && !message) || (isReaction && !reaction) || typeof actorId !== "string"
        || (!anonymous && !actorId.trim()) || actorId.length > 160 || /[\r\n\0]/u.test(actorId) ? "invalid_event_shape" as const
        : null;
    if (!aad.providerConversationId) return { kind: "unrecognized", reason: earlyReason ?? "invalid_event_shape" };
    const at = input.now();
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()) || !(receivedAt instanceof Date)
      || !Number.isFinite(receivedAt.getTime()) || at < receivedAt) return { kind: "wait", reason: "clock_unavailable" };
    const [registration] = await input.db.select().from(externalAppRegistrations).where(and(
      eq(externalAppRegistrations.id, aad.registrationId), eq(externalAppRegistrations.provider, "slack"),
      eq(externalAppRegistrations.environment, aad.environment), eq(externalAppRegistrations.providerAppId, aad.providerAppId),
      eq(externalAppRegistrations.state, "active"),
    )).limit(1);
    if (!registration) return { kind: "wait", reason: "registration_unavailable" };
    const installs = await input.db.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.registrationId, registration.id), eq(externalAppInstalls.providerAppId, aad.providerAppId),
      eq(externalAppInstalls.providerAuthorityId, aad.providerAuthorityId), eq(externalAppInstalls.state, "active"),
    )).limit(2);
    if (installs.length !== 1 || !installs[0]!.botUserId) return { kind: "wait", reason: "install_unavailable" };
    const install = installs[0]!;
    const bindings = await input.db.select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.installId, install.id), eq(externalChannelBindings.registrationId, registration.id),
      eq(externalChannelBindings.providerConversationId, aad.providerConversationId),
      eq(externalChannelBindings.connectionEpoch, install.connectionEpoch), eq(externalChannelBindings.state, "active"),
    )).limit(2);
    // This is only a candidate. The discard transaction repeats the proof
    // under the conversation lock and treats any historical binding as
    // recoverable, including paused or revoked pairs.
    if (bindings.length === 0) {
      return { kind: "discard", reason: "no_recoverable_pair" };
    }
    if (bindings.length !== 1) return { kind: "wait", reason: "binding_unavailable" };
    const binding = bindings[0]!;
    const decision = await resolveExternalBindingAuthority({ serverId: binding.serverId, bindingId: binding.id,
      expectedConnectionEpoch: binding.connectionEpoch, expectedBindingEpoch: binding.bindingEpoch, now: at }, input.db);
    if (!decision.active || decision.fact.providerAppId !== aad.providerAppId
      || decision.fact.providerAuthorityId !== aad.providerAuthorityId
      || decision.fact.providerConversationId !== aad.providerConversationId) {
      return { kind: "wait", reason: "binding_authority_unavailable" };
    }
    const authority = decision.fact;
    if (!(await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: authority.serverId }, input.db)).enabled) {
      return { kind: "wait", reason: "bridge_disabled" };
    }
    if (isBot) {
      if (!message) return { kind: "unrecognized", reason: "invalid_event_shape" };
      return prepareSlackVerifiedBot({ db: input.db, payloadSealer: input.payloadSealer, aad, message,
        authority, receivedAt, at, custody, syncEnabled: input.botSyncEnabled === true });
    }
    if (earlyReason) return { kind: "unrecognized", reason: earlyReason };
    if (typeof actorId !== "string") return { kind: "unrecognized", reason: "invalid_event_shape" };
    const validateUnresolved = async (tx: DatabaseTransaction, checkedAt: Date): Promise<boolean> => {
      if (!Number.isFinite(checkedAt.getTime())) return false;
        const [lockedInstall] = await tx.select().from(externalAppInstalls)
          .where(eq(externalAppInstalls.id, authority.installId)).limit(1).for("update");
        const [lockedBinding] = await tx.select().from(externalChannelBindings)
          .where(eq(externalChannelBindings.id, authority.bindingId)).limit(1).for("update");
        const [lockedRegistration] = await tx.select().from(externalAppRegistrations)
          .where(eq(externalAppRegistrations.id, authority.registrationId)).limit(1).for("share");
        if (!lockedInstall || !lockedBinding || !lockedRegistration || lockedInstall.botUserId !== install.botUserId) return false;
        const grant = await resolveExternalInstallServerGrantAuthority(tx, { installId: authority.installId,
          serverId: authority.serverId, registrationId: authority.registrationId }, { lock: true });
        if (!grant.current) return false;
        const current = await resolveExternalBindingAuthority({ serverId: authority.serverId, bindingId: authority.bindingId,
          expectedConnectionEpoch: authority.connectionEpoch, expectedBindingEpoch: authority.bindingEpoch, now: checkedAt }, tx as Database);
        if (!current.active || current.fact.providerAppId !== aad.providerAppId
          || current.fact.installId !== authority.installId || current.fact.bindingId !== authority.bindingId
          || current.fact.providerAuthorityId !== authority.providerAuthorityId
          || current.fact.providerConversationId !== authority.providerConversationId
          || !(await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: authority.serverId }, tx as Database)).enabled) return false;
        const [currentActor] = await tx.select().from(externalActorProjections).where(and(
          eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.appRegistrationId, authority.registrationId),
          eq(externalActorProjections.installId, authority.installId), eq(externalActorProjections.workspaceId, authority.providerAuthorityId),
          eq(externalActorProjections.externalActorId, actorId),
        )).limit(1).for("share");
        if (!currentActor || currentActor.state !== "active" || currentActor.deactivated || currentActor.actorKind === "unknown") return true;
        const [address] = await tx.select({ state: externalAddressabilityProjections.state }).from(externalAddressabilityProjections).where(and(
          eq(externalAddressabilityProjections.projectionId, currentActor.id), eq(externalAddressabilityProjections.bindingId, authority.bindingId),
          eq(externalAddressabilityProjections.bindingEpoch, authority.bindingEpoch), eq(externalAddressabilityProjections.connectionEpoch, authority.connectionEpoch),
          eq(externalAddressabilityProjections.conversationId, authority.providerConversationId),
        )).orderBy(desc(externalAddressabilityProjections.contextRevision)).limit(1).for("share");
        return address?.state !== "active";
    };
    const unresolvedActor = (): PreparedVerifiedSlackEvent => {
      if ((!reaction && !message?.providerEditedTs) || at.getTime() < receivedAt.getTime() + 24 * 60 * 60_000) {
        return { kind: "unrecognized", reason: "actor_identity_pending", pendingAuthor: {
          installId: authority.installId, workspaceId: authority.providerAuthorityId,
          bindingId: authority.bindingId, actorId,
        }, validatePendingAuthor: validateUnresolved };
      }
      return { kind: "skip", reason: reaction ? "reaction_author_unavailable" : "edit_author_unavailable", async validate(tx, rawReceivedAt, checkedAt) {
        if (!Number.isFinite(checkedAt.getTime()) || rawReceivedAt.getTime() !== receivedAt.getTime()
          || checkedAt.getTime() < rawReceivedAt.getTime() + 24 * 60 * 60_000) return false;
        return validateUnresolved(tx, checkedAt);
      } };
    };
    const isSelfReaction = !!reaction && actorId === install.botUserId;
    const sourceVerifiedEdit = anonymous && Boolean(message?.providerEditedTs);
    let actor: { projectionId: string; projectionRevision: number; memberRevision: number; contextRevision: number;
      historical: boolean; removedFromChannel: boolean } | null = null;
    let fallback = false;
    let createFallbackProjection = false;
    let runtimeRevision = slackBridgeDatabaseRuntimeRevision(authority);
    if (sourceVerifiedEdit) {
      // The edit worker resolves and locks the original provider receipt;
      // no sender identity is invented or used to authorize the edit.
    } else if (!isSelfReaction) {
      const [projection] = await input.db.select().from(externalActorProjections).where(and(
        eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.appRegistrationId, authority.registrationId),
        eq(externalActorProjections.installId, authority.installId), eq(externalActorProjections.workspaceId, authority.providerAuthorityId),
        eq(externalActorProjections.externalActorId, actorId),
      )).limit(1);
      // Missing identity is an individual event limitation, not a workspace
      // fault. Retain it off the FIFO after bounded retries so later verified
      // messages can flow, and allow replay once identity can be resolved.
      if (!projection) {
        if (!message || message.providerEditedTs || (!anonymous && at.getTime() < receivedAt.getTime() + 24 * 60 * 60_000)) return unresolvedActor();
        fallback = true;
        createFallbackProjection = true;
        actor = { projectionId: randomUUID(), projectionRevision: 1, memberRevision: 0, contextRevision: 0,
          historical: false, removedFromChannel: false };
      } else {
      if (projection.actorKind === "bot") return { kind: "skip", reason: "provider_loop_suppressed" };
      const fallbackScope = { projectionId: projection.id, registrationId: authority.registrationId, installId: authority.installId,
        workspaceId: authority.providerAuthorityId, externalActorId: actorId };
      const existingFallback = projection.actorKind === "unknown" && !anonymous && !!message && !message.providerEditedTs
        && await hasSlackFallbackAuthor(input.db, fallbackScope);
      if (existingFallback && at.getTime() < receivedAt.getTime() + SLACK_REPEAT_FALLBACK_WAIT_MS) {
        // Park this author's message without occupying the conversation head.
        return { kind: "author_grace", holdUntil: new Date(receivedAt.getTime() + SLACK_REPEAT_FALLBACK_WAIT_MS),
          pendingAuthor: { installId: authority.installId, workspaceId: authority.providerAuthorityId,
            bindingId: authority.bindingId, actorId }, validatePendingAuthor: validateUnresolved };
      }
      if (projection.actorKind === "unknown" && !anonymous
        && (reaction || message?.providerEditedTs || (!existingFallback && at.getTime() < receivedAt.getTime() + 24 * 60 * 60_000))) return unresolvedActor();
      const [addressability] = await input.db.select().from(externalAddressabilityProjections).where(and(
        eq(externalAddressabilityProjections.projectionId, projection.id), eq(externalAddressabilityProjections.provider, "slack"),
        eq(externalAddressabilityProjections.appRegistrationId, authority.registrationId),
        eq(externalAddressabilityProjections.installId, authority.installId), eq(externalAddressabilityProjections.workspaceId, authority.providerAuthorityId),
        eq(externalAddressabilityProjections.connectionEpoch, authority.connectionEpoch),
        eq(externalAddressabilityProjections.bindingId, authority.bindingId), eq(externalAddressabilityProjections.bindingEpoch, authority.bindingEpoch),
        eq(externalAddressabilityProjections.conversationId, authority.providerConversationId),
      )).orderBy(desc(externalAddressabilityProjections.contextRevision)).limit(1);
      const removedFromChannel = addressability?.state === "removed";
      const historical = projection.state !== "active" || projection.deactivated || removedFromChannel;
      // Only a previously identified human is eligible for this fallback.
      // Do not reactivate its directory identity or make it mentionable.
      const authorExpired = !reaction && !!message && !message.providerEditedTs
        && (at.getTime() >= receivedAt.getTime() + 24 * 60 * 60_000
          || (existingFallback && at.getTime() >= receivedAt.getTime() + SLACK_REPEAT_FALLBACK_WAIT_MS));
      if (historical && (reaction || projection.actorKind !== "human") && !authorExpired) return unresolvedActor();
      if (historical && projection.actorKind === "human") {
        if (!(await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: authority.serverId }, input.db)).enabled) {
          return { kind: "wait", reason: "bridge_disabled" };
        }
        actor = { projectionId: projection.id, projectionRevision: projection.projectionRevision,
          memberRevision: addressability?.memberRevision ?? 0, contextRevision: addressability?.contextRevision ?? 0,
          historical: true, removedFromChannel };
      } else {
        if (anonymous || (authorExpired && (historical || projection.actorKind === "unknown"
          || !addressability || addressability.state !== "active"))) {
          fallback = true;
          actor = { projectionId: projection.id, projectionRevision: projection.projectionRevision,
            memberRevision: 0, contextRevision: 0, historical: false, removedFromChannel: false };
        } else {
        if (!addressability || addressability.state !== "active") return unresolvedActor();
        actor = { projectionId: projection.id, projectionRevision: projection.projectionRevision,
          memberRevision: addressability.memberRevision, contextRevision: addressability.contextRevision, historical: false, removedFromChannel: false };
        const runtime = await input.runtimeResolver.resolveCurrentRuntime({ authority, projectionId: actor.projectionId,
          actorProjectionRevision: actor.projectionRevision, externalActorId: actorId, memberRevision: actor.memberRevision,
          contextRevision: actor.contextRevision, requiredCapabilities: reaction ? ["reaction_sync"]
            : message!.providerFileIds.length ? ["attachment_transfer"] : [], now: at });
        if (!runtime?.runtimeRevision) return { kind: "wait", reason: "actor_runtime_unavailable" };
        runtimeRevision = runtime.runtimeRevision;
        }
      }
      }
    } else if (!(await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: authority.serverId }, input.db)).enabled) {
      return { kind: "wait", reason: "bridge_disabled" };
    }
    const frozen = { runtimeRevision, provider: "slack", environment: aad.environment,
      appRegistrationId: authority.registrationId, installId: authority.installId, workspaceId: authority.providerAuthorityId,
      providerAuthorityId: authority.providerAuthorityId, providerConversationId: authority.providerConversationId,
      bindingId: authority.bindingId, bindingEpoch: authority.bindingEpoch, connectionEpoch: authority.connectionEpoch,
      raftChannelId: authority.channelId, privacyClass: authority.privacyClass };
    const schemaVersion = reaction ? 3 as const : message!.providerEditedTs ? 4 as const : 2 as const;
    const normalized = reaction ? JSON.stringify({ schema: "external-inbound-normalized-reaction.v1",
      operation: reaction.operation, providerMessageId: reaction.providerMessageId, externalActorId: actorId,
      providerReactionKey: reaction.providerReactionKey, eventOccurredAt: reaction.eventOccurredAt,
      eventSequence: reaction.eventSequence, botUserId: install.botUserId }) : JSON.stringify({
      schema: message!.providerEditedTs ? "external-inbound-normalized-edit.v1" : "external-inbound-normalized-event.v3",
      ...(message!.providerEditedTs ? { providerEditedTs: message!.providerEditedTs } : {}),
      ...(fallback ? { fallbackAuthor: anonymous ? "anonymous" : "unresolved" } : {}),
      ...(sourceVerifiedEdit ? { sourceVerifiedEdit: true } : {}),
      projectionId: sourceVerifiedEdit ? "" : actor!.projectionId, actorProjectionRevision: sourceVerifiedEdit ? 1 : actor!.projectionRevision, externalActorId: actorId,
      providerMessageId: message!.providerMessageId, providerThreadId: message!.providerThreadId,
      providerFileIds: message!.providerFileIds, providerAgentMentions: message!.providerAgentMentions,
      content: message!.content, createdAt: message!.createdAt,
    });
    const sealed = await input.payloadSealer.sealNormalizedPayload({ plaintext: normalized, aad: {
      purpose: "external-inbound-normalized-event", aadVersion: 1, schemaVersion, provider: "slack",
      environment: aad.environment, appRegistrationId: authority.registrationId, installId: authority.installId,
      workspaceId: authority.providerAuthorityId, providerAuthorityId: authority.providerAuthorityId,
      providerConversationId: authority.providerConversationId, providerEventId: aad.providerEventId,
      bindingId: authority.bindingId, bindingEpoch: authority.bindingEpoch, connectionEpoch: authority.connectionEpoch,
      runtimeRevision, raftChannelId: authority.channelId, privacyClass: authority.privacyClass,
    } });
    if (!sealed.encryptedPayload.trim() || !sealed.envelopeKeyId.trim() || sealed.aadVersion !== 1) {
      return { kind: "wait", reason: "normalized_seal_unavailable" };
    }
    const frozenActor = actor;
    return { kind: "materialize", authority: frozen,
      ...(!anonymous && actorId ? { orderedActorId: actorId } : {}),
      normalizedPayloadDigest: createHash("sha256").update(normalized).digest("hex"),
      encryptedPayload: sealed.encryptedPayload, envelopeKeyId: sealed.envelopeKeyId,
      payloadSchemaVersion: schemaVersion, payloadExpiresAt: new Date(at.getTime() + 24 * 60 * 60_000),
      async validateCurrentAuthority(tx: DatabaseTransaction, _candidate, checkedAt) {
        // Caller already holds the conversation advisory lock. Lock authority
        // before it takes the partition, in lifecycle's established order.
        const [lockedInstall] = await tx.select().from(externalAppInstalls)
          .where(eq(externalAppInstalls.id, authority.installId)).limit(1).for("update");
        if (!lockedInstall || lockedInstall.botUserId !== install.botUserId) return false;
        const [lockedBinding] = await tx.select().from(externalChannelBindings)
          .where(eq(externalChannelBindings.id, authority.bindingId)).limit(1).for("update");
        if (!lockedBinding || lockedBinding.serverId !== authority.serverId) return false;
        const [lockedRegistration] = await tx.select().from(externalAppRegistrations)
          // A shared lock fences registration changes until commit while
          // remaining compatible with concurrent verified receipt admission.
          .where(eq(externalAppRegistrations.id, authority.registrationId)).limit(1).for("share");
        if (!lockedRegistration) return false;
        const grant = await resolveExternalInstallServerGrantAuthority(tx, {
          installId: authority.installId, serverId: authority.serverId, registrationId: authority.registrationId,
        }, { lock: true });
        if (!grant.current) return false;
        const current = await resolveExternalBindingAuthority({ serverId: authority.serverId, bindingId: authority.bindingId,
          expectedConnectionEpoch: authority.connectionEpoch, expectedBindingEpoch: authority.bindingEpoch, now: checkedAt }, tx as Database);
        if (!current.active || slackBridgeDatabaseRuntimeRevision(current.fact) !== runtimeRevision
          || !(await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: authority.serverId }, tx as Database)).enabled) return false;
        if (fallback || sourceVerifiedEdit) return true;
        if (!frozenActor) return actorId === lockedInstall.botUserId;
        const [currentActor] = await tx.select().from(externalActorProjections).where(and(
          eq(externalActorProjections.id, frozenActor.projectionId), eq(externalActorProjections.externalActorId, actorId),
          eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.appRegistrationId, authority.registrationId),
          eq(externalActorProjections.installId, authority.installId), eq(externalActorProjections.workspaceId, authority.providerAuthorityId),
          eq(externalActorProjections.projectionRevision, frozenActor.projectionRevision),
          frozenActor.historical && !frozenActor.removedFromChannel
            ? or(eq(externalActorProjections.state, "tombstoned"), eq(externalActorProjections.deactivated, true))
            : frozenActor.historical ? undefined
              : and(eq(externalActorProjections.state, "active"), eq(externalActorProjections.deactivated, false)),
        )).limit(1).for("share");
        if (!currentActor || currentActor.actorKind === "bot") return false;
        if (frozenActor.historical && currentActor.actorKind !== "human") return false;
        if (frozenActor.historical && !frozenActor.removedFromChannel) return true;
        const [currentAddress] = await tx.select().from(externalAddressabilityProjections).where(and(
          eq(externalAddressabilityProjections.projectionId, currentActor.id), eq(externalAddressabilityProjections.bindingId, authority.bindingId),
          eq(externalAddressabilityProjections.provider, "slack"), eq(externalAddressabilityProjections.appRegistrationId, authority.registrationId),
          eq(externalAddressabilityProjections.installId, authority.installId), eq(externalAddressabilityProjections.workspaceId, authority.providerAuthorityId),
          eq(externalAddressabilityProjections.conversationId, authority.providerConversationId),
          eq(externalAddressabilityProjections.bindingEpoch, authority.bindingEpoch), eq(externalAddressabilityProjections.connectionEpoch, authority.connectionEpoch),
          eq(externalAddressabilityProjections.memberRevision, frozenActor.memberRevision),
          eq(externalAddressabilityProjections.contextRevision, frozenActor.contextRevision),
          eq(externalAddressabilityProjections.state, frozenActor.removedFromChannel ? "removed" : "active"),
        )).limit(1).for("share");
        return Boolean(currentAddress);
      },
      ...(fallback && frozenActor ? { async finalizeCurrentAuthority(tx: DatabaseTransaction, rawReceivedAt: Date, checkedAt: Date) {
        if (rawReceivedAt.getTime() !== receivedAt.getTime()
          || (!anonymous && !await slackFallbackWaitElapsed(tx, { projectionId: frozenActor.projectionId,
            registrationId: authority.registrationId, installId: authority.installId, workspaceId: authority.providerAuthorityId,
            externalActorId: actorId }, rawReceivedAt, checkedAt))) return false;
        if (createFallbackProjection) await tx.insert(externalActorProjections).values({
          id: frozenActor.projectionId, provider: "slack", appRegistrationId: authority.registrationId,
          installId: authority.installId, workspaceId: authority.providerAuthorityId, externalActorId: actorId,
          identityKind: anonymous ? "anonymous" : "provider_actor", displayName: anonymous ? "Slack" : `Slack user ${actorId}`,
          handles: [], actorKind: "unknown", state: "active", deactivated: false, projectionRevision: 1,
          observedAt: checkedAt, createdAt: checkedAt, updatedAt: checkedAt,
        }).onConflictDoNothing();
        const [currentActor] = await tx.select().from(externalActorProjections).where(and(
          eq(externalActorProjections.id, frozenActor.projectionId), eq(externalActorProjections.provider, "slack"),
          eq(externalActorProjections.appRegistrationId, authority.registrationId), eq(externalActorProjections.installId, authority.installId),
          eq(externalActorProjections.workspaceId, authority.providerAuthorityId), eq(externalActorProjections.externalActorId, actorId),
          eq(externalActorProjections.identityKind, anonymous ? "anonymous" : "provider_actor"),
          anonymous ? eq(externalActorProjections.actorKind, "unknown") : undefined,
          eq(externalActorProjections.projectionRevision, frozenActor.projectionRevision),
        )).limit(1).for("update");
        if (!currentActor || currentActor.actorKind === "bot") return false;
        if (!anonymous) {
          const [currentAddress] = await tx.select({ state: externalAddressabilityProjections.state })
            .from(externalAddressabilityProjections).where(and(
              eq(externalAddressabilityProjections.projectionId, currentActor.id),
              eq(externalAddressabilityProjections.bindingId, authority.bindingId),
              eq(externalAddressabilityProjections.bindingEpoch, authority.bindingEpoch),
              eq(externalAddressabilityProjections.connectionEpoch, authority.connectionEpoch),
              eq(externalAddressabilityProjections.conversationId, authority.providerConversationId),
            )).orderBy(desc(externalAddressabilityProjections.contextRevision)).limit(1).for("share");
          if (currentActor.state === "active" && !currentActor.deactivated && currentActor.actorKind !== "unknown"
            && currentAddress?.state === "active") return false;
        }
        return true;
      } } : {}),
    };
  };
}
