/**
 * RFC 077 §3.2: a personal assistant sends a message AS its owner. The owner is
 * the author (`sender_type = user`, `sender_id = owner`); the message carries
 * `delegated_by_agent_id`, so every client can say "sent by {assistant} for
 * {owner}". It goes through the owner's own send path (`broadcastAndDeliver`),
 * so read state, notifications, search and permissions all follow the owner.
 *
 * Every send re-checks, in order, and writes nothing when one fails:
 * - the assistant is still the owner's (`resolveAssistantOwner`, done by the
 *   route) and the owner turned "send as me" on (`agents.assistant_send_as_owner`,
 *   on for an assistant created since task #8; the owner can turn it off);
 * - the conversation exists in this server, is not the assistant's own DM with
 *   its owner (it speaks there as itself), and the owner can post to it right
 *   now;
 * - no `@everyone` / `@here`, and not a conversation bridged to an external chat;
 * - a DM only while the owner lets the assistant read DMs (reads and sends agree).
 * A reply's thread is created only after all of that passed.
 *
 * `dmWith` names a person or an agent instead of a conversation: the owner's
 * DM with them, opened when there is none yet, by exactly the web's "Send DM"
 * path (`openDirectMessageForUser`, same rules), as the owner. Whoever the
 * owner can DM themselves, the assistant can DM for them. Every check that
 * does not need the DM runs before it is opened, so a refused send leaves no
 * new DM behind; see `openOwnerDm`.
 *
 * After a send, Raft posts a receipt in the owner's DM with the assistant
 * (`postDelegatedReceipt`); the owner can retract it (`retractDelegatedMessage`).
 */
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseExecutor } from "../db/index";
import { AssistantSendAsOwnerError } from "./assistantDelegatedMessageAuthority";
import { agents, attachmentProjectionRevocations, attachments, externalChannelBindings, messageReactions, messages } from "../db/schema";

/** `revoke_reason` of the attachments of a delegated message its owner retracted. */
export const DELEGATED_RETRACT_REVOKE_REASON = "delegated_message_retracted";
import type { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import * as userService from "./userService";
import { assistantReadsOwnerDms, dmScopeOf, OWNER_RESOLVE_AMBIGUOUS_CODE, resolveNameForOwner } from "./assistantService";
import { areDmsReadOnlyByQuota, isChannelReadOnlyByBillingFeature, isChannelReadOnlyByQuota } from "./planService";
import { openDirectMessageForUser } from "./directMessageOpenService";
import { recordIntegrationAuditEventBestEffort } from "./integrationAuditService";
import { clearActionCardSubmittedInput, emitActionCardMessageUpdated } from "./actionCardsService";
import { recordTraceEvent } from "../tracing/semanticTrace";
import { removeAttachmentObjectHoldsWithExecutor } from "./attachmentObjectHoldService";
import { asServerId, DELEGATED_RECEIPT_KIND, isMessageCardMetadata, type DelegatedReceiptEntry, type DelegatedReceiptMetadata } from "@botiverse/raft-shared";

export const ASSISTANT_SEND_AS_OWNER_MAX_LENGTH = 32_000;

/** `@everyone` / `@here` as a whole word: a delegated message never pings a whole conversation. */
export const MASS_MENTION_PATTERN = /(^|[^\w@])@(everyone|here)\b/i;

export { AssistantSendAsOwnerError } from "./assistantDelegatedMessageAuthority";

export async function assistantSendsAsOwner(agentId: string): Promise<boolean> {
  const [row] = await getDb().select({ on: agents.assistantSendAsOwner }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return row?.on === true;
}

export async function setAssistantSendAsOwner(agentId: string, on: boolean, executor: DatabaseExecutor = getDb()): Promise<void> {
  await executor.update(agents).set({ assistantSendAsOwner: on }).where(eq(agents.id, agentId));
}

export interface SendAsOwnerResult {
  messageId: string;
  /** The conversation the message landed in (a thread's own channel when it went to a thread). */
  channelId: string;
}

export async function sendAsOwner(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  serverId: string;
  agentId: string;
  ownerUserId: string;
  /** The conversation. Exactly one of `channelId` and `dmWith`. */
  channelId?: string;
  /** `@name` (`~human` / `~agent` when a person and an agent share it): the owner's DM with them, opened if there is none. */
  dmWith?: string;
  content: string;
  /** Reply in the thread under this message (created if it has none yet); it must be in `channelId`. Not with `dmWith`. */
  parentMessageId?: string;
}): Promise<SendAsOwnerResult> {
  const fail = (status: number, code: string, message: string): never => {
    throw new AssistantSendAsOwnerError(status, code, message);
  };
  if (!await assistantSendsAsOwner(input.agentId)) {
    fail(403, "assistant_send_as_owner_off", "Your owner has not turned on sending as them. Summarize for them in your DM instead.");
  }
  const content = input.content;
  if (typeof content !== "string" || content.trim().length === 0) fail(400, "invalid_content", "The message is empty.");
  if (content.length > ASSISTANT_SEND_AS_OWNER_MAX_LENGTH) {
    fail(400, "invalid_content", `The message is longer than ${ASSISTANT_SEND_AS_OWNER_MAX_LENGTH} characters.`);
  }
  if (MASS_MENTION_PATTERN.test(content)) {
    fail(400, "mass_mention_not_allowed", "A message sent as your owner cannot use @everyone or @here.");
  }
  const hasChannelId = typeof input.channelId === "string" && input.channelId.length > 0;
  const hasDmWith = typeof input.dmWith === "string" && input.dmWith.trim().length > 0;
  if (hasChannelId === hasDmWith) {
    fail(400, "invalid_target", "Give exactly one of channelId (a conversation) or dmWith (@name, for your owner's DM with them).");
  }
  if (hasDmWith && input.parentMessageId) {
    fail(400, "invalid_target", "parentMessageId needs channelId: a reply goes under a message of a conversation you name by its id.");
  }

  const notFound = () => fail(404, "channel_not_found", "Channel not found or not visible");
  // Every check above ran before a new DM can be opened here.
  const channelId = hasDmWith
    ? await openOwnerDm({ serverId: input.serverId, agentId: input.agentId, ownerUserId: input.ownerUserId, dmWith: input.dmWith!, fail })
    : input.channelId!;
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== input.serverId) return notFound();
  const ownDmId = await channelService.findHumanAgentDmChannelId(input.serverId, input.ownerUserId, input.agentId);
  const scope = await dmScopeOf(channel);
  if (scope.dm && (scope.rootChannelId === null || scope.rootChannelId === ownDmId)) return notFound();
  // Reading and sending DMs follow the same switch: no DM sends once the owner closed DMs to it.
  if (scope.dm && !await assistantReadsOwnerDms(input.agentId)) return notFound();
  if (!await channelService.canUserAccessChannel(channel.id, input.ownerUserId, asServerId(input.serverId))) return notFound();

  // A reply under a message: its thread is created only after every check
  // passed, so a refused send leaves no empty thread behind. Until then the
  // checks run on the parent conversation (and on the thread if it exists).
  let existingThreadId: string | null = null;
  if (input.parentMessageId) {
    const parent = await messageService.getMessage(input.parentMessageId);
    if (!parent || parent.channelId !== channel.id) {
      fail(404, "message_not_found", "No such message in this conversation.");
    }
    existingThreadId = parent?.threadId ?? null;
  }
  if (!await channelService.canUserPostToChannel(existingThreadId ?? channel.id, input.ownerUserId)) {
    fail(403, "owner_cannot_post", "Your owner cannot post in this conversation.");
  }
  if (await isChannelReadOnlyByBillingFeature(channel.id, input.serverId) || await isChannelReadOnlyByQuota(channel.id, input.serverId)) {
    fail(403, "owner_cannot_post", "This conversation is read-only on the server's plan.");
  }
  // v1 (Tenny): no delegated sends into a conversation bridged to Slack or another
  // external chat, so every delegated message can be fully retracted.
  if (await isBridgedConversation(channel)) {
    fail(403, "owner_cannot_post", "This conversation is bridged to an external chat; messages cannot be sent there as your owner. Summarize for them in your DM instead.");
  }

  // No rate limit (tygg, 2026-10-21 22:57Z; RFC 077 v3.2).

  const targetChannelId = input.parentMessageId
    ? (await channelService.getOrCreateThread(input.parentMessageId, input.ownerUserId, "user")).id
    : channel.id;

  const owner = await userService.getUser(input.ownerUserId);
  // Bridged conversations are refused above, so this never reaches an external chat.
  // slack-bridge-ordinary-message-producer: assistant.send_as_owner
  const message = await messageService.broadcastAndDeliver(input.io, input.orchestrator, {
    channelId: targetChannelId,
    senderType: "user",
    senderId: input.ownerUserId,
    senderName: owner?.displayName || owner?.name || "User",
    content,
    delegatedByAgentId: input.agentId,
  });

  recordTraceEvent("server.assistant.send_as_owner", {
    agent_id: input.agentId,
    subject_user_id: input.ownerUserId,
    channel_id: targetChannelId,
    message_id: message.id,
    dm: scope.dm,
    dm_with: hasDmWith,
  });
  await recordIntegrationAuditEventBestEffort({
    serverId: input.serverId,
    eventType: "assistant.send_as_owner",
    outcome: "success",
    source: "api",
    actor: { type: "agent", id: input.agentId },
    subject: { type: "human", id: input.ownerUserId },
    target: { type: "message", id: message.id },
    metadata: { messageId: message.id, channelId: targetChannelId, channelType: channel.type },
  });
  await postDelegatedReceipt({
    io: input.io,
    orchestrator: input.orchestrator,
    serverId: input.serverId,
    agentId: input.agentId,
    ownerUserId: input.ownerUserId,
    ownDmId,
    message: { id: message.id, channelId: targetChannelId, content, createdAt: message.createdAt },
    conversation: channel,
    inThread: targetChannelId !== channel.id || channel.type === "thread",
    dmRootChannelId: scope.dm ? scope.rootChannelId : null,
  });
  return { messageId: message.id, channelId: targetChannelId };
}

/**
 * `dmWith`: the owner's DM with the person or agent it names, opened as the
 * owner when there is none, by the web's own "Send DM" path. Runs only after
 * every check that does not need the conversation (the caller's: "send as
 * me" on, content, no mass mention, one target), and does its own DM-only
 * checks first, so a refusal opens nothing:
 * 1. the owner lets the assistant read DMs (reads and sends agree);
 * 2. the name resolves as the owner would find it (`resolveNameForOwner`,
 *    the `owner-resolve` route's answer: 404 / 409), to a person or an agent;
 * 3. not the assistant itself (its own DM with the owner: it speaks there as itself);
 * 4. DMs are writable on the server's plan;
 * 5. `openDirectMessageForUser`: every rule of "Send DM", each refusal 403 with its code.
 * The checks the send then runs on the conversation (access, post, bridge)
 * pass for a DM just opened; only a concurrent change (the owner leaving the
 * server in between) could refuse there, leaving the DM empty, as a "Send DM"
 * the owner then sends nothing in does.
 */
async function openOwnerDm(input: {
  serverId: string;
  agentId: string;
  ownerUserId: string;
  dmWith: string;
  fail: (status: number, code: string, message: string) => never;
}): Promise<string> {
  const { fail } = input;
  if (!await assistantReadsOwnerDms(input.agentId)) {
    fail(403, "assistant_reads_dms_off", "Your owner has not let you read their DMs, so you cannot send DMs for them either. Summarize for them in your DM instead.");
  }
  const resolved = await resolveNameForOwner(input.serverId, input.ownerUserId, input.dmWith);
  if (!resolved.ok) {
    if (resolved.code === OWNER_RESOLVE_AMBIGUOUS_CODE) fail(409, resolved.code, "A person and an agent share that name. Add ~human or ~agent.");
    return fail(404, resolved.code, "Your owner cannot see anyone by that name here.");
  }
  if (resolved.type === "channel") {
    fail(400, "invalid_target", "dmWith names a person or an agent (@name). For a channel, use channelId.");
  }
  if (resolved.type === "agent" && resolved.id === input.agentId) {
    fail(403, "assistant_own_dm", "That is your own DM with your owner: speak there as yourself.");
  }
  if (await areDmsReadOnlyByQuota(input.serverId)) {
    fail(403, "owner_cannot_post", "This conversation is read-only on the server's plan.");
  }
  const opened = await openDirectMessageForUser(
    input.serverId,
    input.ownerUserId,
    resolved.type === "agent" ? { agentId: resolved.id } : { userId: resolved.id },
  );
  if (!opened.ok) return fail(403, opened.code, `Your owner cannot open this DM: ${opened.error}.`);
  if (!opened.channel) return fail(403, "dm_target_not_found", "Your owner cannot open this DM.");
  return opened.channel.id;
}

/** v1 (Tenny): a conversation (or a thread's parent) bridged to Slack or another external chat takes no delegated message. */
export async function isBridgedConversation(channel: { id: string; parentChannelId?: string | null }): Promise<boolean> {
  const bridgeRootIds = [channel.id, ...(channel.parentChannelId ? [channel.parentChannelId] : [])];
  const [bridged] = await getDb()
    .select({ id: externalChannelBindings.id })
    .from(externalChannelBindings)
    .where(and(inArray(externalChannelBindings.channelId, bridgeRootIds), ne(externalChannelBindings.state, "revoked")))
    .limit(1);
  return !!bridged;
}

/** What a retracted delegated message shows in place of its content. */
export const RETRACTED_DELEGATED_MESSAGE_CONTENT = "This message was retracted by its sender.";
export { DELEGATED_RECEIPT_KIND, type DelegatedReceiptMetadata } from "@botiverse/raft-shared";
const RECEIPT_PREVIEW_MAX = 80;

function firstLine(content: string): string {
  const line = content.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.length > RECEIPT_PREVIEW_MAX ? `${line.slice(0, RECEIPT_PREVIEW_MAX - 1)}…` : line;
}

/**
 * RFC 077 PR 2b: Raft (not the assistant) tells the owner about every message
 * sent as them, in their DM with the assistant: where it went, its first line,
 * and `delegatedReceipt` metadata the web turns into a "retract" button for the
 * owner. Best effort: a receipt that fails to post never undoes the send.
 */
async function postDelegatedReceipt(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  serverId: string;
  agentId: string;
  ownerUserId: string;
  ownDmId: string | null;
  message: { id: string; channelId: string; content: string; createdAt: Date | string };
  conversation: { id: string; name: string; type: string };
  inThread: boolean;
  dmRootChannelId: string | null;
}): Promise<void> {
  if (!input.ownDmId) return;
  try {
    // The thread the message is in (a reply), and its parent conversation.
    const thread = input.message.channelId !== input.conversation.id || input.conversation.type === "thread"
      ? await channelService.getChannel(input.message.channelId)
      : null;
    const parent = thread?.parentChannelId ? await channelService.getChannel(thread.parentChannelId) : null;
    const where = input.dmRootChannelId
      ? `dm:@${await channelService.resolveUserFacingDmPeerRef(input.serverId, input.ownerUserId, input.dmRootChannelId) ?? "someone"}`
      : `#${parent?.name ?? input.conversation.name}`;
    const preview = firstLine(input.message.content);
    const content = `Sent for you ${input.inThread ? "in a thread in" : "in"} ${where}: "${preview}"`;
    const metadata: DelegatedReceiptMetadata = {
      kind: DELEGATED_RECEIPT_KIND,
      delegatedReceipt: {
        messageId: input.message.id,
        channelId: input.message.channelId,
        deletedAt: null,
        conversationRef: where,
        conversationType: input.dmRootChannelId ? "dm" : (parent?.type ?? input.conversation.type),
        parentChannelId: thread ? (parent?.id ?? thread.parentChannelId ?? null) : null,
        parentMessageId: thread?.parentMessageId ?? null,
        preview,
        sentAt: new Date(input.message.createdAt).toISOString(),
        retractable: true,
      },
    };
    await messageService.broadcastSystemMessage(input.io, input.orchestrator, input.ownDmId, content, {
      inboxFactPolicy: {
        mode: "record",
        producer: "assistant.delegated_receipt",
        reason: "the owner sees every message their assistant sent as them",
        causalActor: { type: "agent", id: input.agentId },
      },
      actionMetadata: metadata,
      // Never delivered to the assistant: it caused it and already knows.
      targetAgentIds: [],
    });
  } catch (err) {
    console.error("[assistantSendAsOwner] receipt failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * One line of a forward receipt: a message an assistant forwarded as its
 * owner, named from the owner's side (`#channel`, `dm:@peer`; a thread: its
 * parent's), as `postDelegatedReceipt` names a single send.
 */
async function delegatedReceiptEntryFor(input: {
  serverId: string;
  ownerUserId: string;
  message: { id: string; channelId: string; createdAt: Date | string };
  preview: string;
}): Promise<DelegatedReceiptEntry> {
  const conversation = await channelService.getChannel(input.message.channelId);
  const thread = conversation?.type === "thread" ? conversation : null;
  const parent = thread?.parentChannelId ? await channelService.getChannel(thread.parentChannelId) : null;
  const scope = conversation ? await dmScopeOf(conversation) : { dm: false as const };
  const dmRootChannelId = scope.dm ? scope.rootChannelId : null;
  const where = dmRootChannelId
    ? `dm:@${await channelService.resolveUserFacingDmPeerRef(input.serverId, input.ownerUserId, dmRootChannelId) ?? "someone"}`
    : `#${parent?.name ?? conversation?.name ?? "channel"}`;
  return {
    messageId: input.message.id,
    channelId: input.message.channelId,
    deletedAt: null,
    conversationRef: where,
    conversationType: dmRootChannelId ? "dm" : (parent?.type ?? conversation?.type ?? "channel"),
    parentChannelId: thread ? (parent?.id ?? thread.parentChannelId ?? null) : null,
    parentMessageId: thread?.parentMessageId ?? null,
    preview: input.preview,
    sentAt: new Date(input.message.createdAt).toISOString(),
    retractable: true,
  };
}

/**
 * RFC 077 forwardAsOwner: ONE receipt per forward request in the owner's DM
 * with the assistant, a line per destination it went to, each retractable on
 * its own (`delegatedReceipts`; `delegatedReceipt` repeats the first line for
 * clients that read only one). Channels the assistant joined for the owner
 * are named, so the owner can leave them, and so is one joined where the
 * forward then did not go through (a receipt with no line when nothing was
 * sent at all). Best effort, like every receipt.
 */
export async function postDelegatedForwardReceipt(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  serverId: string;
  agentId: string;
  ownerUserId: string;
  ownDmId: string | null;
  content: string;
  itemCount: number;
  sent: Array<{ id: string; channelId: string; createdAt: Date | string }>;
  joined: Array<{ channelId: string; name: string }>;
  joinedNotForwarded?: Array<{ channelId: string; name: string }>;
}): Promise<void> {
  const joinedNotForwarded = input.joinedNotForwarded ?? [];
  if (!input.ownDmId || (input.sent.length === 0 && joinedNotForwarded.length === 0)) return;
  try {
    const preview = firstLine(input.content);
    const entries: DelegatedReceiptEntry[] = [];
    for (const message of input.sent) {
      entries.push(await delegatedReceiptEntryFor({ serverId: input.serverId, ownerUserId: input.ownerUserId, message, preview }));
    }
    const lines = [
      ...(entries.length > 0
        ? [
            `Forwarded ${input.itemCount} message${input.itemCount === 1 ? "" : "s"} for you to:`,
            ...entries.map((entry) => `- ${entry.conversationRef}`),
          ]
        : []),
      ...(input.joined.length > 0
        ? [`Joined ${input.joined.map((channel) => `#${channel.name}`).join(", ")} for you; you can leave ${input.joined.length === 1 ? "it" : "them"} any time.`]
        : []),
      ...joinedNotForwarded.map((channel) =>
        `Joined #${channel.name} for you, but the forward there did not go through. You can leave #${channel.name} any time.`),
    ];
    const metadata: DelegatedReceiptMetadata = {
      kind: DELEGATED_RECEIPT_KIND,
      ...(entries.length > 0 ? { delegatedReceipt: entries[0]! } : {}),
      delegatedReceipts: entries,
      ...(input.joined.length > 0 ? { joinedChannels: input.joined } : {}),
      ...(joinedNotForwarded.length > 0 ? { joinedNotForwarded } : {}),
    };
    await messageService.broadcastSystemMessage(input.io, input.orchestrator, input.ownDmId, lines.join("\n"), {
      inboxFactPolicy: {
        mode: "record",
        producer: "assistant.delegated_receipt",
        reason: "the owner sees every message their assistant sent as them",
        causalActor: { type: "agent", id: input.agentId },
      },
      actionMetadata: metadata,
      // Never delivered to the assistant: it caused it and already knows.
      targetAgentIds: [],
    });
  } catch (err) {
    console.error("[assistantSendAsOwner] forward receipt failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * The receipts for one delegated message, in the owner's DM with the assistant
 * that sent it: a send's own receipt, or a forward receipt with a line for it.
 */
export function delegatedReceiptsQuery(executor: DatabaseExecutor, ownDmId: string, messageId: string) {
  return executor.select({ id: messages.id, actionMetadata: messages.actionMetadata })
    .from(messages)
    .where(and(
      eq(messages.channelId, ownDmId),
      eq(messages.messageType, "system"),
      eq(messages.systemSubtype, "assistant.delegated_receipt"),
      sql`(${messages.actionMetadata}->'delegatedReceipt'->>'messageId' = ${messageId}
        OR (${messages.actionMetadata}::jsonb)->'delegatedReceipts' @> ${JSON.stringify([{ messageId }])}::jsonb)`,
    ));
}

/** A receipt's metadata once `messageId` was retracted: that line (and the single-send field when it is that one). */
export function markDelegatedReceiptRetracted(metadata: DelegatedReceiptMetadata, messageId: string, deletedAt: string): DelegatedReceiptMetadata {
  const mark = (entry: DelegatedReceiptEntry): DelegatedReceiptEntry => entry.messageId === messageId
    ? { ...entry, deletedAt, retractable: false }
    : entry;
  return {
    ...metadata,
    ...(metadata.delegatedReceipt ? { delegatedReceipt: mark(metadata.delegatedReceipt) } : {}),
    ...(Array.isArray(metadata.delegatedReceipts) ? { delegatedReceipts: metadata.delegatedReceipts.map(mark) } : {}),
  };
}

/**
 * RFC 077 PR 2b: the owner retracts a message their assistant sent as them.
 * The row stays (seq, thread anchor, inbox untouched); its content becomes a
 * fixed placeholder, its search text is cleared, and `deleted_at` is set.
 * Copies already delivered (an agent's context, someone's notification)
 * cannot be recalled. Idempotent: a retracted message answers as retracted.
 */
export async function retractDelegatedMessage(input: {
  io: SocketServer;
  serverId: string;
  userId: string;
  messageId: string;
}): Promise<{ messageId: string; deletedAt: string }> {
  const [row] = await getDb().select().from(messages).where(eq(messages.id, input.messageId)).limit(1);
  const channel = row ? await channelService.getChannel(row.channelId) : null;
  // RFC 082: a card message's text changes only through its sender's card
  // update; a retraction (which rewrites the content) leaves a message card
  // alone. A delegated message is a person's, never a card: this only holds
  // that if either changes.
  if (!row || !channel || channel.serverId !== input.serverId || row.senderType !== "user"
    || row.senderId !== input.userId || !row.delegatedByAgentId || isMessageCardMetadata(row.actionMetadata)) {
    throw new AssistantSendAsOwnerError(404, "message_not_found", "No message your assistant sent for you has this id.");
  }
  if (row.deletedAt) return { messageId: row.id, deletedAt: row.deletedAt.toISOString() };

  const now = new Date();
  // Receipts live only in the owner's DM with this assistant; scoping to it
  // keeps the lookup on the channel index (unscoped, it scanned all messages).
  const ownDmId = await channelService.findHumanAgentDmChannelId(input.serverId, input.userId, row.delegatedByAgentId);
  const receiptIds = await getDb().transaction(async (tx) => {
    // A forward carries its sources' text, authors and file names in its
    // forwarded-bundle metadata: that goes too, so it reads as a bare placeholder.
    const forwardedBundle = (row.actionMetadata as { kind?: unknown } | null)?.kind === "forwarded-bundle";
    const [updated] = await tx.update(messages)
      .set({
        content: RETRACTED_DELEGATED_MESSAGE_CONTENT,
        searchText: "",
        deletedAt: now,
        updatedAt: now,
        ...(forwardedBundle ? { actionMetadata: null } : {}),
      })
      .where(and(eq(messages.id, row.id), isNull(messages.deletedAt)))
      .returning({ id: messages.id });
    if (!updated) return [];
    // Its attachments go with it (task #6): every projection is revoked in the same
    // transaction, so no list, preview or download shows them again, and each
    // releases its hold on the bytes (attachment_object_holds). Bytes with no
    // hold are only reported, never deleted, by this release.
    const revoked = await tx.update(attachments)
      .set({ revokedAt: now, revokedById: input.userId, revokedByType: "user", revokeReason: DELEGATED_RETRACT_REVOKE_REASON })
      .where(and(eq(attachments.messageId, row.id), isNull(attachments.revokedAt)))
      .returning({ id: attachments.id, objectId: attachments.objectId });
    const bound = revoked.filter((projection): projection is { id: string; objectId: string } => projection.objectId !== null);
    if (bound.length > 0) {
      await tx.insert(attachmentProjectionRevocations).values(bound.map((projection) => ({
        projectionId: projection.id,
        objectId: projection.objectId,
        hostMessageId: row.id,
        requestServerId: input.serverId,
        revokedById: input.userId,
        revokedByType: "user" as const,
        reason: DELEGATED_RETRACT_REVOKE_REASON,
        revokedAt: now,
      }))).onConflictDoNothing();
      // Revoked projections no longer keep their bytes alive.
      await removeAttachmentObjectHoldsWithExecutor(tx, bound.map((projection) => ({
        holderType: "attachment" as const,
        holderId: projection.id,
        objectId: projection.objectId,
      })), now);
    }
    // Reactions go too: a retracted message is a bare placeholder (task #6, Jasper).
    // Link previews need nothing: they are unfurled from the content, which is replaced.
    await tx.delete(messageReactions).where(eq(messageReactions.messageId, row.id));
    // So do the values someone submitted through an action card's form on it (form.v1:
    // user content, Tenny). Today's carriers are agent-sent, so none is retractable yet.
    await clearActionCardSubmittedInput(tx, row.id);
    // The receipt(s) in the owner's DM with this assistant say "retracted" from now on.
    const receipts = ownDmId ? await delegatedReceiptsQuery(tx, ownDmId, row.id) : [];
    for (const receipt of receipts) {
      const metadata = receipt.actionMetadata as DelegatedReceiptMetadata;
      await tx.update(messages)
        .set({ actionMetadata: markDelegatedReceiptRetracted(metadata, row.id, now.toISOString()), updatedAt: now })
        .where(eq(messages.id, receipt.id));
    }
    return receipts.map((receipt) => receipt.id);
  });

  for (const id of [row.id, ...receiptIds]) await emitActionCardMessageUpdated(input.io, { id });
  recordTraceEvent("server.assistant.send_as_owner.deleted", {
    agent_id: row.delegatedByAgentId,
    subject_user_id: input.userId,
    message_id: row.id,
  });
  await recordIntegrationAuditEventBestEffort({
    serverId: input.serverId,
    eventType: "assistant.send_as_owner.deleted",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: input.userId },
    subject: { type: "agent", id: row.delegatedByAgentId },
    target: { type: "message", id: row.id },
    metadata: { messageId: row.id, channelId: row.channelId },
  });
  return { messageId: row.id, deletedAt: now.toISOString() };
}
