import type { AttentionHint } from "./attentionDependencyOracle.js";

const NON_MEMBER_MENTION_REPLY_GUIDANCE =
  "[Raft notice: You were notified as a non-member, so you cannot reply in that channel. If no reply is needed, no action is required. Otherwise, DM the person who mentioned you or join the channel to participate.]";

export type AgentReplyFacts = {
  non_member_mention?: boolean;
};

export type AgentReplyAffordance = Readonly<{
  kind: "non_member_mention";
  guidance: string;
}>;

export function projectAgentReplyAffordance(facts: AgentReplyFacts): AgentReplyAffordance | null {
  if (facts.non_member_mention !== true) return null;
  return {
    kind: "non_member_mention",
    guidance: NON_MEMBER_MENTION_REPLY_GUIDANCE,
  };
}

export function formatAgentReplyAffordance(facts: AgentReplyFacts): string {
  return projectAgentReplyAffordance(facts)?.guidance ?? "";
}

export function formatAgentReplyAffordanceSuffix(facts: AgentReplyFacts): string {
  const guidance = formatAgentReplyAffordance(facts);
  return guidance ? `\n${guidance}` : "";
}

/**
 * The one definition of the inbox flag set. Everything else -- the wire schema in
 * daemonApiContract.ts, the daemon projection, the renderer -- derives from this.
 *
 * It is a runtime array, not a bare type union, because the wire schema needs the
 * VALUES at runtime. When those two were written out by hand separately, they drifted:
 * #4822 (2026-07-18) taught the daemon to emit `non_member_mention` and did not update
 * the contract, so for seven weeks any inbox snapshot containing that flag was rejected
 * whole -- taking every other pending target and every app item down with it.
 */
const UNKNOWN_FLAG_DISPLAY_LIMIT = 40;

export const AGENT_INBOX_FLAGS = ["mention", "non_member_mention", "thread", "dm", "task"] as const;

export type AgentInboxFlag = (typeof AGENT_INBOX_FLAGS)[number];

export type AgentInboxTargetRow = {
  target: string;
  channelId?: string;
  channelType?: string;
  pendingCount: number;
  firstPendingMsgId?: string;
  firstPendingSeq?: number;
  latestMsgId?: string;
  latestSeq?: number;
  latestSenderName?: string;
  latestSenderType?: "human" | "agent" | "system" | "third_party_app";
  flags: AgentInboxFlag[];
  attentionHint?: AttentionHint;
  /**
   * How many notifications for this target were SUPPRESSED (muted, unfollowed
   * thread) rather than delivered.
   *
   * Suppression is currently recorded only in a server-side trace event, which
   * the agent cannot read. Without this an agent cannot tell "nothing was sent
   * to me" from "things were sent and withheld" -- two states calling for
   * opposite actions. A count is deliberately enough: the agent does not need
   * the withheld content, it needs to know withheld content EXISTS.
   */
  suppressedCount?: number;
};

export const AGENT_INBOX_TARGET_ROW_KEYS = [
  "target",
  "channelId",
  "channelType",
  "pendingCount",
  "firstPendingMsgId",
  "firstPendingSeq",
  "latestMsgId",
  "latestSeq",
  "latestSenderName",
  "latestSenderType",
  "flags",
  "suppressedCount",
  "attentionHint",
] as const satisfies readonly (keyof AgentInboxTargetRow)[];

export function formatAgentInboxSnapshot(rows: readonly AgentInboxTargetRow[]): string {
  if (rows.length === 0) return "Inbox: empty";
  // A suppressed-only target is a THIRD state -- "there is something, and it was
  // not given to you" -- and it must impersonate neither of the other two.
  // Counting it as pending promises messages the agent will not find; omitting it
  // restores the invisibility this whole field exists to remove. So the header
  // carries both numbers and neither stands in for the other.
  const pending = rows.filter((row) => row.pendingCount > 0).length;
  const suppressedOnly = rows.filter((row) => row.pendingCount === 0 && (row.suppressedCount ?? 0) > 0).length;
  const header = suppressedOnly > 0
    ? `Inbox: ${pending} pending target${pending === 1 ? "" : "s"} · ${suppressedOnly} target${suppressedOnly === 1 ? "" : "s"} with suppressed items`
    : `Inbox: ${rows.length} pending target${rows.length === 1 ? "" : "s"}`;
  return [
    header,
    "",
    ...rows.flatMap((row) => [
      row.target,
      formatAgentInboxRowDetails(row),
      "",
    ]),
  ].join("\n").trimEnd();
}

export function formatAgentInboxDelta(
  rows: readonly AgentInboxTargetRow[],
  options: { totalPendingMessages?: number } = {},
): string {
  const totalPendingMessages = options.totalPendingMessages;
  const header = typeof totalPendingMessages === "number"
    ? `Inbox update: ${totalPendingMessages} unread message${totalPendingMessages === 1 ? "" : "s"} total; ${rows.length === 0 ? "no" : rows.length} changed target${rows.length === 1 ? "" : "s"}`
    : `Inbox update: ${rows.length} changed target${rows.length === 1 ? "" : "s"}`;
  if (rows.length === 0) return typeof totalPendingMessages === "number" ? header : "Inbox update: no pending targets";
  return [
    header,
    ...rows.map((row) => `${row.target}  ${formatAgentInboxRowDetails(row)}`),
  ].join("\n");
}

function formatAgentInboxRowDetails(row: AgentInboxTargetRow): string {
  const parts = [`pending: ${row.pendingCount} message${row.pendingCount === 1 ? "" : "s"}`];
  if (row.suppressedCount) parts.push(`${row.suppressedCount} suppressed (not delivered)`);
  if (row.firstPendingMsgId) parts.push(`first msg=${shortMessageId(row.firstPendingMsgId)}`);
  if (row.latestSenderName) parts.push(`latest sender @${row.latestSenderName}`);
  if (row.latestMsgId) parts.push(`latest msg=${shortMessageId(row.latestMsgId)}`);
  parts.push(...row.flags.map(formatAgentInboxFlag));
  if (row.attentionHint) parts.push(`attention_hint=${formatAttentionHintField(row.attentionHint)}`);
  return parts.join(" · ");
}

function formatAgentInboxFlag(flag: string): string {
  if (flag === "mention") return "you were mentioned";
  if (flag === "non_member_mention") return formatAgentReplyAffordance({ non_member_mention: true });
  // A flag this build has never heard of: say so rather than printing it bare. Tolerating
  // unknown values stops a newer daemon from breaking a CLI built after this change, but
  // silent tolerance would trade a loud failure for a quiet one -- so it is surfaced here.
  //
  // The value comes off the wire, so it is BOUNDED and JSON-quoted before display: an
  // unescaped newline or control character would let a flag forge extra output lines in
  // a surface whose whole job is telling the agent what is pending.
  if (!(AGENT_INBOX_FLAGS as readonly string[]).includes(flag)) {
    const bounded = flag.length > UNKNOWN_FLAG_DISPLAY_LIMIT
      ? `${flag.slice(0, UNKNOWN_FLAG_DISPLAY_LIMIT)}…`
      : flag;
    return `unknown inbox flag: ${JSON.stringify(bounded)}`;
  }
  return flag;
}

function shortMessageId(value: string): string {
  return value.slice(0, 8);
}

function formatAttentionHintField(hint: AttentionHint): string {
  return JSON.stringify({
    schema: hint.schema,
    trigger: hint.trigger,
    scope: hint.scope,
    suggested_command: hint.suggested_command,
    copy: hint.copy,
    copy_version: hint.copy_version,
    epoch_ms: hint.epoch_ms,
    thresholds: hint.thresholds,
  });
}
