import { and, eq, isNull, or } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import type { DatabaseExecutor } from "../db/index";
import {
  agents, channelAgents, channelHumans, channels, externalActorProjections,
  externalAddressabilityProjections, externalHumanIdentityLinks, externalMentionFacts, messageMentions,
  serverMembers, slackUsergroupIdentities,
} from "../db/schema";
import type { ProviderNeutralOutboundBindingAuthority, SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import { readSlackBotMentionAuthority } from "./slackBotMentionAuthority";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import { ambiguousSlackMentionHandles } from "./slackProviderAdapter";

type RenderMentions = Pick<SlackBridgeRenderSnapshot, "externalMentions" | "raftMentionSubstitutions">;

/** Current notification authority may narrow frozen intent, never choose another target. */
export async function resolveCurrentSlackRenderMentions(
  db: DatabaseExecutor,
  snapshot: SlackBridgeRenderSnapshot,
  current: ProviderNeutralOutboundBindingAuthority,
  now: Date = currentDate(),
): Promise<RenderMentions> {
  const result: RenderMentions = { externalMentions: [], raftMentionSubstitutions: [] };
  try {
    const ambiguous = ambiguousSlackMentionHandles(snapshot);
    const currentSlackMember = async (externalActorId: string) => {
      const members = await db.select({ id: externalActorProjections.id }).from(externalActorProjections)
        .innerJoin(externalAddressabilityProjections, eq(externalAddressabilityProjections.projectionId, externalActorProjections.id))
        .where(and(
          eq(externalActorProjections.provider, "slack"),
          eq(externalActorProjections.appRegistrationId, current.appRegistrationId),
          eq(externalActorProjections.installId, current.installId),
          eq(externalActorProjections.workspaceId, current.providerAuthorityId),
          eq(externalActorProjections.externalActorId, externalActorId),
          eq(externalActorProjections.state, "active"), eq(externalActorProjections.deactivated, false),
          eq(externalAddressabilityProjections.bindingId, current.bindingId),
          eq(externalAddressabilityProjections.bindingEpoch, current.bindingEpoch),
          eq(externalAddressabilityProjections.connectionEpoch, current.connectionEpoch),
          eq(externalAddressabilityProjections.conversationId, current.providerConversationId),
          eq(externalAddressabilityProjections.state, "active"),
        )).limit(2);
      return members.length === 1;
    };
    const frozenFacts = snapshot.externalMentions.length ? await db.select().from(externalMentionFacts)
      .where(eq(externalMentionFacts.messageId, snapshot.sourceMessageId)) : [];
    for (const mention of snapshot.externalMentions) {
      const facts = frozenFacts.filter((fact) => fact.projectionId === mention.projectionId);
      const fact = facts.length === 1 ? facts[0] : null;
      const originalIntent = fact && fact.provider === mention.provider
        && fact.appRegistrationId === mention.appRegistrationId && fact.installId === mention.installId
        && fact.workspaceId === mention.workspaceId && fact.externalActorId === mention.externalActorId
        && fact.connectionEpoch === mention.connectionEpoch && fact.bindingId === mention.bindingId
        && fact.bindingEpoch === mention.bindingEpoch && fact.conversationId === mention.conversationId
        && fact.memberRevision === mention.memberRevision && fact.contextRevision === mention.contextRevision
        && fact.freshnessObservedAt.toISOString() === mention.freshnessObservedAt
        && fact.freshnessExpiresAt.toISOString() === mention.freshnessExpiresAt
        && fact.handleAtSendTime === mention.handleSnapshot && fact.resolutionReason === mention.resolutionReason;
      if (!originalIntent || ambiguous.has(mention.handleSnapshot)) continue;
      if (mention.externalActorId.startsWith("B")) {
        // The snapshot and fact keep B identity; U exists only in this
        // transient render after the exact mapping version is locked again.
        if (!fact?.slackBotMappingRevision) continue;
        const mapping = await readSlackBotMentionAuthority({ executor: db, botProjectionId: mention.projectionId,
          expectedMappingRevision: fact.slackBotMappingRevision, now, context: {
            provider: current.provider, appRegistrationId: current.appRegistrationId, installId: current.installId,
            workspaceId: current.providerAuthorityId, connectionEpoch: current.connectionEpoch, bindingId: current.bindingId,
            bindingEpoch: current.bindingEpoch, conversationId: current.providerConversationId,
            memberRevision: mention.memberRevision, contextRevision: mention.contextRevision } });
        if (mapping && mapping.bot.externalActorId === mention.externalActorId) {
          result.externalMentions.push({ ...mention, externalActorId: mapping.userId });
        }
      } else if (fact?.slackBotMappingRevision === null && await currentSlackMember(mention.externalActorId)) {
        result.externalMentions.push(mention);
      }
    }
    if (!snapshot.raftMentionSubstitutions.length) return result;
    const bound = await resolveExternalConversationTarget({ executor: db, authorityChannelId: current.raftChannelId });
    if (!bound || bound.level !== "top_level") return result;
    const scopes = new Map<string, { id: string; serverId: string; type: string } | null>();
    const currentScope = async (channelId: string) => {
      if (scopes.has(channelId)) return scopes.get(channelId) ?? null;
      const face = await resolveExternalConversationTarget({ executor: db, authorityChannelId: channelId });
      const parent = face?.level === "thread"
        ? await resolveExternalConversationTarget({ executor: db, authorityChannelId: face.bindingChannelId }) : face;
      let scope = null;
      if (face && parent?.storageChannelId === bound.storageChannelId) {
        const [row] = await db.select({ id: channels.id, serverId: channels.serverId, type: channels.type }).from(channels)
          .where(and(eq(channels.id, face.bindingChannelId), isNull(channels.deletedAt), isNull(channels.archivedAt))).limit(1);
        if (row && row.serverId === face.serverId) scope = row;
      }
      scopes.set(channelId, scope);
      return scope;
    };
    // The original stable Raft target is in the send-time fact. A handle or an
    // old Slack token alone cannot establish who the user intended to mention.
    const facts = await db.select().from(messageMentions).where(and(
      eq(messageMentions.messageId, snapshot.sourceMessageId), eq(messageMentions.notifiableAtSend, true),
      eq(messageMentions.confidence, "exact"),
    ));
    for (const substitution of snapshot.raftMentionSubstitutions) {
      if (ambiguous.has(substitution.handle)) continue;
      const intended = facts.filter((fact) => fact.handleAtSendTime === substitution.handle);
      if (intended.length !== 1) continue;
      const principal = intended[0]!;
      const channel = await currentScope(principal.channelId);
      if (!channel || channel.serverId !== principal.serverId) continue;
      if (principal.targetType === "user") {
        const [member] = await db.select({ id: serverMembers.userId }).from(serverMembers).where(and(
          eq(serverMembers.serverId, channel.serverId), eq(serverMembers.userId, principal.targetId),
        )).limit(1);
        if (!member) continue;
        if (channel.type === "private") {
          const [allowed] = await db.select({ id: channelHumans.userId }).from(channelHumans).where(and(
            eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, principal.targetId),
          )).limit(1);
          if (!allowed) continue;
        }
      } else {
        const [member] = await db.select({ id: agents.id }).from(agents).innerJoin(channelAgents,
          eq(channelAgents.agentId, agents.id)).where(and(eq(agents.id, principal.targetId),
          eq(agents.serverId, channel.serverId), isNull(agents.deletedAt),
          eq(channelAgents.channelId, channel.id))).limit(1);
        if (!member) continue;
      }
      const group = /^<!subteam\^(S[A-Z0-9_]{2,})>$/.exec(substitution.token);
      if (substitution.kind === "usergroup" && group) {
        const identities = await db.select({ providerUsergroupId: slackUsergroupIdentities.providerUsergroupId }).from(slackUsergroupIdentities).where(and(
          eq(slackUsergroupIdentities.installId, current.installId),
          eq(slackUsergroupIdentities.principalId, principal.targetId),
          eq(slackUsergroupIdentities.principalKind, principal.targetType),
          or(
            and(eq(slackUsergroupIdentities.principalKind, "user"), eq(slackUsergroupIdentities.humanCanonical, true)),
            and(eq(slackUsergroupIdentities.principalKind, "agent"), eq(slackUsergroupIdentities.serverId, channel.serverId)),
          ),
        )).limit(2);
        const destination = identities.length === 1 ? identities[0]!.providerUsergroupId : null;
        if (destination && /^S[A-Z0-9_]{2,}$/.test(destination)) {
          result.raftMentionSubstitutions.push({ ...substitution, token: `<!subteam^${destination}>` });
        }
      } else if (substitution.kind === "user" && principal.targetType === "user") {
        const user = /^<@([UW][A-Z0-9_]{2,})>$/.exec(substitution.token);
        if (!user) continue;
        const links = await db.select({ providerUserId: externalHumanIdentityLinks.providerUserId }).from(externalHumanIdentityLinks).where(and(
          eq(externalHumanIdentityLinks.installId, current.installId), eq(externalHumanIdentityLinks.userId, principal.targetId),
          eq(externalHumanIdentityLinks.providerAuthorityId, current.providerAuthorityId),
          eq(externalHumanIdentityLinks.state, "active"),
        )).limit(2);
        const destination = links.length === 1 ? links[0]!.providerUserId : null;
        if (destination && /^[UW][A-Z0-9_]{2,}$/.test(destination) && await currentSlackMember(destination)) {
          result.raftMentionSubstitutions.push({ ...substitution, token: `<@${destination}>` });
        }
      }
    }
    return result;
  } catch {
    console.warn("[SlackBridge] notification lookup degraded", { event: "server.slack_bridge.mentions.degraded",
      messageId: snapshot.sourceMessageId, bindingId: current.bindingId, reason: "mapping_read_failed" });
    // A mapping/display read failure does not suppress the body. Current body
    // access and credential authority are still checked by the worker/transport.
    return { externalMentions: [], raftMentionSubstitutions: [] };
  }
}
