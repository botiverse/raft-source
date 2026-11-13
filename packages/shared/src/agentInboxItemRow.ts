import type { AgentApiInboxItemRow } from "./agentApiContract";
import { formatHint, RAFT_HINTS, type RaftHint, type RaftHintStyle } from "./agentOps/hint";
import { foldAgentOneLineText } from "./agentMessageText";
import {
  formatAgentReplyAffordance,
  formatAttentionHintField,
  isThirdPartyEventsTarget,
  THIRD_PARTY_EVENTS_LABEL,
  type AgentInboxTargetRow,
} from "./agentInbox";
import type { AttentionHint } from "./attentionDependencyOracle";
import { parseAgentTaskRef } from "./agentText/taskRef";

/**
 * RFC 081 D16: the one row an inbox item renders as, wherever the agent sees
 * the list (`raft inbox check` in the CLI, the wake-up notice in the daemon).
 * Both feed the contract's item row (`inbox check` with `items=true`) to
 * `formatAgentInboxItemRow`, so the two lists cannot drift apart again.
 *
 * A row only lists: it never carries a message body. The preview is one
 * folded line, labelled as a preview.
 */
export type AgentInboxItemRow = AgentApiInboxItemRow & {
  /**
   * Managed runners, conversation rows: messages the daemon holds that have
   * not reached the agent yet. Shown beside the unread count, never in place
   * of it.
   */
  notDelivered?: number;
  /**
   * The wake-up notice's own details (the daemon fills them from what its
   * notice showed before inbox items; `inbox check` leaves them unset), in
   * the words agents already know:
   * `first msg=<8 chars>` after the unread count,
   */
  firstUnreadMsgId?: string;
  /** `N suppressed (not delivered)` after the not-delivered count, */
  suppressed?: number;
  /** `attention_hint=<json>` at the end of the row line, */
  attentionHint?: AttentionHint;
  /** and the non-member guidance on its own line under the row. */
  nonMemberMention?: true;
};

/**
 * A managed runner's daemon-pending target (messages the daemon holds for the
 * agent) as an item row: the one mapping `raft inbox check` (a pending target
 * the server list does not show yet) and the daemon's wake-up notice share,
 * so both print the same row for the same target. The daemon has no unread
 * count, task title or times for it; those stay absent. The sender's kind
 * only matters for app rows, which a pending target never is.
 */
export function agentInboxItemRowFromPendingTarget(
  row: AgentInboxTargetRow,
  preview?: { text: string; truncated: boolean } | null,
  /**
   * How the pending count reads. `inbox check` (default): an extra "not yet
   * delivered" note beside the server's unread count. The wake-up (`unread`):
   * the notice is that delivery, and under RFC 081 D1 the pending count is the
   * unread count (Sage, #wg-ax:#19).
   */
  options: { as?: "not_delivered" | "unread" } = {},
): AgentInboxItemRow {
  const asUnread = options.as === "unread";
  return {
    target: row.target,
    kind: "conversation",
    unread: asUnread ? row.pendingCount : 0,
    mentions: row.flags.includes("mention") ? 1 : 0,
    notDelivered: asUnread ? 0 : row.pendingCount,
    latestSender: row.latestSenderName ? { name: row.latestSenderName, type: "user" } : null,
    preview: preview ? preview.text : null,
    previewTruncated: preview?.truncated === true,
    firstUnreadAt: null,
    latestAt: null,
    preLaunch: false,
  };
}

export type AgentInboxItemRowOptions = {
  /** For "5m ago"; without it the row shows no age. */
  nowMs?: number;
  /** `cli` (default) prints `raft ...` commands; `tool` prints tool calls (SDK). */
  hints?: RaftHintStyle;
  /**
   * RFC 081: read with `raft inbox read --target <item>` (a server that lists
   * inbox items). Off: the conversation's own read (`message read --unread`,
   * `task read --unread`), for a server that does not.
   */
  inboxRead?: boolean;
};

/** A hint with no SDK operation yet keeps the CLI form in the tool style, rather than printing "no tool for this". */
function formatCliOnlyHint(hint: RaftHint, style: RaftHintStyle): string {
  return formatHint(hint, hint.op ? style : "cli");
}

/**
 * The command that reads an item's unread entries. The one place that
 * decides it.
 */
export function agentInboxReadCommand(
  target: string,
  { style = "cli", inboxRead = false }: { style?: RaftHintStyle; inboxRead?: boolean } = {},
): string {
  // `raft inbox read` and (task v2) `raft task read <ref>` have no SDK
  // operation yet, so they keep the CLI form in the tool style.
  const hint = inboxRead ? RAFT_HINTS.inboxRead({ target }) : RAFT_HINTS.messageRead({ target, unread: true });
  return formatCliOnlyHint(hint, style);
}

export function formatAgentInboxAgo(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `task #proj:#7 "title"` for a task's conversation; the target itself otherwise. */
function formatItemLabel(target: string, title: string | null | undefined): string {
  const taskRef = parseAgentTaskRef(target);
  if (!taskRef) return target;
  const oneLine = foldAgentOneLineText(title ?? "");
  return oneLine ? `task ${taskRef.ref} ${JSON.stringify(oneLine)}` : `task ${taskRef.ref}`;
}

/**
 * The grouped third-party events row is not a conversation (its transport
 * target cannot be read). Without inbox items its events are fetched with
 * `raft message check`; with them, the server lists app events as items and
 * this row only counts the ones it doesn't (RFC 081 D10), so it names no command.
 */
function formatThirdPartyEventsRow(row: AgentInboxItemRow, options: AgentInboxItemRowOptions): string[] {
  const count = Math.max(row.unread, row.notDelivered ?? 0);
  // With inbox items on, the app events the server lists are items of their
  // own and `message check` is gone (RFC 081 D10); this row holds only what
  // the list can't show (events from before launch, which expire within 7
  // days), so it names no command. With items off, `message check` is still
  // how they are read.
  const parts = options.inboxRead
    ? [THIRD_PARTY_EVENTS_LABEL, `${count} not in this list`, "from before inbox items, expiring within 7 days"]
    : [THIRD_PARTY_EVENTS_LABEL, `${count} pending`];
  if (row.latestSender?.name) parts.push(`latest @${foldAgentOneLineText(row.latestSender.name)}`);
  if (!options.inboxRead) parts.push("fetch with raft message check");
  return [parts.join(" · ")];
}

function formatAgo(row: AgentInboxItemRow, options: AgentInboxItemRowOptions): string | null {
  return options.nowMs === undefined ? null : formatAgentInboxAgo(row.latestAt, options.nowMs);
}

/** `#general · 3 unread · mentions you · 1 new, not yet delivered · latest @alice 5m ago` */
function formatConversationSummary(row: AgentInboxItemRow, options: AgentInboxItemRowOptions): string {
  const parts = [formatItemLabel(row.target, row.title)];
  if (row.unread > 0 || !row.notDelivered) parts.push(`${row.unread} unread`);
  if (row.firstUnreadMsgId) parts.push(`first msg=${foldAgentOneLineText(row.firstUnreadMsgId).slice(0, 8)}`);
  const mentions = row.mentions ?? 0;
  if (mentions > 0) parts.push(mentions === 1 ? "mentions you" : `mentions you ${mentions}x`);
  if (row.notDelivered && row.notDelivered > 0) parts.push(`${row.notDelivered} new, not yet delivered`);
  if (row.suppressed && row.suppressed > 0) parts.push(`${row.suppressed} suppressed (not delivered)`);
  const sender = row.latestSender?.name ? `@${foldAgentOneLineText(row.latestSender.name)}` : null;
  const latest = [sender, formatAgo(row, options)].filter(Boolean).join(" ");
  if (latest) parts.push(`latest ${latest}`);
  if (row.attentionHint) parts.push(`attention_hint=${formatAttentionHintField(row.attentionHint)}`);
  return parts.join(" · ");
}

/** `app:stamp/pr-13754 · 2 unread · from Stamp · about #proj:#232 · latest 5m ago` */
function formatAppSummary(row: AgentInboxItemRow, options: AgentInboxItemRowOptions): string {
  const parts = [row.target, `${row.unread} unread`];
  const appName = row.app ? foldAgentOneLineText(row.app.name) : "";
  if (appName) parts.push(`from ${appName}`);
  if (row.related?.target) parts.push(`about ${row.related.target}`);
  const ago = formatAgo(row, options);
  if (ago) parts.push(`latest ${ago}`);
  return parts.join(" · ");
}

/** `reminder:76d9397d-… · 1 fired, not acked · latest 5m ago` */
function formatReminderSummary(row: AgentInboxItemRow, options: AgentInboxItemRowOptions): string {
  const parts = [row.target, `${row.unread} fired, not acked`];
  const ago = formatAgo(row, options);
  if (ago) parts.push(`latest ${ago}`);
  return parts.join(" · ");
}

function formatSummary(row: AgentInboxItemRow, options: AgentInboxItemRowOptions): string {
  switch (row.kind) {
    case "app":
    case "app_fallback":
      return formatAppSummary(row, options);
    case "reminder":
      return formatReminderSummary(row, options);
    case "conversation":
    default:
      return formatConversationSummary(row, options);
  }
}

/**
 * One item as list lines:
 *
 *   #general · 3 unread · mentions you · latest @alice 5m ago
 *     "first line of the latest message…" (truncated preview)
 *     read: raft inbox read --target "#general"
 *
 * A reminder row adds one `ack:` line per fired revision not yet acked.
 */
export function formatAgentInboxItemRow(row: AgentInboxItemRow, options: AgentInboxItemRowOptions = {}): string[] {
  if (isThirdPartyEventsTarget(row.target)) return formatThirdPartyEventsRow(row, options);
  const style = options.hints ?? "cli";
  const lines = [formatSummary(row, options)];
  if (row.nonMemberMention) lines.push(`  ${formatAgentReplyAffordance({ non_member_mention: true })}`);
  if (row.preview) {
    const text = foldAgentOneLineText(row.preview);
    lines.push(`  ${JSON.stringify(row.previewTruncated ? `${text}…` : text)} (${row.previewTruncated ? "truncated preview" : "preview"})`);
  }
  lines.push(`  read: ${agentInboxReadCommand(row.target, { style, inboxRead: options.inboxRead === true })}`);
  if (row.kind === "reminder") {
    for (const ack of row.ack ?? []) {
      lines.push(`  ack: ${formatCliOnlyHint(RAFT_HINTS.reminderAck({ id: ack.id, revision: ack.revision }), style)}`);
    }
  }
  return lines;
}

/** Rows in list order; an empty list renders as no lines. */
export function formatAgentInboxItemRows(rows: readonly AgentInboxItemRow[], options: AgentInboxItemRowOptions = {}): string {
  return rows.flatMap((row) => formatAgentInboxItemRow(row, options)).join("\n");
}
