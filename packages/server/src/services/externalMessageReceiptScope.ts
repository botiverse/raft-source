import { and, eq, exists, inArray, lt, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DatabaseExecutor } from "../db/index";
import { externalAppInstalls, externalChannelBindings, externalInboundEvents, externalMessageLinks, externalOutboundDeliveries, messages } from "../db/schema";
import { CONFIRMED_THREAD_ROOT_MISSING } from "./externalProviderPreparation";
import { resolveExternalConversationTarget } from "./externalConversationTargetService";
import type { SlackProviderAuthorityFence } from "./slackProviderAdapter";

/** Message location survives changes to the installation and binding authority. */
export function externalMessageReceiptLocation(executor: DatabaseExecutor, canonicalRaftChannelId: string) {
  const message = alias(messages, "receipt_message");
  const root = alias(messages, "receipt_root");
  return exists(executor.select({ id: message.id }).from(message)
    .leftJoin(root, eq(root.id, externalMessageLinks.raftCanonicalRootMessageId))
    .where(and(
      eq(message.id, externalMessageLinks.raftMessageId),
      or(
        eq(message.channelId, canonicalRaftChannelId),
        and(eq(root.channelId, canonicalRaftChannelId), sql`${root.threadId} = ${message.channelId}::text`),
      ),
    )));
}

/**
 * This identifies historical messages in the same actual channel pair. It is
 * never operation authorization: callers separately validate the live binding,
 * installation and actor. Old control-plane epochs and stale credentials do
 * not erase an accepted message receipt.
 */
export function externalMessageReceiptScope(executor: DatabaseExecutor, scope: {
  provider: string;
  providerAuthorityId: string;
  providerConversationId: string;
  canonicalRaftChannelId: string;
}) {
  return and(
    eq(externalMessageLinks.provider, scope.provider),
    eq(externalMessageLinks.providerAuthorityId, scope.providerAuthorityId),
    eq(externalMessageLinks.providerConversationId, scope.providerConversationId),
    eq(externalMessageLinks.outcomeState, "accepted"),
    externalMessageReceiptLocation(executor, scope.canonicalRaftChannelId),
  );
}

export class ConfirmedHistoricalReceiptMissing extends Error {
  readonly reason = CONFIRMED_THREAD_ROOT_MISSING;
}

/** Fresh, potentially reordered roots keep waiting; only pre-pair history can be absent. */
export async function historicalProviderReceiptIsAbsent(
  executor: DatabaseExecutor,
  event: Pick<typeof externalInboundEvents.$inferSelect,
    "id" | "provider" | "bindingId" | "bindingEpoch" | "connectionEpoch" | "installId"
    | "providerAuthorityId" | "providerConversationId" | "raftChannelId">,
  providerMessageId: string,
): Promise<boolean> {
  if (event.provider !== "slack" || !/^[0-9]+\.[0-9]{6}$/.test(providerMessageId)) return false;
  const [current] = await executor.select({ binding: externalChannelBindings }).from(externalChannelBindings)
    .innerJoin(externalAppInstalls, and(
      eq(externalAppInstalls.id, externalChannelBindings.installId),
      eq(externalAppInstalls.state, "active"),
      eq(externalAppInstalls.connectionEpoch, event.connectionEpoch),
      eq(externalAppInstalls.providerAuthorityId, event.providerAuthorityId),
    )).where(and(
      sql`${externalChannelBindings.id}::text = ${event.bindingId}`,
      sql`${externalChannelBindings.installId}::text = ${event.installId}`,
      eq(externalChannelBindings.bindingEpoch, event.bindingEpoch),
      eq(externalChannelBindings.connectionEpoch, event.connectionEpoch),
      eq(externalChannelBindings.channelId, event.raftChannelId),
      eq(externalChannelBindings.providerConversationId, event.providerConversationId),
      eq(externalChannelBindings.state, "active"),
    )).limit(1);
  if (!current) return false;
  const since = current.binding.consentedAt ?? current.binding.createdAt;
  if (Number(providerMessageId) * 1000 >= since.getTime()) return false;
  const [pendingRoot] = await executor.select({ id: externalOutboundDeliveries.id }).from(externalOutboundDeliveries).where(and(
    sql`${externalOutboundDeliveries.renderSnapshot} #>> '{bindingAuthority,providerAuthorityId}' = ${event.providerAuthorityId}`,
    sql`${externalOutboundDeliveries.renderSnapshot} #>> '{bindingAuthority,providerConversationId}' = ${event.providerConversationId}`,
    sql`${externalOutboundDeliveries.renderSnapshot} #>> '{bindingAuthority,raftChannelId}' = ${event.raftChannelId}`,
    or(
      eq(externalOutboundDeliveries.providerMessageId, providerMessageId),
      and(lt(externalOutboundDeliveries.createdAt, since),
        inArray(externalOutboundDeliveries.state, ["queued", "dispatching", "retry_wait", "outcome_unknown", "dead"])),
    ),
  )).limit(1);
  if (pendingRoot) return false;
  const [pendingIngress] = await executor.select({ id: externalInboundEvents.id }).from(externalInboundEvents).where(and(
    ne(externalInboundEvents.id, event.id),
    eq(externalInboundEvents.provider, event.provider),
    eq(externalInboundEvents.providerAuthorityId, event.providerAuthorityId),
    eq(externalInboundEvents.providerConversationId, event.providerConversationId),
    eq(externalInboundEvents.raftChannelId, event.raftChannelId),
    inArray(externalInboundEvents.status, ["queued", "processing"]),
  )).limit(1);
  return !pendingIngress;
}

export type ExternalThreadReceiptResolution =
  | { kind: "found"; providerThreadId: string }
  | { kind: "absent" }
  | { kind: "conflict" }
  | { kind: "unavailable" };

export async function resolveExternalThreadReceipt(input: {
  executor: DatabaseExecutor;
  canonicalRootMessageId: string;
  authority: SlackProviderAuthorityFence;
  allowArchivedForQueuedDelivery?: boolean;
}): Promise<ExternalThreadReceiptResolution> {
  const { executor, authority } = input;
  const [binding] = await executor.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, authority.bindingId),
    eq(externalChannelBindings.installId, authority.installId),
    eq(externalChannelBindings.providerConversationId, authority.providerConversationId),
    eq(externalChannelBindings.bindingEpoch, authority.bindingEpoch),
    eq(externalChannelBindings.connectionEpoch, authority.connectionEpoch),
    eq(externalChannelBindings.state, "active"),
  )).limit(1);
  if (!binding) return { kind: "unavailable" };
  const target = await resolveExternalConversationTarget({ executor, authorityChannelId: binding.channelId,
    allowArchivedForQueuedDelivery: input.allowArchivedForQueuedDelivery });
  if (!target || target.level !== "top_level" || (target.kind === "joint" && target.role !== "host")) return { kind: "unavailable" };
  const links = await executor.select().from(externalMessageLinks).where(and(
    eq(externalMessageLinks.raftMessageId, input.canonicalRootMessageId),
    externalMessageReceiptScope(executor, { ...authority, provider: "slack", canonicalRaftChannelId: target.storageChannelId }),
  )).limit(2);
  if (links.length > 1) return { kind: "conflict" };
  if (links[0]?.providerMessageId) return { kind: "found", providerThreadId: links[0].providerMessageId };
  const [root] = await executor.select({ id: messages.id }).from(messages).where(and(
    eq(messages.id, input.canonicalRootMessageId), eq(messages.channelId, target.storageChannelId),
  )).limit(1);
  if (!root) return { kind: "unavailable" };
  // A root awaiting delivery or confirmation can still become available. An
  // accepted delivery is durable evidence even if its link was lost.
  const roots = await executor.select({ state: externalOutboundDeliveries.state,
    providerMessageId: externalOutboundDeliveries.providerMessageId }).from(externalOutboundDeliveries).where(and(
    eq(externalOutboundDeliveries.sourceMessageId, root.id),
    ne(externalOutboundDeliveries.state, "skipped"),
    sql`${externalOutboundDeliveries.renderSnapshot} #>> '{bindingAuthority,providerAuthorityId}' = ${authority.providerAuthorityId}`,
    sql`${externalOutboundDeliveries.renderSnapshot} #>> '{bindingAuthority,providerConversationId}' = ${authority.providerConversationId}`,
    sql`${externalOutboundDeliveries.renderSnapshot} #>> '{bindingAuthority,raftChannelId}' = ${binding.channelId}`,
  )).limit(2);
  if (roots.length > 1) return { kind: "conflict" };
  if (roots[0]?.state === "accepted" && roots[0].providerMessageId) {
    return { kind: "found", providerThreadId: roots[0].providerMessageId };
  }
  return { kind: roots.length ? "unavailable" : "absent" };
}
