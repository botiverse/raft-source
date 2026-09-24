import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WIKI_AGENT_WORKSPACE_ENABLED,
  WIKI_AGENT_WORKSPACE_ENV,
  WIKI_WORKSPACE_PACK_PROTOCOL_VERSION,
  canonicalizeWikiWorkspacePackFiles,
  type WikiWorkspaceEnsureReceipt,
  type WikiWorkspaceFileReceipt,
  type WikiWorkspacePack,
} from "@botiverse/raft-shared";

const PACK_MARKER_PATH = ".slock/wiki-workspace-pack.json";
const MAX_PACK_FILES = 64;
const MAX_PACK_PATH_BYTES = 512;
const MAX_PACK_FILE_BYTES = 64 * 1024;
const MAX_PACK_BYTES = 256 * 1024;
const MAX_PACK_MARKER_BYTES = 128 * 1024;
const ROOT_PACK_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const SKILL_PATH_PREFIXES = [".agents/skills/", ".claude/skills/"] as const;

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type WikiWorkspacePackMarker = {
  protocolVersion: typeof WIKI_WORKSPACE_PACK_PROTOCOL_VERSION;
  packId: string;
  files: WikiWorkspaceFileReceipt[];
};

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isAllowedPackPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (
    !relativePath
    || Buffer.byteLength(relativePath) > MAX_PACK_PATH_BYTES
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || segments.some((segment) =>
      segment === "."
      || segment === ".."
      || segment === ""
      || Buffer.byteLength(segment) > 255
    )
  ) {
    return false;
  }
  if (ROOT_PACK_FILES.has(relativePath)) return true;
  return SKILL_PATH_PREFIXES.some((prefix) =>
    relativePath.startsWith(prefix)
    && relativePath.length > prefix.length
    && relativePath.endsWith(".md")
  );
}

function validatePack(pack: WikiWorkspacePack): void {
  if (pack.protocolVersion !== WIKI_WORKSPACE_PACK_PROTOCOL_VERSION) {
    throw new Error(`Unsupported Wiki workspace pack protocol: ${pack.protocolVersion}`);
  }
  if (!isSha256(pack.packId)) {
    throw new Error("Wiki workspace pack id must be a lowercase SHA-256");
  }
  if (pack.files.length === 0 || pack.files.length > MAX_PACK_FILES) {
    throw new Error(`Wiki workspace pack must contain 1-${MAX_PACK_FILES} files`);
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of pack.files) {
    if (!isAllowedPackPath(file.relativePath)) {
      throw new Error(`Wiki workspace pack path is outside the allowed scope: ${file.relativePath}`);
    }
    if (paths.has(file.relativePath)) {
      throw new Error(`Wiki workspace pack contains a duplicate path: ${file.relativePath}`);
    }
    paths.add(file.relativePath);
    const size = Buffer.byteLength(file.content);
    if (size === 0 || size > MAX_PACK_FILE_BYTES || file.size !== size) {
      throw new Error(`Wiki workspace pack file has an invalid size: ${file.relativePath}`);
    }
    if (!isSha256(file.sha256) || sha256(file.content) !== file.sha256) {
      throw new Error(`Wiki workspace pack file hash mismatch: ${file.relativePath}`);
    }
    totalBytes += size;
  }
  if (!paths.has("AGENTS.md") || !paths.has("CLAUDE.md")) {
    throw new Error("Wiki workspace pack must contain AGENTS.md and CLAUDE.md");
  }
  if (totalBytes > MAX_PACK_BYTES) {
    throw new Error(`Wiki workspace pack exceeds ${MAX_PACK_BYTES} bytes`);
  }
  const actualPackId = sha256(canonicalizeWikiWorkspacePackFiles(pack.files));
  if (actualPackId !== pack.packId) {
    throw new Error("Wiki workspace pack content hash does not match packId");
  }
}

async function tryLstat(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertWorkspacePathIsSafe(agentDataDir: string, relativePath: string): Promise<void> {
  const rootStat = await lstat(agentDataDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Wiki Agent workspace root must be a real directory");
  }
  let current = agentDataDir;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await tryLstat(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`Wiki workspace managed path crosses a symbolic link: ${relativePath}`);
    }
    if (current !== path.join(agentDataDir, ...relativePath.split("/")) && !stat.isDirectory()) {
      throw new Error(`Wiki workspace managed path has a non-directory ancestor: ${relativePath}`);
    }
  }
}

function parseMarker(value: unknown): WikiWorkspacePackMarker | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WikiWorkspacePackMarker>;
  if (
    candidate.protocolVersion !== WIKI_WORKSPACE_PACK_PROTOCOL_VERSION
    || !isSha256(candidate.packId)
    || !Array.isArray(candidate.files)
    || candidate.files.length === 0
    || candidate.files.length > MAX_PACK_FILES
  ) {
    return null;
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of candidate.files) {
    if (
      !file
      || typeof file !== "object"
      || !isAllowedPackPath(file.relativePath)
      || paths.has(file.relativePath)
      || !isSha256(file.sha256)
      || !Number.isSafeInteger(file.size)
      || file.size <= 0
      || file.size > MAX_PACK_FILE_BYTES
    ) {
      return null;
    }
    paths.add(file.relativePath);
    totalBytes += file.size;
  }
  if (totalBytes > MAX_PACK_BYTES) return null;
  return candidate as WikiWorkspacePackMarker;
}

async function readPackMarker(agentDataDir: string): Promise<WikiWorkspacePackMarker | null> {
  try {
    await assertWorkspacePathIsSafe(agentDataDir, PACK_MARKER_PATH);
    const markerPath = path.join(agentDataDir, PACK_MARKER_PATH);
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.size > MAX_PACK_MARKER_BYTES) return null;
    const raw = await readFile(markerPath, "utf8");
    return parseMarker(JSON.parse(raw));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT"
      || error instanceof SyntaxError
    ) {
      return null;
    }
    throw error;
  }
}

async function readFileReceipt(
  agentDataDir: string,
  relativePath: string,
): Promise<WikiWorkspaceFileReceipt> {
  await assertWorkspacePathIsSafe(agentDataDir, relativePath);
  const targetPath = path.join(agentDataDir, ...relativePath.split("/"));
  const targetStat = await lstat(targetPath);
  if (!targetStat.isFile() || targetStat.size > MAX_PACK_FILE_BYTES) {
    throw new Error(`Wiki workspace managed path is not a bounded regular file: ${relativePath}`);
  }
  const content = await readFile(targetPath);
  return {
    relativePath,
    sha256: sha256(content),
    size: content.byteLength,
  };
}

async function verifyInstalledPack(
  agentDataDir: string,
  marker?: WikiWorkspacePackMarker | null,
): Promise<WikiWorkspacePackMarker | null> {
  const resolvedMarker = marker === undefined ? await readPackMarker(agentDataDir) : marker;
  if (!resolvedMarker) return null;
  const receipts = await Promise.all(
    resolvedMarker.files.map((file) => readFileReceipt(agentDataDir, file.relativePath)),
  ).catch(() => null);
  if (!receipts) return null;
  const expectedByPath = new Map(resolvedMarker.files.map((file) => [file.relativePath, file]));
  if (!receipts.every((receipt) => {
    const expected = expectedByPath.get(receipt.relativePath);
    return expected?.sha256 === receipt.sha256 && expected.size === receipt.size;
  })) {
    return null;
  }
  return { ...resolvedMarker, files: receipts };
}

async function moveIfPresent(source: string, destination: string): Promise<boolean> {
  const stat = await tryLstat(source);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Wiki workspace managed path is not a regular file: ${source}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
  return true;
}

async function copyIfPresent(source: string, destination: string): Promise<boolean> {
  const stat = await tryLstat(source);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Wiki workspace managed path is not a regular file: ${source}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return true;
}

async function installPack(agentDataDir: string, pack: WikiWorkspacePack): Promise<void> {
  const previousMarker = await readPackMarker(agentDataDir);
  const transactionRoot = await mkdtemp(path.join(path.dirname(agentDataDir), ".wiki-workspace-pack-"));
  const nextRoot = path.join(transactionRoot, "next");
  const backupRoot = path.join(transactionRoot, "backup");
  const markerPath = path.join(agentDataDir, PACK_MARKER_PATH);
  const backupMarkerPath = path.join(backupRoot, PACK_MARKER_PATH);
  const newPaths = pack.files.map((file) => file.relativePath);
  const managedPaths = [...new Set([
    ...(previousMarker?.files.map((file) => file.relativePath) ?? []),
    ...newPaths,
  ])].sort(comparePaths);
  const installedNewPaths: string[] = [];
  const backedUpPaths: string[] = [];
  let markerBackedUp = false;
  let tempMarkerPath: string | null = null;

  try {
    for (const file of pack.files) {
      const stagedPath = path.join(nextRoot, ...file.relativePath.split("/"));
      await mkdir(path.dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, file.content, { mode: 0o644 });
      const stagedContent = await readFile(stagedPath);
      if (sha256(stagedContent) !== file.sha256 || stagedContent.byteLength !== file.size) {
        throw new Error(`Wiki workspace staged readback mismatch: ${file.relativePath}`);
      }
    }

    await assertWorkspacePathIsSafe(agentDataDir, PACK_MARKER_PATH);
    for (const relativePath of managedPaths) {
      await assertWorkspacePathIsSafe(agentDataDir, relativePath);
    }

    // Keep the old marker in place until the final atomic rename. If the
    // process crashes mid-install, launch validation fails against that old
    // marker and the next ensure still knows every formerly managed path.
    markerBackedUp = previousMarker
      ? await copyIfPresent(markerPath, backupMarkerPath)
      : false;
    for (const relativePath of managedPaths) {
      const targetPath = path.join(agentDataDir, ...relativePath.split("/"));
      const backupPath = path.join(backupRoot, ...relativePath.split("/"));
      if (await moveIfPresent(targetPath, backupPath)) backedUpPaths.push(relativePath);
    }

    for (const file of pack.files) {
      const stagedPath = path.join(nextRoot, ...file.relativePath.split("/"));
      const targetPath = path.join(agentDataDir, ...file.relativePath.split("/"));
      await mkdir(path.dirname(targetPath), { recursive: true });
      await rename(stagedPath, targetPath);
      installedNewPaths.push(file.relativePath);
    }

    const marker: WikiWorkspacePackMarker = {
      protocolVersion: WIKI_WORKSPACE_PACK_PROTOCOL_VERSION,
      packId: pack.packId,
      files: pack.files
        .map(({ relativePath, sha256: fileSha256, size }) => ({
          relativePath,
          sha256: fileSha256,
          size,
        }))
        .sort((a, b) => comparePaths(a.relativePath, b.relativePath)),
    };
    await mkdir(path.dirname(markerPath), { recursive: true });
    tempMarkerPath = `${markerPath}.${process.pid}-${randomUUID()}.tmp`;
    await writeFile(tempMarkerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    await rename(tempMarkerPath, markerPath);
    tempMarkerPath = null;
  } catch (error) {
    if (tempMarkerPath) {
      await rm(tempMarkerPath, { force: true }).catch(() => undefined);
    }
    await rm(markerPath, { force: true }).catch(() => undefined);
    for (const relativePath of installedNewPaths.reverse()) {
      await rm(path.join(agentDataDir, ...relativePath.split("/")), { force: true }).catch(() => undefined);
    }
    for (const relativePath of backedUpPaths.reverse()) {
      const backupPath = path.join(backupRoot, ...relativePath.split("/"));
      const targetPath = path.join(agentDataDir, ...relativePath.split("/"));
      await mkdir(path.dirname(targetPath), { recursive: true });
      await rename(backupPath, targetPath).catch(() => undefined);
    }
    if (markerBackedUp) {
      await mkdir(path.dirname(markerPath), { recursive: true });
      await rename(backupMarkerPath, markerPath).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function ensureWikiAgentWorkspace(
  agentId: string,
  agentDataDir: string,
  pack: WikiWorkspacePack,
): Promise<WikiWorkspaceEnsureReceipt> {
  validatePack(pack);
  await mkdir(agentDataDir, { recursive: true });
  const installed = await verifyInstalledPack(agentDataDir);
  if (installed?.packId !== pack.packId) {
    await installPack(agentDataDir, pack);
  }
  const verified = await verifyInstalledPack(agentDataDir);
  if (!verified || verified.packId !== pack.packId) {
    throw new Error("Wiki workspace pack installation did not produce a valid readback");
  }
  return { agentId, packId: verified.packId, files: verified.files };
}

export async function ensureWikiWorkspaceIfConfigured(
  agentDataDir: string,
  envVars: Record<string, string> | null | undefined,
): Promise<void> {
  const enabled = (envVars?.[WIKI_AGENT_WORKSPACE_ENV] || "").trim().toLowerCase();
  if (enabled !== WIKI_AGENT_WORKSPACE_ENABLED) return;
  await mkdir(agentDataDir, { recursive: true });
  if (!await verifyInstalledPack(agentDataDir)) {
    throw new Error("Configured Wiki Agent has no valid installed workspace pack");
  }
}
