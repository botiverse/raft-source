// RFC 082 §4.6 test fixture: a card message posted by an agent into a Slack
// bridged channel whose original delivery Slack accepted (or that is still
// queued), with the pair, installation, master switch and link it needs.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { messageCardMetadataAtSend, parseMessageCard, SLACK_BRIDGE_FEATURE_FLAG_KEYS, type MessageCard } from "@botiverse/raft-shared";

import type { Database } from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalDeliveryAttempts,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalOutboundDeliveries,
  featureFlagRules,
  messageCardRevisions,
  messages,
  oauthClients,
  serverAgentMembers,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import type { SlackBridgeRenderSnapshot } from "../services/externalDeliveryOutboxService";
import { updateFeatureFlag } from "../services/featureFlagService";
import { applyMessageCardUpdate } from "../services/messageCardService";
import { getOrCreateThreadForChannel } from "../services/channelService";
import { ensureJointStorageNamespace } from "./integration/jointFixture";

export const APP = "A_CARD";
export const TEAM = "T_CARD";
export const CONVERSATION = "C_CARD";
export const TS = "1793700000.000100";

export function card(state: string): MessageCard {
  const parsed = parseMessageCard({
    version: 1, root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["title", "state"] },
      title: { type: "Text", props: { text: "Build 1.19.0" } },
      state: { type: "Badge", props: { text: state } },
    },
  });
  assert.ok(parsed.ok);
  return parsed.card;
}

export interface SlackCardEditFixtureOptions {
  original?: "accepted" | "queued";
  /** The binding epoch's audience observation: matched (default), or none yet. */
  audience?: "matched" | "none";
  privacy?: "public" | "private";
  /** A real database shared by several cases needs a distinct App per seed. */
  providerAppId?: string;
  /** Where the card is posted: the paired channel (default), or a thread reply in it. */
  conversation?: "channel" | "thread";
}

export async function seedSlackCardEditFixture(db: Database, options: SlackCardEditFixtureOptions = {}) {
  const pair = await seedSlackCardEditPair(db, options);
  if ((options.audience ?? "matched") === "matched") await recordAudience(pair, "matched");
  const first = await seedCardOnPair(pair, { original: options.original ?? "accepted", ts: TS, position: 1,
    conversation: options.conversation ?? "channel" });
  return { ...pair, message: first.message, delivery: first.delivery };
}

/**
 * The fixture with the paired channel turned into one Server's projection of a
 * Joint Channel (the shape a conversion leaves: the same channel id, type
 * `joint`; the binding still anchored to it), another Server's projection
 * beside it, and the bridged card stored where a joint's messages live, its
 * canonical channel (or canonical thread). `pairRole: "host"` (default) is
 * the one side a bridge is provisioned on; "participant" is a binding no
 * provisioning makes, to show such a side never edits.
 */
export async function seedJointSlackCardEditFixture(db: Database, options: Pick<SlackCardEditFixtureOptions, "conversation" | "providerAppId"> & {
  pairRole?: "host" | "participant";
} = {}) {
  const { joint, ...pair } = await seedJointSlackCardEditPair(db, options);
  const first = await seedCardOnPair(pair, { original: "accepted", ts: TS, position: 1,
    conversation: options.conversation ?? "channel", jointCanonicalChannelId: joint.canonical.id });
  return { ...pair, message: first.message, delivery: first.delivery, joint };
}

/**
 * The joint pair of seedJointSlackCardEditFixture, its audience matched, with
 * no card on it yet: for a test that sends the card itself (a real send
 * through a projection, and its real outbound admission).
 */
export async function seedJointSlackCardEditPair(db: Database, options: Pick<SlackCardEditFixtureOptions, "providerAppId"> & {
  pairRole?: "host" | "participant";
} = {}) {
  const pair = await seedSlackCardEditPair(db, { providerAppId: options.providerAppId });
  const joint = await makePairChannelJoint(pair, options.pairRole ?? "host");
  await recordAudience(pair, "matched");
  return { ...pair, joint };
}

/** The pair's channel as `role`'s projection of a new Joint Channel; the other side a new Server with its own agent in its projection. */
async function makePairChannelJoint(pair: Pair, role: "host" | "participant") {
  const { db } = pair;
  const suffix = randomUUID().slice(0, 8);
  await db.update(channels).set({ type: "joint" }).where(eq(channels.id, pair.channel.id));
  // The joint posting authority (lockJointPostingAuthority) reads the agent's server membership, as createAgent writes it.
  await db.insert(serverAgentMembers).values({ serverId: pair.server.id, agentId: pair.agent.id }).onConflictDoNothing();
  const storageServerId = await ensureJointStorageNamespace(pair.owner.id);
  const [canonical] = await db.insert(channels).values({ serverId: storageServerId, name: `joint-storage-${randomUUID()}`, type: "channel" }).returning();
  const [otherOwner] = await db.insert(users).values({
    email: `card-edit-other-${suffix}@raft.test`, name: `card-edit-other-${suffix}`, passwordHash: "test-only", emailVerified: true,
  }).returning();
  const [other] = await db.insert(servers).values({ name: "Card edits (other side)", slug: `card-edits-other-${suffix}`, ownerId: otherOwner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: other!.id, userId: otherOwner!.id, role: "owner" });
  const [otherProjection] = await db.insert(channels).values({ serverId: other!.id, name: pair.channel.name, type: "joint" }).returning();
  await db.insert(channelHumans).values({ channelId: otherProjection!.id, userId: otherOwner!.id });
  const [otherAgent] = await db.insert(agents).values({ serverId: other!.id, name: `other-hands-${suffix}`, displayName: "Other Hands", runtime: "codex" }).returning();
  await db.insert(serverAgentMembers).values({ serverId: other!.id, agentId: otherAgent!.id });
  await db.insert(channelAgents).values({ channelId: otherProjection!.id, agentId: otherAgent!.id });
  const hostServerId = role === "host" ? pair.server.id : other!.id;
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical!.id, createdByServerId: hostServerId, createdByUserId: pair.owner.id }).returning();
  const pairSide = { serverId: pair.server.id, localChannelId: pair.channel.id, role };
  const otherSide = { serverId: other!.id, localChannelId: otherProjection!.id, role: role === "host" ? "participant" as const : "host" as const };
  // The host joined first.
  for (const side of role === "host" ? [pairSide, otherSide] : [otherSide, pairSide]) {
    await db.insert(jointChannelServers).values({ jointChannelId: joint!.id, ...side, joinedByUserId: pair.owner.id });
  }
  return { jointChannelId: joint!.id, canonical: canonical!, other: other!, otherOwner: otherOwner!, otherProjection: otherProjection!, otherAgent: otherAgent! };
}

/** The pair alone: server, channel, agent, App registration, installation, binding, master switch, queue partition. */
export async function seedSlackCardEditPair(db: Database, options: Pick<SlackCardEditFixtureOptions, "privacy" | "providerAppId"> = {}) {
  const appId = options.providerAppId ?? APP;
  const suffix = randomUUID().slice(0, 8);
  const privacy = options.privacy ?? "public";
  const [owner] = await db.insert(users).values({
    email: `card-edit-${suffix}@raft.test`, name: `card-edit-${suffix}`, passwordHash: "test-only", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Card edits", slug: `card-edits-${suffix}`, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [channel] = await db.insert(channels).values({ serverId: server!.id, name: `builds-${suffix}`,
    type: privacy === "private" ? "private" : "channel" }).returning();
  // A human member too, so removing the agent never empties (and deletes) a private channel.
  await db.insert(channelHumans).values({ channelId: channel!.id, userId: owner!.id });
  const [agent] = await db.insert(agents).values({ serverId: server!.id, name: `hands-${suffix}`, displayName: "Hands", runtime: "codex" }).returning();
  await db.insert(channelAgents).values({ channelId: channel!.id, agentId: agent!.id });
  const [client] = await db.insert(oauthClients).values({
    serverId: server!.id, clientId: `card-edit-${suffix}`, clientSecretHash: "hash", appType: "slock_builtin",
    name: "Slack", createdByUserId: owner!.id,
  }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: client!.id, provider: "slack", environment: "test", providerAppId: appId,
    providerOAuthClientId: `card-edit-${suffix}`, capabilityManifestVersion: 1, capabilityManifestHash: "manifest",
    requiredCapabilities: [],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server!.id, registrationId: registration!.id, state: "active", grantEpoch: 1, grantedManifestVersion: 1,
    grantedManifestHash: "manifest", grantedCapabilities: [], grantedByType: "human", grantedById: owner!.id,
  }).returning();
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server!.id, registrationId: registration!.id, serverGrantId: grant!.id, grantEpoch: 1, state: "active",
    connectionEpoch: 1, scopeRevision: 1, credentialRevision: 1, installedScopes: ["chat:write"],
    providerAppId: appId, providerTeamId: TEAM, authorityType: "team", providerAuthorityId: TEAM,
    botUserId: "U_BOT", providerBotId: "B_BOT",
  }).returning();
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server!.id, registrationId: registration!.id, installId: install!.id, channelId: channel!.id,
    providerConversationId: CONVERSATION, providerConversationKind: privacy === "private" ? "private_channel" : "public_channel",
    privacyClass: privacy,
    ...(privacy === "private" ? { audienceRevision: 1, audienceFreshUntil: new Date(Date.now() + 30 * 24 * 60 * 60_000) } : {}),
    state: "active", grantEpoch: 1, connectionEpoch: 1, bindingEpoch: 1,
    consentedByType: "human", consentedById: owner!.id, consentedAt: new Date(),
  }).returning();
  assert.ok(await updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: true, killSwitch: false }));
  await db.insert(featureFlagRules).values({
    flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, stage: "server", priority: 100, decision: "allow", values: [server!.id],
  });
  await db.insert(externalDeliveryPartitions).values({ bindingId: binding!.id, bindingEpoch: 1 });
  return { db, owner: owner!, server: server!, channel: channel!, agent: agent!, registration: registration!,
    install: install!, binding: binding! };
}
type Pair = Awaited<ReturnType<typeof seedSlackCardEditPair>>;
export type SlackCardEditFixture = Pair & {
  message: typeof messages.$inferSelect;
  delivery: typeof externalOutboundDeliveries.$inferSelect;
};
type Fixture = SlackCardEditFixture;

/** A new audience observation of the pair's binding epoch (the next revision). */
export async function recordAudience(pair: Pick<Pair, "db" | "binding">, status: "matched" | "mismatch" | "unavailable",
  options: { expiresAt?: Date; bindingEpoch?: number } = {}) {
  const epoch = options.bindingEpoch ?? pair.binding.bindingEpoch;
  const existing = await pair.db.select({ revision: externalBindingAudienceSnapshots.audienceRevision })
    .from(externalBindingAudienceSnapshots).where(eq(externalBindingAudienceSnapshots.bindingId, pair.binding.id));
  const observedAt = new Date(Date.now() - 60_000);
  await pair.db.insert(externalBindingAudienceSnapshots).values({
    bindingId: pair.binding.id, bindingEpoch: epoch,
    audienceRevision: Math.max(0, ...existing.map((row) => row.revision)) + 1,
    externalMemberCount: 1, externalAudienceDigest: "a".repeat(64), raftMemberCount: 1, raftAudienceDigest: "b".repeat(64),
    status, observedAt, expiresAt: options.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60_000),
  });
}

/** A card message (revision 1) bridged on the pair at the next queue position, its original accepted with `ts` or queued. */
export async function seedCardOnPair(pair: Pair, input: {
  original: "accepted" | "queued"; ts: string; position: number; conversation?: "channel" | "thread";
  /** The paired channel is a Joint projection: the card (and a thread's root) is stored in this canonical channel. */
  jointCanonicalChannelId?: string;
}): Promise<Pick<Fixture, "message" | "delivery">> {
  const { db, server, channel, agent, registration, install, binding } = pair;
  const first = card("In review");
  const storageChannelId = input.jointCanonicalChannelId ?? channel.id;
  // A thread reply: its root in the paired channel, the card in the root's thread.
  const thread = input.conversation === "thread" && input.jointCanonicalChannelId ? await (async () => {
    // A joint thread: the root in canonical storage, the canonical thread and
    // the paired side's local face opened the way the write paths open them.
    const [root] = await db.insert(messages).values({ channelId: storageChannelId, senderType: "user", senderId: pair.owner.id,
      content: "release thread", messageType: "chat" }).returning();
    const opened = await getOrCreateThreadForChannel(channel.id, root!.id, pair.owner.id, "user");
    const [threadChannel] = await db.select().from(channels).where(eq(channels.id, opened.canonicalThreadChannelId));
    return { root: root!, channel: threadChannel! };
  })() : input.conversation === "thread" ? await (async () => {
    const [root] = await db.insert(messages).values({ channelId: channel.id, senderType: "user", senderId: pair.owner.id,
      content: "release thread", messageType: "chat" }).returning();
    const [threadChannel] = await db.insert(channels).values({ serverId: server.id, name: `thread-${root!.id.slice(0, 8)}`,
      type: "thread", parentMessageId: root!.id, parentChannelId: channel.id }).returning();
    await db.update(messages).set({ threadId: threadChannel!.id }).where(eq(messages.id, root!.id));
    return { root: root!, channel: threadChannel! };
  })() : null;
  const [message] = await db.insert(messages).values({
    channelId: thread?.channel.id ?? storageChannelId, senderType: "agent", senderId: agent.id, content: `Build 1.19.${input.position - 1} · In review`,
    messageType: "chat", actionMetadata: messageCardMetadataAtSend(first, new Date()),
  }).returning();
  await db.insert(messageCardRevisions).values({
    messageId: message!.id, revision: 1, card: first, content: message!.content, senderAgentId: agent.id,
  });
  const snapshot: SlackBridgeRenderSnapshot = {
    schema: "slack-bridge-render-snapshot.v5",
    sourceMessageId: message!.id,
    sourceMessageSeq: message!.seq,
    canonicalConversationId: thread?.channel.id ?? storageChannelId,
    level: thread ? "thread" : "top_level",
    canonicalRootMessageId: thread?.root.id ?? null,
    sourcePermalink: `https://app.slock.ai/s/${server.slug}/channel/${channel.id}?msg=${message!.id}`,
    senderType: "agent",
    senderId: agent.id,
    authorName: "Hands",
    authorPresentation: { displayName: "Hands", fallbackKind: "agent", avatar: null },
    sanitizedText: message!.content,
    externalMentions: [],
    raftMentionSubstitutions: [],
    attachments: [],
    bindingAuthority: {
      provider: "slack", environment: "test", appRegistrationId: registration.id, installId: install.id,
      workspaceId: TEAM, connectionEpoch: 1, bindingId: binding.id, bindingEpoch: 1, memberRevision: 1,
      contextRevision: 1, privacyClass: binding.privacyClass, raftChannelId: channel.id, providerAuthorityId: TEAM,
      providerConversationId: CONVERSATION,
    },
    enqueueRuntimeRevision: "runtime-card",
  };
  const accepted = input.original === "accepted";
  // The partition tail is checked against its deliveries at commit: write both together.
  const delivery = await db.transaction(async (tx) => {
    await tx.update(externalDeliveryPartitions).set({ lastEnqueuedPosition: input.position,
      ...(accepted ? { cursorPosition: input.position } : {}) })
      .where(eq(externalDeliveryPartitions.bindingId, binding.id));
    const [inserted] = await tx.insert(externalOutboundDeliveries).values({
      sourceMessageId: message!.id, bindingId: binding.id, bindingEpoch: 1, partitionPosition: input.position,
      enqueueRuntimeRevision: "runtime-card", renderSnapshotSchema: snapshot.schema,
      renderSnapshot: snapshot as unknown as Record<string, unknown>,
      renderSnapshotDigest: String(input.position % 10).repeat(64).replace(/^./u, "d"),
      // Unique across the database (one real database serves several cases).
      reconciliationMarker: createHash("sha256").update(message!.id).digest("base64url").slice(0, 43),
      ...(accepted ? {
        state: "accepted" as const, providerAttempts: 1, firstDispatchedAt: new Date(), providerMessageId: input.ts, acceptedAt: new Date(),
      } : { state: "queued" as const }),
    }).returning();
    return inserted!;
  });
  if (accepted) await confirmOriginal(db, { delivery, install, binding, message: message! }, { onlyLink: true, ts: input.ts,
    ...(thread ? { threadTs: "1793690000.000001" } : {}) });
  return { message: message!, delivery };
}

export async function confirmOriginal(db: Database, fixture: Pick<Fixture, "delivery" | "install" | "binding" | "message">,
  options: { onlyLink?: boolean; ts?: string; threadTs?: string } = {}) {
  const ts = options.ts ?? TS;
  if (!options.onlyLink) {
    await db.update(externalOutboundDeliveries).set({ state: "accepted", providerAttempts: 1,
      firstDispatchedAt: new Date(), providerMessageId: ts, acceptedAt: new Date(), nextAttemptAt: null, stateReason: null })
      .where(eq(externalOutboundDeliveries.id, fixture.delivery.id));
    await db.delete(externalMessageLinks).where(eq(externalMessageLinks.deliveryId, fixture.delivery.id));
  }
  await db.insert(externalDeliveryAttempts).values({
    deliveryId: fixture.delivery.id, attemptNumber: 1, leaseGeneration: 1, runtimeRevision: "runtime-card",
    credentialRevision: 1, dispatchAuthorization: "automatic", providerIoStartedAt: new Date(), outcome: "accepted",
    outcomeReason: "provider_accepted", terminalAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(externalMessageLinks).values({
    deliveryId: fixture.delivery.id, provider: "slack", installId: fixture.install.id, providerAuthorityId: TEAM,
    providerConversationId: CONVERSATION, providerMessageId: ts, providerThreadId: options.threadTs ?? null,
    bindingId: fixture.binding.id, bindingEpoch: 1,
    connectionEpoch: 1, raftMessageId: fixture.message.id, firstDirection: "raft_outbound",
    payloadFingerprint: fixture.delivery.renderSnapshotDigest, outcomeState: "accepted", authorityState: "active",
  });
}

export async function updateCard(fixture: Pick<Fixture, "message" | "agent">, state: string, at: Date, content?: string) {
  const outcome = await applyMessageCardUpdate({
    messageId: fixture.message.id, senderAgentId: fixture.agent.id, card: card(state),
    content: content ?? `Build 1.19.0 · ${state}`, now: at,
  });
  assert.equal(outcome.kind, "updated");
  return outcome.kind === "updated" ? outcome.answer.revision : 0;
}
