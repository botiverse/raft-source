import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import {
  agentMigrationTransferSummarySchema,
  type AgentMigrationTransferSummary,
} from "@botiverse/raft-shared";

export const AGENT_MIGRATION_BUNDLE_SCHEMA_VERSION = "agent-bundle/v2" as const;

export type AgentMigrationExportMode = "cooperative" | "forensic";
export type AgentMigrationBundleEntrySource = "workspace" | "runtime";
export type AgentMigrationBundleEntryKind = "file" | "symlink";

export interface CooperativeAgentMigrationManifest {
  include?: string[];
  exclude_regenerable?: string[];
  secrets_disclosed?: string[];
  cleaned?: string[];
}

export interface AgentMigrationRuntimeSessionRef {
  runtime: string;
  label: string;
  path: string;
  reachable?: boolean;
  reason?: string;
}

export interface BuildAgentMigrationExportManifestInput {
  agentId: string;
  slockHome: string;
  workspacePath?: string;
  mode: AgentMigrationExportMode;
  cooperativeManifest?: CooperativeAgentMigrationManifest;
  runtimeSessionRefs?: AgentMigrationRuntimeSessionRef[];
  now?: Date;
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
  secretShapes?: string[];
}

export interface AgentMigrationSourceBundleFileEntry extends AgentMigrationBundleFileEntry {
  sourcePath: string;
}

export interface AgentMigrationExcludedRegenerableEntry {
  path: string;
  reason: "regenerable_default" | "cooperative_exclude_regenerable";
  regenerableHint: string;
}

export interface AgentMigrationPromotedIncludeEntry {
  path: string;
  reason: "exclude_not_regenerable";
}

export interface AgentMigrationProposalRefusalEntry {
  path: string;
  reason: "outside_workspace" | "unsafe_path";
  source: "include" | "exclude_regenerable" | "secrets_disclosed" | "cleaned";
}

export interface AgentMigrationUnreachableEntry {
  path: string;
  reason: "missing" | "read_error" | "unsupported_file_type" | "unsafe_symlink_target";
  detail?: string;
}

export interface AgentMigrationSecretDisclosure {
  path: string;
  shapes: string[];
}

export interface AgentMigrationCrossTreeRefEntry {
  runtime: string;
  label: string;
  bundlePath: string;
  reachable: boolean;
  reason?: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface AgentMigrationExportManifest {
  schemaVersion: typeof AGENT_MIGRATION_BUNDLE_SCHEMA_VERSION;
  agentId: string;
  mode: AgentMigrationExportMode;
  createdAt: string;
  defaults: {
    unknownFiles: "include";
    excludePolicy: "regenerable_only";
    regenerableDirectoryNames: string[];
  };
  files: AgentMigrationBundleFileEntry[];
  excludedRegenerable: AgentMigrationExcludedRegenerableEntry[];
  promotedIncludes: AgentMigrationPromotedIncludeEntry[];
  proposalRefusals: AgentMigrationProposalRefusalEntry[];
  unreachable: AgentMigrationUnreachableEntry[];
  secretsDisclosed: AgentMigrationSecretDisclosure[];
  cleaned: string[];
  crossTreeRefs: AgentMigrationCrossTreeRefEntry[];
}

export interface AgentMigrationExportBuildPlan {
  manifest: AgentMigrationExportManifest;
  files: AgentMigrationSourceBundleFileEntry[];
  roots: {
    slockHome: string;
    workspace: string;
  };
}

const REGENERABLE_DIRECTORY_NAMES = [
  ".cache",
  ".gradle",
  ".pnpm-store",
  ".venv",
  "__pycache__",
  "dist",
  "node_modules",
  "target",
  "vendor",
];

const THIRD_PARTY_REGENERABLE_NAMES = new Set([".pnpm-store", ".venv", "node_modules", "vendor"]);
const CACHE_REGENERABLE_NAMES = new Set([".cache", ".gradle", "__pycache__"]);
const BUILD_REGENERABLE_NAMES = new Set(["dist", "target"]);

export function summarizeAgentMigrationExportManifest(
  manifest: Pick<AgentMigrationExportManifest, "files" | "excludedRegenerable">,
): AgentMigrationTransferSummary {
  const excludedRegenerableByCategory = {
    thirdPartyDependencies: 0,
    caches: 0,
    buildArtifacts: 0,
    otherRegenerable: 0,
  };
  for (const entry of manifest.excludedRegenerable) {
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
  const includedWorkspacePaths = manifest.files
    .map((entry) => entry.workspaceRelativePath?.replaceAll("\\", "/"))
    .filter((entry): entry is string => Boolean(entry));

  return agentMigrationTransferSummarySchema.parse({
    includedFileCount: manifest.files.length,
    includedBytes: manifest.files.reduce(
      (total, entry) => total + (entry.kind === "file" ? entry.sizeBytes ?? 0 : 0),
      0,
    ),
    excludedRegenerableCount: manifest.excludedRegenerable.length,
    excludedRegenerableByCategory,
    keyWorkspaceEntries: {
      memoryMdPresent: includedWorkspacePaths.includes("MEMORY.md"),
      notesPresent: includedWorkspacePaths.some((entry) => entry === "notes" || entry.startsWith("notes/")),
    },
  });
}

const SECRET_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "credentials.json",
  "credential.json",
]);

const ENV_KEY_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;

export async function buildAgentMigrationExportManifest(
  input: BuildAgentMigrationExportManifestInput,
): Promise<AgentMigrationExportManifest> {
  return (await buildAgentMigrationExportPlan(input)).manifest;
}

export async function buildAgentMigrationExportPlan(
  input: BuildAgentMigrationExportManifestInput,
): Promise<AgentMigrationExportBuildPlan> {
  const slockHome = path.resolve(input.slockHome);
  const workspace = path.resolve(input.workspacePath ?? path.join(slockHome, "agents", input.agentId));
  const proposedIncludes = normalizeProposalPaths(input.cooperativeManifest?.include, workspace, "include");
  const proposedRegenerableExcludes = normalizeProposalPaths(input.cooperativeManifest?.exclude_regenerable, workspace, "exclude_regenerable");
  const cleanedProposal = normalizeProposalPaths(input.cooperativeManifest?.cleaned, workspace, "cleaned");
  const state: BuildState = {
    workspace,
    files: [],
    excludedRegenerable: [],
    promotedIncludes: [],
    proposalRefusals: [
      ...proposedIncludes.refusals,
      ...proposedRegenerableExcludes.refusals,
      ...cleanedProposal.refusals,
    ],
    unreachable: [],
    secretsDisclosed: [],
    seenWorkspacePaths: new Set(),
    explicitIncludePaths: new Set(proposedIncludes.paths),
  };

  await walkWorkspace(workspace, "", new Set(proposedRegenerableExcludes.paths), state, { forceIncludeRegenerable: false });

  for (const requestedPath of proposedIncludes.paths) {
    if (!state.seenWorkspacePaths.has(requestedPath)) {
      await includeWorkspacePath(requestedPath, state, { forceIncludeRegenerable: true });
    }
  }

  for (const requestedPath of proposedRegenerableExcludes.paths) {
    if (isRegenerablePath(requestedPath)) continue;
    state.promotedIncludes.push({ path: requestedPath, reason: "exclude_not_regenerable" });
    await includeWorkspacePath(requestedPath, state, { forceIncludeRegenerable: true });
  }

  const crossTreeRefs = await buildCrossTreeRefs(input.runtimeSessionRefs ?? []);
  const secretDisclosureProposal = normalizeProposalPaths(input.cooperativeManifest?.secrets_disclosed, workspace, "secrets_disclosed");
  state.proposalRefusals.push(...secretDisclosureProposal.refusals);

  const sourceFiles = sortSourceBundleEntries(state.files);
  const manifest: AgentMigrationExportManifest = {
    schemaVersion: AGENT_MIGRATION_BUNDLE_SCHEMA_VERSION,
    agentId: input.agentId,
    mode: input.mode,
    createdAt: (input.now ?? new Date()).toISOString(),
    defaults: {
      unknownFiles: "include",
      excludePolicy: "regenerable_only",
      regenerableDirectoryNames: [...REGENERABLE_DIRECTORY_NAMES],
    },
    files: sourceFiles.map(toPortableBundleEntry),
    excludedRegenerable: sortByPath(state.excludedRegenerable),
    promotedIncludes: sortByPath(state.promotedIncludes),
    proposalRefusals: sortByPath(state.proposalRefusals),
    unreachable: sortByPath(state.unreachable),
    secretsDisclosed: sortByPath([
      ...state.secretsDisclosed,
      ...normalizeProvidedSecretDisclosures(secretDisclosureProposal.paths),
    ]),
    cleaned: cleanedProposal.paths,
    crossTreeRefs: crossTreeRefs.sort((a, b) => a.bundlePath.localeCompare(b.bundlePath)),
  };

  return {
    manifest,
    files: sourceFiles,
    roots: {
      slockHome,
      workspace,
    },
  };
}

interface BuildState {
  workspace: string;
  files: AgentMigrationSourceBundleFileEntry[];
  excludedRegenerable: AgentMigrationExcludedRegenerableEntry[];
  promotedIncludes: AgentMigrationPromotedIncludeEntry[];
  proposalRefusals: AgentMigrationProposalRefusalEntry[];
  unreachable: AgentMigrationUnreachableEntry[];
  secretsDisclosed: AgentMigrationSecretDisclosure[];
  seenWorkspacePaths: Set<string>;
  explicitIncludePaths: Set<string>;
}

async function walkWorkspace(
  root: string,
  relativeDir: string,
  proposedRegenerableExcludes: Set<string>,
  state: BuildState,
  opts: { forceIncludeRegenerable: boolean },
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
    if (entry.isDirectory()) {
      if (!opts.forceIncludeRegenerable && isRegenerablePath(relativePath)) {
        if (state.explicitIncludePaths.has(relativePath)) {
          await walkWorkspace(root, relativePath, proposedRegenerableExcludes, state, { forceIncludeRegenerable: true });
          continue;
        }
        if (hasExplicitIncludeDescendant(relativePath, state.explicitIncludePaths)) {
          await walkWorkspace(root, relativePath, proposedRegenerableExcludes, state, opts);
          continue;
        }
        state.excludedRegenerable.push({
          path: relativePath,
          reason: proposedRegenerableExcludes.has(relativePath) ? "cooperative_exclude_regenerable" : "regenerable_default",
          regenerableHint: `${entry.name} is treated as rebuildable/installable state and is not bundled by default`,
        });
        continue;
      }
      await walkWorkspace(root, relativePath, proposedRegenerableExcludes, state, opts);
      continue;
    }

    await includeWorkspacePath(relativePath, state, { forceIncludeRegenerable: opts.forceIncludeRegenerable });
  }
}

async function includeWorkspacePath(
  workspaceRelativePath: string,
  state: BuildState,
  opts: { forceIncludeRegenerable: boolean },
): Promise<void> {
  const normalizedRelativePath = normalizeRelativePath(workspaceRelativePath);
  if (state.seenWorkspacePaths.has(normalizedRelativePath)) return;
  const sourcePath = path.join(state.workspace, normalizedRelativePath);

  let stat;
  try {
    stat = await lstat(sourcePath);
  } catch {
    state.unreachable.push({
      path: normalizedRelativePath,
      reason: "missing",
    });
    return;
  }

  if (stat.isDirectory()) {
    if (!opts.forceIncludeRegenerable && isRegenerablePath(normalizedRelativePath)) {
      state.excludedRegenerable.push({
        path: normalizedRelativePath,
        reason: "cooperative_exclude_regenerable",
        regenerableHint: `${path.basename(normalizedRelativePath)} is treated as rebuildable/installable state and is not bundled by default`,
      });
      return;
    }
    await walkWorkspace(state.workspace, normalizedRelativePath, new Set(), state, opts);
    return;
  }

  state.seenWorkspacePaths.add(normalizedRelativePath);
  const baseEntry = {
    source: "workspace" as const,
    sourcePath,
    workspaceRelativePath: normalizedRelativePath,
    bundlePath: `workspace/${normalizedRelativePath}`,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
  };

  if (stat.isSymbolicLink()) {
    let rawLinkTarget: string;
    try {
      rawLinkTarget = await readlink(sourcePath);
    } catch {
      state.unreachable.push({
        path: normalizedRelativePath,
        reason: "read_error",
      });
      return;
    }
    let linkTarget: string;
    try {
      linkTarget = normalizeAgentMigrationSymlinkTarget(normalizedRelativePath, rawLinkTarget);
    } catch {
      state.unreachable.push({
        path: normalizedRelativePath,
        reason: "unsafe_symlink_target",
        detail: redactedSymlinkTarget(rawLinkTarget),
      });
      return;
    }
    state.files.push({
      ...baseEntry,
      kind: "symlink",
      linkTarget,
    });
    return;
  }

  if (!stat.isFile()) {
    state.unreachable.push({
      path: normalizedRelativePath,
      reason: "unsupported_file_type",
    });
    return;
  }

  const secretShapes = await detectSecretShapes(sourcePath, normalizedRelativePath);
  if (secretShapes.length > 0) {
    state.secretsDisclosed.push({ path: normalizedRelativePath, shapes: secretShapes });
  }

  state.files.push({
    ...baseEntry,
    kind: "file",
    sizeBytes: stat.size,
    sha256: await sha256File(sourcePath),
    secretShapes: secretShapes.length > 0 ? secretShapes : undefined,
  });
}

async function buildCrossTreeRefs(
  refs: AgentMigrationRuntimeSessionRef[],
): Promise<AgentMigrationCrossTreeRefEntry[]> {
  const result: AgentMigrationCrossTreeRefEntry[] = [];
  for (const ref of refs) {
    const sourcePath = path.resolve(ref.path);
    const bundlePath = `runtime/${safeBundleSegment(ref.runtime)}/${safeBundleSegment(ref.label)}/${safeBundleSegment(path.basename(sourcePath) || "session")}`;
    const entry: AgentMigrationCrossTreeRefEntry = {
      runtime: ref.runtime,
      label: ref.label,
      bundlePath,
      reachable: ref.reachable !== false,
      reason: ref.reason,
    };

    try {
      const stat = await lstat(sourcePath);
      if (stat.isFile()) {
        entry.sizeBytes = stat.size;
        entry.sha256 = await sha256File(sourcePath);
      }
    } catch {
      entry.reachable = false;
    }

    result.push(entry);
  }
  return result;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function detectSecretShapes(sourcePath: string, relativePath: string): Promise<string[]> {
  const basename = path.basename(relativePath);
  const lowerBasename = basename.toLowerCase();
  const shapes = new Set<string>();

  if (SECRET_FILE_NAMES.has(lowerBasename) || lowerBasename.startsWith(".env.")) {
    shapes.add(`file:${basename}`);
    try {
      const text = await readFile(sourcePath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = ENV_KEY_PATTERN.exec(line);
        if (match) shapes.add(`env:${match[1]}`);
      }
    } catch {
      shapes.add("content:unreadable");
    }
  }

  if (/(?:secret|token|credential|api[-_]?key)/i.test(relativePath)) {
    shapes.add(`path:${basename}`);
  }

  return [...shapes].sort();
}

function normalizeProvidedSecretDisclosures(disclosures: string[]): AgentMigrationSecretDisclosure[] {
  return disclosures.map((entry) => ({
    path: entry,
    shapes: ["provided"],
  }));
}

interface NormalizedProposalPaths {
  paths: string[];
  refusals: AgentMigrationProposalRefusalEntry[];
}

function normalizeProposalPaths(
  paths: string[] | undefined,
  workspace: string,
  source: AgentMigrationProposalRefusalEntry["source"],
): NormalizedProposalPaths {
  if (!paths) return { paths: [], refusals: [] };
  const workspacePathApi = path.posix.isAbsolute(workspace) ? path.posix : path.win32;
  const result: string[] = [];
  const refusals: AgentMigrationProposalRefusalEntry[] = [];
  for (const value of paths) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (isPortableAbsolutePath(trimmed)) {
      if (!workspacePathApi.isAbsolute(trimmed)) {
        refusals.push({
          path: redactedProposalPath(trimmed, "absolute"),
          reason: "outside_workspace",
          source,
        });
        continue;
      }
      const relative = workspacePathApi.relative(workspace, trimmed);
      if (isOutsideWorkspaceRelativePath(relative)) {
        refusals.push({
          path: redactedProposalPath(trimmed, "absolute"),
          reason: "outside_workspace",
          source,
        });
        continue;
      }
      try {
        result.push(normalizeRelativePath(relative));
      } catch {
        refusals.push({
          path: redactedProposalPath(trimmed, "absolute"),
          reason: "unsafe_path",
          source,
        });
      }
      continue;
    }
    try {
      result.push(normalizeRelativePath(trimmed));
    } catch {
      refusals.push({
        path: redactedProposalPath(trimmed, "unsafe"),
        reason: "unsafe_path",
        source,
      });
    }
  }
  return { paths: [...new Set(result)], refusals };
}

function redactedProposalPath(value: string, kind: "absolute" | "unsafe"): string {
  const fingerprint = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `<redacted:${kind}:${fingerprint}>`;
}

function redactedSymlinkTarget(value: string): string {
  const fingerprint = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `<redacted:unsafe-symlink-target:${fingerprint}>`;
}

export function normalizeAgentMigrationSymlinkTarget(
  workspaceRelativePath: string,
  linkTarget: string,
): string {
  const portableTarget = linkTarget.replaceAll("\\", "/");
  if (
    !linkTarget
    || linkTarget.includes("\0")
    || isPortableAbsolutePath(linkTarget)
    || WINDOWS_DRIVE_PATH_PATTERN.test(linkTarget)
  ) {
    throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
  }

  const normalizedTarget = path.posix.normalize(portableTarget);
  const normalizedLinkPath = normalizeRelativePath(workspaceRelativePath);
  const resolvedTarget = path.posix.normalize(
    path.posix.join(path.posix.dirname(normalizedLinkPath), normalizedTarget),
  );
  if (
    !normalizedTarget
    || normalizedTarget === "."
    || resolvedTarget === ".."
    || resolvedTarget.startsWith("../")
    || isPortableAbsolutePath(resolvedTarget)
    || WINDOWS_DRIVE_PATH_PATTERN.test(normalizedTarget)
  ) {
    throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
  }
  return normalizedTarget;
}

export function assertAgentMigrationManifestSymlinkTargetsSafe(
  manifest: AgentMigrationExportManifest,
): void {
  if (!Array.isArray(manifest.files)) throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
  for (const entry of manifest.files) {
    if (entry.kind !== "symlink") continue;
    if (!entry.workspaceRelativePath || entry.linkTarget === undefined) {
      throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
    }
    const normalized = normalizeAgentMigrationSymlinkTarget(
      entry.workspaceRelativePath,
      entry.linkTarget,
    );
    if (normalized !== entry.linkTarget) {
      throw new Error("MIGRATION_OBJECT_STORE_UNSAFE_LINK");
    }
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

function isPortableAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value.replaceAll("\\", "/")) || path.win32.isAbsolute(value);
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
    .some((segment) => REGENERABLE_DIRECTORY_NAMES.includes(segment));
}

function hasExplicitIncludeDescendant(relativePath: string, explicitIncludePaths: Set<string>): boolean {
  const prefix = `${relativePath}/`;
  for (const includePath of explicitIncludePaths) {
    if (includePath.startsWith(prefix)) return true;
  }
  return false;
}

function safeBundleSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function toPortableBundleEntry(entry: AgentMigrationSourceBundleFileEntry): AgentMigrationBundleFileEntry {
  const { sourcePath: _sourcePath, ...portable } = entry;
  void _sourcePath;
  return portable;
}

function sortSourceBundleEntries(entries: AgentMigrationSourceBundleFileEntry[]): AgentMigrationSourceBundleFileEntry[] {
  return [...entries].sort((a, b) => a.bundlePath.localeCompare(b.bundlePath));
}

function sortByPath<T extends { path: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}
