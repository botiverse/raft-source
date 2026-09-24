/**
 * #688 daemon-fallback Claude startup-crash diagnostics. Diagnostic-domain
 * extraction belongs here: scrub+cap and carrier construction stay separate
 * from orchestration, while APM keeps only call sites.
 */
import {
  buildBoundedVisibleCrashDetail,
  buildRuntimeErrorActivityDiagnostic,
  MAX_VISIBLE_CRASH_DETAIL_CHARS,
} from "./runtimeErrorDiagnostics.js";
import type { RuntimeErrorActivityDiagnostic } from "@botiverse/raft-shared";

export { buildBoundedVisibleCrashDetail, MAX_VISIBLE_CRASH_DETAIL_CHARS };

/** Structural slice of the daemon AgentProcess the carrier builder needs (kept
 * local so this diagnostic module does not depend on agentProcessManager). */
type CrashProcessSlice = {
  driver: { id: string };
  lastRuntimeError: string | null;
  recentStderr: string[] | readonly string[] | null | undefined;
};

/**
 * #688 gap (a): the Claude close-before-turn-boundary crash path previously
 * emitted a plain runtime_crashed/runtime_error with no typed carrier. Build a
 * daemon-fallback typed carrier ONLY when (1) drive is claude, (2) the process
 * closed before a turn boundary, and (3) there is daemon-scrubbed stderr text.
 * lastRuntimeError first, else recentStderr last (matches the classifier's
 * candidate source).
 */
export function buildClaudeStartupCrashRuntimeError(
  ap: CrashProcessSlice,
  closeBeforeTurnBoundary: boolean,
): RuntimeErrorActivityDiagnostic | undefined {
  if (ap.driver.id !== "claude") return undefined;
  if (!closeBeforeTurnBoundary) return undefined;
  const message = ap.lastRuntimeError || (Array.isArray(ap.recentStderr) ? ap.recentStderr.at(-1) : undefined);
  if (!message || message.length === 0) return undefined;
  return buildRuntimeErrorActivityDiagnostic(message, {
    reasonProvenance: "daemon_fallback",
    nativeReasonPresent: false,
  });
}

/** #688 exported projection shape (structurally compatible with the daemon
 * TrajectoryEntry for text entries — no daemon type import kept here). */
export type TextProjectionEntry = { kind: "text"; text: string };
/** Wide structural slice of a trajectory entry the projection maps (text only). */
type ProjectableEntry = { kind?: unknown; text?: unknown };

/**
 * #688 bounded visible terminal-failure projection: redact + cap the user-visible
 * runtime_error detail and its text entries (decision-package ~512B bound). Kept in
 * the diagnostic domain so the APM module holds only a call site (Stone per-line
 * attribution: 4083-4087 is migratable helper logic, not branch wiring).
 */
export function buildBoundedVisibleCrashProjection(
  rawDetail: string,
  rawEntries: readonly ProjectableEntry[] | undefined,
): { detail: string; entries: TextProjectionEntry[] } {
  const detail = buildBoundedVisibleCrashDetail(rawDetail);
  const entries = rawEntries
    ?.map((e) => e.kind === "text" ? { ...e, text: buildBoundedVisibleCrashDetail(String(e.text)) } : e) as TextProjectionEntry[]
    ?? [{ kind: "text", text: `Error: ${detail}` }];
  return { detail, entries };
}
