import { ConfirmedHistoricalReceiptMissing, externalMessageReceiptLocation, externalMessageReceiptScope, historicalProviderReceiptIsAbsent } from "./externalMessageReceiptScope";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import { createHash } from "node:crypto";

import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database, DatabaseTransaction } from "../db/index";
import {
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppInstalls,
  externalChannelBindings,
  externalInboundEvents,
  externalMessageLinks,
  externalReactionCommands,
  externalReactionFacts,
  externalReactionStates,
  messageReactionDiscussionVersions,
  messages,
} from "../db/schema";
import { evaluateFeatureFlag } from "./featureFlagService";
import {
  EXTERNAL_REACTION_MAPPING_REVISION,
  externalReactionFromSlack,
  externalReactionToSlack,
} from "./externalReactionEmojiMap";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function bumpDiscussionVersion(
  tx: DatabaseTransaction,
  messageId: string,
  emoji: string,
): Promise<number> {
  const [row] = await tx.insert(messageReactionDiscussionVersions).values({
    messageId,
    emoji,
    version: 1,
  }).onConflictDoUpdate({
    target: [messageReactionDiscussionVersions.messageId, messageReactionDiscussionVersions.emoji],
    set: {
      version: sql`${messageReactionDiscussionVersions.version} + 1`,
      updatedAt: sql`now()`,
    },
  }).returning({ version: messageReactionDiscussionVersions.version });
  if (!row) throw new Error("External reaction discussion version did not advance");
  return row.version;
}

export async function applyExternalReactionObservation(input: {
  tx: DatabaseTransaction;
  inboundEventId: string;
  providerEventId: string;
  operation: "add" | "remove";
  providerMessageId: string;
  externalActorId: string;
  providerReactionKey: string;
  eventOccurredAt: Date;
  eventSequence: number;
  botUserId: string;
  now: Date;
  operationAuthority?: import("./externalInboundWorkerService").ExternalInboundRuntimeAuthority;
}): Promise<{ outcome: "applied" | "noop" | "stale" | "quarantined" | "bot_echo" | "unsupported"; changed: boolean; raftMessageId: string }> {
  const [event] = await input.tx.select().from(externalInboundEvents).where(and(
    eq(externalInboundEvents.id, input.inboundEventId),
    eq(externalInboundEvents.providerEventId, input.providerEventId),
    inArray(externalInboundEvents.status, ["queued", "processing"]),
  )).for("update").limit(1);
  if (!event) throw new Error("External reaction ingress authority is unavailable");
  const [existingFact] = await input.tx.select().from(externalReactionFacts).where(and(
    eq(externalReactionFacts.provider, event.provider),
    eq(externalReactionFacts.appRegistrationId, event.appRegistrationId),
    eq(externalReactionFacts.providerEventId, input.providerEventId),
  )).limit(1);
  if (existingFact) {
    return { outcome: existingFact.outcome, changed: false, raftMessageId: existingFact.raftMessageId };
  }
  const receiptTarget = await resolveExternalConversationTarget({ executor: input.tx, authorityChannelId: event.raftChannelId });
  if (!receiptTarget) throw new Error("External reaction conversation is unavailable");
  const links = await input.tx.select().from(externalMessageLinks).where(and(
    eq(externalMessageLinks.providerMessageId, input.providerMessageId),
    externalMessageReceiptScope(input.tx, { ...event, canonicalRaftChannelId: receiptTarget.storageChannelId }),
  )).for("update").limit(2);
  if (links.length === 0 && await historicalProviderReceiptIsAbsent(input.tx, event, input.providerMessageId)) {
    throw new ConfirmedHistoricalReceiptMissing();
  }
  if (links.length !== 1) throw new Error("External reaction message link is unavailable");
  const link = links[0]!;
  const mapping = externalReactionFromSlack(input.providerReactionKey);
  const botEcho = input.externalActorId === input.botUserId;
  if (botEcho || !mapping) {
    const outcome = botEcho ? "bot_echo" as const : "unsupported" as const;
    await input.tx.insert(externalReactionFacts).values({
      inboundEventId: event.id,
      providerEventId: input.providerEventId,
      operation: input.operation,
      provider: event.provider,
      appRegistrationId: event.appRegistrationId,
      installId: event.installId,
      workspaceId: event.workspaceId,
      connectionEpoch: event.connectionEpoch,
      bindingId: event.bindingId,
      bindingEpoch: event.bindingEpoch,
      messageLinkId: link.id,
      raftMessageId: link.raftMessageId,
      projectionId: null,
      externalActorId: input.externalActorId,
      providerReactionKey: input.providerReactionKey,
      canonicalEmoji: mapping?.canonicalEmoji ?? null,
      mappingRevision: mapping?.mappingRevision ?? EXTERNAL_REACTION_MAPPING_REVISION,
      eventOccurredAt: input.eventOccurredAt,
      eventSequence: input.eventSequence,
      outcome,
      createdAt: input.now,
    });
    if (botEcho && mapping) {
      const desiredPresent = input.operation === "add";
      const [command] = await input.tx.select().from(externalReactionCommands).where(and(
        eq(externalReactionCommands.messageLinkId, link.id),
        eq(externalReactionCommands.providerReactionKey, mapping.providerReactionKey),
        eq(externalReactionCommands.desiredPresent, desiredPresent),
        inArray(externalReactionCommands.state, ["queued", "dispatching", "retry_wait", "outcome_unknown"]),
      )).orderBy(desc(externalReactionCommands.desiredRevision)).for("update").limit(1);
      if (command) {
        await input.tx.update(externalReactionCommands).set({
          state: "accepted",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorClass: null,
          terminalAt: input.now,
          updatedAt: input.now,
        }).where(eq(externalReactionCommands.id, command.id));
      }
    }
    return { outcome, changed: false, raftMessageId: link.raftMessageId };
  }

  const operation = { ...event, ...input.operationAuthority };
  const projections = await input.tx.select().from(externalActorProjections).where(and(
    eq(externalActorProjections.provider, operation.provider),
    eq(externalActorProjections.appRegistrationId, operation.appRegistrationId),
    eq(externalActorProjections.installId, operation.installId),
    eq(externalActorProjections.workspaceId, operation.workspaceId),
    eq(externalActorProjections.externalActorId, input.externalActorId),
    eq(externalActorProjections.state, "active"),
    eq(externalActorProjections.deactivated, false),
  )).for("update").limit(2);
  if (projections.length !== 1) throw new Error("External reaction actor projection is unavailable");
  const projection = projections[0]!;
  const [address] = await input.tx.select().from(externalAddressabilityProjections).where(and(
    eq(externalAddressabilityProjections.projectionId, projection.id),
    eq(externalAddressabilityProjections.provider, operation.provider),
    eq(externalAddressabilityProjections.appRegistrationId, operation.appRegistrationId),
    eq(externalAddressabilityProjections.installId, operation.installId),
    eq(externalAddressabilityProjections.workspaceId, operation.workspaceId),
    eq(externalAddressabilityProjections.connectionEpoch, operation.connectionEpoch),
    eq(externalAddressabilityProjections.bindingId, operation.bindingId),
    eq(externalAddressabilityProjections.bindingEpoch, operation.bindingEpoch),
    eq(externalAddressabilityProjections.conversationId, operation.providerConversationId),
    eq(externalAddressabilityProjections.state, "active"),
  )).orderBy(desc(externalAddressabilityProjections.contextRevision)).limit(1);
  if (!address) throw new Error("External reaction actor addressability is unavailable");

  // The locked message link above serializes updates to this provider
  // message. Presence is mutable state for the same actor/message/emoji;
  // its previous binding epoch is provenance, not a second reaction.
  const states = await input.tx.select({ state: externalReactionStates }).from(externalReactionStates)
    .innerJoin(externalActorProjections, and(
      eq(externalActorProjections.id, externalReactionStates.projectionId),
      eq(externalActorProjections.provider, event.provider),
      eq(externalActorProjections.workspaceId, event.workspaceId),
      eq(externalActorProjections.externalActorId, input.externalActorId),
    )).where(and(
      eq(externalReactionStates.messageLinkId, link.id),
      eq(externalReactionStates.providerReactionKey, mapping.providerReactionKey),
    )).for("update", { of: externalReactionStates }).limit(2);
  if (states.length > 1) throw new Error("External reaction presence identity is ambiguous");
  const current = states[0]?.state;
  const desiredPresent = input.operation === "add";
  let outcome: "applied" | "noop" | "stale" | "quarantined";
  let changed = false;
  if (current && current.lastEventSequence > input.eventSequence) {
    outcome = "stale";
  } else if (current && current.lastEventSequence === input.eventSequence) {
    outcome = current.present === desiredPresent ? "noop" : "quarantined";
  } else {
    changed = !current ? desiredPresent : current.present !== desiredPresent;
    outcome = changed ? "applied" : "noop";
    const values = {
      provider: event.provider,
      appRegistrationId: event.appRegistrationId,
      installId: event.installId,
      workspaceId: event.workspaceId,
      connectionEpoch: event.connectionEpoch,
      bindingId: event.bindingId,
      bindingEpoch: event.bindingEpoch,
      messageLinkId: link.id,
      raftMessageId: link.raftMessageId,
      projectionId: projection.id,
      providerReactionKey: mapping.providerReactionKey,
      canonicalEmoji: mapping.canonicalEmoji,
      mappingRevision: mapping.mappingRevision,
      present: desiredPresent,
      lastProviderEventId: input.providerEventId,
      lastEventAt: input.eventOccurredAt,
      lastEventSequence: input.eventSequence,
      updatedAt: input.now,
    };
    if (current) {
      await input.tx.update(externalReactionStates).set(values)
        .where(eq(externalReactionStates.id, current.id));
    } else {
      await input.tx.insert(externalReactionStates).values({ ...values, createdAt: input.now });
    }
    if (changed) await bumpDiscussionVersion(input.tx, link.raftMessageId, mapping.canonicalEmoji);
  }
  await input.tx.insert(externalReactionFacts).values({
    inboundEventId: event.id,
    providerEventId: input.providerEventId,
    operation: input.operation,
    provider: event.provider,
    appRegistrationId: event.appRegistrationId,
    installId: event.installId,
    workspaceId: event.workspaceId,
    connectionEpoch: event.connectionEpoch,
    bindingId: event.bindingId,
    bindingEpoch: event.bindingEpoch,
    messageLinkId: link.id,
    raftMessageId: link.raftMessageId,
    projectionId: projection.id,
    externalActorId: input.externalActorId,
    providerReactionKey: input.providerReactionKey,
    canonicalEmoji: mapping.canonicalEmoji,
    mappingRevision: mapping.mappingRevision,
    eventOccurredAt: input.eventOccurredAt,
    eventSequence: input.eventSequence,
    outcome,
    createdAt: input.now,
  });
  return { outcome, changed, raftMessageId: link.raftMessageId };
}

export async function enqueueSlackReactionAggregateTransition(input: {
  tx: DatabaseTransaction;
  raftMessageId: string;
  canonicalEmoji: string;
  localDiscussionVersion: number;
  localAggregateCount: number;
  desiredPresent: boolean;
  now: Date;
}): Promise<number> {
  const mapping = externalReactionToSlack(input.canonicalEmoji);
  const rows = await input.tx.select({
    link: externalMessageLinks,
    binding: externalChannelBindings,
    install: externalAppInstalls,
    serverId: externalChannelBindings.serverId,
  }).from(externalMessageLinks)
    .innerJoin(externalAppInstalls, and(
      eq(externalAppInstalls.providerAuthorityId, externalMessageLinks.providerAuthorityId),
      eq(externalAppInstalls.state, "active"),
    ))
    .innerJoin(externalChannelBindings, and(
      eq(externalChannelBindings.installId, externalAppInstalls.id),
      eq(externalChannelBindings.providerConversationId, externalMessageLinks.providerConversationId),
      eq(externalChannelBindings.connectionEpoch, externalAppInstalls.connectionEpoch),
      eq(externalChannelBindings.state, "active"),
    ))
    .innerJoin(messages, eq(messages.id, externalMessageLinks.raftMessageId))
    .where(and(
      eq(externalMessageLinks.raftMessageId, input.raftMessageId),
      eq(externalMessageLinks.provider, "slack"),
      eq(externalMessageLinks.outcomeState, "accepted"),
    ));
  const currentPairRows: typeof rows = [];
  for (const row of rows) {
    const target = await resolveExternalConversationTarget({ executor: input.tx, authorityChannelId: row.binding.channelId });
    if (!target || target.level !== "top_level" || (target.kind === "joint" && target.role !== "host")) continue;
    const [samePair] = await input.tx.select({ id: externalMessageLinks.id }).from(externalMessageLinks).where(and(
      eq(externalMessageLinks.id, row.link.id), externalMessageReceiptLocation(input.tx, target.storageChannelId),
    )).limit(1);
    if (samePair) currentPairRows.push(row);
  }
  const receiptsPerBinding = new Map<string, number>();
  for (const row of currentPairRows) receiptsPerBinding.set(row.binding.id, (receiptsPerBinding.get(row.binding.id) ?? 0) + 1);
  let created = 0;
  for (const row of currentPairRows) {
    // Conflicting historical provider identities are not a license to write
    // reactions to both messages. Other, unambiguous pairs remain independent.
    if (receiptsPerBinding.get(row.binding.id) !== 1) continue;
    const flag = await evaluateFeatureFlag({
      key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
      serverId: row.serverId,
    }, input.tx as unknown as Database);
    if (!flag.enabled) continue;
    const providerReactionKey = mapping?.providerReactionKey
      ?? `unsupported:${digest(input.canonicalEmoji).slice(0, 32)}`;
    const [latest] = await input.tx.select().from(externalReactionCommands).where(and(
      eq(externalReactionCommands.messageLinkId, row.link.id),
      eq(externalReactionCommands.providerReactionKey, providerReactionKey),
    )).orderBy(desc(externalReactionCommands.desiredRevision)).for("update").limit(1);
    if (latest && latest.desiredPresent === input.desiredPresent && !latest.terminalAt) continue;
    if (latest && !latest.terminalAt) {
      await input.tx.update(externalReactionCommands).set({
        state: "superseded",
        leaseOwner: null,
        leaseExpiresAt: null,
        terminalAt: input.now,
        updatedAt: input.now,
      }).where(eq(externalReactionCommands.id, latest.id));
    }
    const desiredRevision = (latest?.desiredRevision ?? 0) + 1;
    await input.tx.insert(externalReactionCommands).values({
      provider: row.link.provider,
      appRegistrationId: row.install.registrationId,
      installId: row.install.id,
      workspaceId: row.install.providerAuthorityId,
      providerAuthorityId: row.install.providerAuthorityId,
      connectionEpoch: row.install.connectionEpoch,
      bindingId: row.binding.id,
      bindingEpoch: row.binding.bindingEpoch,
      messageLinkId: row.link.id,
      raftMessageId: row.link.raftMessageId,
      providerConversationId: row.link.providerConversationId,
      providerMessageId: row.link.providerMessageId!,
      providerReactionKey,
      canonicalEmoji: input.canonicalEmoji,
      mappingRevision: mapping?.mappingRevision ?? EXTERNAL_REACTION_MAPPING_REVISION,
      desiredRevision,
      desiredPresent: input.desiredPresent,
      localDiscussionVersion: input.localDiscussionVersion,
      localAggregateCount: input.localAggregateCount,
      sourceSnapshotDigest: digest({
        schema: "external-reaction-command.v1",
        raftMessageId: input.raftMessageId,
        canonicalEmoji: input.canonicalEmoji,
        localDiscussionVersion: input.localDiscussionVersion,
        localAggregateCount: input.localAggregateCount,
        desiredPresent: input.desiredPresent,
        messageLinkId: row.link.id,
        providerReactionKey,
        desiredRevision,
      }),
      state: mapping ? "queued" : "deterministic_failure",
      nextAttemptAt: input.now,
      lastErrorClass: mapping ? null : "unsupported_reaction_mapping",
      terminalAt: mapping ? null : input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
    created += 1;
  }
  return created;
}
