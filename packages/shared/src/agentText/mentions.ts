// Canonical mention text for agent-facing output (moved verbatim from the
// CLI's commands/mention/_format.ts; the CLI wraps these in its axSurface
// registrations and pins the bytes with its snapshot tests).

import type { SenderMentionDeliveryOutcome, SenderMentionDeliveryReasonCategory } from "../agentApiContract";
import { formatAgentReplyAffordance } from "../agentInbox";
import { formatHint, formatHintFlag, formatHintName, RAFT_HINTS, type RaftHintStyle } from "../agentOps/hint";

export type AgentMentionActionKind = "notify" | "add";

/** Pending-mention reason for an agent mentioned in another agent's lounge: never deliverable. */
export const AGENT_LOUNGE_EXCLUDED_MENTION_REASON = "lounge_agent_excluded";

export interface AgentPendingMentionAction {
  resolutionId: string;
  messageId: string;
  targetType: string;
  targetHandle: string;
  reason: string;
  availableActions: string[];
  expiresAt?: string | null;
}

export interface AgentSenderPendingMentionAction {
  resolutionId: string;
  messageId: string;
  targetHandle: string;
  status: "not_queued";
  reason: "not_in_conversation";
  consequence: "This @mention did not notify anyone.";
  expiresAt: string | null;
  recoveryCommand: string | null;
}

export interface AgentSenderUnresolvedMentionWarning {
  targetHandle: string;
  status: "not_queued";
  reason: "unknown_or_not_visible";
  consequence: "This @mention did not notify anyone.";
  expiresAt: null;
  recoveryCommand: null;
}

export type AgentMentionActionResultStatus =
  | "queued"
  | "delivered"
  | "dropped"
  | "stale"
  | "expired"
  | "no_permission"
  | "not_found"
  | "ambiguous";

export interface AgentMentionActionResult {
  resolutionId: string;
  status: AgentMentionActionResultStatus;
  action?: AgentMentionActionKind | null;
  messageId?: string | null;
  channelId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetHandle?: string | null;
  message?: string | null;
  reason?: string | null;
  dedupedResolutionIds?: string[];
}

export function normalizeAgentMentionAction(action: string): AgentMentionActionKind | null {
  if (action === "notify" || action === "notify_only") return "notify";
  if (action === "add" || action === "invite") return "add";
  return null;
}

function actionVerbs(action: AgentPendingMentionAction): AgentMentionActionKind[] {
  const verbs = action.availableActions
    .map(normalizeAgentMentionAction)
    .filter((verb): verb is AgentMentionActionKind => verb !== null);
  return Array.from(new Set(verbs));
}

function formatActionCommands(action: AgentPendingMentionAction, style: RaftHintStyle): string[] {
  return actionVerbs(action).map((verb) => `  ${verb}: ${formatHint(RAFT_HINTS.mentionAction(verb, action.resolutionId), style)}`);
}

function formatAuthoredMentionToken(targetHandle: string): string {
  return targetHandle.startsWith("@") ? targetHandle : `@${targetHandle}`;
}

const PENDING_MENTION_ACTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-token mention recovery command line; null when the id is not a UUID (fail closed). */
export function formatAgentMentionNotifyRecoveryCommand(resolutionId: string, style: RaftHintStyle = "cli"): string | null {
  return PENDING_MENTION_ACTION_ID_RE.test(resolutionId)
    ? formatHint(RAFT_HINTS.mentionAction("notify", resolutionId), style)
    : null;
}

export function toAgentSenderPendingMentionAction(action: AgentPendingMentionAction): AgentSenderPendingMentionAction {
  return {
    resolutionId: action.resolutionId,
    messageId: action.messageId,
    targetHandle: formatAuthoredMentionToken(action.targetHandle),
    status: "not_queued",
    reason: "not_in_conversation",
    consequence: "This @mention did not notify anyone.",
    expiresAt: action.expiresAt ?? null,
    recoveryCommand: formatAgentMentionNotifyRecoveryCommand(action.resolutionId),
  };
}

export function toAgentSenderUnresolvedMentionWarning(targetHandle: string): AgentSenderUnresolvedMentionWarning {
  return {
    targetHandle: formatAuthoredMentionToken(targetHandle),
    status: "not_queued",
    reason: "unknown_or_not_visible",
    consequence: "This @mention did not notify anyone.",
    expiresAt: null,
    recoveryCommand: null,
  };
}

function formatPendingReason(reason: string): string {
  if (reason === "not_member") {
    return "not in the conversation at send time, so the @mention was not delivered";
  }
  return reason;
}

export function normalizeAgentPendingMentionActions(data: unknown): AgentPendingMentionAction[] {
  const value = data as { pendingMentionActions?: unknown; actions?: unknown; results?: unknown } | null;
  const raw = Array.isArray(value?.pendingMentionActions)
    ? value.pendingMentionActions
    : Array.isArray(value?.actions)
      ? value.actions
      : Array.isArray(value?.results)
        ? value.results
        : [];

  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      resolutionId: String(item.resolutionId ?? item.id ?? ""),
      messageId: String(item.messageId ?? ""),
      targetType: String(item.targetType ?? "unknown"),
      targetHandle: String(item.targetHandle ?? ""),
      reason: String(item.reason ?? "Mention target was not notified at send time."),
      availableActions: Array.isArray(item.availableActions)
        ? item.availableActions.map(String)
        : [],
      expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : null,
    }))
    .filter((item) => item.resolutionId.length > 0);
}

export function normalizeAgentUnresolvedMentionHandles(data: unknown): string[] {
  const value = data as { unresolvedMentionHandles?: unknown } | null;
  if (!Array.isArray(value?.unresolvedMentionHandles)) return [];
  return Array.from(new Set(
    value.unresolvedMentionHandles
      .filter((handle): handle is string => typeof handle === "string")
      .map((handle) => handle.trim())
      .filter(Boolean),
  ));
}

/** How many recipients the send receipt names before "and N more". */
const DELIVERED_AGENTS_SHOWN = 10;

/**
 * The agent handles a send response says it was delivered to
 * (`deliveredToAgents`), deduplicated, in the Server's order; [] when it
 * reached none, null when the Server did not count (Joint channel, older Server).
 */
export function normalizeAgentDeliveredToAgents(data: unknown): string[] | null {
  const value = data as { deliveredToAgents?: unknown } | null;
  if (!Array.isArray(value?.deliveredToAgents)) return null;
  return Array.from(new Set(
    value.deliveredToAgents
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.trim())
      .filter(Boolean),
  ));
}

/**
 * The send receipt's line naming the agents this message was delivered to,
 * by plain name (no @, so copying it mentions no one). Empty when it reached
 * none, or when the Server did not count.
 */
export function formatAgentDeliveredToAgentsLine(names: readonly string[] | null): string {
  if (!names || names.length === 0) return "";
  const shown = names.slice(0, DELIVERED_AGENTS_SHOWN).join(", ");
  const more = names.length > DELIVERED_AGENTS_SHOWN ? ` and ${names.length - DELIVERED_AGENTS_SHOWN} more` : "";
  return `Delivered to ${names.length} ${names.length === 1 ? "agent" : "agents"}: ${shown}${more}.`;
}

export function normalizeAgentMentionActionResults(data: unknown): AgentMentionActionResult[] {
  const value = data as { results?: unknown; actionResults?: unknown } | null;
  const raw = Array.isArray(value?.results)
    ? value.results
    : Array.isArray(value?.actionResults)
      ? value.actionResults
      : [];

  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      resolutionId: String(item.resolutionId ?? item.id ?? ""),
      status: String(item.status ?? "not_found") as AgentMentionActionResultStatus,
      action: typeof item.action === "string" ? normalizeAgentMentionAction(item.action) : null,
      messageId: typeof item.messageId === "string" ? item.messageId : null,
      channelId: typeof item.channelId === "string" ? item.channelId : null,
      targetType: typeof item.targetType === "string" ? item.targetType : null,
      targetId: typeof item.targetId === "string" ? item.targetId : null,
      targetHandle: typeof item.targetHandle === "string" ? item.targetHandle : null,
      message: typeof item.message === "string" ? item.message : null,
      reason: typeof item.reason === "string" ? item.reason : null,
      dedupedResolutionIds: Array.isArray(item.dedupedResolutionIds)
        ? item.dedupedResolutionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [],
    }))
    .filter((item) => item.resolutionId.length > 0);
}

/** Mirrors the route's own clamp; rows beyond it are unreachable, since the query contract is `{ limit }` alone. */
export const AGENT_MENTION_PENDING_MAX_LIMIT = 100;
const PENDING_DEFAULT_LIMIT = 50;

function pendingPageVerdict(hasMore: boolean | undefined, limit: number | undefined, shown: number, style: RaftHintStyle): string {
  const limitFlag = formatHintFlag("limit", "limit", style);
  const asked = limit === undefined ? "server default 50" : `${limitFlag} ${limit}`;
  if (hasMore === true) {
    const atCap = (limit ?? PENDING_DEFAULT_LIMIT) >= AGENT_MENTION_PENDING_MAX_LIMIT;
    return atCap
      ? `shown ${shown}, ${asked} — truncated=true · more pending actions exist AND this is the `
        + `server's maximum page (${AGENT_MENTION_PENDING_MAX_LIMIT}); this route has no offset or cursor, so the `
        + `rest cannot be reached from here — resolve what you can and re-run; rows with no `
        + `available actions are not actionable here and will remain until they expire`
      : `shown ${shown}, ${asked} — truncated=true · more pending actions exist; raise ${limitFlag} `
        + `(server caps at ${AGENT_MENTION_PENDING_MAX_LIMIT}) or resolve these first and re-run`;
  }
  if (hasMore === false) return `shown ${shown}, ${asked} — truncated=false · this is the complete list`;
  return `shown ${shown}, ${asked} — truncated=unknown · server did not report has_more, so completeness is NOT asserted`;
}

/** Undelivered-mentions partial result (send) or the pending list. */
export function formatAgentPendingMentionActions(
  actions: AgentPendingMentionAction[],
  opts: {
    source?: "send" | "pending";
    unresolvedMentionHandles?: string[];
    hasMore?: boolean;
    limit?: number;
    /** How command hints render (default `cli`). */
    hints?: RaftHintStyle;
  } = {},
): string {
  const style = opts.hints ?? "cli";
  const unresolvedMentionHandles = opts.source === "send"
    ? Array.from(new Set(opts.unresolvedMentionHandles ?? []))
    : [];
  const pageNote = opts.source === "pending" ? pendingPageVerdict(opts.hasMore, opts.limit, actions.length, style) : "";

  if (actions.length === 0 && unresolvedMentionHandles.length === 0) {
    return (opts.source === "pending"
      ? `Pending mention actions\n\nNo pending mention actions. (${pageNote})\n`
      : "");
  }

  if (opts.source === "send") {
    const lines = [
      "Undelivered mentions — partial result",
      "Message effect: status=queued. Queue acceptance is the only message proof.",
      `Do not rerun \`${formatHintName(RAFT_HINTS.messageSendName(), style)}\`; the message is already queued and a retry could duplicate it.`,
      "Each row below is bound to the literal @token from your message.",
      "For a literal name rather than a recipient, wrap the @handle in inline or fenced code.",
      "",
    ];
    for (const rawAction of actions) {
      if (rawAction.reason === AGENT_LOUNGE_EXCLUDED_MENTION_REASON) {
        // Agent Lounge: other agents never take part there, so nothing can be recovered.
        lines.push(`- ${formatAuthoredMentionToken(rawAction.targetHandle)} — status=not_queued`);
        lines.push(`  reason: ${AGENT_LOUNGE_EXCLUDED_MENTION_REASON}`);
        lines.push("  consequence: This @mention did not notify anyone.");
        lines.push("  pending action: none; only this lounge's own agent takes part here, other agents never receive its mentions");
        lines.push("  recovery: none; to reach that agent, write to it where it takes part (a DM or a channel it is in).");
        continue;
      }
      const action = toAgentSenderPendingMentionAction(rawAction);
      lines.push(`- ${action.targetHandle} — status=${action.status}`);
      lines.push(`  reason: ${action.reason}`);
      lines.push(`  consequence: ${action.consequence}`);
      lines.push(`  pending action: ${action.recoveryCommand ? action.resolutionId : "[invalid pending action id]"}`);
      if (action.messageId) lines.push(`  message: ${action.messageId}`);
      lines.push(`  expires: ${action.expiresAt ?? "unknown"}`);
      if (action.recoveryCommand) {
        lines.push(`  recovery: ${style === "cli" ? action.recoveryCommand : formatAgentMentionNotifyRecoveryCommand(action.resolutionId, style)}`);
        lines.push("  note: the handle resolved, but the target was not in this conversation at send time. This does not prove the person left the server.");
        lines.push("  note: notify exits nonzero unless the target queue accepts the delivery.");
      } else {
        lines.push(`  recovery: unavailable because the pending action id is invalid; inspect \`${formatHint(RAFT_HINTS.mentionPending(), style)}\` without resending the message.`);
      }
    }
    for (const rawHandle of unresolvedMentionHandles) {
      const warning = toAgentSenderUnresolvedMentionWarning(rawHandle);
      lines.push(`- ${warning.targetHandle} — status=${warning.status}`);
      lines.push(`  reason: ${warning.reason}`);
      lines.push(`  consequence: ${warning.consequence}`);
      lines.push("  pending action: none; no visible target resolved for this token");
      lines.push("  expires: n/a");
      lines.push("  recovery: if this was a literal name or prose, wrap it in inline/fenced code; otherwise verify the exact handle and send only a corrected follow-up mention; do not resend this message.");
    }
    return (`${lines.join("\n")}\n`);
  }

  const lines = ["Pending mention actions", `(${pageNote})`, ""];
  for (const action of actions) {
    const target = action.targetHandle
      ? `${action.targetHandle} (${action.targetType})`
      : action.targetType;
    lines.push(`- ${action.resolutionId} — ${target}`);
    if (action.messageId) lines.push(`  message: ${action.messageId}`);
    lines.push(`  reason: ${formatPendingReason(action.reason)}`);
    if (action.expiresAt) lines.push(`  expires: ${action.expiresAt}`);
    const commands = formatActionCommands(action, style);
    if (commands.length > 0) {
      lines.push("  recovery commands:");
      lines.push(...commands);
      if (actionVerbs(action).includes("notify")) {
        lines.push("  note: notify exits nonzero unless the target queue accepts the delivery.");
      }
    }
  }
  return (`${lines.join("\n")}\n`);
}

function formatMentionActionDetail(result: AgentMentionActionResult): string | null {
  const detail = result.message ?? result.reason ?? null;
  if (result.status === "dropped") {
    return detail
      ? `not delivered: ${detail}`
      : "not delivered";
  }
  return detail;
}

/** notify/add action outcome rows. */
export function formatAgentMentionActionResults(action: AgentMentionActionKind, results: AgentMentionActionResult[]): string {
  const lines = [`Mention ${action} results`, ""];
  if (results.length === 0) {
    lines.push("No result rows returned.");
    return (`${lines.join("\n")}\n`);
  }
  for (const result of results) {
    const target = result.targetHandle ? ` ${result.targetHandle}` : "";
    const detail = formatMentionActionDetail(result);
    const suffix = detail ? ` — ${detail}` : "";
    lines.push(`- ${result.resolutionId}${target}: ${result.status}${suffix}`);
    if (result.dedupedResolutionIds && result.dedupedResolutionIds.length > 1) {
      lines.push(`  deduped: ${result.dedupedResolutionIds.join(", ")}`);
    }
  }
  if (
    action === "notify"
    && results.some((result) => result.status === "queued" && result.reason !== "already_queued")
  ) {
    lines.push("", `Recipient guidance: ${formatAgentReplyAffordance({ non_member_mention: true })}`);
  }
  return (`${lines.join("\n")}\n`);
}

export interface AgentSenderMentionDeliveryRow {
  targetHandle: string;
  outcome: SenderMentionDeliveryOutcome;
  reasonCategory?: SenderMentionDeliveryReasonCategory;
}

function describeDelivery(row: AgentSenderMentionDeliveryRow): string {
  switch (row.outcome) {
    case "delivered":
      return "delivered";
    case "pending":
      return "still in flight — do not conclude yet";
    case "unknown":
      return "UNKNOWN — our instrument could not see this one; re-check, do not conclude";
    case "lost":
      switch (row.reasonCategory) {
        case "quota":
          return "LOST — target is rate/quota limited; it will not arrive, re-route or retry later";
        case "runtime_error":
          return "LOST — target's runtime rejected delivery; re-route";
        case "not_launched":
          return "LOST — target was not running; re-route or start it";
        case "unclassified":
          return "LOST — cause is outside the seat-availability set; re-route";
        default:
          return "LOST — server sent no category for this row (malformed); treat the cause as unknown";
      }
  }
}

/** Per-target mention delivery outcome for a message the bound agent sent. */
export function formatAgentSenderMentionDeliveries(messageId: string, deliveries: AgentSenderMentionDeliveryRow[]): string {
  if (deliveries.length === 0) {
    return `Message ${messageId}\n\nNo mention deliveries recorded for this message.\n`;
  }
  const lines = [`Message ${messageId} — mention delivery per target`, ""];
  for (const row of deliveries) {
    lines.push(`  ${row.targetHandle || "(unknown target)"}: ${describeDelivery(row)}`);
  }
  return `${lines.join("\n")}\n`;
}
