/**
 * Which workspace files a migration to Raft hosted brings over (task #16).
 *
 * Pure and deterministic: the same bundle always gives the same file set, so a
 * rebuilt file set after a lost lease is byte-identical and the provider's
 * one import can be retried with the same body. Two steps:
 *
 * 1. `classifyHostedImportEntry` drops entries the provider can never take
 *    (symlinks, `.git`, Raft state, paths outside its key rule, reserved names,
 *    files over the per-file cap) from the entry metadata alone.
 * 2. `selectHostedImportFiles` fills the provider's file and byte budget by
 *    priority: `MEMORY.md`, then `notes/**`, then the rest by path.
 *
 * Text checks (UTF-8, no NUL) need the bytes and run while reading the chosen
 * files; the provider's own `import-check` runs last.
 */
import type { AgentMigrationHostedImportLimits, AgentMigrationHostedImportSummary, AgentMigrationHostedSkipReason } from "@botiverse/raft-shared";

/** The provider's state key rule: ≤128 chars, ASCII letters/digits/`._/-`, starting with a letter or digit. */
const HOSTED_IMPORT_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
/** Names the provider keeps for its own state files. */
const HOSTED_RESERVED_PATHS = new Set(["memory", "todo", "journal"]);
/** The workspace ignore files a Computer reads; they mean nothing to the provider. */
const HOSTED_RAFT_IGNORE_FILES = new Set([".raftmigrateignore", ".raftbackupignore", ".raftbackupignore.user"]);
/** How many skipped paths a summary names per reason. */
export const HOSTED_IMPORT_SUMMARY_PATHS_PER_REASON = 20;

export type HostedImportEntryMeta =
  | { type: "file"; path: string; sizeBytes: number }
  | { type: "symlink"; path: string };

export type HostedImportCandidate = { path: string; sizeBytes: number };

export type HostedImportSkip = { path: string; sizeBytes: number; reason: AgentMigrationHostedSkipReason };

/** The reason an entry can never be imported, or null when it is a candidate. */
export function classifyHostedImportEntry(
  entry: HostedImportEntryMeta,
  limits: Pick<AgentMigrationHostedImportLimits, "maxFileBytes">,
): AgentMigrationHostedSkipReason | null {
  if (entry.type === "symlink") return "symlink";
  const segments = entry.path.split("/");
  if (segments.includes(".git")) return "git";
  if (
    segments[0] === ".raft"
    || segments[0] === ".raft-migration"
    || HOSTED_RAFT_IGNORE_FILES.has(entry.path)
  ) {
    return "raft_state";
  }
  if (!HOSTED_IMPORT_PATH.test(entry.path) || segments.some((segment) => segment === "." || segment === "..")) {
    return "path_rule";
  }
  if (HOSTED_RESERVED_PATHS.has(entry.path) || entry.path.startsWith("kept:")) return "reserved";
  if (entry.sizeBytes > limits.maxFileBytes) return "file_too_large";
  return null;
}

function priority(path: string): number {
  if (path === "MEMORY.md") return 0;
  if (path.startsWith("notes/")) return 1;
  return 2;
}

/** Comparison by code unit, not locale: the order must be the same on every server. */
function compareCandidates(a: HostedImportCandidate, b: HostedImportCandidate): number {
  const byPriority = priority(a.path) - priority(b.path);
  if (byPriority !== 0) return byPriority;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Fill the budget in priority order. A file that does not fit is skipped and
 * smaller later files may still fit (first fit, in a fixed order).
 */
export function selectHostedImportFiles(
  candidates: readonly HostedImportCandidate[],
  limits: Pick<AgentMigrationHostedImportLimits, "maxFiles" | "maxTotalBytes">,
): { selected: HostedImportCandidate[]; overBudget: HostedImportCandidate[] } {
  const ordered = [...candidates].sort(compareCandidates);
  const selected: HostedImportCandidate[] = [];
  const overBudget: HostedImportCandidate[] = [];
  let bytes = 0;
  for (const candidate of ordered) {
    if (selected.length < limits.maxFiles && bytes + candidate.sizeBytes <= limits.maxTotalBytes) {
      selected.push(candidate);
      bytes += candidate.sizeBytes;
    } else {
      overBudget.push(candidate);
    }
  }
  return { selected, overBudget };
}

/** UTF-8 without NUL: what the provider accepts as text. */
export function isHostedImportText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Group skips by reason, largest first within each, with a bounded path list. */
export function summarizeHostedImport(input: {
  imported: readonly HostedImportCandidate[];
  skipped: readonly HostedImportSkip[];
}): AgentMigrationHostedImportSummary {
  const byReason = new Map<AgentMigrationHostedSkipReason, HostedImportSkip[]>();
  for (const skip of input.skipped) {
    const list = byReason.get(skip.reason) ?? [];
    list.push(skip);
    byReason.set(skip.reason, list);
  }
  const skipped = [...byReason.entries()]
    .map(([reason, list]) => {
      const largest = [...list]
        .sort((a, b) => b.sizeBytes - a.sizeBytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .slice(0, HOSTED_IMPORT_SUMMARY_PATHS_PER_REASON)
        .map((skip) => skip.path);
      return {
        reason,
        count: list.length,
        bytes: list.reduce((n, skip) => n + skip.sizeBytes, 0),
        largestPaths: largest,
      };
    })
    .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  return {
    importedFileCount: input.imported.length,
    importedBytes: input.imported.reduce((n, file) => n + file.sizeBytes, 0),
    skipped,
  };
}
