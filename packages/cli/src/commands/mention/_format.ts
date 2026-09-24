import { axSurface, type CliReplyText } from "../../core/renderer.js";
import { formatAgentReplyAffordance } from "@botiverse/raft-shared";

export type MentionActionKind = "notify" | "add";

export interface PendingMentionAction {
  resolutionId: string;
  messageId: string;
  targetType: string;
  targetHandle: string;
  reason: string;
  availableActions: string[];
  expiresAt?: string | null;
}

export interface SenderPendingMentionAction {
  resolutionId: string;
  messageId: string;
  targetHandle: string;
  status: "not_queued";
  reason: "not_in_conversation";
  consequence: "This @mention did not notify anyone.";
  expiresAt: string | null;
  recoveryCommand: string | null;
}

export interface SenderUnresolvedMentionWarning {
  targetHandle: string;
  status: "not_queued";
  reason: "unknown_or_not_visible";
  consequence: "This @mention did not notify anyone.";
  expiresAt: null;
  recoveryCommand: null;
}

export type MentionActionResultStatus =
  | "queued"
  | "delivered"
  | "dropped"
  | "stale"
  | "expired"
  | "no_permission"
  | "not_found"
  | "ambiguous";

export interface MentionActionResult {
  resolutionId: string;
  status: MentionActionResultStatus;
  action?: MentionActionKind | null;
  messageId?: string | null;
  channelId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetHandle?: string | null;
  message?: string | null;
  reason?: string | null;
  dedupedResolutionIds?: string[];
}

function normalizeAction(action: string): MentionActionKind | null {
  if (action === "notify" || action === "notify_only") return "notify";
  if (action === "add" || action === "invite") return "add";
  return null;
}

function formatActionCommands(action: PendingMentionAction): string[] {
  const verbs = action.availableActions
    .map(normalizeAction)
    .filter((verb): verb is MentionActionKind => verb !== null);
  return Array.from(new Set(verbs)).map((verb) => `  ${verb}: raft mention ${verb} ${action.resolutionId}`);
}

function formatAuthoredMentionToken(targetHandle: string): string {
  return targetHandle.startsWith("@") ? targetHandle : `@${targetHandle}`;
}

const PENDING_MENTION_ACTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const formatMentionNotifyRecoveryCommand = axSurface(
  "Per-token mention recovery command line.",
  (resolutionId: string): string | null => {
  // Pending mention action ids are UUIDs. Fail closed instead of turning an
  // unexpected server value into a multiline or shell-interpreted command.
  return PENDING_MENTION_ACTION_ID_RE.test(resolutionId)
    ? `raft mention notify ${resolutionId}`
    : null;
},
  {
    examples: [{ args: ["00000000-1111-2222-3333-444444444444"] }],
  },
);

export function toSenderPendingMentionAction(action: PendingMentionAction): SenderPendingMentionAction {
  return {
    resolutionId: action.resolutionId,
    messageId: action.messageId,
    targetHandle: formatAuthoredMentionToken(action.targetHandle),
    status: "not_queued",
    reason: "not_in_conversation",
    consequence: "This @mention did not notify anyone.",
    expiresAt: action.expiresAt ?? null,
    recoveryCommand: formatMentionNotifyRecoveryCommand(action.resolutionId),
  };
}

export function toSenderUnresolvedMentionWarning(targetHandle: string): SenderUnresolvedMentionWarning {
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

export function normalizePendingMentionActions(data: unknown): PendingMentionAction[] {
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

export function normalizeUnresolvedMentionHandles(data: unknown): string[] {
  const value = data as { unresolvedMentionHandles?: unknown } | null;
  if (!Array.isArray(value?.unresolvedMentionHandles)) return [];
  return Array.from(new Set(
    value.unresolvedMentionHandles
      .filter((handle): handle is string => typeof handle === "string")
      .map((handle) => handle.trim())
      .filter(Boolean),
  ));
}

export function normalizeMentionActionResults(data: unknown): MentionActionResult[] {
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
      status: String(item.status ?? "not_found") as MentionActionResultStatus,
      action: typeof item.action === "string" ? normalizeAction(item.action) : null,
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

export const formatPendingMentionActions = axSurface(
  "Undelivered-mentions partial result / pending list.",
  (
  actions: PendingMentionAction[],
  opts: { source?: "send" | "pending"; unresolvedMentionHandles?: string[] } = {},
): string => {
  const unresolvedMentionHandles = opts.source === "send"
    ? Array.from(new Set(opts.unresolvedMentionHandles ?? []))
    : [];
  if (actions.length === 0 && unresolvedMentionHandles.length === 0) {
    return (opts.source === "pending"
      ? "Pending mention actions\n\nNo pending mention actions.\n"
      : "");
  }

  if (opts.source === "send") {
    const lines = [
      "Undelivered mentions — partial result",
      "Message effect: status=queued. Queue acceptance is the only message proof.",
      "Do not rerun `raft message send`; the message is already queued and a retry could duplicate it.",
      "Each row below is bound to the literal @token from your message.",
      "For a literal name rather than a recipient, wrap the @handle in inline or fenced code.",
      "",
    ];
    for (const rawAction of actions) {
      const action = toSenderPendingMentionAction(rawAction);
      lines.push(`- ${action.targetHandle} — status=${action.status}`);
      lines.push(`  reason: ${action.reason}`);
      lines.push(`  consequence: ${action.consequence}`);
      lines.push(`  pending action: ${action.recoveryCommand ? action.resolutionId : "[invalid pending action id]"}`);
      if (action.messageId) lines.push(`  message: ${action.messageId}`);
      lines.push(`  expires: ${action.expiresAt ?? "unknown"}`);
      if (action.recoveryCommand) {
        lines.push(`  recovery: ${action.recoveryCommand}`);
        lines.push("  note: the handle resolved, but the target was not in this conversation at send time. This does not prove the person left the server.");
        lines.push("  note: notify exits nonzero unless the target queue accepts the delivery.");
      } else {
        lines.push("  recovery: unavailable because the pending action id is invalid; inspect `raft mention pending` without resending the message.");
      }
    }
    for (const rawHandle of unresolvedMentionHandles) {
      const warning = toSenderUnresolvedMentionWarning(rawHandle);
      lines.push(`- ${warning.targetHandle} — status=${warning.status}`);
      lines.push(`  reason: ${warning.reason}`);
      lines.push(`  consequence: ${warning.consequence}`);
      lines.push("  pending action: none; no visible target resolved for this token");
      lines.push("  expires: n/a");
      lines.push("  recovery: if this was a literal name or prose, wrap it in inline/fenced code; otherwise verify the exact handle and send only a corrected follow-up mention; do not resend this message.");
    }
    return (`${lines.join("\n")}\n`);
  }

  const lines = ["Pending mention actions", ""];
  for (const action of actions) {
    const target = action.targetHandle
      ? `${action.targetHandle} (${action.targetType})`
      : action.targetType;
    lines.push(`- ${action.resolutionId} — ${target}`);
    if (action.messageId) lines.push(`  message: ${action.messageId}`);
    lines.push(`  reason: ${formatPendingReason(action.reason)}`);
    if (action.expiresAt) lines.push(`  expires: ${action.expiresAt}`);
    const commands = formatActionCommands(action);
    if (commands.length > 0) {
      lines.push("  recovery commands:");
      lines.push(...commands);
      if (commands.some((command) => command.includes(" mention notify "))) {
        lines.push("  note: notify exits nonzero unless the target queue accepts the delivery.");
      }
    }
  }
  return (`${lines.join("\n")}\n`);
},
  {
    examples: [{ title: "send partial result", args: [[{ resolutionId: "00000000-1111-2222-3333-444444444444", messageId: "55555555-6666-7777-8888-999999999999", targetType: "agent", targetHandle: "@bob", reason: "not_in_conversation", availableActions: ["notify", "add"], expiresAt: "2026-09-01T08:00:00.000Z" }], { source: "send", unresolvedMentionHandles: ["@type-o-handle"] }] }],
  },
);

function formatMentionActionDetail(result: MentionActionResult): string | null {
  const detail = result.message ?? result.reason ?? null;
  if (result.status === "dropped") {
    return detail
      ? `not delivered: ${detail}`
      : "not delivered";
  }
  return detail;
}

export const formatMentionActionResults = axSurface(
  "notify/add action outcome rows.",
  (action: MentionActionKind, results: MentionActionResult[]): string => {
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
},
  {
    examples: [{ args: ["notify", [{ resolutionId: "00000000-1111-2222-3333-444444444444", status: "queued", action: "notify", targetHandle: "@bob" }]] }],
  },
);
