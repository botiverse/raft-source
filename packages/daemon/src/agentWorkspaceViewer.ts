import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FileNode } from "@botiverse/raft-shared";

/**
 * The agent workspace file viewer (`agent:workspace:list` / `agent:workspace:read`):
 * what a person allowed to view an agent's workspace can list and read.
 *
 * It never follows a symbolic link. A link the agent (or a tool it ran) made
 * inside `agents/<id>/` may point anywhere the daemon's user can read: the
 * Computer key in `runner.state.json`, `~/.codex/auth.json`, other agents'
 * workspaces. The agent can already read those; the people viewing its
 * workspace must not. So a link is listed as a link (no target, no size), a
 * directory reached through a link is not listed, and a file is read only
 * when no path component from the workspace root down to it is a link.
 * Refusals look like a missing entry: an empty listing, or the same error a
 * missing file gives, so they tell nothing about the target.
 */

const WORKSPACE_TEXT_FILE_MAX_BYTES = 1_048_576;
const WORKSPACE_IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

const WORKSPACE_TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".js", ".ts", ".jsx", ".tsx", ".yaml", ".yml",
  ".toml", ".log", ".csv", ".xml", ".html", ".css", ".sh", ".py",
]);

const WORKSPACE_IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const WORKSPACE_NEVER_VISIBLE_HIDDEN_NAMES = new Set([
  ".aws",
  ".gnupg",
  ".ssh",
  // Both Raft home names (~/.raft on new machines, ~/.slock on older ones)
  // hold credentials, so a workspace that contains the user's home must not
  // expose them. This also hides a workspace's own `.raft/` activity detail.
  ".raft",
  ".slock",
  ".slock-runtime",
]);

const WORKSPACE_SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /(?:^|[._-])secret(?:s)?(?:[._-]|$)/i,
  /(?:^|[._-])credential(?:s)?(?:[._-]|$)/i,
  /(?:^|[._-])token(?:s)?(?:[._-]|$)/i,
];

/** Read-only, never through a link as the last component, never blocking on a FIFO. */
const WORKSPACE_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

function isWorkspaceNeverVisibleHiddenEntry(name: string): boolean {
  return WORKSPACE_NEVER_VISIBLE_HIDDEN_NAMES.has(name) || name.startsWith(".slock-");
}

function workspacePathParts(relativePath: string): string[] {
  return relativePath.split(path.sep).filter(Boolean);
}

function isWorkspaceHiddenPath(relativePath: string): boolean {
  return workspacePathParts(relativePath).some((part) => part.startsWith("."));
}

function isWorkspaceNeverVisibleHiddenPath(relativePath: string): boolean {
  return workspacePathParts(relativePath).some(isWorkspaceNeverVisibleHiddenEntry);
}

function isWorkspaceSecretFilePath(filePath: string): boolean {
  return workspacePathParts(filePath).some((part) =>
    WORKSPACE_SECRET_FILE_PATTERNS.some((pattern) => pattern.test(part))
  );
}

/** The error every refused or missing read gives (the daemon answers all of them alike). */
function workspaceFileNotFound(): Error {
  return Object.assign(new Error("File not found"), { code: "ENOENT" });
}

/** `target` (already confined to `workspaceDir`) as components below it; empty for the root. */
function relativeWorkspaceParts(workspaceDir: string, target: string): string[] {
  return workspacePathParts(path.relative(workspaceDir, target));
}

/**
 * lstat every component from the workspace root down to `target`: the root
 * and each parent must be a real directory, no component may be a link.
 * Returns the target's lstat, or null when any check fails or a component is missing.
 */
async function lstatWithoutLinks(workspaceDir: string, parts: readonly string[]): Promise<Stats | null> {
  let current = workspaceDir;
  let info: Stats;
  try {
    info = await lstat(current);
    if (!info.isDirectory()) return null;
    for (const part of parts) {
      current = path.join(current, part);
      info = await lstat(current);
      if (info.isSymbolicLink()) return null;
    }
  } catch {
    return null;
  }
  // Every parent of the target was checked as the next component's container;
  // a parent that is not a directory fails the next lstat (ENOTDIR).
  return info;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Resolve a viewer path under `workspaceDir`, or null when it leaves it
 * (`..`, absolute) or names something never shown.
 */
function confineWorkspacePath(workspaceDir: string, requested: string): string | null {
  const resolved = path.resolve(workspaceDir, requested);
  if (!resolved.startsWith(workspaceDir + path.sep) && resolved !== workspaceDir) return null;
  return resolved;
}

/** List ONE level of a workspace directory; directories come without children (lazy-loaded). */
export async function listWorkspaceDirectory(workspaceDir: string, dirPath?: string, includeHidden = false): Promise<FileNode[]> {
  let targetDir = workspaceDir;
  if (dirPath) {
    const resolved = confineWorkspacePath(workspaceDir, dirPath);
    if (!resolved) return [];
    const relativePath = path.relative(workspaceDir, resolved);
    if (isWorkspaceNeverVisibleHiddenPath(relativePath)) return [];
    if (!includeHidden && isWorkspaceHiddenPath(relativePath)) return [];
    targetDir = resolved;
  }

  const parts = relativeWorkspaceParts(workspaceDir, targetDir);
  const before = await lstatWithoutLinks(workspaceDir, parts);
  if (!before?.isDirectory()) return [];

  let entries;
  try { entries = await readdir(targetDir, { withFileTypes: true }); } catch { return []; }
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    const isHidden = entry.name.startsWith(".");
    if (entry.name === "node_modules") continue;
    if (isHidden && (!includeHidden || isWorkspaceNeverVisibleHiddenEntry(entry.name))) continue;
    const fullPath = path.join(targetDir, entry.name);
    const relativePath = path.relative(workspaceDir, fullPath);
    let info;
    try { info = await lstat(fullPath); } catch { continue; }
    const modifiedAt = info.mtime.toISOString();
    if (info.isSymbolicLink()) {
      // Shown as a link, never opened: no target, and no size (a link's size is its target's length).
      nodes.push({ name: entry.name, path: relativePath, isDirectory: false, isSymlink: true, size: 0, modifiedAt, isHidden });
    } else if (info.isDirectory()) {
      nodes.push({ name: entry.name, path: relativePath, isDirectory: true, size: 0, modifiedAt, isHidden });
    } else {
      nodes.push({ name: entry.name, path: relativePath, isDirectory: false, size: info.size, modifiedAt, isHidden });
    }
  }

  // readdir follows a link: had a parent been swapped for one while we listed,
  // the names came from elsewhere. Same check as before, and the same directory.
  const after = await lstatWithoutLinks(workspaceDir, parts);
  if (!after || !sameFile(before, after)) return [];
  return nodes;
}

export type WorkspaceFileRead = {
  content: string | null;
  binary: boolean;
  size: number;
  mimeType?: string;
  encoding?: "utf-8" | "base64";
};

/**
 * Read a workspace file for the viewer. Refused (thrown like a missing file)
 * when any component from the workspace root down to the file is a link, or
 * the file has more than one hard link.
 *
 * Order, and why: (1) lstat every component, so nothing outside the
 * workspace is even opened in the ordinary case; (2) open with O_NOFOLLOW,
 * so a last component swapped for a link after (1) fails with ELOOP; (3)
 * fstat the open file and read only from that descriptor; (4) lstat the
 * components again and require the path to still name, without links, the
 * very file (dev/ino) that was opened. (4) closes the window O_NOFOLLOW
 * leaves open: a parent directory swapped for a link between (1) and (2)
 * makes the open land elsewhere, and the inode then differs from what the
 * plain path names. Node has no fd-to-path call to realpath the descriptor
 * portably, and dev/ino on the descriptor is the stronger check anyway.
 */
export async function readWorkspaceFile(workspaceDir: string, filePath: string): Promise<WorkspaceFileRead> {
  const resolved = confineWorkspacePath(workspaceDir, filePath);
  if (!resolved) throw new Error("Access denied");
  const relativePath = path.relative(workspaceDir, resolved);
  if (isWorkspaceNeverVisibleHiddenPath(relativePath) || isWorkspaceSecretFilePath(relativePath)) {
    throw new Error("Preview is disabled for sensitive workspace files");
  }

  const parts = relativeWorkspaceParts(workspaceDir, resolved);
  if (parts.length === 0) throw new Error("Cannot read a directory");
  const checked = await lstatWithoutLinks(workspaceDir, parts);
  if (!checked) throw workspaceFileNotFound();
  if (checked.isDirectory()) throw new Error("Cannot read a directory");
  if (!checked.isFile()) throw workspaceFileNotFound();

  let handle;
  try {
    handle = await open(resolved, WORKSPACE_READ_FLAGS);
  } catch {
    throw workspaceFileNotFound();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !sameFile(info, checked)) throw workspaceFileNotFound();
    // A hard link is a second name for a file that may live outside the
    // workspace (the Computer key, runtime auth); no component is a link, so
    // only the link count gives it away. Anything the agent keeps here has one.
    if (info.nlink > 1) throw workspaceFileNotFound();
    const after = await lstatWithoutLinks(workspaceDir, parts);
    if (!after || !sameFile(info, after)) throw workspaceFileNotFound();

    const ext = path.extname(resolved).toLowerCase();
    if (WORKSPACE_TEXT_EXTENSIONS.has(ext) || ext === "") {
      if (info.size > WORKSPACE_TEXT_FILE_MAX_BYTES) throw new Error("File too large");
      const buffer = await readOpenFile(handle, info.size);
      return { content: buffer.toString("utf-8"), binary: false, size: info.size, encoding: "utf-8" };
    }

    const imageMimeType = WORKSPACE_IMAGE_MIME_BY_EXTENSION[ext];
    if (imageMimeType) {
      if (info.size > WORKSPACE_IMAGE_PREVIEW_MAX_BYTES) {
        return { content: null, binary: true, size: info.size, mimeType: imageMimeType };
      }
      const buffer = await readOpenFile(handle, info.size);
      return { content: buffer.toString("base64"), binary: true, size: info.size, mimeType: imageMimeType, encoding: "base64" };
    }

    return { content: null, binary: true, size: info.size };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Up to `size` bytes from the start of an open file (fewer if it shrank since fstat). */
async function readOpenFile(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const { bytesRead } = await handle.read(buffer, read, size - read, read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}
