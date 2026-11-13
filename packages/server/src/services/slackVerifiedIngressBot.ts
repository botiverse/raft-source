import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { slackBotFallbackLabel, SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import type { Database, DatabaseExecutor, DatabaseTransaction } from "../db/index";
import { externalActorProjections, externalAppInstalls, externalAppRegistrations,
  externalChannelBindings, slackVerifiedIngressEvents, slackVerifiedIngressRollout } from "../db/schema";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import { resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";
import { evaluateFeatureFlag } from "./featureFlagService";
import type { ExternalIngressPayloadSealer } from "./externalAppIngressService";
import { slackBridgeDatabaseRuntimeRevision } from "./slackBridgeDatabaseRuntimeAuthority";
import { SLACK_BOT_SYNC_PROTOCOL, SLACK_VERIFIED_INGRESS_PROTOCOL } from "./slackVerifiedIngressRolloutContracts";
import { classifyVerifiedSlackInboundAuthor } from "./slackInboundAuthor";
import { readSlackInboundCurrentSelfBotId } from "./slackInboundSelfIdentity";
import { readSlackInboundOutboundEvidence } from "./slackInboundOutboundEvidence";
import { isSlackCardEditSenderOurBot, readSlackCardEditEchoLink } from "./slackCardEditEcho";
import type { VerifiedSlackMessage } from "./slackVerifiedIngressNormalize";
import type { SlackVerifiedIngressAad } from "./slackVerifiedIngressContracts";
import type { PreparedVerifiedSlackEvent, SlackIngressPreparationContext } from "./slackVerifiedIngressRuntime";

type ActiveAuthority = Extract<Awaited<ReturnType<typeof resolveExternalBindingAuthority>>, { active: true }>['fact'];

/**
 * Prepare bot custody without treating a Slack bot as a Raft member. The
 * caller has verified the signed receipt and resolved the current pair. Every
 * decision is repeated under the worker's conversation and authority locks.
 */
export async function prepareSlackVerifiedBot(input: {
  db: Database; payloadSealer: ExternalIngressPayloadSealer; aad: SlackVerifiedIngressAad;
  message: VerifiedSlackMessage; authority: ActiveAuthority; receivedAt: Date; at: Date;
  custody?: SlackIngressPreparationContext; syncEnabled: boolean;
}): Promise<PreparedVerifiedSlackEvent> {
  const { db, aad, message, authority, at, receivedAt, custody } = input;
  const runtimeRevision = slackBridgeDatabaseRuntimeRevision(authority);
  async function botProtocolFloor(executor: DatabaseExecutor): Promise<number | undefined> {
    const [policy] = await executor.select({ minimumWriterProtocol: slackVerifiedIngressRollout.minimumWriterProtocol })
      .from(slackVerifiedIngressRollout).where(eq(slackVerifiedIngressRollout.id, 1)).limit(1);
    return policy?.minimumWriterProtocol;
  }
  const pendingSince = custody?.lastIsolationReason === "bot_outbound_pending" ? custody.lastIsolatedAt ?? undefined : undefined;
  async function classify(executor: DatabaseExecutor, current: ActiveAuthority, checkedAt: Date) {
    const selfBotId = await readSlackInboundCurrentSelfBotId({ db: executor, authority: {
      registrationId: current.registrationId, environment: current.environment, providerAppId: current.providerAppId,
      providerAuthorityId: current.providerAuthorityId, installId: current.installId, connectionEpoch: current.connectionEpoch,
      scopeRevision: current.scopeRevision, credentialRevision: current.credentialRevision,
      installGrantReceiptRevision: current.installGrantReceiptRevision,
    }, now: checkedAt });
    const evidence = await readSlackInboundOutboundEvidence({ db: executor, registrationId: current.registrationId,
      environment: current.environment, providerAppId: current.providerAppId, installId: current.installId,
      workspaceId: current.providerAuthorityId, conversationId: current.providerConversationId,
      providerMessageId: message.providerMessageId, receivedAt, pendingSince });
    // RFC 082 §4.6: an edit of a card message's copy is our echo only with
    // its link at the current epoch and Slack naming this installation's bot.
    const cardLink = message.providerEditedTs && evidence.exactMessageMatch ? await readSlackCardEditEchoLink(executor, {
      installId: current.installId, providerAuthorityId: current.providerAuthorityId,
      providerConversationId: current.providerConversationId, providerMessageId: message.providerMessageId,
      current: { bindingId: current.bindingId, bindingEpoch: current.bindingEpoch, connectionEpoch: current.connectionEpoch },
    }) : null;
    const cardEdit = cardLink ? { ownEcho: cardLink.currentEpoch
      && isSlackCardEditSenderOurBot({ message: message.author, providerAppId: current.providerAppId, selfBotId }) } : undefined;
    return { evidence, decision: classifyVerifiedSlackInboundAuthor({ message: message.author,
      self: { providerAppId: current.providerAppId, identityAvailable: Boolean(selfBotId), selfBotIds: selfBotId ? [selfBotId] : [] },
      outbound: { ...evidence, ...(cardEdit ? { cardEdit } : {}) } }) };
  }
  async function lockedDecision(tx: DatabaseTransaction, checkedAt: Date) {
    const [install] = await tx.select().from(externalAppInstalls).where(eq(externalAppInstalls.id, authority.installId)).limit(1).for("update");
    const [binding] = await tx.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, authority.bindingId)).limit(1).for("update");
    const [registration] = await tx.select().from(externalAppRegistrations).where(eq(externalAppRegistrations.id, authority.registrationId)).limit(1).for("share");
    if (!install || !binding || !registration) return null;
    const grant = await resolveExternalInstallServerGrantAuthority(tx, { installId: authority.installId,
      serverId: authority.serverId, registrationId: authority.registrationId }, { lock: true });
    if (!grant.current) return null;
    const current = await resolveExternalBindingAuthority({ serverId: authority.serverId, bindingId: authority.bindingId,
      expectedConnectionEpoch: authority.connectionEpoch, expectedBindingEpoch: authority.bindingEpoch, now: checkedAt }, tx as Database);
    if (!current.active || slackBridgeDatabaseRuntimeRevision(current.fact) !== runtimeRevision
      || !(await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, serverId: authority.serverId }, tx as Database)).enabled) return null;
    return classify(tx, current.fact, checkedAt);
  }
  // Protocol 1 replicas still use the old skip-only bot behavior. Preserve it
  // until the separately approved irreversible floor change; new off-head
  // reasons must not be exposed to workers that do not understand them.
  if (await botProtocolFloor(db) === 1) return { kind: "skip", reason: message.author.app_id === aad.providerAppId
    ? "provider_self_echo" : "provider_loop_suppressed",
    async validate(tx) { return await botProtocolFloor(tx) === 1; } };
  const initial = await classify(db, authority, at);
  // Self echoes do not produce v4 payloads and may be discarded even while
  // the producer gate is closed, after the same locked proof as when open.
  if (initial.decision.kind === "self_echo") return { kind: "skip", reason: "provider_self_echo",
    async validate(tx, rawReceivedAt, checkedAt) {
      return rawReceivedAt.getTime() === receivedAt.getTime() && (await lockedDecision(tx, checkedAt))?.decision.kind === "self_echo";
    } };
  if (!input.syncEnabled) return { kind: "skip", reason: "provider_bot_sync_disabled",
    async validate(tx, rawReceivedAt, checkedAt) {
      return rawReceivedAt.getTime() === receivedAt.getTime() && Boolean(await lockedDecision(tx, checkedAt));
    } };
  const floor = await botProtocolFloor(db);
  if (floor === undefined || floor < SLACK_BOT_SYNC_PROTOCOL || floor > SLACK_VERIFIED_INGRESS_PROTOCOL)
    return { kind: "wait", reason: "bot_protocol_unavailable" };
  if (initial.decision.kind === "wait") {
    const profile = message.author.bot_profile && typeof message.author.bot_profile === "object" && !Array.isArray(message.author.bot_profile)
      ? message.author.bot_profile as Record<string, unknown> : null;
    const sender = typeof message.author.bot_id === "string" ? message.author.bot_id
      : typeof profile?.id === "string" ? profile.id : null;
    if (initial.decision.reason === "outbound_result_pending" && sender) return { kind: "unrecognized", reason: "bot_outbound_pending", immediate: true,
      pendingAuthor: { installId: authority.installId, workspaceId: authority.providerAuthorityId, bindingId: authority.bindingId, actorId: sender },
      async validatePendingAuthor(tx, checkedAt) {
        const current = (await lockedDecision(tx, checkedAt))?.decision;
        return current?.kind === "wait" && current.reason === "outbound_result_pending";
      } };
    return { kind: "unrecognized", reason: "bot_identity_pending" };
  }
  if (initial.decision.kind !== "bot") return { kind: "unrecognized", reason: "bot_identity_pending" };
  const actorId = initial.decision.providerBotId;
  const [existing] = await db.select().from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.appRegistrationId, authority.registrationId),
    eq(externalActorProjections.installId, authority.installId), eq(externalActorProjections.workspaceId, authority.providerAuthorityId),
    eq(externalActorProjections.externalActorId, actorId),
  )).limit(1);
  if (existing && (existing.actorKind !== "bot" || existing.state !== "active" || existing.deactivated)) {
    return { kind: "unrecognized", reason: "bot_identity_pending" };
  }
  const projectionId = existing?.id ?? randomUUID();
  const revision = existing?.projectionRevision ?? 1;
  const profile = message.author.bot_profile && typeof message.author.bot_profile === "object" && !Array.isArray(message.author.bot_profile)
    ? message.author.bot_profile as Record<string, unknown> : null;
  const senderAppId = typeof message.author.app_id === "string" ? message.author.app_id
    : typeof profile?.app_id === "string" ? profile.app_id : null;
  // Message-controlled username/icon overrides are never primary identity.
  // Until bots.info supplies a formal profile, use only a neutral fallback.
  const fallbackName = slackBotFallbackLabel(actorId);
  const schemaVersion = message.providerEditedTs ? 4 as const : 2 as const;
  const normalized = JSON.stringify({ schema: message.providerEditedTs ? "external-inbound-normalized-edit.v1" : "external-inbound-normalized-event.v4",
    ...(message.providerEditedTs ? { providerEditedTs: message.providerEditedTs } : { botPresentation: { displayName: null, avatarArtifactId: null } }),
    projectionId, actorProjectionRevision: revision, externalActorId: actorId,
    providerMessageId: message.providerMessageId, providerThreadId: message.providerThreadId,
    providerFileIds: message.providerFileIds, providerAgentMentions: message.providerAgentMentions,
    content: message.content, createdAt: message.createdAt });
  const frozen = { runtimeRevision, provider: "slack", environment: aad.environment, appRegistrationId: authority.registrationId,
    installId: authority.installId, workspaceId: authority.providerAuthorityId, providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId, bindingId: authority.bindingId, bindingEpoch: authority.bindingEpoch,
    connectionEpoch: authority.connectionEpoch, raftChannelId: authority.channelId, privacyClass: authority.privacyClass };
  const sealed = await input.payloadSealer.sealNormalizedPayload({ plaintext: normalized, aad: { purpose: "external-inbound-normalized-event",
    aadVersion: 1, schemaVersion, provider: "slack", environment: aad.environment, appRegistrationId: authority.registrationId,
    installId: authority.installId, workspaceId: authority.providerAuthorityId, providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId, providerEventId: aad.providerEventId, bindingId: authority.bindingId,
    bindingEpoch: authority.bindingEpoch, connectionEpoch: authority.connectionEpoch, runtimeRevision,
    raftChannelId: authority.channelId, privacyClass: authority.privacyClass } });
  if (!sealed.encryptedPayload.trim() || !sealed.envelopeKeyId.trim() || sealed.aadVersion !== 1) return { kind: "wait", reason: "normalized_seal_unavailable" };
  return { kind: "materialize", authority: frozen, orderedActorId: actorId,
    botProfileHint: { serverId: authority.serverId, registrationId: authority.registrationId, installId: authority.installId,
      bindingId: authority.bindingId, bindingEpoch: authority.bindingEpoch, connectionEpoch: authority.connectionEpoch,
      providerBotId: actorId, projectionId, senderAppId },
    normalizedPayloadDigest: createHash("sha256").update(normalized).digest("hex"), encryptedPayload: sealed.encryptedPayload,
    envelopeKeyId: sealed.envelopeKeyId, payloadSchemaVersion: schemaVersion, payloadExpiresAt: new Date(at.getTime() + 24 * 60 * 60_000),
    async validateCurrentAuthority(tx, _candidate, checkedAt) {
      const floor = await botProtocolFloor(tx);
      if (floor === undefined || floor < SLACK_BOT_SYNC_PROTOCOL || floor > SLACK_VERIFIED_INGRESS_PROTOCOL) return false;
      const current = await lockedDecision(tx, checkedAt);
      if (current?.decision.kind !== "bot" || current.decision.providerBotId !== actorId) return false;
      if (!existing) return true;
      const [actor] = await tx.select().from(externalActorProjections).where(and(eq(externalActorProjections.id, projectionId),
        eq(externalActorProjections.appRegistrationId, authority.registrationId), eq(externalActorProjections.installId, authority.installId),
        eq(externalActorProjections.workspaceId, authority.providerAuthorityId), eq(externalActorProjections.externalActorId, actorId),
        eq(externalActorProjections.actorKind, "bot"), eq(externalActorProjections.state, "active"),
        eq(externalActorProjections.deactivated, false))).limit(1).for("share");
      return Boolean(actor);
    },
    async finalizeCurrentAuthority(tx, rawReceivedAt, checkedAt) {
      if (rawReceivedAt.getTime() !== receivedAt.getTime()) return false;
      if (!existing) await tx.insert(externalActorProjections).values({ id: projectionId, provider: "slack",
        appRegistrationId: authority.registrationId, installId: authority.installId, workspaceId: authority.providerAuthorityId,
        externalActorId: actorId, identityKind: "provider_actor", displayName: fallbackName, handles: [], actorKind: "bot",
        state: "active", deactivated: false, projectionRevision: 1, observedAt: checkedAt, createdAt: checkedAt, updatedAt: checkedAt }).onConflictDoNothing();
      const [actor] = await tx.select().from(externalActorProjections).where(and(eq(externalActorProjections.id, projectionId),
        eq(externalActorProjections.appRegistrationId, authority.registrationId), eq(externalActorProjections.installId, authority.installId),
        eq(externalActorProjections.workspaceId, authority.providerAuthorityId), eq(externalActorProjections.externalActorId, actorId),
        eq(externalActorProjections.actorKind, "bot"), eq(externalActorProjections.state, "active"),
        eq(externalActorProjections.deactivated, false))).limit(1).for("update");
      if (!actor) return false;
      if (pendingSince) {
        const current = await lockedDecision(tx, checkedAt);
        if (current?.decision.kind !== "bot" || current.decision.providerBotId !== actorId) return false;
        if (current.evidence.manualSkipCandidate) {
          const recorded = await tx.update(slackVerifiedIngressEvents).set({ lastIsolationReason: "bot_pending_same_channel_manual_skip" })
          .where(and(eq(slackVerifiedIngressEvents.appRegistrationId, authority.registrationId),
            eq(slackVerifiedIngressEvents.providerEventId, aad.providerEventId), eq(slackVerifiedIngressEvents.state, "processing"),
            eq(slackVerifiedIngressEvents.lastIsolationReason, "bot_outbound_pending"), eq(slackVerifiedIngressEvents.lastIsolatedAt, pendingSince))).returning({ id: slackVerifiedIngressEvents.id });
          if (recorded.length !== 1) return false;
        }
      }
      return true;
    } };
}
