import { and, desc, eq, gt, ne } from "drizzle-orm";
import type { ExternalAddressabilityContext } from "@botiverse/raft-shared";
import type { Database, DatabaseExecutor } from "../db/index";
import { externalActorProjections, externalAddressabilityProjections, externalAppInstalls, externalChannelBindings, slackVerifiedIngressRollout } from "../db/schema";
import { SLACK_BOT_MENTION_READER_PROTOCOL, SLACK_VERIFIED_INGRESS_PROTOCOL } from "./slackVerifiedIngressRolloutContracts";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import { readSlackInboundCurrentSelfBotId } from "./slackInboundSelfIdentity";

export type SlackBotMentionAuthority = {
  bot: Pick<typeof externalActorProjections.$inferSelect, "id" | "provider" | "appRegistrationId" | "installId" | "workspaceId"
    | "externalActorId" | "displayName" | "state" | "deactivated" | "avatarArtifactId">;
  user: Pick<typeof externalActorProjections.$inferSelect, "id" | "handles">;
  addressability: Pick<typeof externalAddressabilityProjections.$inferSelect,
    "memberRevision" | "contextRevision" | "state" | "observedAt" | "expiresAt">;
  userId: string;
  mappingRevision: number;
};

/**
 * One verified bot-to-user mapping is usable only in the exact live pair in
 * which Slack observed the user. No mapping grants a Raft principal or role.
 * Call inside a transaction so the authority and projection row locks last
 * through fact creation or the immediate pre-send validation.
 */
export async function readSlackBotMentionAuthority(input: {
  executor: DatabaseExecutor; context: ExternalAddressabilityContext; botProjectionId: string;
  now: Date; expectedMappingRevision?: number;
}): Promise<SlackBotMentionAuthority | null> {
  const { executor: tx, context: c, now } = input;
  if (c.provider !== "slack" || !Number.isFinite(now.getTime())
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(c.bindingId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(c.installId)) return null;
  // Below protocol 3 no durable B-identity fact or snapshot may be created:
  // older outbound readers reject it. The floor is sticky and never decreases.
  const [rollout] = await tx.select({ floor: slackVerifiedIngressRollout.minimumWriterProtocol })
    .from(slackVerifiedIngressRollout).where(eq(slackVerifiedIngressRollout.id, 1)).limit(1);
  if (!rollout || rollout.floor < SLACK_BOT_MENTION_READER_PROTOCOL || rollout.floor > SLACK_VERIFIED_INGRESS_PROTOCOL) return null;
  // Install first, then the binding and actor: profile refresh takes the same
  // installation lock before changing a mapping or its conflict set.
  const [install] = await tx.select().from(externalAppInstalls).where(eq(externalAppInstalls.id, c.installId)).limit(1).for("share");
  const [binding] = await tx.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, c.bindingId)).limit(1).for("share");
  if (!install || !install.providerBotId || !install.botUserId || !binding || install.state !== "active" || binding.state !== "active" || binding.installId !== install.id
    || binding.registrationId !== c.appRegistrationId || install.providerAuthorityId !== c.workspaceId
    || binding.providerConversationId !== c.conversationId || binding.connectionEpoch !== c.connectionEpoch
    || binding.bindingEpoch !== c.bindingEpoch) return null;
  const authority = await resolveExternalBindingAuthority({ serverId: binding.serverId, bindingId: binding.id,
    expectedConnectionEpoch: c.connectionEpoch, expectedBindingEpoch: c.bindingEpoch, now }, tx as Database);
  if (!authority.active || authority.fact.registrationId !== c.appRegistrationId || authority.fact.installId !== c.installId
    || authority.fact.providerAuthorityId !== c.workspaceId || authority.fact.providerConversationId !== c.conversationId) return null;
  const selfBotId = await readSlackInboundCurrentSelfBotId({ db: tx, authority: authority.fact, now });
  if (!selfBotId || selfBotId !== install.providerBotId) return null;
  const [bot] = await tx.select().from(externalActorProjections).where(and(eq(externalActorProjections.id, input.botProjectionId),
    eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.appRegistrationId, c.appRegistrationId),
    eq(externalActorProjections.installId, c.installId), eq(externalActorProjections.workspaceId, c.workspaceId),
    eq(externalActorProjections.actorKind, "bot"), eq(externalActorProjections.state, "active"),
    eq(externalActorProjections.deactivated, false))).limit(1).for("share");
  if (!bot || !/^B[A-Z0-9]{2,159}$/u.test(bot.externalActorId) || bot.externalActorId === install.providerBotId
    || !bot.slackBotUserId || bot.slackBotUserId === install.botUserId || bot.slackBotMappingConflict
    || bot.slackBotConnectionEpoch !== authority.fact.connectionEpoch
    || bot.slackBotCredentialRevision !== authority.fact.credentialRevision || bot.slackBotScopeRevision !== authority.fact.scopeRevision
    || !bot.slackBotMappingObservedAt || bot.slackBotMappingObservedAt > now || !bot.slackBotMappingExpiresAt || bot.slackBotMappingExpiresAt <= now
    || (input.expectedMappingRevision !== undefined && bot.slackBotMappingRevision !== input.expectedMappingRevision)) return null;
  // Any second claimant is ambiguous even if its cache is stale: never infer
  // which bot owns the Slack user from observation order.
  const others = await tx.select({ id: externalActorProjections.id }).from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.appRegistrationId, c.appRegistrationId),
    eq(externalActorProjections.installId, c.installId), eq(externalActorProjections.workspaceId, c.workspaceId),
    eq(externalActorProjections.actorKind, "bot"), eq(externalActorProjections.slackBotUserId, bot.slackBotUserId),
    ne(externalActorProjections.id, bot.id))).limit(1);
  if (others.length) return null;
  const [user] = await tx.select().from(externalActorProjections).where(and(eq(externalActorProjections.provider, "slack"),
    eq(externalActorProjections.appRegistrationId, c.appRegistrationId), eq(externalActorProjections.installId, c.installId),
    eq(externalActorProjections.workspaceId, c.workspaceId), eq(externalActorProjections.externalActorId, bot.slackBotUserId),
    eq(externalActorProjections.actorKind, "remote"), eq(externalActorProjections.state, "active"),
    eq(externalActorProjections.deactivated, false))).limit(1).for("share");
  if (!user) return null;
  const [addressability] = await tx.select().from(externalAddressabilityProjections).where(and(
    eq(externalAddressabilityProjections.projectionId, user.id), eq(externalAddressabilityProjections.provider, "slack"),
    eq(externalAddressabilityProjections.appRegistrationId, c.appRegistrationId), eq(externalAddressabilityProjections.installId, c.installId),
    eq(externalAddressabilityProjections.workspaceId, c.workspaceId), eq(externalAddressabilityProjections.bindingId, c.bindingId),
    eq(externalAddressabilityProjections.bindingEpoch, c.bindingEpoch), eq(externalAddressabilityProjections.connectionEpoch, c.connectionEpoch),
    eq(externalAddressabilityProjections.conversationId, c.conversationId), eq(externalAddressabilityProjections.state, "active"),
    gt(externalAddressabilityProjections.expiresAt, now))).orderBy(desc(externalAddressabilityProjections.memberRevision)).limit(1).for("share");
  if (!addressability || addressability.observedAt > now) return null;
  return { bot, user, addressability, userId: bot.slackBotUserId, mappingRevision: bot.slackBotMappingRevision };
}
