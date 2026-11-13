import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isPortableAbsolutePath, normalizeAgentMigrationSymlinkTarget } from "@botiverse/raft-shared/src/agentMigrationBundleReader";
import {
  agentMigrationTransferSummarySchema,
  MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
  type AgentMigrationTransferSummary,
} from "@botiverse/raft-shared";

export type AgentMigrationBundleEntrySource = "workspace" | "runtime";
export type AgentMigrationBundleEntryKind = "file" | "symlink";

/** Entries counted past the entry limit, for the limit error. */
export interface AgentMigrationExportEntryOverflow {
  entryCount: number;
  /** Keyed by top-level workspace path, `dir/` for directories. */
  countByTopLevelPath: Map<string, number>;
}

/**
 * Cumulative source-build progress. `files`/`bytes` only grow within a phase;
 * the phases run in order scanning -> packing.
 */
export interface AgentMigrationExportProgress {
  phase: "scanning" | "packing";
  files: number;
  bytes: number;
}

export interface AgentMigrationBundleFileEntry {
  kind: AgentMigrationBundleEntryKind;
  source: AgentMigrationBundleEntrySource;
  bundlePath: string;
  workspaceRelativePath?: string;
  sizeBytes?: number;
  sha256?: string;
  mode?: number;
  mtimeMs?: number;
  linkTarget?: string;
}

export interface AgentMigrationExcludedRegenerableEntry {
  path: string;
  reason: "regenerable_default";
  regenerableHint: string;
}

/**
 * Which ignore file listed a path. When several did, the first in
 * AGENT_MIGRATION_IGNORE_SOURCE_ORDER wins, so each path has one source.
 */
export type AgentMigrationIgnoreSource = "userFile" | "agentFile" | "legacyFile";

/** A workspace path listed in an ignore file and therefore not moved. */
export interface AgentMigrationExcludedIgnoredEntry {
  path: string;
  reason: "raftmigrateignore";
  /** The ignore file that listed it. Absent counts as `legacyFile`. */
  source?: AgentMigrationIgnoreSource;
  /** Matched through a `**\/<name>` line of that file rather than an exact path. */
  wildcard?: boolean;
  fileCount: number;
  sizeBytes: number;
}

export interface AgentMigrationUnreachableEntry {
  path: string;
  reason: "missing" | "read_error" | "unsupported_file_type" | "unsafe_symlink_target";
  detail?: string;
}

// Matched against every path segment, so only names that are unambiguously
// tool-generated belong here (e.g. not `build`, `out`, `coverage`, `venv`).
const THIRD_PARTY_REGENERABLE_NAMES = new Set([
  ".nox",
  ".pnpm-store",
  ".terraform",
  ".tox",
  ".venv",
  "bower_components",
  "node_modules",
  "vendor",
]);
const CACHE_REGENERABLE_NAMES = new Set([
  ".cache",
  ".dart_tool",
  ".gradle",
  ".mypy_cache",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".turbo",
  "__pycache__",
]);
const BUILD_REGENERABLE_NAMES = new Set([".next", ".nuxt", ".svelte-kit", "dist", "target"]);

const REGENERABLE_DIRECTORY_NAMES = [
  ...THIRD_PARTY_REGENERABLE_NAMES,
  ...CACHE_REGENERABLE_NAMES,
  ...BUILD_REGENERABLE_NAMES,
].sort();
const REGENERABLE_DIRECTORY_NAME_SET = new Set(REGENERABLE_DIRECTORY_NAMES);

const EXCLUDED_IGNORED_SUMMARY_LARGEST = 5;

/** Whether a moved workspace path is the agent's `notes/` directory or under it. */
export function isNotesPath(workspaceRelativePath: string): boolean {
  return workspaceRelativePath === "notes" || workspaceRelativePath.startsWith("notes/");
}

/** The transfer summary from running totals, for a bundle that never lists its files in memory. */
export function summarizeAgentMigrationTransfer(input: {
  includedFileCount: number;
  includedBytes: number;
  memoryMdPresent: boolean;
  notesPresent: boolean;
  excludedRegenerable: AgentMigrationExcludedRegenerableEntry[];
  excludedIgnored?: AgentMigrationExcludedIgnoredEntry[];
  /**
   * The Server advertised SERVER_CAPABILITY_MIGRATION_BACKUP_IGNORE_SOURCES_V1:
   * add `excludedIgnoredBySource`. An older Server's strict schema rejects it.
   */
  reportIgnoredBySource?: boolean;
}): AgentMigrationTransferSummary {
  const excludedRegenerableByCategory = {
    thirdPartyDependencies: 0,
    caches: 0,
    buildArtifacts: 0,
    otherRegenerable: 0,
  };
  for (const entry of input.excludedRegenerable) {
    const names = entry.path.replaceAll("\\", "/").split("/").filter(Boolean);
    if (names.some((name) => THIRD_PARTY_REGENERABLE_NAMES.has(name))) {
      excludedRegenerableByCategory.thirdPartyDependencies += 1;
    } else if (names.some((name) => CACHE_REGENERABLE_NAMES.has(name))) {
      excludedRegenerableByCategory.caches += 1;
    } else if (names.some((name) => BUILD_REGENERABLE_NAMES.has(name))) {
      excludedRegenerableByCategory.buildArtifacts += 1;
    } else {
      excludedRegenerableByCategory.otherRegenerable += 1;
    }
  }
  return agentMigrationTransferSummarySchema.parse({
    includedFileCount: input.includedFileCount,
    includedBytes: input.includedBytes,
    excludedRegenerableCount: input.excludedRegenerable.length,
    excludedRegenerableByCategory,
    keyWorkspaceEntries: {
      memoryMdPresent: input.memoryMdPresent,
      notesPresent: input.notesPresent,
    },
    // Only present when something was ignored, so a summary without ignores
    // stays readable by servers that predate the field.
    ...(input.excludedIgnored && input.excludedIgnored.length > 0
      ? summarizeExcludedIgnored(input.excludedIgnored, input.reportIgnoredBySource === true)
      : {}),
  });
}

type IgnoredTotals = NonNullable<AgentMigrationTransferSummary["excludedIgnoredBySource"]>["wildcard"];
const IGNORED_TOTAL_KEYS = ["count", "fileCount", "bytes"] as const;

function summarizeExcludedIgnored(
  entries: AgentMigrationExcludedIgnoredEntry[],
  bySource: boolean,
): Pick<AgentMigrationTransferSummary, "excludedIgnored" | "excludedIgnoredBySource"> {
  const excludedIgnored = {
    // A wildcard can match any number of directories; the summary's bound
    // reads "at least this many".
    count: Math.min(entries.length, MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT),
    // Measuring stops at the bound (excludeIgnoredPath), so this never exceeds
    // it; the min keeps the strict summary valid whatever the entries say.
    fileCount: Math.min(
      entries.reduce((total, entry) => total + entry.fileCount, 0),
      MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
    ),
    bytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
    largest: [...entries]
      .sort((a, b) => b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path))
      .slice(0, EXCLUDED_IGNORED_SUMMARY_LARGEST)
      .map((entry) => ({ path: entry.path, bytes: entry.sizeBytes })),
  };
  if (!bySource) return { excludedIgnored };
  return { excludedIgnored, excludedIgnoredBySource: summarizeIgnoredBySource(entries, excludedIgnored) };
}

/**
 * Per-source totals of the ignored paths. Each path has one source, so the
 * sources add up to the totals; `wildcard` is the part of them matched by a
 * `**\/<name>` line. Where a total was clamped to its bound, the sources are
 * clamped in AGENT_MIGRATION_IGNORE_SOURCE_ORDER so they never add up to more.
 */
function summarizeIgnoredBySource(
  entries: AgentMigrationExcludedIgnoredEntry[],
  totals: IgnoredTotals,
): NonNullable<AgentMigrationTransferSummary["excludedIgnoredBySource"]> {
  const zero = (): IgnoredTotals => ({ count: 0, fileCount: 0, bytes: 0 });
  const add = (target: IgnoredTotals, entry: AgentMigrationExcludedIgnoredEntry) => {
    target.count += 1;
    target.fileCount += entry.fileCount;
    target.bytes += entry.sizeBytes;
  };
  const raw = { userFile: zero(), agentFile: zero(), legacyFile: zero() };
  // Wildcard matches per source, so a clamped source clamps its wildcard part too.
  const rawWildcard = { userFile: zero(), agentFile: zero(), legacyFile: zero() };
  for (const entry of entries) {
    const source = entry.source ?? "legacyFile";
    add(raw[source], entry);
    if (entry.wildcard) add(rawWildcard[source], entry);
  }
  const result = { userFile: zero(), agentFile: zero(), legacyFile: zero(), wildcard: zero() };
  for (const key of IGNORED_TOTAL_KEYS) {
    let remaining = totals[key];
    for (const source of AGENT_MIGRATION_IGNORE_SOURCE_ORDER) {
      result[source][key] = Math.min(raw[source][key], remaining);
      remaining -= result[source][key];
      result.wildcard[key] += Math.min(rawWildcard[source][key], result[source][key]);
    }
  }
  return result;
}

/** Workspace-root file the agent keeps: paths that are regenerable and need not move. */
export const AGENT_MIGRATION_BACKUP_IGNORE_FILE = ".raftbackupignore";
/** The same file under its earlier name; still read, together with the new one. */
export const AGENT_MIGRATION_IGNORE_FILE = ".raftmigrateignore";
/** Written only by Raft (the user's choices), never by the agent; same format. */
export const AGENT_MIGRATION_USER_IGNORE_FILE = ".raftbackupignore.user";
/**
 * Every ignore file is read and their lines are united. A path listed by more
 * than one is attributed to the first here, as the shared summary schema
 * documents (`excludedIgnoredBySource`).
 */
export const AGENT_MIGRATION_IGNORE_SOURCE_ORDER: readonly AgentMigrationIgnoreSource[] = ["userFile", "agentFile", "legacyFile"];
const IGNORE_SOURCE_FILES: Record<AgentMigrationIgnoreSource, string> = {
  userFile: AGENT_MIGRATION_USER_IGNORE_FILE,
  agentFile: AGENT_MIGRATION_BACKUP_IGNORE_FILE,
  legacyFile: AGENT_MIGRATION_IGNORE_FILE,
};
// `**/<name>` is read only from the new files. Computers before it read
// `.raftmigrateignore` alone and skip such a line as a pattern, so it keeps
// meaning the same everywhere: exact paths only.
const IGNORE_SOURCE_ALLOWS_WILDCARDS: Record<AgentMigrationIgnoreSource, boolean> = {
  userFile: true,
  agentFile: true,
  legacyFile: false,
};
// Never excluded by any ignore line (exact or wildcard): the agent's memory,
// and the ignore files themselves so the next migration applies the same lists
// (and the user's choices travel with the agent). Everything else is the
// agent's call; the source keeps an archived copy for up to 7 days.
const ALWAYS_MOVED_ROOT_PATHS = [
  "MEMORY.md",
  AGENT_MIGRATION_BACKUP_IGNORE_FILE,
  AGENT_MIGRATION_IGNORE_FILE,
  AGENT_MIGRATION_USER_IGNORE_FILE,
];
// Daemon-written activity detail (RFC 069 §5.5) moves with the workspace: an
// entry naming this directory, anything inside it, or any parent is dropped.
const ALWAYS_MOVED_DIRECTORIES = [".raft/activity"];
const IGNORE_PATTERN_CHARS = /[*?[\]!]/;
// The one pattern: `**/<name>`, a directory named <name> at any depth.
const WILDCARD_DIRECTORY_PREFIX = "**/";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;

/** What a listing-only walk excluded; `onEntry` saw everything else. */
export interface AgentMigrationWorkspaceListing {
  excludedRegenerable: AgentMigrationExcludedRegenerableEntry[];
  excludedIgnored: AgentMigrationExcludedIgnoredEntry[];
  unreachable: AgentMigrationUnreachableEntry[];
}

/**
 * Walks the workspace with the same exclusions as an export (built-in
 * regenerable directories, the ignore files) and hands each file or
 * symlink path to `onEntry` in a fixed order, without reading anything or
 * keeping a per-file list. `measureIgnored: false` skips sizing ignored paths
 * on a repeat walk.
 */
export async function listAgentMigrationWorkspace(input: {
  workspacePath: string;
  onEntry: (workspaceRelativePath: string) => Promise<void> | void;
  measureIgnored?: boolean;
  onProgress?: (progress: AgentMigrationExportProgress) => void;
  /** Tests only: a smaller bound than the summary's for measuring ignored files. */
  ignoredFileMeasureLimit?: number;
}): Promise<AgentMigrationWorkspaceListing> {
  const workspace = path.resolve(input.workspacePath);
  const state: BuildState = {
    workspace,
    excludedRegenerable: [],
    excludedIgnored: [],
    unreachable: [],
    ignoreRules: await readAgentMigrationIgnoreRules(workspace),
    progress: { files: 0, bytes: 0 },
    onProgress: input.onProgress,
    onEntry: input.onEntry,
    measureIgnored: input.measureIgnored ?? true,
    ignoredFilesMeasured: 0,
    ignoredFileMeasureLimit: Math.min(
      input.ignoredFileMeasureLimit ?? MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
      MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
    ),
  };
  await walkWorkspace(workspace, "", state);
  return {
    excludedRegenerable: sortByPath(state.excludedRegenerable),
    excludedIgnored: sortByPath(state.excludedIgnored),
    unreachable: sortByPath(state.unreachable),
  };
}

interface BuildState {
  workspace: string;
  excludedRegenerable: AgentMigrationExcludedRegenerableEntry[];
  excludedIgnored: AgentMigrationExcludedIgnoredEntry[];
  unreachable: AgentMigrationUnreachableEntry[];
  ignoreRules: AgentMigrationIgnoreRules;
  progress: { files: number; bytes: number };
  onProgress?: (progress: AgentMigrationExportProgress) => void;
  onEntry: (relativePath: string) => Promise<void> | void;
  /** Count and size ignored paths (skipped by a repeat walk). */
  measureIgnored?: boolean;
  /**
   * Files counted so far across every ignored path. Measuring stops at the
   * summary's bound (MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT), one total
   * for all paths: a count equal to the bound reads "at least this many". Only
   * the measuring stops; the paths stay excluded whole.
   */
  ignoredFilesMeasured: number;
  ignoredFileMeasureLimit: number;
}

/** Top-level workspace path an entry is accounted under: `name` or `dir/`. */
export function agentMigrationTopLevelPath(relativePath: string): string {
  const slashIndex = relativePath.indexOf("/");
  return slashIndex === -1 ? relativePath : `${relativePath.slice(0, slashIndex)}/`;
}

async function walkWorkspace(
  root: string,
  relativeDir: string,
  state: BuildState,
): Promise<void> {
  const absoluteDir = path.join(root, relativeDir);
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    state.unreachable.push({
      path: relativeDir || ".",
      reason: "read_error",
    });
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relativePath = toPosixPath(path.join(relativeDir, entry.name));
    const ignored = matchIgnoreRules(state.ignoreRules, relativePath, entry.name, entry.isDirectory());
    if (ignored) {
      await excludeIgnoredPath(relativePath, entry.isDirectory(), ignored, state);
      continue;
    }
    if (entry.isDirectory()) {
      if (isRegenerablePath(relativePath)) {
        state.excludedRegenerable.push({
          path: relativePath,
          reason: "regenerable_default",
          regenerableHint: `${entry.name} is treated as rebuildable/installable state and is not bundled by default`,
        });
        continue;
      }
      await walkWorkspace(root, relativePath, state);
      continue;
    }

    await state.onEntry(relativePath);
  }
}

function reportScanProgress(state: BuildState, files: number, bytes: number): void {
  state.progress.files += files;
  state.progress.bytes += bytes;
  state.onProgress?.({ phase: "scanning", files: state.progress.files, bytes: state.progress.bytes });
}

interface AgentMigrationIgnoreMatch {
  source: AgentMigrationIgnoreSource;
  wildcard: boolean;
}

/** The united lines of every ignore file, each keyed to the first file listing it. */
interface AgentMigrationIgnoreRules {
  /** Exact workspace-relative paths. */
  paths: Map<string, AgentMigrationIgnoreSource>;
  /** `**\/<name>` lines: directory basenames matched at any depth. */
  directoryNames: Map<string, AgentMigrationIgnoreSource>;
}

async function readAgentMigrationIgnoreRules(workspace: string, maxBytes?: number): Promise<AgentMigrationIgnoreRules> {
  const rules: AgentMigrationIgnoreRules = { paths: new Map(), directoryNames: new Map() };
  for (const source of AGENT_MIGRATION_IGNORE_SOURCE_ORDER) {
    const file = await readAgentMigrationIgnoreFile(
      workspace,
      IGNORE_SOURCE_FILES[source],
      IGNORE_SOURCE_ALLOWS_WILDCARDS[source],
      maxBytes,
    );
    for (const entry of file.paths) if (!rules.paths.has(entry)) rules.paths.set(entry, source);
    for (const name of file.directoryNames) if (!rules.directoryNames.has(name)) rules.directoryNames.set(name, source);
  }
  return rules;
}

/** The Cleaner reads at most this much of each ignore file; past it, the lines read so far. */
export const AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES = 64 * 1024;

/**
 * Whether a migration already leaves out a top-level workspace directory of
 * this name without the agent adding a line for it: a built-in regenerable
 * name, or a top-level line (exact or `**\/<name>`) of any ignore file. Reads
 * only the ignore files themselves, each up to
 * AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES (for the Cleaner's reminder).
 */
export async function readAgentMigrationTopLevelSkip(workspacePath: string): Promise<(name: string) => boolean> {
  const rules = await readAgentMigrationIgnoreRules(path.resolve(workspacePath), AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES);
  return (name) => REGENERABLE_DIRECTORY_NAME_SET.has(name)
    || rules.paths.has(name)
    || rules.directoryNames.has(name);
}

/**
 * Whether a migration leaves out the entry at this workspace-relative path
 * (`/`-separated), by the walk's own rules: an ignore line that matches it, or
 * (a directory) a built-in regenerable name. For a walk that, like the export,
 * never descends into what it left out. Reads the ignore files as
 * readAgentMigrationTopLevelSkip does (for the Cleaner's size estimate).
 */
export async function readAgentMigrationWalkSkip(
  workspacePath: string,
): Promise<(relativePath: string, isDirectory: boolean) => boolean> {
  const rules = await readAgentMigrationIgnoreRules(path.resolve(workspacePath), AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES);
  return (relativePath, isDirectory) => {
    const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    return matchIgnoreRules(rules, relativePath, name, isDirectory) !== null
      || (isDirectory && REGENERABLE_DIRECTORY_NAME_SET.has(name));
  };
}

/**
 * Reads one ignore file at the workspace root: one workspace-relative path per
 * line, `#` comments, and (when `wildcards`) `**\/<name>` for a directory
 * named <name> at any depth (<name> without `/` or pattern characters). Any
 * other pattern is skipped, as is an unsafe path. Only regenerable or
 * re-downloadable content belongs there; exact paths that must always move are
 * dropped here (a wildcard match is checked when it matches, in
 * matchIgnoreRules). A wildcard naming a built-in regenerable directory
 * (`**\/node_modules`) is dropped too: those directories are already skipped
 * as regenerable, and stay reported that way rather than as ignored.
 */
async function readAgentMigrationIgnoreFile(
  workspace: string,
  fileName: string,
  wildcards: boolean,
  maxBytes?: number,
): Promise<{ paths: string[]; directoryNames: string[] }> {
  let text: string;
  try {
    const ignorePath = path.join(workspace, fileName);
    if (!(await lstat(ignorePath)).isFile()) return { paths: [], directoryNames: [] };
    text = maxBytes === undefined ? await readFile(ignorePath, "utf8") : await readFileHead(ignorePath, maxBytes);
  } catch {
    return { paths: [], directoryNames: [] };
  }
  const paths = new Set<string>();
  const directoryNames = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = parseAgentMigrationIgnoreLine(rawLine, workspace, wildcards);
    if (line.kind === "path") paths.add(line.path);
    else if (line.kind === "directoryName") directoryNames.add(line.name);
  }
  return { paths: [...paths], directoryNames: [...directoryNames] };
}

/** The first `maxBytes` of a file; when cut there, without the line the cut split. */
export async function readFileHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    if (read <= maxBytes) return buffer.subarray(0, read).toString("utf8");
    const head = buffer.subarray(0, maxBytes);
    const lastBreak = head.lastIndexOf(0x0a);
    return lastBreak === -1 ? "" : head.subarray(0, lastBreak).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** One ignore-file line as readAgentMigrationIgnoreFile applies it. */
export type AgentMigrationIgnoreLine =
  /** An exact workspace-relative path, normalized. */
  | { kind: "path"; path: string }
  /** A `**\/<name>` line. */
  | { kind: "directoryName"; name: string }
  /** Not applied: blank, a comment, a pattern, an unsafe path, or a wildcard naming a built-in regenerable directory. */
  | { kind: "skipped" }
  /** Skipped: an exact path that always moves. */
  | { kind: "forcedKeep" };

/**
 * The per-line rule of readAgentMigrationIgnoreFile, for one line (no line
 * breaks). Also what Raft checks before it appends a line to
 * `.raftbackupignore.user` (agentMigrationUserIgnore.ts), so a written line
 * means exactly what the reader will apply.
 */
export function parseAgentMigrationIgnoreLine(
  rawLine: string,
  workspace: string,
  wildcards: boolean,
): AgentMigrationIgnoreLine {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return { kind: "skipped" };
  const entry = line.replace(/^\.\//, "").replace(/\/+$/, "");
  if (wildcards && entry.startsWith(WILDCARD_DIRECTORY_PREFIX)) {
    const name = entry.slice(WILDCARD_DIRECTORY_PREFIX.length);
    return isWildcardDirectoryName(name) && !REGENERABLE_DIRECTORY_NAME_SET.has(name)
      ? { kind: "directoryName", name }
      : { kind: "skipped" };
  }
  if (IGNORE_PATTERN_CHARS.test(line)) return { kind: "skipped" };
  const normalized = normalizeIgnorePath(entry, workspace);
  if (normalized === null) return { kind: "skipped" };
  return isAlwaysMovedPath(normalized) ? { kind: "forcedKeep" } : { kind: "path", path: normalized };
}

function isWildcardDirectoryName(name: string): boolean {
  return name !== ""
    && name !== "."
    && name !== ".."
    && !name.includes("/")
    && !name.includes("\\")
    && !name.includes("\0")
    && !IGNORE_PATTERN_CHARS.test(name);
}

/**
 * The ignore line that excludes this walked entry, if any. An exact path and a
 * wildcard from the same file count as the exact path; otherwise the earlier
 * source wins. Wildcards match directories only (not files or symlinks), and
 * never a path that must always move.
 *
 * Precedence decides between lines that name the same entry only. The walk
 * stops at the first excluded directory, so a path inside it is never matched
 * on its own: everything under a directory a `.raftbackupignore` wildcard
 * excludes is attributed to `.raftbackupignore`, even where a
 * `.raftbackupignore.user` line (the earlier source) names a deeper path.
 */
function matchIgnoreRules(
  rules: AgentMigrationIgnoreRules,
  relativePath: string,
  name: string,
  isDirectory: boolean,
): AgentMigrationIgnoreMatch | null {
  const exact = rules.paths.get(relativePath);
  const wildcard = isDirectory && rules.directoryNames.size > 0 && !isAlwaysMovedPath(relativePath)
    ? rules.directoryNames.get(name)
    : undefined;
  if (exact && (!wildcard || ignoreSourceRank(exact) <= ignoreSourceRank(wildcard))) {
    return { source: exact, wildcard: false };
  }
  return wildcard ? { source: wildcard, wildcard: true } : null;
}

function ignoreSourceRank(source: AgentMigrationIgnoreSource): number {
  return AGENT_MIGRATION_IGNORE_SOURCE_ORDER.indexOf(source);
}

function isAlwaysMovedPath(relativePath: string): boolean {
  if (ALWAYS_MOVED_ROOT_PATHS.includes(relativePath)) return true;
  return ALWAYS_MOVED_DIRECTORIES.some((directory) =>
    directory === relativePath
    || directory.startsWith(`${relativePath}/`)
    || relativePath.startsWith(`${directory}/`));
}

/**
 * Records an ignored path with its size and file count (lstat only, symlinks
 * are not followed).
 */
async function excludeIgnoredPath(
  relativePath: string,
  isDirectory: boolean,
  match: AgentMigrationIgnoreMatch,
  state: BuildState,
): Promise<void> {
  if (state.measureIgnored === false) return;
  const totals = { fileCount: 0, sizeBytes: 0 };
  const visit = async (entryPath: string, directory: boolean): Promise<void> => {
    // The bound is reached: stop measuring (a huge ignored node_modules would
    // otherwise be lstat'ed file by file only to overflow the summary).
    if (state.ignoredFilesMeasured >= state.ignoredFileMeasureLimit) return;
    if (!directory) {
      try {
        const entryStat = await lstat(path.join(state.workspace, entryPath));
        totals.fileCount += 1;
        state.ignoredFilesMeasured += 1;
        totals.sizeBytes += entryStat.isFile() ? entryStat.size : 0;
      } catch {
        // Vanished while walking: nothing to move or count.
      }
      reportScanProgress(state, 1, 0);
      return;
    }
    let children;
    try {
      children = await readdir(path.join(state.workspace, entryPath), { withFileTypes: true });
    } catch {
      state.unreachable.push({ path: entryPath, reason: "read_error" });
      return;
    }
    for (const child of children) {
      await visit(toPosixPath(path.join(entryPath, child.name)), child.isDirectory());
    }
  };
  await visit(relativePath, isDirectory);
  state.excludedIgnored.push({
    path: relativePath,
    reason: "raftmigrateignore",
    source: match.source,
    wildcard: match.wildcard,
    ...totals,
  });
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/** A workspace-relative path for an ignore line (an absolute one inside the workspace is made relative), or null when unsafe. */
function normalizeIgnorePath(value: string, workspace: string): string | null {
  const workspacePathApi = path.posix.isAbsolute(workspace) ? path.posix : path.win32;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let relative = trimmed;
  if (isPortableAbsolutePath(trimmed)) {
    if (!workspacePathApi.isAbsolute(trimmed)) return null;
    relative = workspacePathApi.relative(workspace, trimmed);
    if (isOutsideWorkspaceRelativePath(relative)) return null;
  }
  try {
    return normalizeRelativePath(relative);
  } catch {
    return null;
  }
}

function normalizeRelativePath(value: string): string {
  const portable = value.replaceAll("\\", "/");
  if (
    value.includes("\0")
    || isPortableAbsolutePath(value)
    || WINDOWS_DRIVE_PATH_PATTERN.test(value)
  ) {
    throw new Error(`unsafe migration export path: ${value}`);
  }
  const normalized = path.posix.normalize(portable);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe migration export path: ${value}`);
  }
  return normalized;
}


function isOutsideWorkspaceRelativePath(value: string): boolean {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized === ".."
    || normalized.startsWith("../")
    || isPortableAbsolutePath(value)
    || WINDOWS_DRIVE_PATH_PATTERN.test(value);
}

function isRegenerablePath(relativePath: string): boolean {
  return normalizeRelativePath(relativePath)
    .split("/")
    .some((segment) => REGENERABLE_DIRECTORY_NAME_SET.has(segment));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function sortByPath<T extends { path: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

export { normalizeAgentMigrationSymlinkTarget };
