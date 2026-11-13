/**
 * RFC 077 forwardAsOwner (Tenny / Artea, #proj-assistant:33e9ffe6): a
 * personal assistant forwards messages AS its owner, the way the owner
 * forwards in the web. One request, 1 to 20 messages, 1 to 10 destinations,
 * a result per destination, and the web's own idempotency, kept per
 * destination (`forward:{requestId}:{channelId}` plus the request digest):
 * a retry with the same requestId returns what was already sent to each
 * destination it already sent to and sends to the rest, whatever `to` now
 * lists; a destination it already sent to with other messages or note is
 * `request_conflict` there, while a destination it never sent to is sent as
 * a new forward (as the web does); a destination whose message the owner has
 * since retracted is `retracted_by_owner`, never sent again.
 *
 * Everything runs as the owner through the web's paths: the sources through
 * messageForwardService (read as the delegated actor: what the owner can
 * read, minus the DMs the owner keeps from the assistant and its own DM with
 * the owner, the owner-messages route's rule; one conversation, ordinary
 * chat messages), a new DM through openDirectMessageForUser ("Send DM"), a
 * join through joinChannelAsUser, the write through forwardBundleAsUser. The
 * stored message is the web's forwarded bundle plus `delegated_by_agent_id`.
 *
 * On top, the assistant's own rules (deliberately not the human's): "send as
 * me" on, a DM only while the owner lets the assistant read DMs, no
 * `@everyone` / `@here` in the note, no bridged conversation, never the
 * assistant's own DM with its owner. Every check runs before anything is
 * written, so a refused destination opens no DM and joins nothing; `dryRun`
 * runs them all and writes nothing.
 *
 * After a send Raft posts ONE receipt in the owner's DM with the assistant, a
 * line per destination, each retractable on its own. A channel joined for the
 * owner is named there even when the forward there then failed; a retry that
 * finds a forward already stored but never receipted (delivery or the receipt
 * failed the first time) posts its receipt then.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index";
import { messages } from "../db/schema";
import { MAX_FORWARD_DESTINATIONS, asServerId, isSubConversationType } from "@botiverse/raft-shared";
import type { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import * as serverService from "./serverService";
import * as userService from "./userService";
import { assistantReadsOwnerDms, dmScopeOf, resolveNameForOwner, OWNER_RESOLVE_AMBIGUOUS_CODE } from "./assistantService";
import {
  ASSISTANT_SEND_AS_OWNER_MAX_LENGTH,
  AssistantSendAsOwnerError,
  assistantSendsAsOwner,
  isBridgedConversation,
  MASS_MENTION_PATTERN,
  delegatedReceiptsQuery,
  postDelegatedForwardReceipt,
} from "./assistantSendAsOwnerService";
import { areDmsReadOnlyByQuota, getChannelBillingReadOnly, isChannelReadOnlyByQuota } from "./planService";
import { isTaskConversationReadOnly } from "./taskChannelSurface";
import { checkDirectMessageOpen, openDirectMessageForUser, type DirectMessageTarget } from "./directMessageOpenService";
import { joinChannelAsUser, planSelfJoin } from "./channelJoinService";
import {
  buildForwardedBundleMetadata,
  FORWARD_TOO_MANY_MESSAGES_ERROR,
  forwardBundleAsUser,
  forwardMessageContent,
  ForwardRequestError,
  forwardRequestRandomId,
  isOverForwardMessageCap,
  MAX_FORWARD_BUNDLE_ITEMS,
  resolveForwardDestinationStorage,
  resolveForwardSourceMessageIds,
  searchForwardTargets,
  type ForwardedBundleMetadata,
} from "./messageForwardService";
import { ForwardPersistenceError } from "./attachmentForwardService";
import { DmPeerNotMemberError } from "./dmSendPolicy";
import { JointChannelAccessChangedError } from "../lib/channelActorPermissions";
import { ChannelConversionInProgressError } from "./channelConversionFenceService";
import { UUID_RE } from "../lib/messageId";
import { getAppUrl } from "../config/appUrl";
import { buildChannelUrl, buildThreadUrl } from "./pushDisplay";
import { recordIntegrationAuditEventBestEffort } from "./integrationAuditService";
import { recordTraceEvent } from "../tracing/semanticTrace";

export type ForwardAsOwnerDestination = string | { to: string; join?: boolean };

export type ForwardAsOwnerWarning = "joint_external_audience";

/** A type alias (not an interface) so it fits the contract's passthrough result type. */
export type ForwardAsOwnerResult = {
  /** The destination as the request named it. */
  to: string;
  /** The conversation; null for a DM a dry run would create, or a destination that did not resolve. */
  channelId: string | null;
  status: "sent" | "failed" | "would_send";
  messageId?: string;
  /** A link to the sent message to share. */
  link?: string;
  code?: string;
  error?: string;
  /** The owner was joined to this public channel for it (a dry run: would be). */
  joined?: boolean;
  /** A DM the owner never had is opened for it (a dry run: would be). */
  createsDm?: boolean;
  warnings?: ForwardAsOwnerWarning[];
};

type Failure = { failed: true; code: string; error: string; channelId?: string | null };
type Ready = {
  failed: false;
  /** Null until a new DM is opened. */
  channelId: string | null;
  dmTarget: DirectMessageTarget | null;
  join: boolean;
  joinName: string | null;
  warnings: ForwardAsOwnerWarning[];
};

const fail = (status: number, code: string, message: string): never => {
  throw new AssistantSendAsOwnerError(status, code, message);
};

const failed = (code: string, error: string, channelId: string | null = null): Failure => ({ failed: true, code, error, channelId });

const REQUEST_CONFLICT_ERROR = "This requestId was already used with different messages or note. To retry, or after fixing failed destinations, send again with the same requestId and the same messages and note (destinations already sent come back as they were, nothing is sent twice); a new forward needs a new requestId.";

const RETRACTED_BY_OWNER_ERROR = "Your owner retracted the message this forward sent here; do not send it again unless your owner asks you to.";

/**
 * The web forward path's refusals in words an assistant can act on: same
 * status and code. A refusal because of one source names it the way the
 * assistant passed it (`messages[2] ("8d04e7aa")`, its own input), never its
 * content or conversation.
 */
function forwardRefusalForAgent(err: ForwardRequestError, sourceIds?: unknown): string {
  const passed = Array.isArray(sourceIds) && err.sourceIndex !== undefined ? sourceIds[err.sourceIndex] : undefined;
  const source = err.sourceIndex !== undefined
    ? `messages[${err.sourceIndex}]${typeof passed === "string" ? ` (${JSON.stringify(passed.trim())})` : ""}`
    : "A message";
  if (err.code === "source_not_found") return `${source} was not found, or you may not read it for your owner. Leave it out.`;
  if (err.code === "cross_source_bundle") return "All messages of one forward must come from the same conversation. Forward each conversation's messages separately.";
  if (err.code === "forwarded_source_not_supported") return `${source} is itself a forwarded message, which can't be forwarded again. Forward the original message instead.`;
  if (err.code === "unsupported_source_message") return `${source} is not an ordinary chat message (a system or card message, for example); only ordinary chat messages can be forwarded. Leave it out.`;
  if (err.code === "unsupported_source") return `${source} is in a thread or task conversation Raft can't forward from. Leave it out.`;
  if (err.code === "history_limited") return `${source} is older than the server plan's message history, so it can't be forwarded. Leave it out and forward the newer messages.`;
  if (err.status === 403) return `Your owner cannot post in this conversation (${err.message}).`;
  return err.sourceIndex !== undefined ? `${source}: ${err.message}` : err.message;
}

/** Request-level errors (the sources), as this route's. */
async function asRequestError<T>(sourceIds: unknown, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ForwardRequestError) throw new AssistantSendAsOwnerError(err.status, err.code, forwardRefusalForAgent(err, sourceIds));
    throw err;
  }
}

/**
 * Whether the message this requestId recorded in this conversation is now
 * retracted (by the owner: only they can retract a delegated message). A
 * retry must not send it there again.
 */
async function forwardRetractedByOwner(ownerUserId: string, requestId: string, channelId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: messages.id }).from(messages).where(and(
    eq(messages.senderType, "user"),
    eq(messages.senderId, ownerUserId),
    eq(messages.randomId, forwardRequestRandomId(requestId, channelId)),
    isNotNull(messages.deletedAt),
  )).limit(1);
  return Boolean(row);
}

/** A destination's write failing, as the web's batch forward reports it per destination. */
function destinationFailure(err: unknown): Failure {
  if (err instanceof AssistantSendAsOwnerError) return failed(err.code, err.message);
  if (err instanceof ForwardRequestError) return failed(err.code, forwardRefusalForAgent(err));
  if (
    err instanceof messageService.UserRandomIdConflictError
    || (err instanceof ForwardPersistenceError && err.code === "idempotency_conflict")
  ) {
    return failed("request_conflict", REQUEST_CONFLICT_ERROR);
  }
  if (err instanceof ForwardPersistenceError) return failed(err.code, err.message);
  if (err instanceof ChannelConversionInProgressError) {
    return failed(err.code, "This conversation is being converted right now. Retry the same request (same requestId) in a moment.");
  }
  if (err instanceof DmPeerNotMemberError || err instanceof JointChannelAccessChangedError) return failed(err.code, err.message);
  if (err instanceof channelService.ChannelArchivedError) return failed("channel_archived", "This conversation is archived.");
  console.error("[forwardAsOwner] destination failed:", err instanceof Error ? err.name : "unknown");
  return failed("forward_failed", "Could not forward to this destination. Retry the same request (same requestId); nothing is sent twice.");
}

function normalizeDestinations(to: unknown): Array<{ to: string; join: boolean }> | null {
  if (!Array.isArray(to) || to.length === 0 || to.length > MAX_FORWARD_DESTINATIONS) return null;
  const out: Array<{ to: string; join: boolean }> = [];
  for (const entry of to) {
    if (typeof entry === "string" && entry.trim()) out.push({ to: entry.trim(), join: false });
    else if (entry && typeof entry === "object" && typeof (entry as { to?: unknown }).to === "string" && (entry as { to: string }).to.trim()) {
      out.push({ to: (entry as { to: string }).to.trim(), join: (entry as { join?: unknown }).join === true });
    } else return null;
  }
  return out;
}

/** A message link the assistant can share: the web's permalink. */
async function messageLink(serverSlug: string | null, channelId: string, messageId: string): Promise<string | undefined> {
  if (!serverSlug) return undefined;
  const channel = await channelService.getChannel(channelId);
  if (!channel) return undefined;
  const base = getAppUrl().replace(/\/+$/, "");
  if (isSubConversationType(channel.type) && channel.parentChannelId && channel.parentMessageId) {
    const parent = await channelService.getChannel(channel.parentChannelId);
    const parentType = parent?.type === "dm" ? "dm" : parent?.type === "joint" ? "joint" : "channel";
    return `${base}${buildThreadUrl(serverSlug, channel.parentChannelId, parentType, channel.parentMessageId, messageId)}`;
  }
  return `${base}${buildChannelUrl(serverSlug, channel.type === "dm" ? "dm" : "channel", channelId, messageId)}`;
}

export async function forwardAsOwner(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  serverId: string;
  agentId: string;
  ownerUserId: string;
  messages: unknown;
  to: unknown;
  note?: string;
  requestId: string;
  dryRun?: boolean;
}): Promise<{ results: ForwardAsOwnerResult[]; preview?: string }> {
  const { serverId, ownerUserId, agentId } = input;

  // 1. The request: switch, note, shape. Nothing below runs if one fails.
  if (!await assistantSendsAsOwner(agentId)) {
    fail(403, "assistant_send_as_owner_off", "Your owner has not turned on sending as them. Summarize for them in your DM instead.");
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (input.note !== undefined && typeof input.note !== "string") fail(400, "invalid_content", "note is text.");
  if (note.length > ASSISTANT_SEND_AS_OWNER_MAX_LENGTH) {
    fail(400, "invalid_content", `The note is longer than ${ASSISTANT_SEND_AS_OWNER_MAX_LENGTH} characters.`);
  }
  if (MASS_MENTION_PATTERN.test(note)) {
    fail(400, "mass_mention_not_allowed", "A message sent as your owner cannot use @everyone or @here.");
  }
  if (typeof input.requestId !== "string" || !UUID_RE.test(input.requestId)) {
    fail(400, "invalid_request", "requestId is a UUID you choose per forward; reuse it only to retry the same forward.");
  }
  const destinations = normalizeDestinations(input.to);
  if (!destinations) {
    return fail(400, "invalid_request", `to takes 1 to ${MAX_FORWARD_DESTINATIONS} destinations: "#channel", "@name" (~human / ~agent when they share a name), a conversation id, or { to, join: true } for a public channel your owner has not joined.`);
  }
  if (isOverForwardMessageCap(input.messages)) {
    fail(400, "too_many_messages", `${FORWARD_TOO_MANY_MESSAGES_ERROR}. Split it into several forwards.`);
  }

  // 2. The sources, as the owner minus what the assistant may not read for
  // them (the owner-messages route's DM rule): the web's rules, before any
  // destination and before any preview, so a refused source shows nothing.
  const sourceMessageIds = await asRequestError(input.messages, () => resolveForwardSourceMessageIds(serverId, input.messages));
  if (sourceMessageIds === "invalid") {
    return fail(400, "invalid_request", `messages takes 1 to ${MAX_FORWARD_BUNDLE_ITEMS} distinct message ids (full, or the 8-character msg= id), all from one conversation.`);
  }
  const bundle: ForwardedBundleMetadata = await asRequestError(input.messages, () => buildForwardedBundleMetadata({
    serverId: asServerId(serverId),
    forwarderUserId: ownerUserId,
    delegatedByAgentId: agentId,
    sourceMessageIds,
  }));
  const content = forwardMessageContent(note, bundle.forwardedItems.length);

  // 3. Each destination, as the owner, writing nothing.
  const ownDmId = await channelService.findHumanAgentDmChannelId(serverId, ownerUserId, agentId);
  const readsDms = await assistantReadsOwnerDms(agentId);
  const dmsReadOnly = await areDmsReadOnlyByQuota(serverId);

  const checkConversation = async (
    channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
    join: boolean,
  ): Promise<Failure | Ready> => {
    // Access first: a conversation the owner is not in reads the same whatever it is (no DM switch or own-DM answer for it).
    if (!await channelService.canUserAccessChannel(channel.id, ownerUserId, asServerId(serverId))) {
      return failed("channel_not_found", "No such conversation, or your owner cannot see it.");
    }
    const scope = await dmScopeOf(channel);
    if (scope.dm && scope.rootChannelId !== null && scope.rootChannelId === ownDmId) {
      return failed("assistant_own_dm", "That is your own DM with your owner: speak there as yourself.", channel.id);
    }
    if (scope.dm && scope.rootChannelId === null) return failed("channel_not_found", "No such conversation, or your owner cannot see it.");
    if (scope.dm && !readsDms) {
      return failed("assistant_reads_dms_off", "Your owner has not let you read their DMs, so you cannot send DMs for them either.", channel.id);
    }
    // The write's own gates, so a dry run reports what the send would hit:
    // an archived conversation (or one under an archived parent), a thread
    // whose parent message is gone, a task conversation without its task.
    try {
      await channelService.assertChannelNotArchived(channel.id);
      await resolveForwardDestinationStorage(serverId, channel);
    } catch (err) {
      const failure = destinationFailure(err);
      return { ...failure, channelId: channel.id };
    }
    let joinName: string | null = null;
    if (!await channelService.canUserPostToChannel(channel.id, ownerUserId)) {
      if (channel.type !== "channel") return failed("owner_cannot_post", "Your owner cannot post in this conversation.", channel.id);
      const plan = await planSelfJoin(serverId, ownerUserId, channel);
      if (!plan.ok) return failed(plan.code, `Your owner cannot join #${channel.name}: ${plan.error}.`, channel.id);
      if (plan.action === "member") return failed("owner_cannot_post", "Your owner cannot post in this conversation.", channel.id);
      if (!join) {
        return failed(
          "join_required",
          `Your owner has not joined #${channel.name}. Pass { to: "#${channel.name}", join: true } to join it for them (they are told), or leave it out, then send again with the same requestId.`,
          channel.id,
        );
      }
      joinName = channel.name;
    }
    // The plan and task gates of the web's forward admission (humanPostAdmission), checked before anything is written.
    if (await getChannelBillingReadOnly(channel.id, serverId) || await isChannelReadOnlyByQuota(channel.id, serverId)) {
      return failed("owner_cannot_post", "This conversation is read-only on the server's plan.", channel.id);
    }
    if (await isTaskConversationReadOnly(serverId, channel)) {
      return failed("owner_cannot_post", "This task is read-only from your owner's server.", channel.id);
    }
    if (await isBridgedConversation(channel)) {
      return failed("bridged_conversation", "This conversation is bridged to an external chat; nothing can be sent there as your owner. Summarize for them in your DM instead.", channel.id);
    }
    const root = channel.parentChannelId ? await channelService.getChannel(channel.parentChannelId) : null;
    const warnings: ForwardAsOwnerWarning[] = channel.type === "joint" || root?.type === "joint" ? ["joint_external_audience"] : [];
    return { failed: false, channelId: channel.id, dmTarget: null, join: joinName !== null, joinName, warnings };
  };

  const notFound = () => failed("channel_not_found", "No such conversation, or your owner cannot see it.");
  const planDestination = async (to: string, join: boolean): Promise<Failure | Ready> => {
    if (UUID_RE.test(to)) {
      const channel = await channelService.getChannel(to);
      return channel && channel.serverId === serverId ? checkConversation(channel, join) : notFound();
    }
    if (!to.startsWith("#") && !to.startsWith("@")) {
      return failed("invalid_target", "Name a destination as \"#channel\", \"@name\" (~human / ~agent when they share a name) or a conversation id.");
    }
    const resolved = await resolveNameForOwner(serverId, ownerUserId, to);
    if (!resolved.ok) {
      return resolved.code === OWNER_RESOLVE_AMBIGUOUS_CODE
        ? failed(resolved.code, "A person and an agent share that name. Add ~human or ~agent.")
        : failed(resolved.code, to.startsWith("#")
          ? "Your owner cannot see a channel by that name here."
          : "Your owner cannot see anyone by that name here.");
    }
    if (resolved.type === "channel") {
      const channel = await channelService.getChannel(resolved.id);
      return channel ? checkConversation(channel, join) : notFound();
    }
    if (resolved.type === "agent" && resolved.id === agentId) {
      return failed("assistant_own_dm", "That is your own DM with your owner: speak there as yourself.", ownDmId);
    }
    if (!readsDms) return failed("assistant_reads_dms_off", "Your owner has not let you read their DMs, so you cannot send DMs for them either.");
    const target: DirectMessageTarget = resolved.type === "agent" ? { agentId: resolved.id } : { userId: resolved.id };
    const checked = await checkDirectMessageOpen(serverId, ownerUserId, target, { findExisting: true });
    if (!checked.ok) return failed(checked.code, `Your owner cannot open this DM: ${checked.error}.`);
    if (checked.existingChannelId) {
      const channel = await channelService.getChannel(checked.existingChannelId);
      return channel ? checkConversation(channel, join) : notFound();
    }
    if (dmsReadOnly) return failed("owner_cannot_post", "DMs are read-only on the server's plan.");
    return { failed: false, channelId: null, dmTarget: target, join: false, joinName: null, warnings: [] };
  };

  const plans: Array<Failure | Ready> = [];
  const seen = new Set<string>();
  for (const destination of destinations) {
    const plan = await planDestination(destination.to, destination.join);
    // The web forwards once per conversation; a second name for the same one is reported, not sent twice.
    const key = !plan.failed ? (plan.channelId ?? `dm:${plan.dmTarget?.agentId ?? plan.dmTarget?.userId}`) : null;
    if (key && seen.has(key)) {
      plans.push(failed("duplicate_destination", "Same conversation as an earlier destination of this request.", plan.failed ? null : plan.channelId));
      continue;
    }
    if (key) seen.add(key);
    // A retry: the owner retracted what this requestId sent here. Reported, never re-sent.
    if (!plan.failed && plan.channelId && await forwardRetractedByOwner(ownerUserId, input.requestId, plan.channelId)) {
      plans.push(failed("retracted_by_owner", RETRACTED_BY_OWNER_ERROR, plan.channelId));
      continue;
    }
    plans.push(plan);
  }

  const resultOf = (to: string, plan: Failure | Ready, extra: Partial<ForwardAsOwnerResult> = {}): ForwardAsOwnerResult => plan.failed
    ? { to, channelId: plan.channelId ?? null, status: "failed", code: plan.code, error: plan.error }
    : {
        to,
        channelId: plan.channelId,
        status: "would_send",
        ...(plan.dmTarget ? { createsDm: true } : {}),
        ...(plan.join ? { joined: true } : {}),
        ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
        ...extra,
      };

  if (input.dryRun) {
    return {
      results: destinations.map((destination, index) => resultOf(destination.to, plans[index]!)),
      // What a recipient's agent reads, through the same renderer.
      preview: messageService.appendAgentFacingForwardedSnapshot(content, bundle),
    };
  }

  // 4. Send, one destination after another, each as the web's batch forward does.
  const owner = await userService.getUser(ownerUserId);
  const senderName = owner?.displayName || owner?.name || "User";
  const server = await serverService.getServer(serverId);
  const serverSlug = server?.slug ?? null;
  const results: ForwardAsOwnerResult[] = [];
  const sentForReceipt: Array<{ id: string; channelId: string; createdAt: Date | string }> = [];
  const joined: Array<{ channelId: string; name: string }> = [];
  // Joined for the owner, but the forward there then failed: still told, so they can leave.
  const joinedNotForwarded: Array<{ channelId: string; name: string }> = [];
  // Newly stored by this request (the audit); a replay is only receipted when it never was.
  const newlySent = new Set<string>();
  for (const [index, destination] of destinations.entries()) {
    const plan = plans[index]!;
    if (plan.failed) {
      results.push(resultOf(destination.to, plan));
      continue;
    }
    let channelId = plan.channelId;
    let createsDm = false;
    let didJoin = false;
    try {
      if (!channelId && plan.dmTarget) {
        const opened = await openDirectMessageForUser(serverId, ownerUserId, plan.dmTarget);
        if (!opened.ok || !opened.channel) {
          results.push(resultOf(destination.to, failed(opened.ok ? "dm_target_not_found" : opened.code, "Your owner cannot open this DM.")));
          continue;
        }
        channelId = opened.channel.id;
        createsDm = true;
      }
      if (plan.join && channelId) {
        const joinResult = await joinChannelAsUser(input.io, serverId, ownerUserId, await channelService.getChannel(channelId));
        if (!joinResult.ok) {
          results.push(resultOf(destination.to, failed(joinResult.code, `Your owner cannot join #${plan.joinName}: ${joinResult.error}.`, channelId)));
          continue;
        }
        didJoin = joinResult.joined;
      }
      const forwarded = await forwardBundleAsUser({
        io: input.io,
        orchestrator: input.orchestrator,
        serverId,
        userId: ownerUserId,
        senderName,
        targetChannelId: channelId!,
        content,
        note,
        sourceMessageIds,
        bundleMetadata: bundle,
        requestId: input.requestId,
        delegatedByAgentId: agentId,
      });
      if (didJoin) joined.push({ channelId: channelId!, name: plan.joinName ?? "channel" });
      if (!forwarded.replayed) newlySent.add(forwarded.messageId);
      // A replay whose first attempt stored the message but never wrote its
      // receipt (delivery or the receipt failed): the owner gets it now.
      if (!forwarded.replayed || (ownDmId && (await delegatedReceiptsQuery(getDb(), ownDmId, forwarded.messageId).limit(1)).length === 0)) {
        sentForReceipt.push({ id: forwarded.messageId, channelId: channelId!, createdAt: forwarded.createdAt });
      }
      const link = await messageLink(serverSlug, channelId!, forwarded.messageId);
      results.push({
        to: destination.to,
        channelId,
        status: "sent",
        messageId: forwarded.messageId,
        ...(link ? { link } : {}),
        ...(didJoin ? { joined: true } : {}),
        ...(createsDm ? { createsDm: true } : {}),
        ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
      });
    } catch (err) {
      if (didJoin && channelId) joinedNotForwarded.push({ channelId, name: plan.joinName ?? "channel" });
      const failure = destinationFailure(err);
      // Retracted between the check above and this write: the stored row no longer matches the request.
      if (failure.code === "request_conflict" && channelId && await forwardRetractedByOwner(ownerUserId, input.requestId, channelId)) {
        results.push({ to: destination.to, channelId, status: "failed", code: "retracted_by_owner", error: RETRACTED_BY_OWNER_ERROR });
        continue;
      }
      results.push({ to: destination.to, channelId, status: "failed", code: failure.code, error: failure.error, ...(didJoin ? { joined: true } : {}) });
    }
  }

  if (newlySent.size > 0 || joinedNotForwarded.length > 0) {
    recordTraceEvent("server.assistant.forward_as_owner", {
      agent_id: agentId,
      subject_user_id: ownerUserId,
      forwarded_count: bundle.forwardedItems.length,
      destination_count: destinations.length,
      sent_count: newlySent.size,
      joined_count: joined.length + joinedNotForwarded.length,
    });
  }
  for (const message of sentForReceipt) {
    if (!newlySent.has(message.id)) continue;
    await recordIntegrationAuditEventBestEffort({
      serverId,
      eventType: "assistant.send_as_owner",
      outcome: "success",
      source: "api",
      actor: { type: "agent", id: agentId },
      subject: { type: "human", id: ownerUserId },
      target: { type: "message", id: message.id },
      metadata: { messageId: message.id, channelId: message.channelId, forwardedCount: bundle.forwardedItems.length },
    });
  }
  if (sentForReceipt.length > 0 || joinedNotForwarded.length > 0) {
    await postDelegatedForwardReceipt({
      io: input.io,
      orchestrator: input.orchestrator,
      serverId,
      agentId,
      ownerUserId,
      ownDmId,
      content,
      itemCount: bundle.forwardedItems.length,
      sent: sentForReceipt,
      joined,
      joinedNotForwarded,
    });
  }
  return { results };
}

const ASSISTANT_READS_DMS_OFF_SEARCH_REASON = "Your owner has not let you read their DMs, so people, agents and DMs (and threads in DMs) are left out of these results.";

/**
 * The web composer's target search, as the owner, for the assistant: each
 * target with the `to` to pass back to forwardAsOwner. Never the assistant's
 * own DM with its owner; no people, agents or DMs while the owner keeps DMs
 * from it, and then the answer always says so (`omitted`), whether or not
 * this search matched any: simpler to rely on than "only when something was
 * dropped".
 */
export async function searchForwardTargetsForOwner(input: {
  serverId: string;
  agentId: string;
  ownerUserId: string;
  q: string;
  limit?: number;
}): Promise<{
  targets: Array<{ label: string; to: string; requiredAction?: "join_channel" | "create_dm" }>;
  omitted?: "assistant_reads_dms_off";
  omittedReason?: string;
}> {
  const [{ targets, conversations }, readsDms, ownDmId] = await Promise.all([
    searchForwardTargets({ serverId: asServerId(input.serverId), userId: input.ownerUserId, q: input.q, limit: input.limit }),
    assistantReadsOwnerDms(input.agentId),
    channelService.findHumanAgentDmChannelId(input.serverId, input.ownerUserId, input.agentId),
  ]);
  // A thread or task conversation: passed back by its conversation id.
  const conversationTargets = conversations.flatMap((target) => {
    if (target.parentChannelType === "dm" && (!readsDms || target.parentChannelId === ownDmId)) return [];
    return [{ label: target.subtitle ? `${target.title} (${target.subtitle})` : target.title, to: target.channelId }];
  });
  const otherTargets = targets.flatMap((target) => {
    if (target.type === "channel") {
      return [{ label: target.title, to: `#${target.handle}`, ...(target.requiredAction ? { requiredAction: target.requiredAction } : {}) }];
    }
    if (!readsDms) return [];
    if (target.channelId && target.channelId === ownDmId) return [];
    if (target.peerKind === "agent" && target.id === input.agentId) return [];
    const suffix = target.peerKind === "agent" ? "~agent" : "~human";
    return [{
      label: target.subtitle ? `${target.title} (${target.subtitle})` : target.title,
      to: `@${target.handle}${suffix}`,
      ...(target.requiredAction ? { requiredAction: target.requiredAction } : {}),
    }];
  });
  const targetList = [...otherTargets, ...conversationTargets];
  return readsDms
    ? { targets: targetList }
    : { targets: targetList, omitted: "assistant_reads_dms_off", omittedReason: ASSISTANT_READS_DMS_OFF_SEARCH_REASON };
}
