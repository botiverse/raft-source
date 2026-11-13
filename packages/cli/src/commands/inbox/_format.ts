import {
  AGENT_INBOX_REMINDER_TARGET_PREFIX,
  agentInboxItemRowFromPendingTarget,
  agentInboxReadCommand,
  foldAgentOneLineText,
  formatAgentInboxAppItems as sharedFormatAgentInboxAppItems,
  formatAgentInboxDismissedText,
  formatAgentInboxItemRow,
  formatAgentInboxReadText,
  formatHint,
  isThirdPartyEventsTarget,
  RAFT_HINTS,
} from "@botiverse/raft-shared/src/agentCliSurface";
export type {
  AgentInboxTargetRow as InboxTargetRow,
  AgentInboxAppItem as InboxAppItem,
  AgentInboxItem as InboxItem,
} from "@botiverse/raft-shared";

import { axSurface } from "../../core/renderer";
import { formatMessageLine, type MessageLike } from "../message/_format";
import type {
  AgentApiInboxConversation,
  AgentApiInboxDismissResponse,
  AgentApiInboxItemRow,
  AgentApiInboxListResponse,
  AgentApiInboxReadEntry,
  AgentApiInboxReadResponse,
  AgentApiInboxView,
  AgentInboxAppItem,
  AgentInboxItemRow,
  AgentInboxSourceSeal,
  AgentInboxTargetRow,
} from "@botiverse/raft-shared";

// The shared inbox projections render both here and inside daemon inbox
// notices; on the CLI side they are reply surfaces in their own right.
export const formatAgentInboxAppItems = axSurface(
  "App-sourced inbox item rows.",
  sharedFormatAgentInboxAppItems,
  {
    examples: [
      { args: [[{ source: "app", itemId: "it-1", appId: "reminder", notificationClass: "fire", sourceRef: { kind: "reminder", id: "76d9397d" }, primaryAction: { kind: "run_command", commandId: "reminder.ack" }, actionCli: "raft reminder log", retention: "until_explicit_ack", title: "Reminder fired" }]] },
      {
        title: "a Computer-local item the agent may dismiss (the Cleaner's)",
        args: [[{ source: "app", itemId: "714fbfc6-2d3e-5a1b-a9c4-0f6e8d7c5b3a", appId: "system.cleaner", notificationClass: "disk_space_hint", sourceRef: { kind: "backup_ignore_hint", id: "agent-1" }, primaryAction: { kind: "run_command", commandId: "cleaner.disk_guidance" }, actionCli: 'raft manual get agent --intent "Keep your workspace migratable" --reason "Cleaner reminder about .raftbackupignore"', retention: "transient", title: "Review .raftbackupignore", summary: "Over half the move size limit (60%). Largest folders that still move: checkouts/, archive/." }]],
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// `raft inbox check`: the agent's Activity panel.
//
// One entry point, no required flags. The server list is the durable unread
// set (newest activity first, keyset-paged); a managed runner's daemon snapshot
// only annotates it ("N new, not yet delivered") and contributes app items and
// the seal registry. Every row carries its one `read:` command and the output
// ends with exactly one `Next:` line.
// ---------------------------------------------------------------------------

export type InboxCheckInput = {
  view: AgentApiInboxView;
  before?: number;
  list: AgentApiInboxListResponse;
  /** Managed runners only: the daemon's pending (not yet delivered) targets. */
  pendingRows?: readonly AgentInboxTargetRow[];
  appItems?: readonly AgentInboxAppItem[];
  seals?: readonly AgentInboxSourceSeal[];
  /** Managed runner whose daemon snapshot could not be read. */
  daemonError?: string;
  /**
   * No daemon at all (external agent): say app items/seals are unavailable.
   * Conversation-only list only: with inbox items the server lists app items
   * and reminders itself.
   */
  appItemsUnavailable?: boolean;
  nowMs: number;
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `next`: null for a row with nothing to run (inbox items on, the grouped pre-launch events row). */
type RenderedRow = { lines: string[]; next: string | null };

// Rows render through the shared formatter (RFC 081 D16), the same one the
// daemon's wake-up notice uses; this file only maps the data sources (the
// server's durable list, the daemon's not-yet-delivered snapshot) onto its
// row fields. `inboxRead`: the server lists inbox items, so every row is read
// with `raft inbox read`.
function renderRow(row: AgentInboxItemRow, nowMs: number, inboxRead: boolean): RenderedRow {
  const lines = formatAgentInboxItemRow(row, { nowMs, inboxRead });
  const read = agentInboxReadCommand(row.target, { inboxRead });
  const next = isThirdPartyEventsTarget(row.target)
    ? inboxRead
      // `message check` is gone where items are listed (RFC 081 D10): these
      // pre-launch events can't be read, so the Next step is another row's.
      ? null
      : "fetch the third-party app events above: raft message check"
    : inboxRead
      ? `read the first item above: ${read}`
      : `read the first conversation above: ${read}`;
  return { lines, next };
}

/** The fields a conversation row has that a server without inbox items does not send. */
function conversationRowDefaults(target: string): Pick<AgentApiInboxItemRow, "target" | "kind" | "preview" | "previewTruncated" | "firstUnreadAt" | "preLaunch"> {
  return { target, kind: "conversation", preview: null, previewTruncated: false, firstUnreadAt: null, preLaunch: false };
}

/** The sender's kind only matters for app rows, which a conversation row never is. */
function latestSenderOf(name: string | null | undefined): AgentApiInboxItemRow["latestSender"] {
  return name ? { name, type: "user" } : null;
}

function conversationRow(item: AgentApiInboxConversation, pending: AgentInboxTargetRow | undefined): AgentInboxItemRow {
  return {
    ...conversationRowDefaults(item.target),
    title: typeof item.title === "string" ? item.title : null,
    unread: item.unread,
    mentions: item.mentions,
    notDelivered: pending?.pendingCount ?? 0,
    latestSender: latestSenderOf((isThirdPartyEventsTarget(item.target) ? pending?.latestSenderName : undefined) ?? item.latestSenderName),
    latestAt: item.latestAt,
  };
}

// A daemon-pending target maps through the shared row mapping, the one the
// daemon's wake-up notice uses too (RFC 081 D16).
const pendingOnlyRow = (row: AgentInboxTargetRow): AgentInboxItemRow => agentInboxItemRowFromPendingTarget(row);

/**
 * The header counts the server's totals plus the daemon-pending conversations
 * the server's list does not show yet (`extraPending`: pendingNotListed in the
 * `"unread"` view, so the mentions view's "of N unread conversations" is the
 * unread view's N). Without them the header said "0 unread conversations"
 * above a row saying "1 new, not yet delivered".
 *
 * `hasOtherItems`: app or reminder rows follow, so "nothing unread" would be
 * wrong; it says there are no unread conversations instead.
 */
function formatHeader(input: InboxCheckInput, extraPending: readonly AgentInboxTargetRow[], hasOtherItems = false): string {
  // The grouped app-events row is not a conversation.
  const pending = extraPending.filter((row) => !isThirdPartyEventsTarget(row.target));
  const totals = {
    conversations: input.list.totals.conversations + pending.length,
    dms: input.list.totals.dms + pending.filter((row) => row.flags.includes("dm")).length,
    mentions: input.list.totals.mentions + pending.filter((row) => row.flags.includes("mention")).length,
  };
  const nothing = hasOtherItems || extraPending.length > 0 ? "Inbox: no unread conversations." : "Inbox: nothing unread.";
  const breakdown = `${plural(totals.dms, "DM")}, ${totals.mentions} with mentions`;
  if (input.view === "mentions") {
    if (totals.mentions === 0) {
      return totals.conversations === 0
        ? nothing
        : `Inbox: no unread mentions (${plural(totals.conversations, "unread conversation")} in total).`;
    }
    return `Inbox: ${plural(totals.mentions, "conversation")} with unread mentions (of ${plural(totals.conversations, "unread conversation")}).`;
  }
  if (totals.conversations === 0) return nothing;
  return `Inbox: ${plural(totals.conversations, "unread conversation")} (${breakdown}).`;
}

function formatSealRegistryText(seals: readonly AgentInboxSourceSeal[], items: readonly AgentInboxAppItem[]): string {
  if (seals.length === 0) return "";
  const lines = seals.map((seal) => {
    const sameSource = items.filter((item) =>
      item.appId === seal.appId
      && item.notificationClass === seal.notificationClass
      && item.sourceRef.kind === seal.sourceRef.kind
      && item.sourceRef.id === seal.sourceRef.id,
    );
    const exact = seal.sourceRef.revision !== undefined
      && sameSource.some((item) => item.sourceRef.revision === seal.sourceRef.revision);
    let status: string;
    if (seal.sourceRef.revision === undefined) {
      status = "DETACHED(id-only)";
    } else if (exact) {
      status = "SEALED(exact)";
    } else if (sameSource.length > 0) {
      const live = [...new Set(sameSource.map((item) => item.sourceRef.revision ?? "(none)"))].sort().join(",");
      status = `STALE(sealed-specimen-mutated) registered_revision=${seal.sourceRef.revision} live_revision=${live}`;
    } else {
      status = `DETACHED(no-live-item) registered_revision=${seal.sourceRef.revision}`;
    }
    return `seal app=${seal.appId} · class=${seal.notificationClass} · source=${seal.sourceRef.kind}:${seal.sourceRef.id} · status=${status} · owner=${seal.owner} · unseal_when=${seal.until}`;
  });
  return `Seal registry:\n${lines.join("\n")}`;
}

/**
 * Rows that are newest activity there is: daemon pending targets the durable list does not show yet (chain lag). First page only.
 * `view`: the mentions view lists only those that mention the agent; its header still counts all of them (`"unread"`).
 */
function pendingNotListed(input: InboxCheckInput, listed: ReadonlySet<string>, view: AgentApiInboxView = input.view): AgentInboxTargetRow[] {
  if (input.before !== undefined) return [];
  return (input.pendingRows ?? []).filter((row) =>
    row.pendingCount > 0
    && !listed.has(row.target)
    && (view === "unread" || row.flags.includes("mention")));
}

/** `More:` and the one `Next:` line; none when there is nothing to do. */
function formatTrailer(input: InboxCheckInput, rows: readonly RenderedRow[]): string[] {
  const { list, view } = input;
  const viewFlag = view === "mentions" ? " --view mentions" : "";
  const trailer: string[] = [];
  if (list.hasMore && list.nextBeforeSeq !== null) {
    trailer.push(`More: raft inbox check${viewFlag} --before ${list.nextBeforeSeq}`);
  }
  const firstNext = rows.find((row) => row.next !== null)?.next;
  if (firstNext) {
    trailer.push(`Next: ${firstNext}`);
  } else if (rows.length > 0) {
    trailer.push("Next: nothing to read; those app events expire within 7 days.");
  } else if (input.before !== undefined && (list.totals.conversations > 0)) {
    trailer.push(`Next: no older ${view === "mentions" ? "mentions" : "unread conversations"}; run raft inbox check${viewFlag} for the newest.`);
  } else if (view === "mentions" && list.totals.conversations > 0) {
    trailer.push("Next: run raft inbox check to list all unread conversations.");
  }
  // Nothing to do: the header already says nothing is unread.
  return trailer;
}

function formatDaemonSections(input: InboxCheckInput, appItems: readonly AgentInboxAppItem[]): string[] {
  const sections: string[] = [];
  const appPart = formatAgentInboxAppItems(appItems);
  if (appPart) sections.push(appPart);
  // Seals are checked against every live daemon item, reminders included.
  const sealPart = formatSealRegistryText(input.seals ?? [], input.appItems ?? []);
  if (sealPart) sections.push(sealPart);
  return sections;
}

function formatDaemonError(input: InboxCheckInput): string | null {
  return input.daemonError
    ? `Daemon pending buffer unavailable (${input.daemonError}); not-yet-delivered counts and app items are not shown.`
    : null;
}

function formatPageHeader(input: InboxCheckInput, header: string, rows: readonly RenderedRow[]): string {
  if (rows.length === 0) return header;
  return header + (input.before === undefined ? " Newest activity first." : ` Activity before seq ${input.before}, newest first.`);
}

/** A server without inbox items (or with them off): the conversation-only list. */
function formatLegacyInboxCheckText(input: InboxCheckInput): string {
  const { list } = input;
  const pendingByTarget = new Map((input.pendingRows ?? []).map((row) => [row.target, row]));
  const listed = new Set(list.items.map((item) => item.target));
  const extraPending = pendingNotListed(input, listed);
  const rows: RenderedRow[] = [
    ...extraPending.map((row) => renderRow(pendingOnlyRow(row), input.nowMs, false)),
    ...list.items.map((item) => renderRow(conversationRow(item, pendingByTarget.get(item.target)), input.nowMs, false)),
  ];

  const sections: string[] = [formatPageHeader(input, formatHeader(input, pendingNotListed(input, listed, "unread")), rows)];
  if (rows.length > 0) sections.push(rows.flatMap((row) => row.lines).join("\n"));
  const trailer = formatTrailer(input, rows);
  if (trailer.length > 0) sections.push(trailer.join("\n"));
  sections.push(...formatDaemonSections(input, input.appItems ?? []));
  if (input.appItemsUnavailable) sections.push("App items and reminder seals: not available for external agents.");
  const daemonError = formatDaemonError(input);
  if (daemonError) sections.push(daemonError);
  return sections.join("\n\n");
}

/** Reminder app items now come from the server as `reminder:` rows; the daemon's copy would list them twice. */
const REMINDER_APP_ID = "system.reminder";

/** The reminder ids the server lists (full ids from `ack`, and the id in the target, which may be short). */
function listedReminderIdsOf(rows: readonly AgentApiInboxItemRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.kind !== "reminder") continue;
    ids.push(row.target.slice(AGENT_INBOX_REMINDER_TARGET_PREFIX.length));
    for (const ack of row.ack ?? []) ids.push(ack.id);
  }
  return ids.filter((id) => id.length > 0);
}

/** Ids may be full or an 8-character short id on either side. */
function isListedReminder(id: string, listed: readonly string[]): boolean {
  return listed.some((other) => other.startsWith(id) || id.startsWith(other));
}

/** ` 2 app items, 1 reminder.` (with what was left out), or "" when there are none. */
function formatOtherItemsCount(rows: readonly AgentApiInboxItemRow[], omitted: AgentApiInboxListResponse["omitted"]): string {
  const apps = rows.filter((row) => row.kind === "app" || row.kind === "app_fallback").length + (omitted?.app ?? 0);
  const reminders = rows.filter((row) => row.kind === "reminder").length + (omitted?.reminder ?? 0);
  const parts = [
    ...(apps > 0 ? [plural(apps, "app item")] : []),
    ...(reminders > 0 ? [plural(reminders, "reminder")] : []),
  ];
  return parts.length > 0 ? ` ${parts.join(", ")}.` : "";
}

/** `N items predate <date>; dismiss without reading: raft inbox dismiss --before <date>` (RFC 081 D12). */
function formatPreLaunchLine(preLaunch: AgentApiInboxListResponse["preLaunch"]): string | null {
  if (!preLaunch || preLaunch.count <= 0) return null;
  const verb = preLaunch.count === 1 ? "predates" : "predate";
  return `${plural(preLaunch.count, "item")} ${verb} ${preLaunch.before}; dismiss without reading: ${formatHint(RAFT_HINTS.inboxDismiss({ before: preLaunch.before }))}`;
}

/** `Not listed: 3 more app items and 1 more reminder; read the ones above first.` */
function formatOmittedLine(omitted: AgentApiInboxListResponse["omitted"]): string | null {
  if (!omitted) return null;
  const parts = [
    ...(omitted.app > 0 ? [`${omitted.app} more ${omitted.app === 1 ? "app item" : "app items"}`] : []),
    ...(omitted.reminder > 0 ? [`${omitted.reminder} more ${omitted.reminder === 1 ? "reminder" : "reminders"}`] : []),
  ];
  return parts.length > 0 ? `Not listed: ${parts.join(" and ")}; read the ones above first.` : null;
}

/**
 * RFC 081 inbox items (`items=true` answered with `rows`): conversations, app
 * items and reminders in the server's order, each read with `raft inbox read`.
 */
function formatItemsInboxCheckText(input: InboxCheckInput, itemRows: readonly AgentApiInboxItemRow[]): string {
  const { list } = input;
  const pendingByTarget = new Map((input.pendingRows ?? []).map((row) => [row.target, row]));
  const listed = new Set([...itemRows.map((row) => row.target), ...list.items.map((item) => item.target)]);
  const extraPending = pendingNotListed(input, listed);
  const rows: RenderedRow[] = [
    ...extraPending.map((row) => renderRow(pendingOnlyRow(row), input.nowMs, true)),
    ...itemRows.map((row) => renderRow(
      row.kind === "conversation" ? { ...row, notDelivered: pendingByTarget.get(row.target)?.pendingCount ?? 0 } : row,
      input.nowMs,
      true,
    )),
  ];

  const others = formatOtherItemsCount(itemRows, list.omitted);
  const header = formatHeader(input, pendingNotListed(input, listed, "unread"), others !== "") + others;
  const sections: string[] = [formatPageHeader(input, header, rows)];
  if (rows.length > 0) sections.push(rows.flatMap((row) => row.lines).join("\n"));
  const trailer = formatTrailer(input, rows);
  const preLaunch = formatPreLaunchLine(list.preLaunch);
  if (preLaunch) trailer.push(preLaunch);
  const omitted = formatOmittedLine(list.omitted);
  if (omitted) trailer.push(omitted);
  if (trailer.length > 0) sections.push(trailer.join("\n"));
  // Daemon-local app items still show here, except reminders the server
  // already lists as `reminder:` rows. A reminder that fired before inbox
  // items launched is not an item (it stays on the old path), so the
  // daemon's copy is the only place the agent sees it and its ack command.
  const listedReminderIds = listedReminderIdsOf(itemRows);
  sections.push(...formatDaemonSections(input, (input.appItems ?? []).filter((item) =>
    item.appId !== REMINDER_APP_ID || !isListedReminder(item.sourceRef.id, listedReminderIds))));
  const daemonError = formatDaemonError(input);
  if (daemonError) sections.push(daemonError);
  return sections.join("\n\n");
}

function formatInboxCheckText(input: InboxCheckInput): string {
  const rows = input.list.rows;
  return Array.isArray(rows) ? formatItemsInboxCheckText(input, rows) : formatLegacyInboxCheckText(input);
}

const EXAMPLE_NOW_MS = Date.parse("2026-09-25T12:00:00.000Z");

const EXAMPLE_REMINDER_ID = "76d9397d-1111-4222-8333-444455556666";

/** RFC 081 inbox items: one row of each kind. */
const EXAMPLE_ITEM_ROWS: AgentApiInboxItemRow[] = [
  { target: "dm:@richard", kind: "conversation", conversationKind: "dm", unread: 3, mentions: 0, latestSender: { name: "richard", type: "user" }, preview: "can you look at the release notes before 5?", previewTruncated: false, firstUnreadAt: "2026-09-25T11:40:00.000Z", latestAt: "2026-09-25T11:48:00.000Z", preLaunch: false },
  { target: "app:stamp/pr-13754", kind: "app", objectRef: "pr-13754", app: { key: "stamp", name: "Stamp" }, related: { target: "#general:#7" }, unread: 2, latestSender: { name: "Stamp", type: "app" }, preview: "checks failed on 9ed73d5: unit-fast (cli) timed out after 20 minutes and", previewTruncated: true, firstUnreadAt: "2026-09-25T11:30:00.000Z", latestAt: "2026-09-25T11:35:00.000Z", preLaunch: false },
  { target: `reminder:${EXAMPLE_REMINDER_ID}`, kind: "reminder", app: { key: "system.reminder", name: "Reminder" }, ack: [{ app: "system.reminder", id: EXAMPLE_REMINDER_ID, revision: "2" }], unread: 1, latestSender: null, preview: "check the deploy", previewTruncated: false, firstUnreadAt: "2026-09-25T11:00:00.000Z", latestAt: "2026-09-25T11:00:00.000Z", preLaunch: false },
  { target: "#engineering", kind: "conversation", conversationKind: "channel", unread: 40, mentions: 0, latestSender: { name: "alice", type: "user" }, preview: null, previewTruncated: false, firstUnreadAt: "2026-08-01T09:00:00.000Z", latestAt: "2026-08-02T18:00:00.000Z", preLaunch: true },
];

export const formatInboxCheck = axSurface(
  "Agent Activity panel: unread conversations (with inbox items on, app items and reminders too) with per-row read commands, one Next line, then app items and seals.",
  formatInboxCheckText,
  {
    examples: [
      {
        args: [{
          view: "unread",
          nowMs: EXAMPLE_NOW_MS,
          list: {
            view: "unread",
            items: [
              { target: "dm:@richard", kind: "dm", unread: 3, mentions: 0, lastReadSeq: 1200, activitySeq: 1210, latestSenderName: "richard", latestAt: "2026-09-25T11:48:00.000Z" },
              { target: "#general:3f4b1fd4", kind: "thread", unread: 1, mentions: 1, lastReadSeq: 1180, activitySeq: 1190, latestSenderName: "alice", latestAt: "2026-09-25T11:00:00.000Z" },
              { target: "#general:#7", kind: "thread", conversationKind: "task", taskNumber: 7, title: "Homepage hero copy", unread: 2, mentions: 0, lastReadSeq: 1170, activitySeq: 1185, latestSenderName: "cody", latestAt: "2026-09-25T10:30:00.000Z" },
            ],
            hasMore: true,
            nextBeforeSeq: 1190,
            totals: { conversations: 43, dms: 2, mentions: 5 },
          },
        }],
      },
      {
        args: [{
          view: "unread",
          nowMs: EXAMPLE_NOW_MS,
          list: { view: "unread", items: [], hasMore: false, nextBeforeSeq: null, totals: { conversations: 0, dms: 0, mentions: 0 } },
        }],
      },
      {
        args: [{
          view: "unread",
          nowMs: EXAMPLE_NOW_MS,
          list: { view: "unread", items: [], hasMore: false, nextBeforeSeq: null, totals: { conversations: 0, dms: 0, mentions: 0 } },
          pendingRows: [
            { target: "dm:@third-party-agent-events:3f4b1fd4-0000-4000-8000-000000000000", pendingCount: 20, latestSenderName: "stamp", latestSenderType: "third_party_app", flags: ["dm"] },
          ],
        }],
      },
      {
        title: "inbox items (RFC 081)",
        args: [{
          view: "unread",
          nowMs: EXAMPLE_NOW_MS,
          list: {
            view: "unread",
            items: [],
            rows: EXAMPLE_ITEM_ROWS,
            hasMore: true,
            nextBeforeSeq: 1100,
            totals: { conversations: 12, dms: 1, mentions: 0 },
            preLaunch: { count: 9, before: "2026-09-01" },
            omitted: { app: 0, reminder: 2 },
          },
          pendingRows: [{ target: "dm:@richard", pendingCount: 1, flags: ["dm"] }],
        }],
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// `raft inbox read`: one page of one item (RFC 081 D4).
// ---------------------------------------------------------------------------

export type InboxReadEntry = AgentApiInboxReadEntry & MessageLike;

export type InboxReadInput = {
  response: AgentApiInboxReadResponse;
  /** The entries as printed (sender details already shown in this context elided). */
  entries: readonly InboxReadEntry[];
  /** Now, for a reaction item's times (dated when not today); defaults to the clock. */
  nowMs?: number;
};

// The page's text is shared with the SDK's `inbox.read` (packages/shared/src/agentInboxReadText.ts).
function formatInboxReadText(input: InboxReadInput): string {
  return formatAgentInboxReadText(input);
}

const EXAMPLE_READ_BASE = { remainingCapped: false, nextCursor: null } as const;

const EXAMPLE_REACTED_MESSAGE_ID = "3f2a1c9e-1111-4222-8333-444455556666";
const EXAMPLE_REACTION_TARGET = `app:system.reaction-notices/msg/${EXAMPLE_REACTED_MESSAGE_ID}`;

/** One reaction notice as an `inbox read` entry: the Server's summary line, and the notice as `app_event`. */
function exampleReactionEntry(eventId: string, emoji: string, reactor: { name: string; kind: "human" | "agent" }, reactedAt: string, message: { conversation: string | null; replyTarget: string | null }): InboxReadEntry {
  const where = message.conversation ? ` in ${message.conversation}` : "";
  return {
    message_id: eventId,
    channel_type: "dm",
    channel_name: "third-party-agent-events:agent-1",
    sender_type: "third_party_app",
    sender_name: "Reactions",
    timestamp: reactedAt,
    content: `System notification: ${reactor.name} reacted ${emoji} to your message${where}: "Deploy plan for v1.21.63 is ready for…"`,
    third_party_event: { id: eventId, kind: "notification", client_id: "system.reaction-notices", client_name: "Reactions", system_app: "system.reaction-notices", expires_at: "2026-09-30T10:00:00.000Z" },
    app_event: {
      app: "reaction-notices",
      kind: "message",
      message: { id: EXAMPLE_REACTED_MESSAGE_ID, channelId: "0d0d0d0d-1111-4222-8333-444455556666", ...message, excerpt: "Deploy plan for v1.21.63 is ready for review: the migration runs first, then the web deploy.", excerptTruncated: false },
      reactor: { id: `${eventId.slice(0, 8)}-0000-4000-8000-000000000000`, ...reactor },
      emoji,
      reactedAt,
    },
  } as InboxReadEntry;
}

export const formatInboxRead = axSurface(
  "inbox read: one page of one inbox item, its entries as message lines, what is left, and one Next line.",
  formatInboxReadText,
  {
    examples: [
      {
        title: "conversation, more left",
        args: [{
          response: { ...EXAMPLE_READ_BASE, target: "#general", kind: "conversation", entries: [], unreadBefore: 5, remaining: 2, consumed: false },
          entries: [
            { seq: 1201, message_id: "aaaabbbb-1111-4222-8333-444455556666", channel_type: "channel", channel_name: "general", sender_type: "human", sender_name: "alice", timestamp: "2026-09-25T11:40:00.000Z", content: "deploy is green" },
            { seq: 1202, message_id: "ccccdddd-1111-4222-8333-444455556666", channel_type: "channel", channel_name: "general", sender_type: "human", sender_name: "bob", timestamp: "2026-09-25T11:41:00.000Z", content: "thanks" },
          ],
        }],
      },
      {
        title: "reminder",
        args: [{
          response: { ...EXAMPLE_READ_BASE, target: `reminder:${EXAMPLE_REMINDER_ID}`, kind: "reminder", entries: [], unreadBefore: 1, remaining: 1, consumed: false },
          entries: [
            { message_id: "eeeeffff-1111-4222-8333-444455556666", channel_type: "dm", channel_name: "reminder", sender_type: "app", sender_name: "Reminder", timestamp: "2026-09-25T11:00:00.000Z", content: "check the deploy", ack: { app: "system.reminder", id: EXAMPLE_REMINDER_ID, revision: "2" } },
          ],
        }],
      },
      {
        title: "already read",
        args: [{ response: { ...EXAMPLE_READ_BASE, target: "#general", kind: "conversation", entries: [], unreadBefore: 0, remaining: 0, consumed: true }, entries: [] }],
      },
      {
        title: "reactions to your message (system.reaction-notices), with its reply in its thread",
        args: [{
          response: { ...EXAMPLE_READ_BASE, target: EXAMPLE_REACTION_TARGET, kind: "app", entries: [], unreadBefore: 2, remaining: 0, consumed: true, app: { key: "system.reaction-notices", name: "Reactions" }, related: { target: "#proj-x" } },
          entries: [
            exampleReactionEntry("aaaa0001-1111-4222-8333-444455556666", "✅", { name: "tygg", kind: "human" }, "2026-09-25T10:02:00.000Z", { conversation: "#proj-x", replyTarget: "#proj-x:3f2a1c9e" }),
            exampleReactionEntry("aaaa0002-1111-4222-8333-444455556666", "👍", { name: "Remy", kind: "agent" }, "2026-09-24T18:40:00.000Z", { conversation: "#proj-x", replyTarget: "#proj-x:3f2a1c9e" }),
          ],
          nowMs: EXAMPLE_NOW_MS,
        }],
      },
      {
        title: "reactions to a message in a conversation without threads (no reply target)",
        args: [{
          response: { ...EXAMPLE_READ_BASE, target: EXAMPLE_REACTION_TARGET, kind: "app", entries: [], unreadBefore: 1, remaining: 0, consumed: true, app: { key: "system.reaction-notices", name: "Reactions" }, related: { target: "#board:#7" } },
          entries: [exampleReactionEntry("aaaa0003-1111-4222-8333-444455556666", "🎉", { name: "alice", kind: "human" }, "2026-09-25T11:30:00.000Z", { conversation: "#board:#7", replyTarget: null })],
          nowMs: EXAMPLE_NOW_MS,
        }],
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// `raft inbox dismiss`: the escape hatch (RFC 081 D12).
// ---------------------------------------------------------------------------

function formatInboxDismissedText(response: AgentApiInboxDismissResponse): string {
  return formatAgentInboxDismissedText(response);
}

export const formatInboxDismissed = axSurface(
  "inbox dismiss: how many items were dismissed without being read, what was skipped or is left, and one Next line.",
  formatInboxDismissedText,
  {
    examples: [
      { title: "one item", args: [{ dismissed: 1, conversations: 1, appItems: 0, skippedNeedsAck: 0, earliestActivityAt: "2026-08-02T18:00:00.000Z", remaining: 0 }] },
      { title: "--before, capped", args: [{ dismissed: 500, conversations: 480, appItems: 20, skippedNeedsAck: 2, earliestActivityAt: "2026-06-01T08:00:00.000Z", remaining: 37 }] },
    ],
  },
);
