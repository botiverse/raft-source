import { isAgentActivityDetailKind, type ToolStuckActivityDiagnostic } from "@botiverse/raft-shared";

/**
 * task #25 — server-side normalizer for the daemon's stuck-tool carrier. The
 * server passes it to the socket payload and the activity read-back and uses
 * it for the sender's DM delivery warning (no DM or notification is sent about
 * it), so a malformed or
 * hostile frame must not smuggle arbitrary payloads through: a bounded tool
 * name, a known detail kind, finite times and small counts only.
 */
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_COUNT = 1_000_000;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeToolStuckActivityDiagnostic(
  value: ToolStuckActivityDiagnostic | Record<string, unknown> | null | undefined,
): ToolStuckActivityDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const toolName = candidate.toolName;
  if (typeof toolName !== "string" || toolName.length === 0 || toolName.length > MAX_TOOL_NAME_LENGTH) return null;
  if (!isAgentActivityDetailKind(candidate.toolDetailKind)) return null;
  const startedAtMs = finiteNonNegative(candidate.startedAtMs);
  const quietSinceMs = finiteNonNegative(candidate.quietSinceMs);
  const thresholdMs = finiteNonNegative(candidate.thresholdMs);
  const queuedMessages = finiteNonNegative(candidate.queuedMessages);
  if (startedAtMs === null || quietSinceMs === null || thresholdMs === null || queuedMessages === null) return null;
  if (quietSinceMs < startedAtMs || !Number.isInteger(queuedMessages) || queuedMessages > MAX_COUNT) return null;
  return {
    toolName,
    toolDetailKind: candidate.toolDetailKind,
    startedAtMs: Math.round(startedAtMs),
    quietSinceMs: Math.round(quietSinceMs),
    thresholdMs: Math.round(thresholdMs),
    queuedMessages,
  };
}
