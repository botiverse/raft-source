// Canonical agent-facing message text: the `[target=… msg=… time=… type=…]`
// header line and the target string an agent replies to.
//
// This is an AX contract, not an implementation detail: the daemon-managed
// runner, the CLI (`raft message check` / `read`), and the SDK all hand the
// model this exact shape, so an agent sees one world regardless of transport.
// The CLI wraps these functions in `axSurface()` for the AX surfaces manifest;
// the SDK exposes them as `message.text`. Behaviour is pinned by
// `packages/cli/src/commands/message/_format.test.ts`.

import { formatAgentReplyAffordanceSuffix } from "./agentInbox";
import { formatHint, RAFT_HINTS, type RaftHintStyle } from "./agentOps/hint";
import { formatRaftChannelTaskRef, formatRaftDmTaskRef, type RaftTargetString } from "./raftRefs";
import { formatAgentTaskRef } from "./agentText/taskRef";
import { renderThirdPartyEventPayload } from "./thirdPartyInertRenderer";
import { formatUtcTimestamp } from "./utcTimestamp";
import type { AgentMessageCardMarker } from "./messageCard";
import type { AgentApiMessageReaction } from "./agentApiMessageContract";

export interface AgentMessageTaskCurrentProjectionLike {
  title?: string;
  description?: string | null;
  revision?: number;
  superseded?: boolean;
  amendedAt?: string | null;
  amended_at?: string | null;
  amendedByType?: string | null;
  amended_by_type?: string | null;
  amendedByName?: string | null;
  amended_by_name?: string | null;
  source?: string;
}

/**
 * Prefix every continuation line of a quoted body with `  │ `, so body text
 * never reaches column 0. Structural lines (`[target=…]` / `[1/5 seq=…]` headers,
 * read cursors, footers) always start at column 0, so a line-anchored reader
 * (`grep '^\['`) cannot be handed a forged one by message content. The `│` is
 * non-whitespace on purpose: a reader that trims each line still sees it. It is
 * the same quote marker as the freshness-hold digest previews. Remove the first
 * four characters after each line separator to recover the original body.
 */
export const AGENT_BODY_CONTINUATION_PREFIX = "  │ ";
// Every separator a universal-newline reader (Python `str.splitlines()`, etc.)
// breaks on, not just `\n`: a body could otherwise start an unprefixed line
// with a lone `\r`, NEL or U+2028. `\r\n` is matched first as one separator.
// Exported without the `g` flag so callers' `.test()` / `.exec()` carry no
// `lastIndex` state; global uses build their own from `.source`.
export const AGENT_BODY_LINE_SEPARATOR = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const AGENT_BODY_LINE_SEPARATOR_GLOBAL = new RegExp(AGENT_BODY_LINE_SEPARATOR.source, "g");
export function indentAgentBodyContinuationLines(text: string): string {
  // The separator itself is kept, so removing the prefix restores the exact body.
  return text.replace(AGENT_BODY_LINE_SEPARATOR_GLOBAL, (separator) => `${separator}${AGENT_BODY_CONTINUATION_PREFIX}`);
}

// `\s` misses some of the separators above (\x1c–\x1e, \x85), so a fold on
// `\s+` alone leaves a break a universal-newline reader still splits on.
const AGENT_ONE_LINE_FOLD = new RegExp(`(?:${AGENT_BODY_LINE_SEPARATOR.source}|\\s)+`, "g");
/**
 * Input normalization for free text agents will read: every universal line
 * separator becomes `replacement`: `"\n"` for a field that keeps its lines (a
 * description, so the one break renderers quote is the only kind stored),
 * `" "` for one that doesn't (a display name, a filename, a title).
 */
export function replaceAgentLineBreaks(text: string, replacement: "\n" | " "): string {
  return text.replace(AGENT_BODY_LINE_SEPARATOR_GLOBAL, replacement);
}

/** Free text kept to one line (a title in a list, a preview): every run of whitespace and line separators becomes one space. */
export function foldAgentOneLineText(text: string): string {
  return text.replace(AGENT_ONE_LINE_FOLD, " ").trim();
}

/**
 * Free text quoted on one line, its line breaks kept visible: JSON's escapes
 * (`\n`, `\"`, …), plus the line separators JSON leaves bare (NEL, U+2028,
 * U+2029). A person's answer to a question card; a page's own text in a
 * publish check (folded first: foldAgentOneLineText).
 */
export function quoteAgentOneLineText(text: string): string {
  return JSON.stringify(text).replace(/[\u0085\u2028\u2029]/g, (separator) => `\\u${separator.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Task v2: one task whose `source_message_id` is the rendered chat message.
 * Present (as `source_tasks`) only on servers with task v2 conversations; the
 * pre-v2 single `task_*` fields keep their exact shape elsewhere.
 */
export interface AgentMessageSourceTaskLike {
  number: number;
  status: string;
  assignee_type?: string | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
}

/**
 * `[tasks #proj:#2 in_progress @cody, #proj:#4 todo]` — every task hanging
 * under a chat message (task v2). `conversationTarget` is where the message
 * lives (`#proj`, `dm:@peer`); each task is named by its ref there. Without
 * one (or for a thread target) the bare `#2` is printed.
 */
export function formatAgentSourceTasksSuffix(
  tasks: readonly AgentMessageSourceTaskLike[] | null | undefined,
  conversationTarget?: string | null,
): string {
  if (!tasks?.length) return "";
  const entries = tasks.map((task) => {
    const assignee = task.assignee_id
      ? task.assignee_name ? ` @${task.assignee_name}` : " <unresolved>"
      : "";
    const label = (conversationTarget ? formatAgentTaskRef(conversationTarget, task.number) : null) ?? `#${task.number}`;
    return `${label} ${task.status}${assignee}`;
  });
  return ` [tasks ${entries.join(", ")}]`;
}

/** The wire-shaped message fields the canonical text reads. Extra keys are ignored. */
export interface AgentMessageLike {
  /**
   * Set by the client, never on the wire: the message's target when its own
   * channel fields don't carry it. An `inbox read` page of a conversation
   * returns history rows with only `channelId`; the page's canonical `target`
   * is the address (RFC 081).
   */
  display_target?: string;
  channel_type?: string;
  channel_name?: string;
  parent_channel_type?: string;
  parent_channel_name?: string;
  message_id?: string;
  timestamp?: string;
  sender_type?: string;
  sender_name?: string;
  sender_description?: string | null;
  /** IANA zone of a human web sender; transport only, not rendered yet. */
  sender_timezone?: string | null;
  /** RFC 077: the personal assistant that sent this as its owner (the sender). */
  delegated_by?: { name: string } | null;
  /** RFC 082: a card message's revision, when it last changed, and the card's text (markdown); the body is its fallback text. */
  message_card?: AgentMessageCardMarker | null;
  content?: string;
  attachments?: Array<{ id: string; filename: string }>;
  task_status?: string | null;
  task_number?: number | null;
  task_assignee_id?: string | null;
  task_assignee_type?: string | null;
  task_assignee_name?: string | null;
  task_current_projection?: AgentMessageTaskCurrentProjectionLike | null;
  /** Task v2: every task hanging under this chat message (servers with task v2 conversations only). */
  source_tasks?: AgentMessageSourceTaskLike[] | null;
  /**
   * Task v2: set when the message is in a task's own conversation (delivered
   * as `channel_type: "thread"` under the task's channel): the task number.
   * The message's target is then the task ref (`#channel:#7`).
   */
  task_conversation_number?: number | null;
  /** The message's reactions, one entry per emoji (AgentApiMessageEnvelope.reactions); printed under it (formatAgentMessageReactionsLine). */
  reactions?: AgentApiMessageReaction[] | null;
  non_member_mention?: boolean;
  third_party_event?: {
    id: string;
    kind: string;
    client_id: string;
    client_name: string;
    external_event_id?: string | null;
    /** Absent on an `inbox read` entry, which carries no raw data (RFC 081). */
    payload_hash?: string;
    payload?: Record<string, unknown>;
    /** Raft's own system app wrote it (set by the Server from the row): payload as written. */
    system_app?: string;
    /** RFC 081, pushed to the daemon: the inbox item it is listed under (`app:<client_id>[/<object.ref>]`), when it is one. */
    inbox_item_target?: string;
    /** #wg-ax:#24, with inbox_item_target: that item's unread events when it was pushed, those that joined it without a wake included. */
    inbox_item_unread?: number;
    expires_at: string;
    source?: {
      client_id?: string;
      client_name?: string;
      oauth_client_id?: string;
      access_token_id_hash?: string | null;
      resource?: string;
    };
  };
  [key: string]: unknown;
}

/**
 * Task v2: the task ref (`#channel:#7`, `dm:@peer:#7`) of a message in a
 * task's own conversation; null for every other message.
 */
export type AgentMessageTaskConversationFields = Pick<AgentMessageLike, "channel_type" | "parent_channel_name" | "parent_channel_type" | "task_conversation_number">;

export function formatAgentMessageTaskRef(m: AgentMessageTaskConversationFields): RaftTargetString | null {
  const taskNumber = m.task_conversation_number;
  if (m.channel_type !== "thread" || !m.parent_channel_name || typeof taskNumber !== "number" || !Number.isInteger(taskNumber) || taskNumber <= 0) {
    return null;
  }
  return m.parent_channel_type === "dm"
    ? formatRaftDmTaskRef(m.parent_channel_name, taskNumber)
    : formatRaftChannelTaskRef(m.parent_channel_name, taskNumber);
}

/**
 * ` [task conversation — reply: raft task reply "#proj:#7"]` after a message
 * in a task's own conversation: a task is replied to with `raft task reply`,
 * never `raft message send`.
 */
export function formatAgentTaskReplySuffix(m: AgentMessageTaskConversationFields, style: RaftHintStyle = "cli"): string {
  const ref = formatAgentMessageTaskRef(m);
  return ref ? ` [task conversation — reply: ${formatHint(RAFT_HINTS.taskReply(ref), style)}]` : "";
}

/**
 * The target an agent passes back to reply where a message came from:
 * `#channel`, `#channel:shortid`, `dm:@peer`, `dm:@peer:shortid`, the task
 * ref `#channel:#7` / `dm:@peer:#7` for a task's own conversation (task v2),
 * or `agent-event:shortid` for third-party app events.
 */
export function formatAgentMessageTarget(m: AgentMessageLike): RaftTargetString {
  if (m.third_party_event) {
    return `agent-event:${thirdPartyEventShortId(m.third_party_event)}` as RaftTargetString;
  }
  if (m.display_target) return m.display_target as RaftTargetString;
  const taskRef = formatAgentMessageTaskRef(m);
  if (taskRef) return taskRef;
  if (m.channel_type === "thread" && m.parent_channel_name) {
    const shortId = m.channel_name?.startsWith("thread-") ? m.channel_name.slice(7) : m.channel_name;
    if (m.parent_channel_type === "dm") {
      return `dm:@${m.parent_channel_name}:${shortId}` as RaftTargetString;
    }
    return `#${m.parent_channel_name}:${shortId}` as RaftTargetString;
  }
  if (m.channel_type === "dm") {
    return `dm:@${m.channel_name}` as RaftTargetString;
  }
  return `#${m.channel_name}` as RaftTargetString;
}

/**
 * `@name`, then the sender's time zone when the message carries one (a human
 * web sender's browser zone at send time), then the profile description:
 * `@cindyz (Asia/Shanghai) — Founder`. Message timestamps stay UTC; the zone
 * only tells an agent how the sender meant "tomorrow" or "tonight".
 *
 * It lands on the header line, and a description is free text anyone sets on
 * their own profile: its line breaks are prefixed like a body's, so none can
 * start a forged `[target=…]` header.
 */
export function formatSenderHandleText(name: string, description?: string | null, timezone?: string | null): string {
  const zone = timezone ? ` (${timezone})` : "";
  return indentAgentBodyContinuationLines(description ? `@${name}${zone} — ${description}` : `@${name}${zone}`);
}

export function formatAgentSenderHandle(m: AgentMessageLike): string {
  return formatSenderHandleText(m.sender_name ?? "unknown", m.sender_description ?? null, m.sender_timezone ?? null);
}

/**
 * RFC 082 §4.3 (Sage): a card message is marked in the header, Raft's
 * key=value line, never in the body the sender wrote: ` card=r1` on the
 * first version, ` card=r3 updated=2026-11-03 12:03:00Z` (the same UTC form as
 * `time=`) once it was replaced. Empty for every other message, so their
 * header keeps its bytes. Only Raft's own values reach the line: a revision
 * that is not a positive integer, or a time that does not parse, is left out.
 */
export function formatAgentMessageCardHeaderFields(card: AgentMessageCardMarker | null | undefined): string {
  if (!card || !Number.isSafeInteger(card.revision) || card.revision < 1) return "";
  const updated = card.revision > 1 && typeof card.updated_at === "string" && !Number.isNaN(Date.parse(card.updated_at))
    ? ` updated=${formatUtcTimestamp(card.updated_at)}`
    : "";
  return ` card=r${card.revision}${updated}`;
}

/**
 * RFC 082 §4.3: what the card itself says, under the body: Raft's own
 * `card:` line, then the markdown Raft generated from the card
 * (`message_card.text`), every line of it prefixed like a body's (the card is
 * its sender's text, so none of it starts a line). Left out when the body
 * already is that text (a fallback Raft derived from the card, not cut), and
 * for every other message.
 */
export function formatAgentMessageCardBlock(card: AgentMessageCardMarker | null | undefined, body: string | null | undefined): string {
  const text = typeof card?.text === "string" ? card.text : "";
  if (!text.trim() || text === body) return "";
  return `\ncard:\n${AGENT_BODY_CONTINUATION_PREFIX}${indentAgentBodyContinuationLines(text)}`;
}

/** At most this many emoji are named on a message's reactions line; the rest are counted (`· +2 more`). */
export const AGENT_MESSAGE_REACTION_GROUPS_SHOWN = 3;
/** At most this many reactors are named per emoji on that line; the rest are counted (`+1`). */
export const AGENT_MESSAGE_REACTION_NAMES_SHOWN = 2;

/**
 * The line Raft prints under a message that has reactions, after everything
 * else the message prints (body, suffixes, card, task projection):
 *
 *   `  · reactions: ✅ tygg · 👍 3 (alice, Remy, +1) · +2 more`
 *
 * Its prefix is two spaces and `·`, never column 0, so a line-anchored reader
 * (`grep '^\['`) never takes it for a header; and never `  │ `, the body's
 * continuation prefix, so it can't be read as (or forged by) the message's
 * own text: every line a body or card adds starts with `  │ `, so no message
 * content can start a line with `  · ` (the same reason the inbox's `  ack:`
 * lines are safe). Every emoji and name is folded to one line.
 *
 * At most AGENT_MESSAGE_REACTION_GROUPS_SHOWN emoji, in the envelope's order
 * (first use). One reactor is named alone (`✅ tygg`); otherwise the count,
 * then up to AGENT_MESSAGE_REACTION_NAMES_SHOWN names and how many more
 * (`👍 3 (alice, Remy, +1)`, `👍 7` when the Server named nobody). Names are
 * handles without `@`, so copying the line pings nobody. Empty for a message
 * without reactions (an older Server sends none).
 */
export function formatAgentMessageReactionsLine(reactions: readonly AgentApiMessageReaction[] | null | undefined): string {
  if (!Array.isArray(reactions)) return "";
  const groups = reactions.flatMap((reaction) => {
    const group = formatAgentMessageReactionGroup(reaction);
    return group ? [group] : [];
  });
  if (groups.length === 0) return "";
  const shown = groups.slice(0, AGENT_MESSAGE_REACTION_GROUPS_SHOWN);
  const more = groups.length - shown.length;
  return `\n  · reactions: ${[...shown, ...(more > 0 ? [`+${more} more`] : [])].join(" · ")}`;
}

/** A reactor's name as Raft prints it: one line, no leading `@`. */
export function formatAgentReactorName(name: unknown): string {
  return typeof name === "string" ? foldAgentOneLineText(name).replace(/^@+/, "") : "";
}

function formatAgentMessageReactionGroup(reaction: AgentApiMessageReaction | null | undefined): string | null {
  if (!reaction || typeof reaction !== "object") return null;
  const emoji = typeof reaction.emoji === "string" ? foldAgentOneLineText(reaction.emoji) : "";
  const names = (Array.isArray(reaction.reactors) ? reaction.reactors : [])
    .map((reactor) => formatAgentReactorName(reactor?.name))
    .filter((name) => name.length > 0);
  const counted = typeof reaction.count === "number" && Number.isFinite(reaction.count) ? Math.floor(reaction.count) : 0;
  // `count` is the total; never print fewer than the names the Server sent.
  const count = Math.max(counted, names.length);
  if (!emoji || count < 1) return null;
  if (count === 1 && names.length > 0) return `${emoji} ${names[0]}`;
  const shown = names.slice(0, AGENT_MESSAGE_REACTION_NAMES_SHOWN);
  if (shown.length === 0) return `${emoji} ${count}`;
  const rest = count - shown.length;
  return `${emoji} ${count} (${[...shown, ...(rest > 0 ? [`+${rest}`] : [])].join(", ")})`;
}

export function formatAgentAttachmentSuffix(attachments: Array<{ id: string; filename: string }> | undefined, style: RaftHintStyle = "cli"): string {
  if (!attachments?.length) return "";
  // The tool form names the one attachment's id; with several, the id is the caller's pick.
  const download = formatHint(RAFT_HINTS.attachmentView(style === "tool" && attachments.length === 1 ? attachments[0]!.id : undefined), style);
  // A filename is the uploader's free text on the header line: prefixed like a body.
  const list = attachments.map((a) => `${indentAgentBodyContinuationLines(a.filename)} (id:${a.id})`).join(", ");
  return ` [${attachments.length} attachment${attachments.length > 1 ? "s" : ""}: ${list} — use ${download} to download]`;
}

export function formatAgentTaskAssigneeSuffix(assigneeId?: string | null, assigneeName?: string | null): string {
  if (!assigneeId) return "";
  return assigneeName ? ` assignee=@${assigneeName}` : " assignee=<unresolved>";
}

/**
 * Superseded-task projection suffix. `neutralize`, when given, rewrites quoted
 * title/description/actor text so pasted refs cannot route attention (the CLI
 * passes its search-preview neutraliser); the actor handle is then `user:<name>`.
 */
export function formatAgentTaskCurrentProjection(
  projection: AgentMessageTaskCurrentProjectionLike | null | undefined,
  taskNumber?: number | null,
  neutralize?: (text: string) => string,
): string {
  const neutralizeRefs = neutralize !== undefined;
  const renderPreviewText = neutralize ?? ((text: string) => text);
  if (!projection?.superseded) return "";
  const revision = Number.isInteger(projection.revision) ? projection.revision : "?";
  const source = projection.source ?? "tasks_current_projection";
  const actorName = projection.amendedByName ?? projection.amended_by_name ?? null;
  const actorType = projection.amendedByType ?? projection.amended_by_type ?? null;
  const actor = actorName
    ? neutralizeRefs ? `user:${actorName}` : `@${actorName}`
    : actorType === "system" ? "system" : "<unresolved>";
  const amendedAt = projection.amendedAt ?? projection.amended_at ?? null;
  const lines = [
    `[${taskNumber ? `task #${taskNumber} ` : "task "}superseded: current projection rev=${revision} source=${source} actor=${actor} time=${amendedAt ? formatUtcTimestamp(amendedAt) : "-"}]`,
    `Current title: ${indentAgentBodyContinuationLines(neutralizeRefs ? renderPreviewText(projection.title ?? "") : projection.title ?? "")}`,
  ];
  if (projection.description != null) {
    lines.push(`Current description: ${indentAgentBodyContinuationLines(neutralizeRefs ? renderPreviewText(projection.description) : projection.description)}`);
  }
  return `\n${lines.join("\n")}`;
}

/**
 * The payload printed with an app event: only one with fields. What an
 * external app's event carries is the Server's call (its payload is dropped
 * at ingress, artin 2026-11-08); an empty `{}` prints nothing.
 */
export function thirdPartyEventPayloadForAgent(event: { payload?: Record<string, unknown> | null }): Record<string, unknown> | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length === 0) return null;
  return payload;
}

/**
 * A third-party event's id as an agent sees it, in `msg=` and in its
 * `agent-event:` target: the first 8 characters of the event's own id (a
 * uuid), never the app's `external_event_id`. Every path that renders an
 * event (live delivery, `message read`, hosted tools) uses this, so the same
 * event delivered twice carries the same id and the repeat-delivery rule can
 * match it.
 */
export function thirdPartyEventShortId(event: { id: string }): string {
  return event.id.slice(0, 8).toLowerCase();
}

/**
 * One received-message line: header bracket + sender + content + suffixes.
 * `omitTaskReplyHint`: a task conversation read (`raft task read`) states the
 * reply command once instead of on every line.
 */
export function formatAgentMessageLine(m: AgentMessageLike, style: RaftHintStyle = "cli", options: { omitTaskReplyHint?: boolean } = {}): string {
  if (m.third_party_event) {
    const msgId = thirdPartyEventShortId(m.third_party_event);
    const time = m.timestamp ? formatUtcTimestamp(m.timestamp) : "-";
    const event = m.third_party_event;
    const content = m.content ?? "";
    // The Server builds the content: "Third-party <kind>: <summary>" (a system
    // app's adds its own `event_id:`/`payload_hash:`/`resource:` lines). The
    // app's summary is the only text in it the app wrote, so a separator in that
    // first line (an event stored before the Server folded them all) is quoted.
    // No provenance line (hashes, resource): Raft's bookkeeping, not the agent's.
    const [summaryLine = "", ...serverLines] = content.split("\n");
    const quotedContent = [indentAgentBodyContinuationLines(summaryLine), ...serverLines].join("\n");
    const payload = thirdPartyEventPayloadForAgent(event);
    return (`[target=agent-event:${msgId} msg=${msgId} time=${time} type=third_party_app] ${indentAgentBodyContinuationLines(`@${event.client_id} — ${event.client_name}`)}: ${quotedContent}${payload ? `\npayload:\n${renderThirdPartyEventPayload({ payload, system_app: event.system_app })}` : ""}`);
  }
  const target = formatAgentMessageTarget(m);
  const msgId = m.message_id ? m.message_id.slice(0, 8) : "-";
  const time = m.timestamp ? formatUtcTimestamp(m.timestamp) : "-";
  // RFC 077: sent by an assistant as its owner (the sender); never hidden.
  const senderType = ` type=${m.sender_type}${m.delegated_by?.name ? ` delegated_by=@${m.delegated_by.name}` : ""}${formatAgentMessageCardHeaderFields(m.message_card)}`;
  const content = indentAgentBodyContinuationLines(m.content ?? "");
  const attachSuffix = formatAgentAttachmentSuffix(m.attachments, style);
  // Task v2 (source_tasks present): the list of every task hanging under the
  // message replaces the pre-v2 single-task bracket, which is otherwise kept
  // byte-for-byte.
  const taskSuffix = m.source_tasks?.length
    ? formatAgentSourceTasksSuffix(m.source_tasks, target)
    : m.task_status
      ? ` [task #${m.task_number} status=${m.task_status}${formatAgentTaskAssigneeSuffix(m.task_assignee_id, m.task_assignee_name)}]`
      : "";
  const taskReplySuffix = options.omitTaskReplyHint ? "" : formatAgentTaskReplySuffix(m, style);
  return (`[target=${target} msg=${msgId} time=${time}${senderType}] ${formatAgentSenderHandle(m)}: ${content}${attachSuffix}${taskSuffix}${taskReplySuffix}${formatAgentReplyAffordanceSuffix(m)}${formatAgentMessageCardBlock(m.message_card, m.content)}${formatAgentTaskCurrentProjection(m.task_current_projection)}${formatAgentMessageReactionsLine(m.reactions)}`);
}

/** Batch of received-message lines (`raft message check` output). */
export function formatAgentMessages(messages: AgentMessageLike[], style: RaftHintStyle = "cli"): string {
  if (messages.length === 0) return "No new inbox messages.";
  return messages.map((m) => formatAgentMessageLine(m, style)).join("\n");
}

/**
 * `message check` hands over a bounded batch, oldest first per conversation;
 * the server reports how many conversations still have unread after it.
 */
export function formatAgentInboxHint(hint: { unread_conversations: number }, style: RaftHintStyle = "cli"): string {
  const n = hint.unread_conversations;
  return `Still unread: ${n} ${n === 1 ? "conversation" : "conversations"}. Run \`${formatHint(RAFT_HINTS.inboxList(), style)}\` to list them.`;
}
