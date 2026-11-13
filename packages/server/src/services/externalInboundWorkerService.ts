import { slackFallbackWaitElapsed } from "./slackFallbackPolicy";
import { ConfirmedHistoricalReceiptMissing, externalMessageReceiptScope, historicalProviderReceiptIsAbsent } from "./externalMessageReceiptScope";
import { renderSlackEmojiShortcodes } from "./slackEmojiShortcodes";
import { parseSlackEditTimestamp, slackEditTimestampIsNewer } from "./slackMessageEditTimestamp";
import { createHash } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import {
  clearClockInterval,
  currentDate,
  extractRaftMentionHandles,
  isMessageCardMetadata,
  resolveRaftMentionHandle,
  setClockInterval,
} from "@botiverse/raft-shared";
import { logMessageChanged } from "./messageChangeLog";

import { withSlackIngressProtocol, readSlackIngressRollout } from "./slackVerifiedIngressRollout";
import { SlackIngressRolloutUnavailable } from "./slackVerifiedIngressRolloutContracts";
import { SlackNormalizedEnvelopeInvalid } from "./slackNormalizedPayloadError";
import type { Database, DatabaseExecutor, DatabaseTransaction } from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAddressabilityProjections,
  externalAppInstalls,
  externalInboundEvents,
  externalMessageLinks,
  externalMessageAuthorFacts,
  externalMentionFacts,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  slackVerifiedIngressEvents,
  slackVerifiedIngressPartitions,
  users,
} from "../db/schema";
import {
  insertCanonicalExternalMessage,
  insertSlackHistoricalAuthorMessage,
  insertSlackProvisionalProfileMessage,
  insertSlackFallbackAuthorMessage,
  SLACK_PROFILE_WAIT_MS,
  insertExternalMentionFact,
  MAX_EXTERNAL_MESSAGE_BYTES,
  MAX_SLACK_EXTERNAL_MESSAGE_BYTES,
  resolveExternalMentionFromDurableAuthority,
  lockSlackMentionAuthority,
} from "./externalProjectionService";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import { recordInboxFactsForPersistedMessages } from "./messageService";
import { slackBotWakeIsLimited } from "./slackBotWakeLimit";
import type { JointThreadProjection } from "./channelService";
import {
  getActiveJointChannelProjectionsByLocalChannel,
  getActiveJointThreadProjectionsByCanonicalThread,
  isChannelAgent,
  isChannelHuman,
  startReadPositionAtJoin,
} from "./channelService";
import {
  createInboundExternalAttachmentTransferWithExecutor,
} from "./externalAttachmentTransferService";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService";
import { applyExternalReactionObservation } from "./externalReactionSyncService";
import {
  normalizeSlackMentionHandle,
  renderSlackUsergroupMentions,
  type SlackUsergroupMention,
} from "./slackMentionTokens";

const INBOUND_LEASE_MS = 60_000;
const INBOUND_BLOCKED_RETRY_MS = 30_000;
const INBOUND_PAYLOAD_SCHEMA_V1 = "external-inbound-normalized-event.v1" as const;
const INBOUND_PAYLOAD_SCHEMA_V2 = "external-inbound-normalized-event.v2" as const;
const INBOUND_PAYLOAD_SCHEMA_V3 = "external-inbound-normalized-event.v3" as const;
// Old workers quarantine and erase unknown v4 payloads. Do not add a producer
// until every old reader has exited and deployment/rollback is fenced.
const INBOUND_PAYLOAD_SCHEMA_V4 = "external-inbound-normalized-event.v4" as const;
const INBOUND_EDIT_PAYLOAD_SCHEMA = "external-inbound-normalized-edit.v1" as const;
const INBOUND_REACTION_PAYLOAD_SCHEMA = "external-inbound-normalized-reaction.v1" as const;
const ATTACHMENT_UNAVAILABLE_MARKER = "[One or more attachments unavailable]";

type InboundEvent = typeof externalInboundEvents.$inferSelect;

class ExternalInboundTargetUnavailableError extends Error {}

type LockedJointParentProjection = {
  serverId: string;
  localChannelId: string;
  role: "host" | "participant";
  status: "active" | "disconnected";
  joinedByUserId: string | null;
  channel: typeof channels.$inferSelect;
};

let inboundEventRowLockHookForTests: (() => Promise<void> | void) | null = null;
let inboundCanonicalCommitHookForTests: (() => Promise<void> | void) | null = null;

export function __setExternalInboundEventRowLockHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  inboundEventRowLockHookForTests = hook;
}

export function __setExternalInboundCanonicalCommitHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  inboundCanonicalCommitHookForTests = hook;
}

type ExternalInboundNormalizedMessageFields = {
  projectionId: string;
  actorProjectionRevision: number;
  externalActorId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  content: string;
  createdAt: string;
  fallbackAuthor?: "anonymous" | "unresolved";
  sourceVerifiedEdit?: true;
};

export type ExternalInboundNormalizedMessage = ExternalInboundNormalizedMessageFields & (
  | { schema: typeof INBOUND_EDIT_PAYLOAD_SCHEMA; providerFileIds: string[]; providerAgentMentions: SlackUsergroupMention[]; providerEditedTs: string }
  | { schema: typeof INBOUND_PAYLOAD_SCHEMA_V1 }
  | { schema: typeof INBOUND_PAYLOAD_SCHEMA_V2; providerFileIds: string[] }
  | {
      schema: typeof INBOUND_PAYLOAD_SCHEMA_V3;
      providerFileIds: string[];
      providerAgentMentions: SlackUsergroupMention[];
    }
  | {
      schema: typeof INBOUND_PAYLOAD_SCHEMA_V4;
      providerFileIds: string[];
      providerAgentMentions: SlackUsergroupMention[];
      botPresentation: { displayName: string | null; avatarArtifactId: string | null };
    }
);

type ParsedExternalInboundNormalizedMessage = ExternalInboundNormalizedMessageFields & {
  providerFileIds: string[];
  providerAgentMentions: SlackUsergroupMention[];
} & (
  | { schema: typeof INBOUND_PAYLOAD_SCHEMA_V4; botPresentation: { displayName: string | null; avatarArtifactId: string | null }; providerEditedTs?: never }
  | { schema: typeof INBOUND_PAYLOAD_SCHEMA_V1 | typeof INBOUND_PAYLOAD_SCHEMA_V2 | typeof INBOUND_PAYLOAD_SCHEMA_V3 | typeof INBOUND_EDIT_PAYLOAD_SCHEMA; providerEditedTs?: string; botPresentation?: never }
);

type ParsedExternalInboundNormalizedReaction = {
  schema: typeof INBOUND_REACTION_PAYLOAD_SCHEMA;
  operation: "add" | "remove";
  providerMessageId: string;
  externalActorId: string;
  providerReactionKey: string;
  eventOccurredAt: string;
  eventSequence: number;
  botUserId: string;
};

export type ExternalInboundRuntimeAuthority = {
  runtimeRevision: string;
  provider: string;
  environment: "test" | "production";
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  bindingId: string;
  bindingEpoch: number;
  connectionEpoch: number;
  raftChannelId: string;
  privacyClass: "public" | "private";
};

export interface ExternalInboundWorkerDependencies {
  decryptNormalizedPayload(input: {
    eventId: string;
    ciphertext: string;
    envelopeKeyId: string;
    aad: {
      purpose: "external-inbound-normalized-event";
      aadVersion: 1;
      schemaVersion: 1 | 2 | 3 | 4;
      provider: string;
      environment: "test" | "production";
      appRegistrationId: string;
      installId: string;
      workspaceId: string;
      providerAuthorityId: string;
      providerConversationId: string;
      providerEventId: string;
      bindingId: string;
      bindingEpoch: number;
      connectionEpoch: number;
      runtimeRevision: string;
      raftChannelId: string;
      privacyClass: "public" | "private";
    };
    signal?: AbortSignal;
  }): Promise<string>;
  resolveCurrentRuntime(input: {
    eventId: string;
    frozenAuthority: ExternalInboundRuntimeAuthority;
    requiredCapabilities?: readonly ("attachment_transfer" | "reaction_sync")[];
    signal?: AbortSignal;
  }): Promise<(ExternalInboundRuntimeAuthority & { operationAuthority?: ExternalInboundRuntimeAuthority }) | null>;
  resolveProviderMentionProfiles?(input: {
    eventId: string;
    frozenAuthority: ExternalInboundRuntimeAuthority;
    providerUserIds: readonly string[];
    signal?: AbortSignal;
  }): Promise<readonly { providerUserId: string; displayName: string; handle: string | null }[]>;
  /**
   * Resolves Slack usergroup ids to the Raft principal whose managed group it
   * is: an Agent (`raft-agent:` marker) or a human (`raft-user:` marker).
   */
  resolveProviderAgentMentionHandles?(input: {
    eventId: string;
    frozenAuthority: ExternalInboundRuntimeAuthority;
    providerUsergroupIds: readonly string[];
    signal?: AbortSignal;
  }): Promise<readonly ExternalInboundProviderMentionHandle[] | null>;
  onMessageEdited?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onMessageCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onMessageCommittedError?(error: unknown): void;
  onReactionCommitted?(input: { eventId: string; messageId: string }): Promise<void> | void;
  onReactionCommittedError?(error: unknown): void;
  now?(): Date;
}

export type ExternalInboundWorkerResult =
  | { kind: "disabled" }
  | { kind: "empty" }
  | { kind: "blocked"; eventId: string; reason: string }
  | { kind: "committed" | "duplicate" | "echo"; eventId: string; messageId: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nonEmpty(value: unknown, max = 320): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validClock(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function frozenAuthority(event: InboundEvent): ExternalInboundRuntimeAuthority {
  return {
    runtimeRevision: event.runtimeRevision,
    provider: event.provider,
    environment: event.environment,
    appRegistrationId: event.appRegistrationId,
    installId: event.installId,
    workspaceId: event.workspaceId,
    providerAuthorityId: event.providerAuthorityId,
    providerConversationId: event.providerConversationId,
    bindingId: event.bindingId,
    bindingEpoch: event.bindingEpoch,
    connectionEpoch: event.connectionEpoch,
    raftChannelId: event.raftChannelId,
    privacyClass: event.privacyClass,
  };
}

function sameAuthority(left: ExternalInboundRuntimeAuthority, right: ExternalInboundRuntimeAuthority): boolean {
  return (Object.keys(right) as (keyof ExternalInboundRuntimeAuthority)[])
    .every((key) => left[key] === right[key]);
}

function appendAttachmentUnavailableMarker(content: string, provider: string): string {
  const suffix = `\n\n${ATTACHMENT_UNAVAILABLE_MARKER}`;
  const maximumContentBytes = (provider === "slack" ? MAX_SLACK_EXTERNAL_MESSAGE_BYTES : MAX_EXTERNAL_MESSAGE_BYTES)
    - Buffer.byteLength(suffix, "utf8");
  let prefix = "";
  let prefixBytes = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + characterBytes > maximumContentBytes) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${suffix}`;
}

const SLACK_NATIVE_USER_MENTION = /<@([A-Z0-9]{2,160})(?:\|[^>\r\n]{1,160})?>/gu;

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/gu, "\\$&");
}

function slackMentionLabel(
  providerUserId: string,
  actor: Pick<typeof externalActorProjections.$inferSelect, "displayName" | "handles">,
): string {
  const opaqueId = providerUserId.trim().toLocaleLowerCase("en-US");
  const handle = actor.handles.find((candidate) => (
    /^[\p{L}\p{N}._-]{1,80}$/u.test(candidate)
    && candidate.trim().toLocaleLowerCase("en-US") !== opaqueId
  ));
  if (handle) return `@${handle}`;
  const displayName = actor.displayName.trim().replace(/\s+/gu, " ").slice(0, 80);
  return displayName && displayName.toLocaleLowerCase("en-US") !== opaqueId
    ? `@${escapeMarkdownLabel(displayName)}`
    : "@Slack user";
}

export function renderSlackInboundMentionLabels(
  content: string,
  labelsByProviderUserId: ReadonlyMap<string, string>,
): string {
  const rendered = content.replace(SLACK_NATIVE_USER_MENTION, (_token, providerUserId: string) => (
    labelsByProviderUserId.get(providerUserId) ?? "@Slack user"
  ));
  if (Buffer.byteLength(rendered, "utf8") <= 40_000) return rendered;
  // A pathological body can contain thousands of short mention tokens. Keep
  // the accepted content bound without restoring opaque provider identifiers.
  return content.replace(SLACK_NATIVE_USER_MENTION, "@user");
}

async function renderProviderInboundMentions(
  executor: DatabaseExecutor,
  event: InboundEvent,
  content: string,
  providerProfiles: readonly { providerUserId: string; displayName: string; handle: string | null }[] = [],
): Promise<string> {
  if (event.provider !== "slack") return content;
  const emojiContent = renderSlackEmojiShortcodes(content);
  const providerUserIds = [...new Set(
    [...content.matchAll(SLACK_NATIVE_USER_MENTION)].map((match) => match[1]!),
  )];
  if (providerUserIds.length === 0) return emojiContent;
  const actors = await executor.select({
    externalActorId: externalActorProjections.externalActorId,
    displayName: externalActorProjections.displayName,
    handles: externalActorProjections.handles,
  }).from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, "slack"),
    eq(externalActorProjections.appRegistrationId, event.appRegistrationId),
    eq(externalActorProjections.installId, event.installId),
    eq(externalActorProjections.workspaceId, event.workspaceId),
    inArray(externalActorProjections.externalActorId, providerUserIds),
    eq(externalActorProjections.state, "active"),
    eq(externalActorProjections.deactivated, false),
  ));
  const labels = new Map(providerProfiles.map((profile) => [
    profile.providerUserId,
    slackMentionLabel(profile.providerUserId, {
      displayName: profile.displayName,
      handles: profile.handle ? [profile.handle] : [],
    }),
  ]));
  for (const actor of actors) {
    labels.set(actor.externalActorId, slackMentionLabel(actor.externalActorId, actor));
  }
  return renderSlackInboundMentionLabels(emojiContent, labels);
}

/**
 * The handle a Slack member's inbound `<@U…>` token was rendered as, when it is
 * one. `slackMentionLabel` falls back to a display name or "Slack user"; those
 * are not handles, so they carry no structured mention.
 */
function slackMentionHandle(
  providerUserId: string,
  actor: Pick<typeof externalActorProjections.$inferSelect, "displayName" | "handles">,
): string | null {
  const label = slackMentionLabel(providerUserId, actor);
  const handle = label.slice(1);
  return actor.handles.includes(handle) ? handle : null;
}

/**
 * Display-only structured mentions for Slack members picked in Slack.
 *
 * The outbound path already records a picked Slack member as an
 * `external_mention_facts` row, which is what makes Raft render the mention
 * styled. Inbound messages rendered `<@U…>` to `@handle` text but recorded
 * nothing, so the same person showed styled when mentioned from Raft and as
 * plain text when mentioned from Slack (yezizp, #wg-slack-bridge:54ae7275).
 *
 * This writes the fact only: never a `message_mentions` row. A Slack member is
 * not a Raft principal and is never notified (msg d6f3bb0d). Resolution goes
 * through the same durable addressability authority as the outbound path, so
 * only members this binding currently observes in the conversation are recorded; anyone else
 * stays plain text. Best effort: a fact that cannot be resolved is skipped,
 * never a reason to refuse the provider message.
 */
async function recordSlackInboundExternalMentionFacts(input: {
  executor: DatabaseExecutor;
  event: InboundEvent;
  messageId: string;
  providerUserIds: readonly string[];
  botUserId: string | null;
  now: Date;
}): Promise<void> {
  const { executor, event } = input;
  if (event.provider !== "slack") return;
  const memberIds = input.providerUserIds.filter((id) => id !== input.botUserId);
  if (memberIds.length === 0) return;
  const actors = await executor.select({
    id: externalActorProjections.id,
    externalActorId: externalActorProjections.externalActorId,
    displayName: externalActorProjections.displayName,
    handles: externalActorProjections.handles,
  }).from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, "slack"),
    eq(externalActorProjections.appRegistrationId, event.appRegistrationId),
    eq(externalActorProjections.installId, event.installId),
    eq(externalActorProjections.workspaceId, event.workspaceId),
    inArray(externalActorProjections.externalActorId, memberIds),
    eq(externalActorProjections.state, "active"),
    eq(externalActorProjections.deactivated, false),
  ));
  for (const actor of actors) {
    const handle = slackMentionHandle(actor.externalActorId, actor);
    if (!handle) continue;
    // This binding's newest observation of the member. The resolver below
    // re-checks it (active, unexpired, same binding/epochs), so a member who
    // left the conversation stays plain text.
    const [observed] = await executor.select({
      memberRevision: externalAddressabilityProjections.memberRevision,
      contextRevision: externalAddressabilityProjections.contextRevision,
    }).from(externalAddressabilityProjections).where(and(
      eq(externalAddressabilityProjections.projectionId, actor.id),
      eq(externalAddressabilityProjections.bindingId, event.bindingId),
      eq(externalAddressabilityProjections.bindingEpoch, event.bindingEpoch),
      eq(externalAddressabilityProjections.connectionEpoch, event.connectionEpoch),
      eq(externalAddressabilityProjections.conversationId, event.providerConversationId),
      eq(externalAddressabilityProjections.state, "active"),
      gt(externalAddressabilityProjections.expiresAt, input.now),
    )).orderBy(desc(externalAddressabilityProjections.memberRevision)).limit(1);
    if (!observed) continue;
    const resolution = await resolveExternalMentionFromDurableAuthority({
      executor,
      rawHandle: handle,
      explicitProjectionId: actor.id,
      raftPrincipalCollision: false,
      now: input.now,
      context: {
        provider: "slack",
        appRegistrationId: event.appRegistrationId,
        installId: event.installId,
        workspaceId: event.workspaceId,
        connectionEpoch: event.connectionEpoch,
        bindingId: event.bindingId,
        bindingEpoch: event.bindingEpoch,
        conversationId: event.providerConversationId,
        memberRevision: observed.memberRevision,
        contextRevision: observed.contextRevision,
      },
    });
    if (resolution.kind !== "resolved") continue;
    await insertExternalMentionFact({ executor, messageId: input.messageId, fact: resolution.fact });
  }
}

export type ExternalInboundProviderMentionHandle =
  | { agentId: string; providerUsergroupId: string; handle: string }
  | { userId: string; providerUsergroupId: string; handle: string };

type ResolvedSlackAgentMention = {
  agentId: string;
  handle: string;
  providerUsergroupId: string;
  label: string;
};

async function resolveSlackAgentMentions(
  executor: DatabaseExecutor,
  event: InboundEvent,
  mentions: readonly SlackUsergroupMention[],
  providerHandles: readonly ExternalInboundProviderMentionHandle[],
): Promise<ResolvedSlackAgentMention[]> {
  const requestedIds = new Set(mentions.map((mention) => mention.providerUsergroupId));
  if (event.provider !== "slack" || requestedIds.size === 0) return [];
  const rows = await executor.select({
    agentId: agents.id,
    name: agents.name,
  }).from(channelAgents)
    .innerJoin(channels, eq(channels.id, channelAgents.channelId))
    .innerJoin(agents, and(
      eq(agents.id, channelAgents.agentId),
      eq(agents.serverId, channels.serverId),
      isNull(agents.deletedAt),
    ))
    .where(eq(channelAgents.channelId, event.raftChannelId));
  const channelAgentsById = new Map(rows.map((row) => [row.agentId, row]));
  const byProviderId = new Map(providerHandles
    .filter((handle) => requestedIds.has(handle.providerUsergroupId))
    .flatMap((handle) => ("agentId" in handle ? [[handle.providerUsergroupId, handle] as const] : [])));
  const resolved = new Map<string, ResolvedSlackAgentMention>();
  for (const mention of mentions) {
    const providerHandle = byProviderId.get(mention.providerUsergroupId);
    if (!providerHandle) continue;
    const agent = channelAgentsById.get(providerHandle.agentId);
    if (!agent) continue;
    resolved.set(agent.agentId, {
      agentId: agent.agentId,
      handle: agent.name,
      providerUsergroupId: mention.providerUsergroupId,
      label: `@${agent.name}`,
    });
  }
  return [...resolved.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
}

// Every Slack-encoded entity: user/usergroup/channel mentions, links, specials.
const SLACK_ANGLE_TOKEN = /<[^<>\r\n]*>/gu;

type SlackPlainTextMentionTarget = {
  targetType: "user" | "agent";
  targetId: string;
  handle: string;
};

/**
 * Typed `@name` text that names a Raft member (Agent or human) of the mention
 * scope. Slack sends typed text unchanged when the author does not pick from
 * autocomplete — the only way to reach Raft-only humans, and Agents in
 * workspaces where Slack refuses the Agent usergroups. Slack's own `<…>`
 * tokens are removed first, so a picked Slack user or usergroup is never
 * matched a second time by its label; a target reached both ways keeps one
 * row (unique mention index). Matching follows Raft free-text mentions (word
 * boundary, code spans ignored, CJK suffix rule). Slack handles are
 * lower-case, so a case-insensitive match is accepted when exactly one scope
 * member has that name; any name shared by two members stays text.
 */
async function resolveSlackPlainTextMentions(
  executor: DatabaseExecutor,
  content: string,
  scopeChannelIds: readonly string[],
): Promise<SlackPlainTextMentionTarget[]> {
  const tokens = extractRaftMentionHandles(content.replace(SLACK_ANGLE_TOKEN, " ")).slice(0, 50);
  if (tokens.length === 0 || scopeChannelIds.length === 0) return [];
  const [agentRows, humanRows] = await Promise.all([
    executor.select({ id: agents.id, name: agents.name })
      .from(channelAgents)
      .innerJoin(channels, eq(channels.id, channelAgents.channelId))
      .innerJoin(agents, and(
        eq(agents.id, channelAgents.agentId),
        eq(agents.serverId, channels.serverId),
        isNull(agents.deletedAt),
      ))
      .where(inArray(channelAgents.channelId, [...scopeChannelIds])),
    executor.select({ id: users.id, name: users.name })
      .from(channelHumans)
      .innerJoin(users, eq(users.id, channelHumans.userId))
      .where(inArray(channelHumans.channelId, [...scopeChannelIds])),
  ]);
  const members = new Map<string, SlackPlainTextMentionTarget>();
  for (const row of agentRows) {
    members.set(`agent:${row.id}`, { targetType: "agent", targetId: row.id, handle: row.name });
  }
  for (const row of humanRows) {
    members.set(`user:${row.id}`, { targetType: "user", targetId: row.id, handle: row.name });
  }
  const index = (key: (name: string) => string) => {
    const byName = new Map<string, SlackPlainTextMentionTarget | null>();
    for (const member of members.values()) {
      const name = key(member.handle);
      byName.set(name, byName.has(name) ? null : member);
    }
    return byName;
  };
  const byName = index((name) => name);
  const byFoldedName = index((name) => name.toLocaleLowerCase("en-US"));
  const resolved = new Map<string, SlackPlainTextMentionTarget>();
  for (const token of tokens) {
    const exact = resolveRaftMentionHandle(token, (name) => byName.has(name));
    const member = exact
      ? byName.get(exact.handle)
      : (() => {
        const folded = resolveRaftMentionHandle(
          token.toLocaleLowerCase("en-US"),
          (name) => byFoldedName.has(name),
        );
        return folded ? byFoldedName.get(folded.handle) : null;
      })();
    if (member) resolved.set(`${member.targetType}:${member.targetId}`, member);
  }
  return [...resolved.values()];
}

type ResolvedSlackHumanMention = {
  userId: string;
  handle: string;
  providerUsergroupId: string;
  label: string;
};

/**
 * A picked human usergroup resolves to its Raft user only when that user is a
 * member of the mention scope (bound channel, parent channel for threads,
 * every active face for Joint targets) — the same membership that makes a
 * native Slack user mention notifiable. Out-of-scope humans mint nothing and
 * the token keeps the author's own label.
 */
async function resolveSlackHumanMentions(
  executor: DatabaseExecutor,
  event: InboundEvent,
  mentions: readonly SlackUsergroupMention[],
  providerHandles: readonly ExternalInboundProviderMentionHandle[],
  mentionScopeChannelIds: readonly string[],
): Promise<ResolvedSlackHumanMention[]> {
  const requestedIds = new Set(mentions.map((mention) => mention.providerUsergroupId));
  if (event.provider !== "slack" || requestedIds.size === 0) return [];
  const byProviderId = new Map(providerHandles
    .filter((handle) => requestedIds.has(handle.providerUsergroupId))
    .flatMap((handle) => ("userId" in handle ? [[handle.providerUsergroupId, handle] as const] : [])));
  if (byProviderId.size === 0) return [];
  const userIds = [...new Set([...byProviderId.values()].map((handle) => handle.userId))];
  const rows = await executor.select({ id: users.id, name: users.name })
    .from(users)
    .where(and(inArray(users.id, userIds), isNull(users.retiredAt)));
  const usersById = new Map(rows.map((row) => [row.id, row]));
  const inScope = new Map<string, boolean>();
  const resolved = new Map<string, ResolvedSlackHumanMention>();
  for (const mention of mentions) {
    const providerHandle = byProviderId.get(mention.providerUsergroupId);
    if (!providerHandle) continue;
    const user = usersById.get(providerHandle.userId);
    if (!user) continue;
    let member = inScope.get(user.id);
    if (member === undefined) {
      member = false;
      for (const scopeChannelId of mentionScopeChannelIds) {
        if (await isChannelHuman(scopeChannelId, user.id, executor)) {
          member = true;
          break;
        }
      }
      inScope.set(user.id, member);
    }
    if (!member) continue;
    if (resolved.has(user.id)) continue;
    resolved.set(user.id, {
      userId: user.id,
      handle: user.name,
      providerUsergroupId: mention.providerUsergroupId,
      label: `@${user.name}`,
    });
  }
  return [...resolved.values()].sort((left, right) => left.userId.localeCompare(right.userId));
}

function parseBotPresentation(value: unknown): { displayName: string | null; avatarArtifactId: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== "avatarArtifactId\0displayName"
    || !(record.displayName === null || typeof record.displayName === "string")
    || !(record.avatarArtifactId === null || typeof record.avatarArtifactId === "string")) return null;
  return { displayName: record.displayName, avatarArtifactId: record.avatarArtifactId };
}

function parseNormalizedMessage(
  plaintext: string,
  expectedDigest: string,
): ParsedExternalInboundNormalizedMessage | null {
  if (sha256(plaintext) !== expectedDigest) return null;
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  const commonKeys = [
    "actorProjectionRevision",
    "content",
    "createdAt",
    "externalActorId",
    "projectionId",
    "providerMessageId",
    "providerThreadId",
  ];
  const isEdit = message.schema === INBOUND_EDIT_PAYLOAD_SCHEMA;
  const isBotPresentation = message.schema === INBOUND_PAYLOAD_SCHEMA_V4;
  const fallbackAuthor = message.schema === INBOUND_PAYLOAD_SCHEMA_V3
    && (message.fallbackAuthor === "anonymous" || message.fallbackAuthor === "unresolved") ? message.fallbackAuthor : undefined;
  const sourceVerifiedEdit = isEdit && message.sourceVerifiedEdit === true;
  if (fallbackAuthor) commonKeys.push("fallbackAuthor");
  if (sourceVerifiedEdit) commonKeys.push("sourceVerifiedEdit");
  if (isEdit) commonKeys.push("providerEditedTs");
  const expectedKeys = isBotPresentation
    ? [...commonKeys, "botPresentation", "providerAgentMentions", "providerFileIds", "schema"].sort()
    : message.schema === INBOUND_PAYLOAD_SCHEMA_V3 || isEdit
    ? [...commonKeys, "providerAgentMentions", "providerFileIds", "schema"].sort()
    : message.schema === INBOUND_PAYLOAD_SCHEMA_V2
      ? [...commonKeys, "providerFileIds", "schema"].sort()
      : [...commonKeys, "schema"].sort();
  if (Object.keys(message).sort().join("\0") !== expectedKeys.join("\0")) return null;
  const providerFileIds = message.schema === INBOUND_PAYLOAD_SCHEMA_V2
    || message.schema === INBOUND_PAYLOAD_SCHEMA_V3 || isBotPresentation || isEdit
    ? message.providerFileIds
    : [];
  const providerAgentMentions = message.schema === INBOUND_PAYLOAD_SCHEMA_V3 || isBotPresentation || isEdit
    ? message.providerAgentMentions
    : [];
  if (
    (message.schema !== INBOUND_PAYLOAD_SCHEMA_V1
      && message.schema !== INBOUND_PAYLOAD_SCHEMA_V2
      && message.schema !== INBOUND_PAYLOAD_SCHEMA_V3 && !isBotPresentation && !isEdit)
    || (isEdit && (!parseSlackEditTimestamp(message.providerEditedTs)
      || parseSlackEditTimestamp(message.providerEditedTs) !== message.providerEditedTs))
    || !(sourceVerifiedEdit ? message.projectionId === "" : nonEmpty(message.projectionId))
    || !positive(message.actorProjectionRevision)
    || !(fallbackAuthor === "anonymous" || sourceVerifiedEdit ? message.externalActorId === "" : nonEmpty(message.externalActorId))
    || !nonEmpty(message.providerMessageId, 160)
    || !(message.providerThreadId === null || nonEmpty(message.providerThreadId, 160))
    || !nonEmpty(message.content, 40_000)
    || !nonEmpty(message.createdAt, 80)
    || !Number.isFinite(Date.parse(message.createdAt))
    || new Date(message.createdAt).toISOString() !== message.createdAt
    || (isBotPresentation && !parseBotPresentation(message.botPresentation))
    || !Array.isArray(providerFileIds)
    || (isEdit && providerFileIds.length !== 0)
    || providerFileIds.length > 10
    || providerFileIds.some((fileId) => !nonEmpty(fileId, 320))
    || new Set(providerFileIds).size !== providerFileIds.length
    || !Array.isArray(providerAgentMentions)
    || providerAgentMentions.length > 50
    || providerAgentMentions.some((mention) => {
      if (!mention || typeof mention !== "object" || Array.isArray(mention)) return true;
      const record = mention as Record<string, unknown>;
      return Object.keys(record).sort().join("\0") !== "handle\0providerUsergroupId"
        || !nonEmpty(record.providerUsergroupId, 160)
        || !/^S[A-Z0-9]{2,}$/u.test(record.providerUsergroupId as string)
        || !(record.handle === null || (
          nonEmpty(record.handle, 80)
          && normalizeSlackMentionHandle(record.handle as string) === record.handle
        ));
    })
    || new Set(providerAgentMentions.map((mention) => (
      (mention as SlackUsergroupMention).providerUsergroupId
    ))).size !== providerAgentMentions.length
  ) return null;
  return {
    ...message,
    providerFileIds,
    providerAgentMentions,
  } as unknown as ParsedExternalInboundNormalizedMessage;
}

function parseNormalizedReaction(
  plaintext: string,
  expectedDigest: string,
): ParsedExternalInboundNormalizedReaction | null {
  if (sha256(plaintext) !== expectedDigest) return null;
  let value: unknown;
  try { value = JSON.parse(plaintext); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reaction = value as Record<string, unknown>;
  if (
    Object.keys(reaction).sort().join("\0") !== [
      "botUserId",
      "eventOccurredAt",
      "eventSequence",
      "externalActorId",
      "operation",
      "providerMessageId",
      "providerReactionKey",
      "schema",
    ].sort().join("\0")
    || reaction.schema !== INBOUND_REACTION_PAYLOAD_SCHEMA
    || (reaction.operation !== "add" && reaction.operation !== "remove")
    || !nonEmpty(reaction.providerMessageId, 160)
    || !nonEmpty(reaction.externalActorId, 160)
    || !nonEmpty(reaction.providerReactionKey, 160)
    || !nonEmpty(reaction.botUserId, 160)
    || !nonEmpty(reaction.eventOccurredAt, 80)
    || !positive(reaction.eventSequence)
    || !Number.isFinite(Date.parse(reaction.eventOccurredAt))
    || new Date(reaction.eventOccurredAt).toISOString() !== reaction.eventOccurredAt
  ) return null;
  return reaction as ParsedExternalInboundNormalizedReaction;
}

function terminalErase(event: InboundEvent, status: "committed" | "duplicate" | "echo", messageId: string, now: Date) {
  return {
    status,
    encryptedPayload: null,
    envelopeKeyId: null,
    payloadExpiresAt: null,
    payloadErasedAt: now,
    payloadTombstoneDigest: sha256(JSON.stringify([
      "external-inbound-payload-tombstone",
      "v1",
      event.id,
      event.normalizedPayloadDigest,
      status,
      messageId,
    ])),
    committedMessageId: messageId,
    outcomeReason: `provider_inbound_${status}`,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
  } as const;
}

function terminalEraseWithoutMessage(
  event: InboundEvent,
  status: "dead" | "quarantined" | "revoked",
  reason: string,
  now: Date,
) {
  return {
    status,
    encryptedPayload: null,
    envelopeKeyId: null,
    payloadExpiresAt: null,
    payloadErasedAt: now,
    payloadTombstoneDigest: sha256(JSON.stringify([
      "external-inbound-payload-tombstone",
      "v1",
      event.id,
      event.normalizedPayloadDigest,
      status,
      reason,
    ])),
    committedMessageId: null,
    outcomeReason: reason,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
  } as const;
}

async function inboundTransaction<T>(db: Database, durableSlack: boolean, purpose: "claim" | "settle",
  run: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  return durableSlack ? withSlackIngressProtocol({ db, purpose, run }) : db.transaction(run);
}

async function releaseLease(
  db: Database,
  eventId: string,
  leaseOwner: string,
  leaseGeneration: number,
  reason: string,
  now: Date,
  durableSlack = false,
): Promise<void> {
  await inboundTransaction(db, durableSlack, "settle", async tx => {
    await tx.update(externalInboundEvents).set({
    status: "queued",
    leaseOwner: null,
    leaseExpiresAt: null,
    outcomeReason: reason,
    updatedAt: now,
  }).where(and(
    eq(externalInboundEvents.id, eventId),
    eq(externalInboundEvents.status, "processing"),
    eq(externalInboundEvents.leaseOwner, leaseOwner),
    eq(externalInboundEvents.leaseGeneration, leaseGeneration),
  ));
  });
}

async function terminalizeLeaseWithoutMessage(
  db: Database,
  event: InboundEvent,
  leaseOwner: string,
  leaseGeneration: number,
  status: "dead" | "quarantined" | "revoked",
  reason: string,
  now: Date,
  durableSlack = false,
): Promise<void> {
  await inboundTransaction(db, durableSlack, "settle", async tx => {
    await tx.update(externalInboundEvents).set(terminalEraseWithoutMessage(event, status, reason, now)).where(and(
    eq(externalInboundEvents.id, event.id),
    eq(externalInboundEvents.status, "processing"),
    eq(externalInboundEvents.leaseOwner, leaseOwner),
    eq(externalInboundEvents.leaseGeneration, leaseGeneration),
  ));
  });
}

async function resolveTargetChannel(
  executor: DatabaseExecutor,
  event: InboundEvent,
  payload: ExternalInboundNormalizedMessageFields,
): Promise<{
  channel: typeof channels.$inferSelect;
  canonicalRootMessageId: string | null;
  jointThreadProjection: JointThreadProjection | null;
} | null> {
  const conversationTarget = await resolveExternalConversationTarget({
    executor,
    authorityChannelId: event.raftChannelId,
  });
  if (!conversationTarget) return null;
  // Channel rows are only serialized and revalidated here, never re-keyed, so
  // every channel lock in this resolver is FOR NO KEY UPDATE: it still
  // excludes Raft send admission and archive/delete writes, but not the FOR KEY
  // SHARE that foreign-key checks (inbox facts, push outbox, mentions) take on
  // the same rows. Rows are also taken in the Raft send path's order, so the
  // two cannot form a cycle: Joint parent projections (local parents) ->
  // canonical parent -> local thread projections -> canonical thread. A Raft
  // Joint-thread send locks local parent -> its local thread -> canonical
  // thread; a Joint channel send locks local parent -> canonical parent.
  const [authorityChannel] = await executor.select().from(channels)
    .where(eq(channels.id, conversationTarget.authorityChannelId)).for("no key update").limit(1);
  if (conversationTarget.kind === "joint" && payload.providerThreadId) {
    // The host's local parent (authority) was taken above, ahead of this sorted
    // set; that is safe only because a host's local channel is never the
    // canonical one, so no locker can hold the canonical parent and want it.
    // A thread reply freezes every active parent projection below; take their
    // rows before the canonical parent, as a Joint channel send does.
    await executor.select({ id: channels.id }).from(jointChannelServers)
      .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
      .where(and(
        eq(jointChannelServers.jointChannelId, conversationTarget.jointChannelId),
        eq(jointChannelServers.status, "active"),
      ))
      .orderBy(asc(jointChannelServers.serverId))
      .for("no key update", { of: channels });
  }
  const [parentChannel] = await executor.select().from(channels)
    .where(eq(channels.id, conversationTarget.storageChannelId)).for("no key update").limit(1);
  if (
    !authorityChannel
    || !parentChannel
    || authorityChannel.deletedAt
    || authorityChannel.archivedAt
    || parentChannel.type === "thread"
    || parentChannel.deletedAt
    || parentChannel.archivedAt
    // Visibility is per-platform: a pair stays live across public/private
    // flips on either side, so inbound commits only require a real,
    // un-archived channel of an ordinary type — not a class match. Joint
    // targets still require host role + joint authority + canonical parent.
    || (conversationTarget.kind === "joint" && (
      conversationTarget.role !== "host"
      || authorityChannel.type !== "joint"
      || parentChannel.type !== "channel"
    ))
    || (conversationTarget.kind === "ordinary"
      && parentChannel.type !== "channel" && parentChannel.type !== "private")
  ) return null;
  if (!payload.providerThreadId) {
    return {
      channel: parentChannel,
      canonicalRootMessageId: null,
      jointThreadProjection: null,
    };
  }

  const rootLinks = await executor.select().from(externalMessageLinks).where(and(
    eq(externalMessageLinks.providerMessageId, payload.providerThreadId),
    externalMessageReceiptScope(executor, { ...event, canonicalRaftChannelId: parentChannel.id }),
  )).for("update").limit(2);
  if (rootLinks.length > 1) return null;
  const rootLink = rootLinks[0];
  if (!rootLink) {
    if (await historicalProviderReceiptIsAbsent(executor, event, payload.providerThreadId)) {
      throw new ConfirmedHistoricalReceiptMissing();
    }
    return null;
  }
  const [rootMessage] = await executor.select().from(messages)
    .where(eq(messages.id, rootLink.raftMessageId)).for("update").limit(1);
  if (!rootMessage || rootMessage.channelId !== parentChannel.id) return null;

  let lockedJointParentProjections: LockedJointParentProjection[] | null = null;
  if (conversationTarget.kind === "joint") {
    const [parentJoint] = await executor.select().from(jointChannels).where(and(
      eq(jointChannels.id, conversationTarget.jointChannelId),
      eq(jointChannels.canonicalChannelId, parentChannel.id),
      eq(jointChannels.status, "active"),
    )).for("update").limit(1);
    if (!parentJoint) return null;

    const parentProjections = await executor.select({
      serverId: jointChannelServers.serverId,
      localChannelId: jointChannelServers.localChannelId,
      role: jointChannelServers.role,
      status: jointChannelServers.status,
      joinedByUserId: jointChannelServers.joinedByUserId,
      channel: channels,
    }).from(jointChannelServers)
      .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
      .where(and(
        eq(jointChannelServers.jointChannelId, parentJoint.id),
        eq(jointChannelServers.status, "active"),
      ))
      .orderBy(asc(jointChannelServers.serverId))
      .for("no key update");
    if (
      parentProjections.length === 0
      || parentProjections.some((projection) =>
        projection.status !== "active"
        || projection.channel.serverId !== projection.serverId
        || projection.channel.type !== "joint"
        || projection.channel.deletedAt
        || projection.channel.archivedAt
      )
      || !parentProjections.some((projection) =>
        projection.localChannelId === event.raftChannelId
        && projection.serverId === conversationTarget.serverId
        && projection.role === "host"
      )
    ) return null;
    lockedJointParentProjections = parentProjections;
  }

  // The root message row locked above serializes every creator of this
  // canonical thread (inbound replies here; Raft thread creation takes its
  // foreign-key share on the same root), so finding or creating the thread
  // needs no thread-row lock yet. The canonical thread row itself is locked
  // last, after any local thread projection, matching Raft send admission.
  const findCanonicalThread = () => executor.select().from(channels).where(and(
    eq(channels.type, "thread"),
    eq(channels.parentMessageId, rootMessage.id),
  )).limit(1);
  let [threadChannel] = await findCanonicalThread();
  if (!threadChannel) {
    [threadChannel] = await executor.insert(channels).values({
      serverId: parentChannel.serverId,
      name: `thread-${rootMessage.id.slice(0, 8)}`,
      type: "thread",
      parentMessageId: rootMessage.id,
    }).onConflictDoNothing().returning();
    if (!threadChannel) [threadChannel] = await findCanonicalThread();
  }
  if (!threadChannel || threadChannel.serverId !== parentChannel.serverId || threadChannel.deletedAt) {
    throw new ExternalInboundTargetUnavailableError();
  }
  const canonicalThreadId = threadChannel.id;
  const lockCanonicalThread = async () => {
    const [locked] = await executor.select().from(channels)
      .where(eq(channels.id, canonicalThreadId)).for("no key update").limit(1);
    if (
      !locked
      || locked.type !== "thread"
      || locked.parentMessageId !== rootMessage.id
      || locked.serverId !== parentChannel.serverId
      || locked.deletedAt
    ) throw new ExternalInboundTargetUnavailableError();
    return locked;
  };
  if (rootMessage.threadId !== threadChannel.id) {
    await executor.update(messages).set({ threadId: threadChannel.id })
      .where(eq(messages.id, rootMessage.id));
  }

  if (conversationTarget.kind === "ordinary") {
    return {
      channel: await lockCanonicalThread(),
      canonicalRootMessageId: rootMessage.id,
      jointThreadProjection: null,
    };
  }

  // The accepted provider root serializes every reply racing to create the
  // same canonical thread. Under that lock, freeze the complete active Joint
  // parent projection set and materialize one local thread face per active
  // server before the reply itself is inserted.
  if (!lockedJointParentProjections) throw new ExternalInboundTargetUnavailableError();

  const existingJointThreads = await executor.select().from(jointChannels).where(and(
    eq(jointChannels.canonicalChannelId, threadChannel.id),
    eq(jointChannels.status, "active"),
  )).for("update").limit(2);
  if (existingJointThreads.length > 1) throw new ExternalInboundTargetUnavailableError();
  let [jointThread] = existingJointThreads;
  if (!jointThread) {
    [jointThread] = await executor.insert(jointChannels).values({
      canonicalChannelId: threadChannel.id,
      createdByServerId: conversationTarget.serverId,
      createdByUserId: null,
      status: "active",
    }).onConflictDoNothing({ target: jointChannels.canonicalChannelId }).returning();
  }
  if (!jointThread) {
    // A local first open (channelService.getOrCreateThreadForChannel) does not
    // take the provider root lock and created the record first:
    // canonical_channel_id is unique, so use its record.
    [jointThread] = await executor.select().from(jointChannels).where(and(
      eq(jointChannels.canonicalChannelId, threadChannel.id),
      eq(jointChannels.status, "active"),
    )).for("update").limit(1);
  }
  if (!jointThread || jointThread.canonicalChannelId !== threadChannel.id) {
    throw new ExternalInboundTargetUnavailableError();
  }

  let hostThreadProjection: JointThreadProjection | null = null;
  for (const parentProjection of lockedJointParentProjections) {
    let [threadProjection] = await executor.select().from(jointChannelServers).where(and(
      eq(jointChannelServers.jointChannelId, jointThread.id),
      eq(jointChannelServers.serverId, parentProjection.serverId),
    )).for("update").limit(1);
    let localThreadChannel: typeof channels.$inferSelect | undefined;
    if (threadProjection) {
      [localThreadChannel] = await executor.select().from(channels)
        .where(eq(channels.id, threadProjection.localChannelId)).for("no key update").limit(1);
    } else {
      [localThreadChannel] = await executor.insert(channels).values({
        serverId: parentProjection.serverId,
        name: `thread-${rootMessage.id.slice(0, 8)}`,
        type: "thread",
        parentMessageId: null,
      }).returning();
      [threadProjection] = await executor.insert(jointChannelServers).values({
        jointChannelId: jointThread.id,
        serverId: parentProjection.serverId,
        localChannelId: localThreadChannel.id,
        role: parentProjection.role,
        status: "active",
        joinedByUserId: parentProjection.joinedByUserId,
      }).returning();
    }
    if (
      !threadProjection
      || !localThreadChannel
      || threadProjection.status !== "active"
      || threadProjection.role !== parentProjection.role
      || threadProjection.localChannelId !== localThreadChannel.id
      || localThreadChannel.serverId !== parentProjection.serverId
      || localThreadChannel.type !== "thread"
      || localThreadChannel.parentMessageId !== null
      || localThreadChannel.deletedAt
      || localThreadChannel.archivedAt
    ) throw new ExternalInboundTargetUnavailableError();

    if (parentProjection.localChannelId === event.raftChannelId) {
      hostThreadProjection = {
        jointThreadId: jointThread.id,
        localThreadChannelId: localThreadChannel.id,
        canonicalThreadChannelId: threadChannel.id,
        localServerId: parentProjection.serverId,
        localParentChannelId: parentProjection.localChannelId,
        canonicalParentChannelId: parentChannel.id,
        kind: "thread",
        canonicalParentMessageId: rootMessage.id,
        canonicalParentTaskId: null,
        role: parentProjection.role,
        threadChannel: localThreadChannel,
      };
    }
  }
  if (!hostThreadProjection) throw new ExternalInboundTargetUnavailableError();
  const lockedCanonicalThread = await lockCanonicalThread();
  return {
    channel: lockedCanonicalThread,
    canonicalRootMessageId: rootMessage.id,
    jointThreadProjection: hostThreadProjection,
  };
}

export async function enqueueExternalInboundEvent(input: {
  db: DatabaseExecutor;
  authority: ExternalInboundRuntimeAuthority;
  providerEventId: string;
  normalizedPayloadDigest: string;
  encryptedPayload: string;
  envelopeKeyId: string;
  payloadSchemaVersion?: 1 | 2 | 3 | 4;
  payloadExpiresAt: Date;
  receivedAt?: Date;
}): Promise<{ event: InboundEvent; duplicate: boolean }> {
  const now = input.receivedAt ?? currentDate();
  const payloadSchemaVersion = input.payloadSchemaVersion ?? 1;
  if (
    !validClock(now)
    || !validClock(input.payloadExpiresAt)
    || input.payloadExpiresAt.getTime() <= now.getTime()
    || !nonEmpty(input.providerEventId, 320)
    || !/^[0-9a-f]{64}$/.test(input.normalizedPayloadDigest)
    || !nonEmpty(input.encryptedPayload, 1_000_000)
    || !nonEmpty(input.envelopeKeyId, 320)
    || (payloadSchemaVersion !== 1 && payloadSchemaVersion !== 2 && payloadSchemaVersion !== 3 && payloadSchemaVersion !== 4)
  ) throw new Error("External inbound sealed event admission is invalid");
  const authority = input.authority;
  if (
    !nonEmpty(authority.runtimeRevision)
    || (payloadSchemaVersion === 3 && authority.provider !== "slack")
    || !nonEmpty(authority.provider, 80)
    || !nonEmpty(authority.appRegistrationId)
    || !nonEmpty(authority.installId, 160)
    || !nonEmpty(authority.workspaceId)
    || !nonEmpty(authority.providerAuthorityId, 160)
    || !nonEmpty(authority.providerConversationId, 160)
    || !nonEmpty(authority.bindingId, 160)
    || !nonEmpty(authority.raftChannelId)
    || !positive(authority.bindingEpoch)
    || !positive(authority.connectionEpoch)
    || (authority.environment !== "test" && authority.environment !== "production")
    || (authority.privacyClass !== "public" && authority.privacyClass !== "private")
  ) throw new Error("External inbound frozen authority is invalid");

  const [event] = await input.db.insert(externalInboundEvents).values({
    provider: authority.provider,
    environment: authority.environment,
    appRegistrationId: authority.appRegistrationId,
    installId: authority.installId,
    workspaceId: authority.workspaceId,
    providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId,
    providerEventId: input.providerEventId,
    bindingId: authority.bindingId,
    bindingEpoch: authority.bindingEpoch,
    connectionEpoch: authority.connectionEpoch,
    runtimeRevision: authority.runtimeRevision,
    raftChannelId: authority.raftChannelId,
    privacyClass: authority.privacyClass,
    normalizedPayloadDigest: input.normalizedPayloadDigest,
    encryptedPayload: input.encryptedPayload,
    envelopeKeyId: input.envelopeKeyId,
    payloadSchemaVersion,
    payloadExpiresAt: input.payloadExpiresAt,
    receivedAt: now,
    updatedAt: now,
  }).onConflictDoNothing({
    target: [
      externalInboundEvents.provider,
      externalInboundEvents.appRegistrationId,
      externalInboundEvents.providerEventId,
    ],
  }).returning();
  if (event) return { event, duplicate: false };

  const [existing] = await input.db.select().from(externalInboundEvents).where(and(
    eq(externalInboundEvents.provider, authority.provider),
    eq(externalInboundEvents.appRegistrationId, authority.appRegistrationId),
    eq(externalInboundEvents.providerEventId, input.providerEventId),
  )).limit(1);
  if (!existing) throw new Error("External inbound provider event replay disappeared");
  if (
    existing.normalizedPayloadDigest !== input.normalizedPayloadDigest
    || existing.payloadSchemaVersion !== payloadSchemaVersion
    || !sameAuthority(frozenAuthority(existing), authority)
  ) throw new Error("External inbound provider event identity conflicts with frozen admission");
  return { event: existing, duplicate: true };
}

export async function processExternalInboundEventOnce(input: {
  db: Database;
  leaseOwner: string;
  dependencies?: ExternalInboundWorkerDependencies | null;
  signal?: AbortSignal;
  /** Enabled only after all replicas can safely retain and order Slack events. */
  durableSlackMode?: boolean;
  providerScope?: "slack" | "other";
}): Promise<ExternalInboundWorkerResult> {
  if (!input.dependencies) return { kind: "disabled" };
  if (!nonEmpty(input.leaseOwner, 160)) throw new Error("External inbound lease owner is invalid");
  const claimAt = input.dependencies.now?.() ?? currentDate();
  if (!validClock(claimAt)) throw new Error("External inbound clock is invalid");
  const blockedRetryThreshold = new Date(claimAt.getTime() - INBOUND_BLOCKED_RETRY_MS);

  const durableSlack = input.durableSlackMode === true && input.providerScope !== "other";
  let claimResult: InboundEvent | null | undefined;
  try {
    claimResult = await inboundTransaction(input.db, durableSlack, "claim", async (executor) => {
    const eligibleAt = sql<Date>`CASE
      WHEN ${externalInboundEvents.status} = 'processing' THEN ${externalInboundEvents.leaseExpiresAt}
      WHEN ${externalInboundEvents.outcomeReason} IS NULL THEN ${externalInboundEvents.receivedAt}
      ELSE ${externalInboundEvents.updatedAt} + (${INBOUND_BLOCKED_RETRY_MS} * interval '1 millisecond')
    END`;
    const eligible = or(
      and(
        eq(externalInboundEvents.status, "queued"),
        or(
          isNull(externalInboundEvents.outcomeReason),
          lte(externalInboundEvents.updatedAt, blockedRetryThreshold),
        ),
      ),
      and(
        eq(externalInboundEvents.status, "processing"),
        lt(externalInboundEvents.leaseExpiresAt, claimAt),
      ),
    );
    const orderedSlackHead = sql`(${externalInboundEvents.provider} <> 'slack' OR NOT EXISTS (
      SELECT 1 FROM external_inbound_events prior
      WHERE prior.provider = ${externalInboundEvents.provider}
        AND prior.environment = ${externalInboundEvents.environment}
        AND prior.app_registration_id = ${externalInboundEvents.appRegistrationId}
        AND prior.provider_authority_id = ${externalInboundEvents.providerAuthorityId}
        AND prior.provider_conversation_id = ${externalInboundEvents.providerConversationId}
        AND prior.raft_channel_id = ${externalInboundEvents.raftChannelId}
        AND prior.status IN ('queued', 'processing')
        AND (prior.received_at, prior.id) < (${externalInboundEvents.receivedAt}, ${externalInboundEvents.id})
    ))`;
    const providerFilter = input.providerScope === "slack" ? eq(externalInboundEvents.provider, "slack")
      : input.providerScope === "other" ? sql`${externalInboundEvents.provider} <> 'slack'` : undefined;
    const [candidate] = await executor.select().from(externalInboundEvents)
      .where(and(eligible, providerFilter, input.durableSlackMode ? orderedSlackHead : undefined))
      .orderBy(asc(eligibleAt), asc(externalInboundEvents.receivedAt), asc(externalInboundEvents.id))
      .for("update", input.durableSlackMode ? { skipLocked: true } : undefined).limit(1);
    if (!candidate) return null;
    const leaseGeneration = candidate.leaseGeneration + 1;
    const [claimed] = await executor.update(externalInboundEvents).set({
      status: "processing",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: new Date(claimAt.getTime() + INBOUND_LEASE_MS),
      leaseGeneration,
      outcomeReason: null,
      updatedAt: claimAt,
    }).where(eq(externalInboundEvents.id, candidate.id)).returning();
    return claimed;
  });
  } catch (error) {
    if (error instanceof SlackIngressRolloutUnavailable && (error.reason === "paused" || error.reason === "not_enabled")) {
      return { kind: "disabled" };
    }
    throw error;
  }
  const claim = claimResult;
  if (!claim) return { kind: "empty" };
  const releaseClaim = async (reason: string): Promise<void> => {
    const releaseAt = input.dependencies?.now?.() ?? currentDate();
    if (!validClock(releaseAt)) throw new Error("External inbound release clock is invalid");
    await releaseLease(
      input.db,
      claim.id,
      input.leaseOwner,
      claim.leaseGeneration,
      reason,
      releaseAt, durableSlack && claim.provider === "slack");
  };
  if (!claim.encryptedPayload || !claim.envelopeKeyId || !claim.payloadExpiresAt) {
    await releaseClaim("payload_custody_missing");
    return { kind: "blocked", eventId: claim.id, reason: "payload_custody_missing" };
  }
  if (claim.payloadExpiresAt.getTime() <= claimAt.getTime()
    && !(input.durableSlackMode && claim.provider === "slack")) {
    await terminalizeLeaseWithoutMessage(
      input.db,
      claim,
      input.leaseOwner,
      claim.leaseGeneration,
      "dead",
      "payload_expired",
      claimAt, durableSlack && claim.provider === "slack");
    return { kind: "blocked", eventId: claim.id, reason: "payload_expired" };
  }

  let plaintext: string;
  try {
    plaintext = await input.dependencies.decryptNormalizedPayload({
      eventId: claim.id,
      ciphertext: claim.encryptedPayload,
      envelopeKeyId: claim.envelopeKeyId,
      aad: {
        purpose: "external-inbound-normalized-event",
        aadVersion: 1,
        schemaVersion: claim.payloadSchemaVersion as 1 | 2 | 3 | 4,
        provider: claim.provider,
        environment: claim.environment,
        appRegistrationId: claim.appRegistrationId,
        installId: claim.installId,
        workspaceId: claim.workspaceId,
        providerAuthorityId: claim.providerAuthorityId,
        providerConversationId: claim.providerConversationId,
        providerEventId: claim.providerEventId,
        bindingId: claim.bindingId,
        bindingEpoch: claim.bindingEpoch,
        connectionEpoch: claim.connectionEpoch,
        runtimeRevision: claim.runtimeRevision,
        raftChannelId: claim.raftChannelId,
        privacyClass: claim.privacyClass,
      },
      signal: input.signal,
    });
  } catch (error) {
    if (durableSlack && claim.provider === "slack" && error instanceof SlackNormalizedEnvelopeInvalid) {
      await terminalizeLeaseWithoutMessage(input.db, claim, input.leaseOwner, claim.leaseGeneration,
        "quarantined", "payload_invalid", claimAt, true);
      return { kind: "blocked", eventId: claim.id, reason: "payload_invalid" };
    }
    await releaseClaim("payload_decrypt_failed");
    return { kind: "blocked", eventId: claim.id, reason: "payload_decrypt_failed" };
  }
  const reactionPayload = claim.payloadSchemaVersion === 3
    ? parseNormalizedReaction(plaintext, claim.normalizedPayloadDigest)
    : null;
  const payload = claim.payloadSchemaVersion === 3
    ? null
    : parseNormalizedMessage(plaintext, claim.normalizedPayloadDigest);
  if ((claim.payloadSchemaVersion === 4 && claim.provider !== "slack")
    || (!payload && !reactionPayload)
    || (payload && (payload.schema === INBOUND_EDIT_PAYLOAD_SCHEMA) !== (claim.payloadSchemaVersion === 4))) {
    await terminalizeLeaseWithoutMessage(
      input.db,
      claim,
      input.leaseOwner,
      claim.leaseGeneration,
      "quarantined",
      "payload_invalid",
      claimAt, durableSlack && claim.provider === "slack");
    return { kind: "blocked", eventId: claim.id, reason: "payload_invalid" };
  }
  const frozen = frozenAuthority(claim);
  const runtime = await input.dependencies.resolveCurrentRuntime({
    eventId: claim.id,
    frozenAuthority: frozen,
    requiredCapabilities: reactionPayload
      ? ["reaction_sync"]
      : payload!.providerFileIds.length > 0
        ? ["attachment_transfer"]
        : [],
    signal: input.signal,
  }).catch(() => null);
  const operation = runtime?.operationAuthority;
  const operationMatchesPair = !operation || (frozen.provider === "slack"
    && (["provider", "environment", "workspaceId", "providerAuthorityId", "providerConversationId", "raftChannelId"] as const)
      .every((key) => operation[key] === frozen[key]));
  if (!runtime || !sameAuthority(runtime, frozen) || !operationMatchesPair) {
    await releaseClaim("runtime_authority_inactive_or_mismatched");
    return { kind: "blocked", eventId: claim.id, reason: "runtime_authority_inactive_or_mismatched" };
  }

  // A former author's verified history must not create new actionable
  // mentions. The commit transaction repeats the actor and receipt checks.
  let possiblyHistoricalAuthor = Boolean(payload?.fallbackAuthor || payload?.sourceVerifiedEdit);
  if (payload && !payload.sourceVerifiedEdit && durableSlack && claim.provider === "slack") {
    const [observedActor] = await input.db.select({ state: externalActorProjections.state,
      deactivated: externalActorProjections.deactivated }).from(externalActorProjections).where(and(
      eq(externalActorProjections.id, payload.projectionId), eq(externalActorProjections.provider, "slack"),
      eq(externalActorProjections.appRegistrationId, claim.appRegistrationId),
      eq(externalActorProjections.installId, claim.installId), eq(externalActorProjections.workspaceId, claim.workspaceId),
      eq(externalActorProjections.externalActorId, payload.externalActorId),
    )).limit(1);
    possiblyHistoricalAuthor ||= Boolean(observedActor && (observedActor.state !== "active" || observedActor.deactivated));
    if (observedActor && !possiblyHistoricalAuthor) {
      const [address] = await input.db.select({ state: externalAddressabilityProjections.state })
        .from(externalAddressabilityProjections).where(and(
          eq(externalAddressabilityProjections.projectionId, payload.projectionId),
          eq(externalAddressabilityProjections.bindingId, claim.bindingId),
          eq(externalAddressabilityProjections.bindingEpoch, claim.bindingEpoch),
          eq(externalAddressabilityProjections.connectionEpoch, claim.connectionEpoch),
          eq(externalAddressabilityProjections.conversationId, claim.providerConversationId),
        )).orderBy(desc(externalAddressabilityProjections.contextRevision)).limit(1);
      possiblyHistoricalAuthor = address?.state === "removed";
    }
  }

  let providerMentionProfiles: readonly {
    providerUserId: string;
    displayName: string;
    handle: string | null;
  }[] = [];
  if (payload && !possiblyHistoricalAuthor && frozen.provider === "slack" && input.dependencies.resolveProviderMentionProfiles) {
    const mentionedIds = [...new Set(
      [...payload.content.matchAll(SLACK_NATIVE_USER_MENTION)].map((match) => match[1]!),
    )].slice(0, 50);
    const currentActors = mentionedIds.length === 0 ? [] : await input.db.select({
      externalActorId: externalActorProjections.externalActorId,
    }).from(externalActorProjections).where(and(
      eq(externalActorProjections.provider, "slack"),
      eq(externalActorProjections.appRegistrationId, claim.appRegistrationId),
      eq(externalActorProjections.installId, claim.installId),
      eq(externalActorProjections.workspaceId, claim.workspaceId),
      inArray(externalActorProjections.externalActorId, mentionedIds),
      eq(externalActorProjections.state, "active"),
      eq(externalActorProjections.deactivated, false),
    ));
    const currentIds = new Set(currentActors.map((actor) => actor.externalActorId));
    const missingIds = mentionedIds.filter((providerUserId) => !currentIds.has(providerUserId));
    providerMentionProfiles = missingIds.length === 0
      ? []
      : await input.dependencies.resolveProviderMentionProfiles({
        eventId: claim.id,
        frozenAuthority: runtime.operationAuthority ?? frozen,
        providerUserIds: missingIds,
        signal: input.signal,
      }).catch(() => []);
  }

  let providerAgentMentionHandles: readonly ExternalInboundProviderMentionHandle[] = [];
  if (payload && !possiblyHistoricalAuthor && payload.providerAgentMentions.length > 0) {
    if (!input.dependencies.resolveProviderAgentMentionHandles) {
      await releaseClaim("provider_agent_mention_unavailable");
      return { kind: "blocked", eventId: claim.id, reason: "provider_agent_mention_unavailable" };
    }
    const resolved = await input.dependencies.resolveProviderAgentMentionHandles({
      eventId: claim.id,
      frozenAuthority: runtime.operationAuthority ?? frozen,
      providerUsergroupIds: payload.providerAgentMentions.map((mention) => (
        mention.providerUsergroupId
      )),
      signal: input.signal,
    }).catch(() => null);
    if (resolved === null) {
      await releaseClaim("provider_agent_mention_unavailable");
      return { kind: "blocked", eventId: claim.id, reason: "provider_agent_mention_unavailable" };
    }
    providerAgentMentionHandles = resolved;
  }

  if (reactionPayload) {
    const reactionAt = input.dependencies.now?.() ?? currentDate();
    try {
      const applied = await inboundTransaction(input.db, durableSlack && claim.provider === "slack", "settle", async (tx) => {
        const [event] = await tx.select().from(externalInboundEvents).where(and(
          eq(externalInboundEvents.id, claim.id),
          eq(externalInboundEvents.status, "processing"),
          eq(externalInboundEvents.leaseOwner, input.leaseOwner),
          eq(externalInboundEvents.leaseGeneration, claim.leaseGeneration),
        )).for("update").limit(1);
        if (!event || !event.leaseExpiresAt || event.leaseExpiresAt <= reactionAt) return null;
        const result = await applyExternalReactionObservation({
          tx,
          inboundEventId: event.id,
          providerEventId: event.providerEventId,
          operation: reactionPayload.operation,
          providerMessageId: reactionPayload.providerMessageId,
          externalActorId: reactionPayload.externalActorId,
          providerReactionKey: reactionPayload.providerReactionKey,
          eventOccurredAt: new Date(reactionPayload.eventOccurredAt),
          eventSequence: reactionPayload.eventSequence,
          botUserId: reactionPayload.botUserId,
          operationAuthority: runtime.operationAuthority,
          now: reactionAt,
        });
        if (result.outcome === "quarantined") {
          await tx.update(externalInboundEvents).set(terminalEraseWithoutMessage(
            event,
            "quarantined",
            "reaction_event_order_conflict",
            reactionAt,
          )).where(eq(externalInboundEvents.id, event.id));
          return { status: "quarantined" as const, messageId: result.raftMessageId, changed: false };
        }
        const status = result.outcome === "bot_echo" ? "echo" as const : "committed" as const;
        await tx.update(externalInboundEvents).set(terminalErase(event, status, result.raftMessageId, reactionAt))
          .where(eq(externalInboundEvents.id, event.id));
        return { status, messageId: result.raftMessageId, changed: result.changed };
      });
      if (!applied) {
        await releaseClaim("reaction_commit_authority_lost");
        return { kind: "blocked", eventId: claim.id, reason: "reaction_commit_authority_lost" };
      }
      if (applied.status === "quarantined") {
        return { kind: "blocked", eventId: claim.id, reason: "reaction_event_order_conflict" };
      }
      if (applied.status === "committed" && applied.changed && input.dependencies.onReactionCommitted) {
        try {
          await input.dependencies.onReactionCommitted({
            eventId: claim.id,
            messageId: applied.messageId,
          });
        } catch (error) {
          // Reaction state is already durable. Realtime is an acceleration
          // path and must never replay the provider event on socket failure.
          try {
            input.dependencies.onReactionCommittedError?.(error);
          } catch {
            // Observability must not restore a retry after durable commit.
          }
        }
      }
      return { kind: applied.status, eventId: claim.id, messageId: applied.messageId };
    } catch (error) {
      if (error instanceof ConfirmedHistoricalReceiptMissing) {
        await terminalizeLeaseWithoutMessage(input.db, claim, input.leaseOwner, claim.leaseGeneration,
          "dead", error.reason, reactionAt, durableSlack && claim.provider === "slack");
        console.warn("[SlackBridge] historical dependency discarded", { event: "server.slack_bridge.history.discarded",
          direction: "provider_inbound", operation: "reaction", bindingId: claim.bindingId, operationId: claim.id, reason: error.reason });
        return { kind: "blocked", eventId: claim.id, reason: error.reason };
      }
      await releaseClaim("reaction_commit_blocked");
      return { kind: "blocked", eventId: claim.id, reason: "reaction_commit_blocked" };
    }
  }
  if (!payload) throw new Error("External inbound message payload routing invariant failed");

  if (payload.providerFileIds.length > 0) {
    let attachmentFacts;
    try {
      attachmentFacts = await inboundTransaction(input.db, durableSlack && claim.provider === "slack", "settle", async (executor) => {
        const [event] = await executor.select().from(externalInboundEvents).where(and(
          eq(externalInboundEvents.id, claim.id),
          eq(externalInboundEvents.status, "processing"),
          eq(externalInboundEvents.leaseOwner, input.leaseOwner),
          eq(externalInboundEvents.leaseGeneration, claim.leaseGeneration),
        )).for("update").limit(1);
        if (!event) return null;
        for (const [orderedPosition, providerFileId] of payload.providerFileIds.entries()) {
          await createInboundExternalAttachmentTransferWithExecutor(executor, {
            provider: event.provider,
            appRegistrationId: event.appRegistrationId,
            installId: event.installId,
            workspaceId: event.workspaceId,
            providerAuthorityId: event.providerAuthorityId,
            providerFileId,
            inboundEventId: event.id,
            connectionEpoch: event.connectionEpoch,
            bindingId: event.bindingId,
            bindingEpoch: event.bindingEpoch,
            orderedPosition,
            sourceActorProjectionId: payload.projectionId,
            ...(durableSlack && event.provider === "slack" ? { verifiedSlackProof: {
              leaseOwner: input.leaseOwner, leaseGeneration: claim.leaseGeneration, at: claimAt, sourcePlaintext: plaintext,
            } } : {}),
          }, claimAt);
        }
        return executor.select().from(externalAttachmentMessageFacts)
          .where(eq(externalAttachmentMessageFacts.inboundEventId, event.id))
          .orderBy(asc(externalAttachmentMessageFacts.orderedPosition))
          .for("update");
      });
    } catch {
      await releaseClaim("attachment_transfer_prepare_failed");
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_prepare_failed" };
    }
    if (!attachmentFacts || attachmentFacts.length !== payload.providerFileIds.length) {
      await terminalizeLeaseWithoutMessage(
        input.db,
        claim,
        input.leaseOwner,
        claim.leaseGeneration,
        "quarantined",
        "attachment_transfer_set_invalid",
        claimAt, durableSlack && claim.provider === "slack");
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_set_invalid" };
    }
    if (attachmentFacts.some((fact) => fact.state === "pending")) {
      await releaseClaim("attachment_transfer_pending");
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_pending" };
    }
    if (attachmentFacts.some((fact) => fact.state !== "stored" && fact.state !== "unavailable" && fact.state !== "revoked")) {
      await terminalizeLeaseWithoutMessage(
        input.db,
        claim,
        input.leaseOwner,
        claim.leaseGeneration,
        "quarantined",
        "attachment_transfer_state_invalid",
        claimAt, durableSlack && claim.provider === "slack");
      return { kind: "blocked", eventId: claim.id, reason: "attachment_transfer_state_invalid" };
    }
  }

  let commitAt = claimAt;
  let commitBlockReason = "commit_authority_lost_or_root_unavailable";
  let committed: ExternalInboundWorkerResult | null = null;
  try {
    committed = await inboundTransaction(input.db, durableSlack && claim.provider === "slack", "settle", async (executor): Promise<ExternalInboundWorkerResult | null> => {
      const [event] = await executor.select().from(externalInboundEvents).where(and(
        eq(externalInboundEvents.id, claim.id),
        eq(externalInboundEvents.status, "processing"),
        eq(externalInboundEvents.leaseOwner, input.leaseOwner),
        eq(externalInboundEvents.leaseGeneration, claim.leaseGeneration),
      )).for("update").limit(1);
      if (!event) return null;
      if (inboundEventRowLockHookForTests) await inboundEventRowLockHookForTests();
      // Both new messages and edits can later resolve Slack mentions. Fence the
      // install and binding before either path locks an author projection.
      if (event.provider === "slack" && payload.content.includes("<@")) {
        await lockSlackMentionAuthority(executor, { provider: event.provider, installId: event.installId, bindingId: event.bindingId });
      }
      const freshCommitAt = input.dependencies?.now?.() ?? currentDate();
      if (!validClock(freshCommitAt)) {
        commitBlockReason = "invalid_commit_clock";
        return null;
      }
      commitAt = freshCommitAt;
      if (!event.leaseExpiresAt || event.leaseExpiresAt.getTime() <= commitAt.getTime()) {
        commitBlockReason = "lease_expired_before_canonical_commit";
        return null;
      }
      if (!event.payloadExpiresAt || (event.payloadExpiresAt.getTime() <= commitAt.getTime()
        && !(input.durableSlackMode && event.provider === "slack"))) {
        commitBlockReason = "payload_expired_before_canonical_commit";
        return null;
      }

      if (payload.sourceVerifiedEdit) {
        if (!durableSlack || event.provider !== "slack" || runtime.operationAuthority) throw new Error("Anonymous edit lacks current Slack authority");
        const [raw] = await executor.select({ id: slackVerifiedIngressEvents.id }).from(slackVerifiedIngressEvents)
          .innerJoin(slackVerifiedIngressPartitions, eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId))
          .where(and(eq(slackVerifiedIngressEvents.materializedInboundEventId, event.id),
            eq(slackVerifiedIngressEvents.normalizationSource, "verified_raw"), eq(slackVerifiedIngressEvents.state, "materialized"),
            eq(slackVerifiedIngressEvents.appRegistrationId, event.appRegistrationId),
            eq(slackVerifiedIngressEvents.providerEventId, event.providerEventId),
            eq(slackVerifiedIngressPartitions.environment, event.environment),
            eq(slackVerifiedIngressPartitions.providerAuthorityId, event.providerAuthorityId),
            eq(slackVerifiedIngressPartitions.providerConversationId, event.providerConversationId))).limit(1);
        if (!raw) throw new Error("Anonymous edit lacks verified Slack custody");
      }

      const rejectUnverifiedEdit = async () => {
        await executor.update(externalInboundEvents).set(terminalEraseWithoutMessage(event, "dead", "edit_target_unverified", commitAt))
          .where(eq(externalInboundEvents.id, event.id));
        return { kind: "blocked" as const, eventId: event.id, reason: "edit_target_unverified" };
      };

      const receiptTarget = await resolveExternalConversationTarget({ executor, authorityChannelId: event.raftChannelId });
      if (!receiptTarget) return null;
      const linkIdentity = and(
        externalMessageReceiptScope(executor, { ...event, canonicalRaftChannelId: receiptTarget.storageChannelId }),
        eq(externalMessageLinks.providerMessageId, payload.providerMessageId),
      );
      let editTarget: Awaited<ReturnType<typeof resolveTargetChannel>> = null;
      if (payload.schema === INBOUND_EDIT_PAYLOAD_SCHEMA) {
        // New replies lock the channel before their root link. Editing that
        // root must use the same order, or each transaction can wait for the
        // other's lock. This first read is only an existence check; authority
        // and edit ordering are checked again on the locked row below.
        const observedLinks = await executor.select().from(externalMessageLinks)
          .where(linkIdentity).limit(2);
        if (observedLinks.length > 1) { commitBlockReason = "historical_message_receipt_conflict"; return null; }
        const observedLink = observedLinks[0];
        if (!observedLink) {
          if (payload.sourceVerifiedEdit) return rejectUnverifiedEdit();
          commitBlockReason = "edit_original_message_pending";
          return null;
        }
        if (observedLink.firstDirection === "provider_inbound") {
          // An edit cannot move the original to a different provider thread.
          // Reject that before the target resolver can materialize a thread.
          if (observedLink.providerThreadId !== payload.providerThreadId) {
            if (payload.sourceVerifiedEdit) return rejectUnverifiedEdit();
            commitBlockReason = "edit_message_authority_mismatch";
            return null;
          }
          editTarget = await resolveTargetChannel(executor, { ...event, ...runtime.operationAuthority }, payload);
          if (!editTarget) return null;
        }
      }
      const existingLinks = await executor.select().from(externalMessageLinks)
        .where(linkIdentity).for("update").limit(2);
      if (existingLinks.length > 1) { commitBlockReason = "historical_message_receipt_conflict"; return null; }
      const existingLink = existingLinks[0];
      if (payload.schema === INBOUND_EDIT_PAYLOAD_SCHEMA) {
        if (!existingLink) {
          if (payload.sourceVerifiedEdit) return rejectUnverifiedEdit();
          commitBlockReason = "edit_original_message_pending";
          return null;
        }
        const finish = async (status: "committed" | "duplicate" | "echo") => {
          await executor.update(externalInboundEvents).set(terminalErase(event, status, existingLink.raftMessageId, commitAt))
            .where(eq(externalInboundEvents.id, event.id));
          return { kind: status, eventId: event.id, messageId: existingLink.raftMessageId };
        };
        if (existingLink.firstDirection === "raft_outbound") {
          if (payload.sourceVerifiedEdit) return rejectUnverifiedEdit();
          // RFC 082 §4.6: verified ingress discards only a proven echo of our
          // own card edit before it gets here. Any other edit event on a card
          // message's copy is left alone, and never called our echo.
          const [outbound] = await executor.select({ actionMetadata: messages.actionMetadata }).from(messages)
            .where(eq(messages.id, existingLink.raftMessageId)).limit(1);
          return finish(isMessageCardMetadata(outbound?.actionMetadata) ? "duplicate" : "echo");
        }
        if (existingLink.providerThreadId !== payload.providerThreadId) {
          if (payload.sourceVerifiedEdit) return rejectUnverifiedEdit();
          commitBlockReason = "edit_message_authority_mismatch";
          return null;
        }
        const target = editTarget;
        if (!target) return null;
        const [message] = await executor.select().from(messages)
          .where(eq(messages.id, existingLink.raftMessageId)).for("update").limit(1);
        const [author] = await executor.select().from(externalMessageAuthorFacts)
          .where(eq(externalMessageAuthorFacts.messageId, existingLink.raftMessageId)).limit(1);
        const operationAuthority = runtime.operationAuthority ?? frozen;
        const actors = await executor.select().from(externalActorProjections).where(and(
          eq(externalActorProjections.provider, event.provider),
          eq(externalActorProjections.appRegistrationId, operationAuthority.appRegistrationId),
          eq(externalActorProjections.installId, operationAuthority.installId),
          eq(externalActorProjections.workspaceId, event.workspaceId),
          eq(externalActorProjections.externalActorId, payload.externalActorId),
          eq(externalActorProjections.state, "active"),
          eq(externalActorProjections.deactivated, false),
          or(
            eq(externalActorProjections.actorKind, "human"),
            and(eq(externalActorProjections.provider, "slack"), eq(externalActorProjections.actorKind, "bot")),
          ),
        )).for("share").limit(2);
        let actor = actors.length === 1 ? actors[0] : null;
        let historicalEdit = durableSlack && event.provider === "slack" && possiblyHistoricalAuthor;
        if (!payload.sourceVerifiedEdit && !actor && actors.length === 0 && durableSlack && event.provider === "slack" && author?.actorKind === "human") {
          // The signed raw receipt and exact normalized digest authenticate a
          // queued edit even when its previously known human has departed.
          // The original immutable author fact below still has to match.
          const [receipt] = await executor.select({ id: slackVerifiedIngressEvents.id }).from(slackVerifiedIngressEvents)
            .innerJoin(slackVerifiedIngressPartitions, eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId))
            .where(and(eq(slackVerifiedIngressEvents.materializedInboundEventId, event.id),
              eq(slackVerifiedIngressEvents.state, "materialized"), eq(slackVerifiedIngressEvents.normalizationSource, "verified_raw"),
              eq(slackVerifiedIngressEvents.appRegistrationId, event.appRegistrationId),
              eq(slackVerifiedIngressEvents.providerEventId, event.providerEventId),
              eq(slackVerifiedIngressPartitions.environment, event.environment),
              eq(slackVerifiedIngressPartitions.providerAuthorityId, event.providerAuthorityId),
              eq(slackVerifiedIngressPartitions.providerConversationId, event.providerConversationId),
              eq(slackVerifiedIngressPartitions.partitionKind, "conversation"))).limit(1);
          if (receipt && sha256(plaintext) === event.normalizedPayloadDigest) {
            const [former] = await executor.select().from(externalActorProjections).where(and(
              eq(externalActorProjections.id, payload.projectionId), eq(externalActorProjections.provider, "slack"),
              eq(externalActorProjections.appRegistrationId, event.appRegistrationId),
              eq(externalActorProjections.installId, event.installId), eq(externalActorProjections.workspaceId, event.workspaceId),
              eq(externalActorProjections.externalActorId, payload.externalActorId), eq(externalActorProjections.actorKind, "human"),
              or(eq(externalActorProjections.state, "tombstoned"), eq(externalActorProjections.deactivated, true)),
            )).for("share").limit(1);
            if (former) { actor = former; historicalEdit = true; }
          }
        }
        if (payload.sourceVerifiedEdit) {
          if (existingLink.installId !== event.installId || existingLink.bindingId !== event.bindingId
            || existingLink.bindingEpoch !== event.bindingEpoch || existingLink.connectionEpoch !== event.connectionEpoch
            || existingLink.providerAuthorityId !== event.providerAuthorityId
            || existingLink.providerConversationId !== event.providerConversationId
            || existingLink.providerMessageId !== payload.providerMessageId || existingLink.firstDirection !== "provider_inbound"
            || !message || message.deletedAt || message.channelId !== target.channel.id || message.senderType !== "external_projection"
            || !author || message.senderId !== author.projectionId || author.provider !== event.provider
            || author.installId !== event.installId || author.workspaceId !== event.workspaceId
            || author.externalConversationId !== event.providerConversationId || author.externalMessageId !== payload.providerMessageId) {
            return rejectUnverifiedEdit();
          }
          historicalEdit = true;
        } else if (!message || message.deletedAt || message.channelId !== target.channel.id
          || message.senderType !== "external_projection"
          || !actor || !author || actor.actorKind !== author.actorKind
          || message.senderId !== author.projectionId || author.provider !== event.provider
          || author.workspaceId !== event.workspaceId || author.externalActorId !== payload.externalActorId
          || author.externalConversationId !== event.providerConversationId || author.externalMessageId !== payload.providerMessageId) {
          commitBlockReason = "edit_message_authority_mismatch";
          return null;
        }
        // RFC 082: a card message's text changes only through its sender's
        // card update; a provider edit leaves a message card alone (finished,
        // nothing written, no message:updated).
        if (isMessageCardMetadata(message.actionMetadata)) return finish("duplicate");
        // The link row lock serializes concurrent edits, retaining exact
        // Slack microseconds rather than rounding through JS Date.
        if (existingLink.lastProviderEditTs
          && !slackEditTimestampIsNewer(payload.providerEditedTs!, existingLink.lastProviderEditTs)) {
          return finish("duplicate");
        }
        const providerContent = historicalEdit ? payload.content : await renderProviderInboundMentions(executor, event, payload.content, providerMentionProfiles);
        // Edits do not create send-time mention notifications or wake agents.
        // Render group labels from the same scoped resolver used for new messages.
        const renderedContent = historicalEdit ? payload.content : renderSlackUsergroupMentions(providerContent, new Map(
          providerAgentMentionHandles.map((mention) => [mention.providerUsergroupId, `@${mention.handle}`]),
        ));
        const content = message.content.endsWith(ATTACHMENT_UNAVAILABLE_MARKER)
          ? appendAttachmentUnavailableMarker(renderedContent, event.provider) : renderedContent;
        await executor.update(externalMessageLinks).set({ lastProviderEditTs: payload.providerEditedTs!, updatedAt: commitAt })
          .where(eq(externalMessageLinks.id, existingLink.id));
        // Slack also sends message_changed for metadata-only changes.
        if (content === message.content) return finish("duplicate");
        // Reply previews use updatedAt as their content revision. Consecutive
        // accepted edits may share a millisecond, so keep this field monotonic.
        const updatedAt = new Date(Math.max(commitAt.getTime(), message.updatedAt.getTime() + 1));
        await executor.update(messages).set({ content, searchText: content, updatedAt })
          .where(eq(messages.id, message.id));
        // RFC 082 §4.4: clients that were away replace it through sync (one
        // `message` change row, in this transaction).
        await logMessageChanged(executor, { messageId: message.id, channelId: message.channelId });
        await executor.update(externalMessageAuthorFacts).set({ contentDigest: sha256(content) })
          .where(eq(externalMessageAuthorFacts.messageId, message.id));

        await executor.delete(externalMentionFacts).where(eq(externalMentionFacts.messageId, message.id));
        const [install] = await executor.select({ botUserId: externalAppInstalls.botUserId }).from(externalAppInstalls)
          .where(eq(externalAppInstalls.id, event.installId)).limit(1);
        await recordSlackInboundExternalMentionFacts({
          executor, event, messageId: message.id,
          providerUserIds: [...new Set([...payload.content.matchAll(SLACK_NATIVE_USER_MENTION)].map((match) => match[1]!))].slice(0, 50),
          botUserId: install?.botUserId ?? null, now: commitAt,
        });
        return finish("committed");
      }
      if (existingLink) {
        if (
          existingLink.firstDirection === "provider_inbound"
          && existingLink.payloadFingerprint !== event.normalizedPayloadDigest
        ) {
          await executor.update(externalInboundEvents).set(terminalEraseWithoutMessage(
            event,
            "quarantined",
            "provider_message_payload_conflict",
            commitAt,
          )).where(eq(externalInboundEvents.id, event.id));
          return {
            kind: "blocked",
            eventId: event.id,
            reason: "provider_message_payload_conflict",
          };
        }
        const status = existingLink.firstDirection === "raft_outbound" ? "echo" : "duplicate";
        await executor.update(externalInboundEvents).set(terminalErase(event, status, existingLink.raftMessageId, commitAt))
          .where(eq(externalInboundEvents.id, event.id));
        return { kind: status, eventId: event.id, messageId: existingLink.raftMessageId };
      }

      const target = await resolveTargetChannel(executor, { ...event, ...runtime.operationAuthority }, payload);
      if (!target) return null;
      // Joint commits store on the canonical channel/thread, which carries no
      // member rows of its own — facts fan out per active local projection
      // (each face's own channel id as sourceChannelId). Threads resolve
      // their faces inside recordInboxFacts via jointThreadProjection; a
      // top-level Joint target needs its channel projections frozen here,
      // matching the send path's executor requirement.
      const jointChannelProjections = target.channel.type !== "thread"
        ? await getActiveJointChannelProjectionsByLocalChannel(target.channel.id, executor)
        : [];
      const jointThreadFaces = target.jointThreadProjection
        ? await getActiveJointThreadProjectionsByCanonicalThread(
            target.jointThreadProjection.canonicalThreadChannelId,
            executor,
          )
        : [];
      const attachmentFacts = payload.providerFileIds.length === 0
        ? []
        : await executor.select().from(externalAttachmentMessageFacts)
          .where(eq(externalAttachmentMessageFacts.inboundEventId, event.id))
          .orderBy(asc(externalAttachmentMessageFacts.orderedPosition))
          .for("update");
      if (
        attachmentFacts.length !== payload.providerFileIds.length
        || attachmentFacts.some((fact) => (
          fact.state !== "stored" && fact.state !== "unavailable" && fact.state !== "revoked"
        ))
      ) {
        commitBlockReason = "attachment_transfer_pending";
        return null;
      }
      const unavailableAttachment = attachmentFacts.some(
        (fact) => fact.state === "unavailable" || fact.state === "revoked",
      );
      // Mention scope mirrors resolveMentionScopeForChannel: for a thread it
      // is the parent channel — every active face for a Joint thread — and
      // for a channel it is every active local projection (or the channel
      // itself when ordinary). Only members of a scope channel are mention
      // targets (typed names and picked Raft usergroups); a picked Slack
      // user never mints a Raft mention.
      const mentionScopeChannelIds = target.channel.type === "thread"
        ? target.jointThreadProjection
          ? jointThreadFaces.map((face) => face.localParentChannelId)
          : [((await executor.select({ channelId: messages.channelId })
              .from(messages)
              .where(eq(messages.id, target.channel.parentMessageId!))
              .limit(1))[0]?.channelId ?? target.channel.id)]
        : jointChannelProjections.length > 0
          ? jointChannelProjections.map((projection) => projection.localChannelId)
          : [target.channel.id];

      const resolvedAgentMentions = payload.fallbackAuthor ? [] : await resolveSlackAgentMentions(
        executor,
        event,
        payload.providerAgentMentions,
        providerAgentMentionHandles,
      );
      const resolvedHumanMentions = payload.fallbackAuthor ? [] : await resolveSlackHumanMentions(
        executor,
        event,
        payload.providerAgentMentions,
        providerAgentMentionHandles,
        mentionScopeChannelIds,
      );
      const providerRenderedContent = payload.fallbackAuthor ? payload.content : await renderProviderInboundMentions(
        executor,
        event,
        payload.content,
        providerMentionProfiles,
      );
      const agentRenderedContent = renderSlackUsergroupMentions(
        providerRenderedContent,
        new Map([...resolvedAgentMentions, ...resolvedHumanMentions].map((mention) => [
          mention.providerUsergroupId,
          mention.label,
        ])),
      );
      const [sourceInstall] = await executor
        .select({ workspaceName: externalAppInstalls.workspaceName, botUserId: externalAppInstalls.botUserId, providerBotId: externalAppInstalls.providerBotId })
        .from(externalAppInstalls)
        .where(and(
          eq(externalAppInstalls.id, event.installId),
          eq(externalAppInstalls.registrationId, event.appRegistrationId),
          eq(externalAppInstalls.providerAuthorityId, event.providerAuthorityId),
        ))
        .limit(1).for("share");
      const operationAuthority = runtime.operationAuthority ?? frozen;
      if (payload.fallbackAuthor) {
        if (!durableSlack || event.provider !== "slack" || runtime.operationAuthority
          || (payload.fallbackAuthor === "unresolved" && !await slackFallbackWaitElapsed(executor, {
            projectionId: payload.projectionId, registrationId: event.appRegistrationId, installId: event.installId,
            workspaceId: event.workspaceId, externalActorId: payload.externalActorId,
          }, event.receivedAt, commitAt))) {
          throw new Error("Fallback author lacks current verified Slack custody");
        }
        const [raw] = await executor.select({ id: slackVerifiedIngressEvents.id }).from(slackVerifiedIngressEvents)
          .innerJoin(slackVerifiedIngressPartitions, eq(slackVerifiedIngressPartitions.id, slackVerifiedIngressEvents.partitionId))
          .where(and(eq(slackVerifiedIngressEvents.materializedInboundEventId, event.id),
            eq(slackVerifiedIngressEvents.normalizationSource, "verified_raw"), eq(slackVerifiedIngressEvents.state, "materialized"),
            eq(slackVerifiedIngressEvents.appRegistrationId, event.appRegistrationId),
            eq(slackVerifiedIngressEvents.providerEventId, event.providerEventId),
            eq(slackVerifiedIngressPartitions.providerAuthorityId, event.providerAuthorityId),
            eq(slackVerifiedIngressPartitions.providerConversationId, event.providerConversationId))).limit(1);
        if (!raw) throw new Error("Fallback author lacks current verified Slack custody");
      }
      const currentActors = await executor.select().from(externalActorProjections).where(and(
        eq(externalActorProjections.provider, operationAuthority.provider),
        eq(externalActorProjections.appRegistrationId, operationAuthority.appRegistrationId),
        eq(externalActorProjections.installId, operationAuthority.installId),
        eq(externalActorProjections.workspaceId, operationAuthority.workspaceId),
        eq(externalActorProjections.externalActorId, payload.externalActorId),
        runtime.operationAuthority ? undefined : eq(externalActorProjections.id, payload.projectionId),
        // #11844 revalidates the current Slack identity independently of its
        // mutable display revision; preserve that behavior in both modes.
        (event.provider === "slack" || runtime.operationAuthority) ? undefined : eq(externalActorProjections.projectionRevision, payload.actorProjectionRevision),
        eq(externalActorProjections.state, "active"), eq(externalActorProjections.deactivated, false),
      )).limit(2);
      let historicalProfile = false;
      if (currentActors.length === 1 && durableSlack && event.provider === "slack" && !runtime.operationAuthority
        && currentActors[0]!.actorKind === "human") {
        const [address] = await executor.select({ state: externalAddressabilityProjections.state })
          .from(externalAddressabilityProjections).where(and(
            eq(externalAddressabilityProjections.projectionId, currentActors[0]!.id),
            eq(externalAddressabilityProjections.bindingId, event.bindingId),
            eq(externalAddressabilityProjections.bindingEpoch, event.bindingEpoch),
            eq(externalAddressabilityProjections.connectionEpoch, event.connectionEpoch),
            eq(externalAddressabilityProjections.conversationId, event.providerConversationId),
          )).orderBy(desc(externalAddressabilityProjections.contextRevision)).limit(1);
        historicalProfile = address?.state === "removed";
      }
      if (currentActors.length === 0 && durableSlack && event.provider === "slack" && !runtime.operationAuthority) {
        const historical = await executor.select().from(externalActorProjections).where(and(
          eq(externalActorProjections.id, payload.projectionId), eq(externalActorProjections.provider, "slack"),
          eq(externalActorProjections.appRegistrationId, event.appRegistrationId), eq(externalActorProjections.installId, event.installId),
          eq(externalActorProjections.workspaceId, event.workspaceId), eq(externalActorProjections.externalActorId, payload.externalActorId),
          eq(externalActorProjections.actorKind, "human"),
          or(eq(externalActorProjections.state, "tombstoned"), eq(externalActorProjections.deactivated, true)),
        )).limit(2);
        if (historical.length === 1) { currentActors.push(historical[0]!); historicalProfile = true; }
      }
      if (currentActors.length === 0 && payload.fallbackAuthor && durableSlack && event.provider === "slack" && !runtime.operationAuthority) {
        const retained = await executor.select().from(externalActorProjections).where(and(
          eq(externalActorProjections.id, payload.projectionId), eq(externalActorProjections.provider, "slack"),
          eq(externalActorProjections.appRegistrationId, event.appRegistrationId), eq(externalActorProjections.installId, event.installId),
          eq(externalActorProjections.workspaceId, event.workspaceId), eq(externalActorProjections.externalActorId, payload.externalActorId),
          inArray(externalActorProjections.actorKind, ["human", "guest", "remote", "unknown"]),
        )).limit(2);
        if (retained.length === 1) currentActors.push(retained[0]!);
      }
      if (currentActors.length === 0) throw new Error("External projection actor authority is not current");
      if (currentActors.length !== 1) return null;
      const currentActor = currentActors[0]!;
      if (event.provider === "slack" && currentActor.actorKind === "bot" && sourceInstall?.providerBotId === currentActor.externalActorId) {
        // A late installation change can make a previously accepted bot our
        // own. The install row is share-locked through this terminal decision.
        await executor.update(externalInboundEvents).set(terminalEraseWithoutMessage(event, "dead", "provider_self_echo_without_link", commitAt))
          .where(eq(externalInboundEvents.id, event.id));
        return { kind: "blocked" as const, eventId: event.id, reason: "provider_self_echo_without_link" };
      }
      if (payload.fallbackAuthor && (currentActor.actorKind === "bot"
        || currentActor.identityKind !== (payload.fallbackAuthor === "anonymous" ? "anonymous" : "provider_actor"))) return null;
      const provisionalProfile = Boolean(payload.fallbackAuthor) || historicalProfile || (event.provider === "slack" && currentActor.actorKind === "unknown"
        && currentActor.displayName === currentActor.externalActorId);
      if (provisionalProfile && !historicalProfile && payload.fallbackAuthor !== "anonymous"
        && commitAt.getTime() < event.receivedAt.getTime() + SLACK_PROFILE_WAIT_MS) {
        commitBlockReason = "external_actor_profile_unavailable";
        return null;
      }
      if (payload.schema === INBOUND_PAYLOAD_SCHEMA_V4 && (event.provider !== "slack" || currentActor.actorKind !== "bot")) {
        commitBlockReason = "bot_actor_authority_mismatch";
        return null;
      }
      if (provisionalProfile) {
        resolvedAgentMentions.length = 0;
        resolvedHumanMentions.length = 0;
      }
      const canonicalInput = {
        executor,
        channelId: target.channel.id,
        content: unavailableAttachment
          ? appendAttachmentUnavailableMarker(historicalProfile || payload.fallbackAuthor ? payload.content : agentRenderedContent, event.provider)
          : historicalProfile || payload.fallbackAuthor ? payload.content : agentRenderedContent,
        createdAt: new Date(payload.createdAt),
        projectionId: currentActor.id,
        provider: event.provider,
        appRegistrationId: operationAuthority.appRegistrationId,
        installId: operationAuthority.installId,
        workspaceId: event.workspaceId,
        workspaceName: sourceInstall?.workspaceName ?? null,
        externalActorId: payload.externalActorId,
        externalConversationId: event.providerConversationId,
        externalMessageId: payload.providerMessageId,
        actorProjectionRevision: currentActor.projectionRevision,
        identityKind: payload.fallbackAuthor === "anonymous" ? "anonymous" as const : "provider_actor" as const,
      };
      const result = payload.fallbackAuthor
        ? await insertSlackFallbackAuthorMessage(canonicalInput, { inboundEventId: event.id,
          leaseOwner: input.leaseOwner, leaseGeneration: claim.leaseGeneration, at: commitAt,
          sourcePlaintext: plaintext, kind: payload.fallbackAuthor })
        : historicalProfile
        ? await insertSlackHistoricalAuthorMessage(canonicalInput, { inboundEventId: event.id,
          leaseOwner: input.leaseOwner, leaseGeneration: claim.leaseGeneration, at: commitAt, sourcePlaintext: plaintext })
        : provisionalProfile
        ? await insertSlackProvisionalProfileMessage(canonicalInput, { receivedAt: event.receivedAt, now: commitAt })
        : await insertCanonicalExternalMessage(canonicalInput);

      // Mint real Raft mention rows for provider-side mention tokens that
      // resolve to a Raft principal. Before this, external_projection messages
      // carried zero message_mentions rows, so Slack-side @-mentions could
      // never notify a linked human or wake an agent — fail-closed by
      // omission (task #221, yezizp directive: match normal Raft mention
      // semantics, no fail-closed).
      const mentionedProviderUserIds = provisionalProfile ? [] : [...new Set(
        [...payload.content.matchAll(SLACK_NATIVE_USER_MENTION)].map((match) => match[1]!),
      )].slice(0, 50);

      // Mention rows carry the sender's local-face coordinates, not the
      // canonical storage channel (mention-v6 contract): the inbound event
      // commits on the host side, so the origin face is the joint host
      // projection — host local thread for Joint threads, host local channel
      // for Joint channels, the bound channel itself for ordinary targets.
      const hostJointProjection = jointChannelProjections.find(
        (projection) => projection.role === "host",
      );
      const mentionOriginChannelId = target.jointThreadProjection
        ? target.jointThreadProjection.localThreadChannelId
        : hostJointProjection?.localChannelId ?? target.channel.id;
      const mentionOriginServerId = target.jointThreadProjection
        ? target.jointThreadProjection.localServerId
        : hostJointProjection?.serverId ?? target.channel.serverId;

      const mentionTargetRows: {
        targetType: "user" | "agent";
        targetId: string;
        handle: string;
        notifiableAtSend: boolean;
      }[] = [];
      if (event.provider === "slack" && !provisionalProfile) {
        for (const mention of await resolveSlackPlainTextMentions(
          executor,
          payload.content,
          mentionScopeChannelIds,
        )) {
          mentionTargetRows.push({ ...mention, notifiableAtSend: true });
        }
      }
      if (event.provider === "slack" && mentionedProviderUserIds.length > 0) {
        // A picked Slack user is a Slack identity, never a Raft one: even an
        // installer's linked Slack account does not mint a Raft mention
        // (yezizp, #wg-slack-bridge:54ae7275 msg d6f3bb0d). Raft people and
        // Agents are reached through their managed usergroups or typed names.
        // A mention of the bridge bot itself addresses the bound channel's
        // agents — that is the only addressable Raft agent set a Slack user
        // can mean. Agents are minted from the same scope set as humans, so
        // every Joint face's agents get the mention on their own face.
        if (sourceInstall?.botUserId && mentionedProviderUserIds.includes(sourceInstall.botUserId)) {
          const mintedAgentIds = new Set<string>();
          for (const scopeChannelId of mentionScopeChannelIds) {
            const scopedAgents = await executor.select({ id: agents.id })
              .from(channelAgents)
              .innerJoin(agents, eq(agents.id, channelAgents.agentId))
              .where(eq(channelAgents.channelId, scopeChannelId));
            for (const agent of scopedAgents) {
              if (mintedAgentIds.has(agent.id)) continue;
              mintedAgentIds.add(agent.id);
              mentionTargetRows.push({
                targetType: "agent",
                targetId: agent.id,
                handle: sourceInstall.botUserId,
                notifiableAtSend: true,
              });
            }
          }
        }
      }

      // A human picked from Slack's usergroup autocomplete is a Raft mention of
      // that human — already scope-checked, so always notifiable. A typed
      // `@name` of the same human may already hold the row.
      for (const mention of resolvedHumanMentions) {
        if (mentionTargetRows.some((row) => (
          row.targetType === "user" && row.targetId === mention.userId
        ))) continue;
        mentionTargetRows.push({
          targetType: "user",
          targetId: mention.userId,
          handle: mention.handle,
          notifiableAtSend: true,
        });
      }

      // A reply into a thread authored by a Raft user/agent must make the
      // parent author a durable thread follower — the same "authored" follow
      // the Raft send path records for internal replies. For a Joint thread
      // the follow lands on each local face where the author is a member of
      // that face's parent channel; ordinary threads have a single face.
      const authorFollowFaces: { threadChannelId: string; scopeParentChannelId: string }[] =
        target.channel.type === "thread"
          ? target.jointThreadProjection
            ? jointThreadFaces.map((face) => ({
                threadChannelId: face.localThreadChannelId,
                scopeParentChannelId: face.localParentChannelId,
              }))
            : target.channel.parentMessageId
              ? [{
                  threadChannelId: target.channel.id,
                  scopeParentChannelId: (
                    await executor.select({ channelId: messages.channelId })
                      .from(messages)
                      .where(eq(messages.id, target.channel.parentMessageId))
                      .limit(1)
                  )[0]?.channelId,
                }].filter((face): face is typeof face & { scopeParentChannelId: string } =>
                  Boolean(face.scopeParentChannelId))
              : []
          : [];
      if (!provisionalProfile && authorFollowFaces.length > 0) {
        const [parentAuthor] = await executor.select({
          senderType: messages.senderType,
          senderId: messages.senderId,
        }).from(messages).where(eq(messages.id, target.channel.parentMessageId!)).limit(1);
        if (parentAuthor && (parentAuthor.senderType === "agent" || parentAuthor.senderType === "user")) {
          for (const face of authorFollowFaces) {
            const faceMember = parentAuthor.senderType === "agent"
              ? await isChannelAgent(face.scopeParentChannelId, parentAuthor.senderId, executor)
              : await isChannelHuman(face.scopeParentChannelId, parentAuthor.senderId, executor);
            if (!faceMember) continue;
            const followResult = await executor.execute(sql`
              INSERT INTO thread_follows (
                thread_channel_id,
                follower_type,
                follower_id,
                parent_message_id,
                reason,
                done_at,
                unfollowed_at
              )
              VALUES (
                ${face.threadChannelId}::uuid,
                ${parentAuthor.senderType},
                ${parentAuthor.senderId}::uuid,
                ${target.channel.parentMessageId}::uuid,
                'authored',
                NULL,
                NULL
              )
              ON CONFLICT (thread_channel_id, follower_type, follower_id) DO UPDATE
              SET
                parent_message_id = EXCLUDED.parent_message_id,
                reason = EXCLUDED.reason,
                created_at = now(),
                done_at = NULL
              WHERE thread_follows.unfollowed_at IS NULL
              RETURNING xmax = 0 AS inserted
            `);
            // Mirror the send path's joinedThroughSeq=reply.seq-1: a fresh
            // follow must not swallow this reply into born-read.
            if ((followResult.rows[0] as { inserted?: boolean } | undefined)?.inserted) {
              await startReadPositionAtJoin(
                executor,
                parentAuthor.senderType === "agent" ? "agent" : "human",
                parentAuthor.senderId,
                face.threadChannelId,
                result.message.seq - 1,
              );
            }
          }
        }
      }

      if (mentionTargetRows.length > 0) {
        await executor.insert(messageMentions).values(
          mentionTargetRows.map((mentionTarget) => ({
            messageId: result.message.id,
            messageSeq: result.message.seq,
            serverId: mentionOriginServerId,
            channelId: mentionOriginChannelId,
            targetType: mentionTarget.targetType,
            targetId: mentionTarget.targetId,
            handleAtSendTime: mentionTarget.handle,
            source: "send_path" as const,
            confidence: "exact" as const,
            notifiableAtSend: mentionTarget.notifiableAtSend,
          })),
        ).onConflictDoNothing();
      }
      if (resolvedAgentMentions.length > 0) {
        await executor.insert(messageMentions).values(resolvedAgentMentions.map((mention) => ({
          messageId: result.message.id,
          messageSeq: result.message.seq,
          serverId: mentionOriginServerId,
          channelId: mentionOriginChannelId,
          targetType: "agent" as const,
          targetId: mention.agentId,
          handleAtSendTime: mention.handle,
          source: "send_path" as const,
          confidence: "exact" as const,
          notifiableAtSend: true,
        }))).onConflictDoNothing();
      }
      await recordSlackInboundExternalMentionFacts({
        executor,
        event,
        messageId: result.message.id,
        providerUserIds: mentionedProviderUserIds,
        botUserId: sourceInstall?.botUserId ?? null,
        now: commitAt,
      });
      const [messageLink] = await executor.insert(externalMessageLinks).values({
        provider: event.provider,
        installId: event.installId,
        providerAuthorityId: event.providerAuthorityId,
        providerConversationId: event.providerConversationId,
        providerMessageId: payload.providerMessageId,
        providerThreadId: payload.providerThreadId,
        bindingId: event.bindingId,
        bindingEpoch: event.bindingEpoch,
        connectionEpoch: event.connectionEpoch,
        raftMessageId: result.message.id,
        raftCanonicalRootMessageId: target.canonicalRootMessageId,
        firstDirection: "provider_inbound",
        payloadFingerprint: event.normalizedPayloadDigest,
        outcomeState: "accepted",
        authorityState: "active",
        stateReason: "provider_inbound_committed",
        createdAt: commitAt,
        updatedAt: commitAt,
      }).returning();
      if (!messageLink) throw new Error("External attachment message link was not created");
      const storedFacts = attachmentFacts.filter((fact) => fact.state === "stored");
      if (storedFacts.length > 0) {
        const projectionIds = storedFacts.map((fact) => fact.attachmentProjectionId!);
        await linkAttachmentsToMessageWithExecutor(
          executor,
          projectionIds,
          result.message.id,
          payload.projectionId,
          "new",
          commitAt,
        );
        const assetIds = storedFacts.map((fact) => fact.assetId);
        await executor.update(externalAttachmentAssets).set({
          state: "linked",
          updatedAt: commitAt,
        }).where(inArray(externalAttachmentAssets.id, assetIds));
        await executor.update(externalAttachmentMessageFacts).set({
          messageLinkId: messageLink.id,
          state: "linked",
          updatedAt: commitAt,
        }).where(inArray(externalAttachmentMessageFacts.id, storedFacts.map((fact) => fact.id)));
      }
      const unavailableFacts = attachmentFacts.filter(
        (fact) => fact.state === "unavailable" || fact.state === "revoked",
      );
      if (unavailableFacts.length > 0) {
        await executor.update(externalAttachmentMessageFacts).set({
          messageLinkId: messageLink.id,
          updatedAt: commitAt,
        }).where(inArray(externalAttachmentMessageFacts.id, unavailableFacts.map((fact) => fact.id)));
      }
      // Count prior bot messages with an agent mention, including messages
      // whose wake was suppressed. The current message and all mention rows
      // remain visible; human notifications are unaffected.
      const botWakeLimited = event.provider === "slack" && currentActor.actorKind === "bot"
        && (mentionTargetRows.some(row => row.targetType === "agent") || resolvedAgentMentions.length > 0)
        && await slackBotWakeIsLimited({ db: executor, projectionId: currentActor.id,
          registrationId: operationAuthority.appRegistrationId, installId: operationAuthority.installId,
          workspaceId: event.workspaceId, providerConversationId: event.providerConversationId,
          bindingId: operationAuthority.bindingId, messageId: result.message.id, now: commitAt });
      await recordInboxFactsForPersistedMessages([result.message], {
        suppressAgentDelivery: provisionalProfile || botWakeLimited,
        executor,
        channel: target.channel,
        // resolveTargetChannel locks the permission-facing binding anchor,
        // canonical storage target, and every active Joint thread projection.
        allowExecutorThread: target.jointThreadProjection === null,
        jointThreadProjection: target.jointThreadProjection,
        // Top-level Joint commits must fan facts out to every active local
        // projection — the canonical storage channel has no members, so
        // without this no face member ever receives a row.
        jointProjections: jointChannelProjections,
        inboxFactPolicy: {
          mode: "record",
          producer: "external_projection.inbound",
          reason: "provider inbound canonical message committed",
        },
      });
      if (inboundCanonicalCommitHookForTests) await inboundCanonicalCommitHookForTests();
      const status = result.kind === "duplicate" ? "duplicate" : "committed";
      await executor.update(externalInboundEvents).set({ ...terminalErase(event, status, result.message.id, commitAt),
        ...(payload.fallbackAuthor ? { outcomeReason: `provider_inbound_fallback_${payload.fallbackAuthor}` }
          : botWakeLimited ? { outcomeReason: "provider_bot_wake_rate_limited" } : {}) })
        .where(eq(externalInboundEvents.id, event.id));
      return { kind: status, eventId: event.id, messageId: result.message.id };
    });
  } catch (error) {
    if (error instanceof ConfirmedHistoricalReceiptMissing) {
      await terminalizeLeaseWithoutMessage(input.db, claim, input.leaseOwner, claim.leaseGeneration,
        "dead", error.reason, commitAt, durableSlack && claim.provider === "slack");
      console.warn("[SlackBridge] historical dependency discarded", { event: "server.slack_bridge.history.discarded",
        direction: "provider_inbound", operation: "message", bindingId: claim.bindingId, operationId: claim.id, reason: error.reason });
      return { kind: "blocked", eventId: claim.id, reason: error.reason };
    }
    if (error instanceof ExternalInboundTargetUnavailableError) {
      await releaseClaim(commitBlockReason);
      return { kind: "blocked", eventId: claim.id, reason: commitBlockReason };
    }
    const actorRevoked = error instanceof Error
      && error.message === "External projection actor authority is not current";
    if (actorRevoked && claim.provider === "slack") {
      await releaseClaim("external_actor_authority_unavailable");
      return { kind: "blocked", eventId: claim.id, reason: "external_actor_authority_unavailable" };
    }
    if (actorRevoked) {
      await terminalizeLeaseWithoutMessage(
        input.db,
        claim,
        input.leaseOwner,
        claim.leaseGeneration,
        "revoked",
        "external_actor_authority_revoked",
        commitAt, durableSlack && claim.provider === "slack");
      return { kind: "blocked", eventId: claim.id, reason: "external_actor_authority_revoked" };
    }
    await releaseClaim("canonical_commit_failed");
    return { kind: "blocked", eventId: claim.id, reason: "canonical_commit_failed" };
  }

  if (committed) {
    const onCommitted = payload.schema === INBOUND_EDIT_PAYLOAD_SCHEMA
      ? input.dependencies.onMessageEdited
      : input.dependencies.onMessageCommitted;
    if (committed.kind === "committed" && onCommitted) {
      try {
        await onCommitted({
          eventId: committed.eventId,
          messageId: committed.messageId,
        });
      } catch (error) {
        // Persistence and inbox facts are already committed. Realtime is an
        // acceleration path; a socket/read-model failure must not replay the
        // provider event or duplicate the canonical message.
        try {
          input.dependencies.onMessageCommittedError?.(error);
        } catch {
          // Observability must not turn a durable commit into a retry.
        }
      }
    }
    return committed;
  }
  if (commitBlockReason === "payload_expired_before_canonical_commit") {
    await terminalizeLeaseWithoutMessage(
      input.db,
      claim,
      input.leaseOwner,
      claim.leaseGeneration,
      "dead",
      commitBlockReason,
      commitAt, durableSlack && claim.provider === "slack");
  } else {
    await releaseClaim(commitBlockReason);
  }
  return { kind: "blocked", eventId: claim.id, reason: commitBlockReason };
}

export function createExternalInboundWorkerRuntime(input: {
  db: Database;
  leaseOwner: string;
  dependencies?: ExternalInboundWorkerDependencies | null;
  intervalMs?: number;
  /** Enable only after the mixed-version rollout barrier has been verified. */
  durableSlackMode?: boolean;
  /** Production runtime reads the durable switch from this database on every tick. */
  slackRolloutDb?: Database;
  onResult?(result: ExternalInboundWorkerResult): void;
  /** A tick that throws; a tick aborted by stop() is not reported. */
  onError?(error: unknown): void;
}) {
  const intervalMs = input.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("External inbound worker interval must be positive");
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<unknown> | null = null;
  let controller: AbortController | null = null;
  const tick = () => {
    if (running) return;
    const tickController = new AbortController();
    controller = tickController;
    const signal = tickController.signal;
    const rollout = input.slackRolloutDb
      ? readSlackIngressRollout(input.slackRolloutDb).then(state => state.mode)
      : Promise.resolve(input.durableSlackMode ? "verified_active" : "legacy");
    running = rollout.then(mode => {
      if (signal.aborted) return;
      if (mode === "legacy") {
        // Preserve the landed worker's error/reporting behavior while disabled.
        return processExternalInboundEventOnce({ db: input.db, leaseOwner: input.leaseOwner,
          dependencies: input.dependencies, signal })
          .then(result => input.onResult?.(result))
          .catch((error: unknown) => { if (!signal.aborted) input.onError?.(error); });
      }
      const calls = [
        ...(mode === "verified_active" ? Array.from({ length: 4 }, () => processExternalInboundEventOnce({ db: input.db,
          leaseOwner: input.leaseOwner, dependencies: input.dependencies, signal,
          durableSlackMode: true, providerScope: "slack" })) : []),
        processExternalInboundEventOnce({ db: input.db, leaseOwner: input.leaseOwner,
          dependencies: input.dependencies, signal, providerScope: "other" }),
      ];
      // fanout-ok: at most four ordered Slack claims and one legacy-provider claim.
      return Promise.allSettled(calls).then(results => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          try { input.onResult?.(result.value); }
          catch (error) { if (!signal.aborted) input.onError?.(error); }
        } else if (!signal.aborted) input.onError?.(result.reason);
      }
      });
    }, (error: unknown) => { if (!signal.aborted) input.onError?.(error); })
      .finally(() => { running = null; controller = null; });
  };
  return {
    start() {
      if (timer || !input.dependencies) return;
      tick();
      timer = setClockInterval(tick, intervalMs) as ReturnType<typeof setInterval>;
      timer.unref?.();
    },
    async stop() {
      if (timer) clearClockInterval(timer);
      timer = null;
      controller?.abort();
      await running?.catch(() => undefined);
    },
    tick,
  };
}

/** Exposes target resolution (and its row-lock order) to the real-PostgreSQL lock-order test. */
export const __resolveExternalInboundTargetForTests = resolveTargetChannel;
