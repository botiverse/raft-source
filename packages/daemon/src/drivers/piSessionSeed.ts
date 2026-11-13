import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  getLatestCompactionEntry,
  VIRTUAL_MODEL_STATE_ENTRY,
  type SessionEntry,
  type SessionHeader,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

// The seed of a rotated pi session (pi#10642: a SessionManager keeps every
// entry of its file in memory, compacted-away history included). Rotation
// writes a new file that rebuilds the same model context and branch state from
// the latest compaction, under the SAME session id: pi sends the id as the
// provider prompt-cache key / affinity, so keeping it keeps the cache route.
//
// Pure: reads the live SessionManager, returns the file content and names. The
// caller writes the seed, renames the old file and resumes.

/** The parts of pi's SessionManager the seed reads. */
export type PiSessionSeedSource = Pick<SessionManager, "getHeader" | "getBranch" | "getEntryCount" | "getSessionFile">;

/** Attrs of the `pi.session.rotated` trace event. */
export interface PiSessionRotationStats {
  entries_before: number;
  bytes_before: number;
  entries_after: number;
  bytes_after: number;
}

export interface PiSessionRotationPaths {
  /** `<newTimestamp>_<id>.jsonl` beside the old file; pi's own naming, so pi finds it by id. */
  seedFile: string;
  /** The old file renamed `<oldName>.jsonl.rotated`: no longer a `.jsonl`, so no lookup by id or listing sees it. */
  rotatedOldFile: string;
}

export type PiSessionSeedRefusal =
  | { rotatable: false; reason: "no_session_file" }
  | { rotatable: false; reason: "unsupported_session_version"; version: number | undefined }
  | { rotatable: false; reason: "unknown_entry_type"; entryType: string }
  // Custom state before the segment whose semantics this module does not know:
  // an extension may fold every entry of its type (pi's codemode store does).
  | { rotatable: false; reason: "unknown_custom_type"; customType: string }
  | { rotatable: false; reason: "no_compaction" }
  | { rotatable: false; reason: "first_kept_entry_not_on_branch" }
  // pi reads the session's model from the latest physical response on the
  // branch (getBranchSelection, buildSessionContext, the cache warmer). Without
  // one in the kept segment, the answer lies in history the seed drops.
  | { rotatable: false; reason: "no_response_in_kept_segment" }
  // The seed's name must sort after the old file's: crash recovery resumes the
  // newest name, and an equal name would be the same path.
  | { rotatable: false; reason: "seed_name_not_newer" };

export interface PiSessionSeed extends PiSessionRotationPaths {
  rotatable: true;
  header: SessionHeader;
  entries: SessionEntry[];
  /** The seed file's JSONL, written the way pi writes it: one `JSON.stringify` line per entry. */
  content: string;
  stats: PiSessionRotationStats;
}

/** The session file version this module writes and reads; a pi version bump fails typecheck here. */
const SEED_VERSION: typeof CURRENT_SESSION_VERSION = 3;

/** pi's `VIRTUAL_MODEL_API` (not exported): the `api` of a response whose virtual model failed to route. */
const PI_VIRTUAL_MODEL_API = "pi-virtual";

type PreSegmentDisposition =
  | { kind: "state"; key: string }
  | { kind: "history" }
  | { kind: "unknown_custom_type"; customType: string }
  | { kind: "unknown_entry_type" };

/**
 * What an entry before the kept segment leaves in the seed: the state it
 * records (the seed keeps the last entry per key), or nothing when it is
 * history the compaction summary covers or a cumulative record. Exhaustive
 * over pi's entry union: a type pi adds fails typecheck here.
 */
function preSegmentDisposition(entry: SessionEntry): PreSegmentDisposition {
  switch (entry.type) {
    case "model_change":
    case "thinking_level_change":
    case "session_info":
      return { kind: "state", key: entry.type };
    case "custom":
      // Only pi's router state has known semantics: getVirtualModelState reads
      // the last entry per virtual model (provider and modelId).
      return entry.customType === VIRTUAL_MODEL_STATE_ENTRY
        ? { kind: "state", key: JSON.stringify([entry.customType, field(entry.data, "provider"), field(entry.data, "modelId")]) }
        : { kind: "unknown_custom_type", customType: entry.customType };
    // Model context: the compaction summary stands in for it.
    case "message":
    case "custom_message":
    case "branch_summary":
    case "compaction":
    // Edits and labels act on an entry that existed before them, so one from
    // before the segment acts on an entry the seed drops.
    case "context_edit":
    case "label":
    // Cumulative usage records (session stats); rotation restarts them.
    case "usage":
      return { kind: "history" };
    default: {
      const unknownEntry: never = entry;
      void unknownEntry;
      return { kind: "unknown_entry_type" };
    }
  }
}

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined;
}

export function piSessionRotationPaths(oldFile: string, sessionId: string, now: Date): PiSessionRotationPaths {
  const fileTimestamp = now.toISOString().replace(/[:.]/g, "-");
  return {
    seedFile: path.join(path.dirname(oldFile), `${fileTimestamp}_${sessionId}.jsonl`),
    rotatedOldFile: `${oldFile}.rotated`,
  };
}

/**
 * The seed of `source`'s current branch (root to leaf): the latest
 * compaction's kept segment (`firstKeptEntryId` to the leaf) verbatim, with
 * original ids so `firstKeptEntryId` and `context_edit` targets still resolve,
 * after the last entry of each state kind from before the segment, in branch
 * order. Parent ids are re-chained in that order. `oldFileBytes` is the old
 * file's size, for the stats.
 */
export function buildPiSessionSeed(
  source: PiSessionSeedSource,
  { now, oldFileBytes }: { now: Date; oldFileBytes: number },
): PiSessionSeed | PiSessionSeedRefusal {
  const header = source.getHeader();
  const oldFile = source.getSessionFile();
  if (!header || !oldFile) return { rotatable: false, reason: "no_session_file" };
  if (header.version !== SEED_VERSION) {
    return { rotatable: false, reason: "unsupported_session_version", version: header.version };
  }
  const paths = piSessionRotationPaths(oldFile, header.id, now);
  if (path.basename(paths.seedFile) <= path.basename(oldFile)) return { rotatable: false, reason: "seed_name_not_newer" };

  const branch = source.getBranch();
  const unknown = branch.find((entry) => preSegmentDisposition(entry).kind === "unknown_entry_type");
  if (unknown) return { rotatable: false, reason: "unknown_entry_type", entryType: unknown.type };

  const compaction = getLatestCompactionEntry(branch);
  if (!compaction) return { rotatable: false, reason: "no_compaction" };
  const compactionIndex = branch.lastIndexOf(compaction);
  // pi's buildContextEntries looks for the kept entry up to the compaction.
  const segmentStart = branch.findIndex((entry, index) => index <= compactionIndex && entry.id === compaction.firstKeptEntryId);
  if (segmentStart < 0) return { rotatable: false, reason: "first_kept_entry_not_on_branch" };
  const segment = branch.slice(segmentStart);
  const hasResponse = segment.some((entry) =>
    entry.type === "message" && entry.message.role === "assistant" && entry.message.api !== PI_VIRTUAL_MODEL_API);
  if (!hasResponse) return { rotatable: false, reason: "no_response_in_kept_segment" };

  const lastIndexByKey = new Map<string, number>();
  for (let index = 0; index < segmentStart; index++) {
    const disposition = preSegmentDisposition(branch[index]!);
    if (disposition.kind === "unknown_custom_type") {
      return { rotatable: false, reason: "unknown_custom_type", customType: disposition.customType };
    }
    if (disposition.kind === "state") lastIndexByKey.set(disposition.key, index);
  }
  const state = [...lastIndexByKey.values()].sort((a, b) => a - b).map((index) => branch[index]!);

  let parentId: string | null = null;
  const entries = [...state, ...segment].map((entry): SessionEntry => {
    const chained = { ...entry, parentId };
    parentId = entry.id;
    return chained;
  });

  const seedHeader: SessionHeader = {
    type: "session",
    version: SEED_VERSION,
    id: header.id,
    timestamp: now.toISOString(),
    cwd: header.cwd,
    parentSession: paths.rotatedOldFile,
  };
  const content = [seedHeader, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join("");
  return {
    rotatable: true,
    ...paths,
    header: seedHeader,
    entries,
    content,
    stats: {
      entries_before: source.getEntryCount(),
      bytes_before: oldFileBytes,
      entries_after: entries.length,
      bytes_after: Buffer.byteLength(content),
    },
  };
}
