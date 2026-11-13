/**
 * #688 daemon-fallback Claude startup-crash diagnostics. Diagnostic-domain
 * extraction belongs here: scrub+cap and carrier construction stay separate
 * from orchestration, while APM keeps only call sites.
 */
import {
  buildBoundedVisibleCrashDetail,
  buildRuntimeErrorActivityDiagnostic,
  MAX_VISIBLE_CRASH_DETAIL_CHARS,
} from "./runtimeErrorDiagnostics";
import type { RuntimeErrorActivityDiagnostic } from "@botiverse/raft-shared";

export { buildBoundedVisibleCrashDetail, MAX_VISIBLE_CRASH_DETAIL_CHARS };

const CLAUDE_ROOT_REFUSAL = "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";

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
  exitCode?: number | null,
): RuntimeErrorActivityDiagnostic | undefined {
  if (ap.driver.id !== "claude") return undefined;
  if (!closeBeforeTurnBoundary) return undefined;
  const rootRefusal = isClaudeRootRefusal(ap, closeBeforeTurnBoundary, exitCode);
  const message = rootRefusal ? CLAUDE_ROOT_REFUSAL : ap.lastRuntimeError || (Array.isArray(ap.recentStderr) ? ap.recentStderr.at(-1) : undefined);
  if (!message || message.length === 0) return undefined;
  const diagnostic = buildRuntimeErrorActivityDiagnostic(message, {
    reasonProvenance: "daemon_fallback",
    nativeReasonPresent: false,
  });
  return rootRefusal
    ? { ...diagnostic, errorClass: "RootPrivilegesError", errorReason: "root_privileges" }
    : diagnostic;
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

/** Current confirmed CLI refusal: other exit codes deliberately keep generic diagnostics. */
function isClaudeRootRefusal(ap: CrashProcessSlice, closeBeforeTurnBoundary: boolean, exitCode?: number | null): boolean {
  return exitCode === 1 && ap.driver.id === "claude" && closeBeforeTurnBoundary
    && [ap.lastRuntimeError, ...(ap.recentStderr ?? [])].some((line) => line?.trim() === CLAUDE_ROOT_REFUSAL);
}

/** Fixed copy and a stable presentation code; never project arbitrary stderr. */
export function buildClaudeStartupCrashActivity(ap: CrashProcessSlice, closeBeforeTurnBoundary: boolean, summary: string, exitCode: number | null): { detail: string; detailKind: "runtime_crashed" | "claude_root_privileges" } {
  if (isClaudeRootRefusal(ap, closeBeforeTurnBoundary, exitCode)) {
    return { detailKind: "claude_root_privileges", detail: "Claude Code cannot start with root or sudo privileges while permission checks are disabled. Run Raft Computer as a non-root user, then start the agent again." };
  }
  return { detailKind: "runtime_crashed", detail: `Crashed (${summary})` };
}
