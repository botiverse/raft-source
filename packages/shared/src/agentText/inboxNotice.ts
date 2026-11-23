/**
 * The wake-up notice whose unread numbers are the Server's (`POST /inbox/rows`,
 * the rows `inbox check` would list), composed from the Computer's own rows
 * and the Server's answer. Pure: the Computer asks, these functions only merge
 * and print. The View Context parser (raftDeliveryParse.ts) reads the result
 * back; the round trip is tested in inboxNotice.test.ts.
 */
import type { AgentApiInboxRowsResponse } from "../agentApiContract";
import { formatAgentInboxItemRow, type AgentInboxItemRow, type AgentInboxItemRowOptions } from "../agentInboxItemRow";
import { formatHint, RAFT_HINTS } from "../agentOps/hint";

/**
 * One of the Computer's rows: a conversation row with the channel id it asked
 * the Server about, or an app/reminder row (null). `heldSeqs`: the seqs of
 * the messages the Computer holds for that conversation (the ones the row
 * lists), for an answer whose rows may be behind (`withBehind`).
 */
export type AgentInboxNoticeLocalRow = {
  channelId: string | null;
  row: AgentInboxItemRow;
  heldSeqs?: readonly number[];
  /** False: the answer was not asked about this conversation, so its having no row says nothing. */
  asked?: boolean;
};

/**
 * The notice's rows, in the Computer's order. A conversation the Server
 * answered prints the Server's row (its number is the one `inbox check`
 * shows), keeping the details only the Computer has (the attention hint, the
 * non-member line). A conversation with no Server row, or every conversation
 * when the ask failed (`response` null), keeps the Computer's row without a
 * number: a missing row means "no number right now", never "nothing unread".
 * Ids are compared without letter case (the Server answers in lower case).
 *
 * An answer with `withBehind` (the Server answered the rows that are behind
 * too) is added to instead: the Server's row counts what is unread up to its
 * `activitySeq`, and the Computer holds every message after that, so the
 * number is the row's `unread` plus the held messages above `activitySeq`.
 * A row that is behind keeps the Computer's latest sender and preview (the
 * Server's are of an older message). A conversation with no row has nothing
 * unread the Server knows of, so the Computer's own row stands, with the
 * count of what it holds. Not exact (out-of-order commits, a read the Server
 * has not seen yet); the next notice has it right. A conversation the answer
 * was not asked about (`asked: false`) still prints without a number.
 */
export function mergeAgentInboxNoticeRows(
  local: readonly AgentInboxNoticeLocalRow[],
  response: AgentApiInboxRowsResponse | null,
): AgentInboxItemRow[] {
  const answered = new Map((response?.rows ?? []).map((row) => [row.channelId.toLowerCase(), row]));
  return local.map(({ channelId, row, heldSeqs, asked }) => {
    if (channelId === null) return row;
    const server = answered.get(channelId.toLowerCase());
    const adds = response?.withBehind === true;
    if (!server) {
      const { notDelivered: _notDelivered, ...rest } = row;
      // The Computer's row already counts what it holds (its `unread`).
      return adds && asked !== false ? rest : { ...rest, unread: 0, unreadUnknown: true };
    }
    const own = {
      ...(row.attentionHint ? { attentionHint: row.attentionHint } : {}),
      ...(row.nonMemberMention ? { nonMemberMention: true as const } : {}),
    };
    const after = adds ? heldAfter(heldSeqs, server.activitySeq) : 0;
    if (after === 0) return { ...server, ...own };
    return {
      ...server,
      unread: server.unread + after,
      mentions: Math.max(server.mentions ?? 0, row.mentions ?? 0),
      latestSender: row.latestSender,
      preview: row.preview,
      previewTruncated: row.previewTruncated,
      latestAt: row.latestAt,
      ...own,
    };
  });
}

/** How many held messages the Server's row does not count yet; a held message with no seq counts as one. */
function heldAfter(heldSeqs: readonly number[] | undefined, activitySeq: number | undefined): number {
  if (!heldSeqs || activitySeq === undefined) return 0;
  return heldSeqs.filter((seq) => !(seq <= activitySeq)).length;
}

export type AgentInboxNoticeInput = {
  /** `new`: what arrived since the last notice. `away`: what is unread from while the agent was not running. */
  reason: "new" | "away";
  rows: readonly AgentInboxItemRow[];
  rowOptions?: AgentInboxItemRowOptions;
  /** The Computer-local app items section (formatAgentInboxAppItems), printed after the rows as today's notice does. */
  localSection?: string;
  /** How many changed items the local section stands for; they count as targets in the header. */
  extraTargets?: number;
  /** The response's `otherUnread`: the agent's unread in conversations this notice does not list. Null when the Server was not reached. */
  older: AgentApiInboxRowsResponse["otherUnread"] | null;
  /** The `olderMessages` the last notice returned. */
  previousOlderMessages: number | null;
};

const HEADERS = {
  new: "new since your last notice",
  away: "unread from while you were away",
} as const;

const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The notice text, and the older-unread message count for the caller to hand
 * back as `previousOlderMessages` next time.
 *
 * The "Older unread" line is not printed every time: it would repeat the same
 * number on every notice. It prints when there is older unread and either the
 * number changed since the last notice or a mention or a DM is in it.
 */
export function formatAgentInboxNotice(input: AgentInboxNoticeInput): { text: string; olderMessages: number | null } {
  const { older, rowOptions = {} } = input;
  const targets = input.rows.length + (input.extraTargets ?? 0);
  const lines = [
    `[Raft inbox notice: ${HEADERS[input.reason]}, in ${counted(targets, "target")}`,
    ...input.rows.flatMap((row) => formatAgentInboxItemRow(row, rowOptions)),
  ];
  if (input.localSection) lines.push("", input.localSection);
  if (older && older.messages > 0 && (older.messages !== input.previousOlderMessages || older.mentions > 0 || older.dms > 0)) {
    const list = formatHint(RAFT_HINTS.inboxList(), rowOptions.hints ?? "cli");
    lines.push(`Older unread: ${counted(older.messages, "message")} in ${counted(older.conversations, "target")}. List everything: ${list}`);
  }
  lines.push("]");
  return { text: lines.join("\n"), olderMessages: older?.messages ?? null };
}
