import { lstatSync } from "node:fs";
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { AGENT_STATE_DIR_NAME, agentStateDir, agentStateFile, readPlainSmallFile, writeAgentStateText } from "./agentStateFiles";
import { RUNTIME_OUTCOME_OUTBOX_DIR_NAME } from "./runtimeOutcomeOutbox";
import path from "node:path";
import { looksLikeUuid, type WorkspaceDirectoryInfo } from "@botiverse/raft-shared";
import { logger } from "./logger";

/** The daemon's own directories beside the workspaces: never listed, read or deleted as one. */
const DAEMON_STATE_DIR_NAMES: ReadonlySet<string> = new Set([RUNTIME_OUTCOME_OUTBOX_DIR_NAME, AGENT_STATE_DIR_NAME]);

export interface AgentWorkspaceSeedFile {
  relativePath: string;
  content: string;
}

export async function initializeAgentWorkspace(
  workspacePath: string,
  initialMemoryMd: string,
  seedFiles: AgentWorkspaceSeedFile[],
  envVars?: Record<string, string> | null,
): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  const memoryMdPath = path.join(workspacePath, "MEMORY.md");
  try {
    await access(memoryMdPath);
  } catch {
    await writeFile(memoryMdPath, initialMemoryMd);
  }

  await mkdir(path.join(workspacePath, "notes"), { recursive: true });
  for (const { relativePath, content } of seedFiles) {
    const fullPath = path.join(workspacePath, relativePath);
    try {
      await access(fullPath);
    } catch {
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }
  }
}

// Containment, not a blocklist. The previous guard rejected "/", "\\" and ".." -- every
// traversal string and nothing else -- so it let through "." and "", which path.join
// collapses to `dataDir` itself. A request naming one workspace then deleted the root
// holding every agent workspace on the machine, and reported ordinary success.
//
// A blocklist can only reject the inputs its author anticipated. Resolving the path and
// asserting it is strictly below `dataDir` rejects the whole class instead, including
// the members nobody has thought of yet.
export function resolveWorkspaceDirectoryPath(dataDir: string, directoryName: string): string | null {
  const root = path.resolve(dataDir);
  const target = path.resolve(root, directoryName);
  // Exactly one level below the root. `dirname === root` rejects the root itself
  // ("." and ""), anything above it ("..", "../x"), and any nested path
  // ("nested/agent-1") in a single comparison -- workspace names are agent ids and
  // are always a single segment.
  // Case-insensitive and without trailing dots or spaces: on macOS and Windows those name the same directory.
  const name = path.basename(target).toLowerCase().replace(/[. ]+$/, "");
  if (path.dirname(target) !== root || DAEMON_STATE_DIR_NAMES.has(name)) {
    return null;
  }
  return target;
}

interface WorkspaceDirectorySummary {
  totalSizeBytes: number;
  fileCount: number;
  latestMtime: Date;
}

function emptyWorkspaceDirectorySummary(latestMtime = new Date(0)): WorkspaceDirectorySummary {
  return {
    totalSizeBytes: 0,
    fileCount: 0,
    latestMtime,
  };
}

function mergeWorkspaceDirectorySummaries(
  base: WorkspaceDirectorySummary,
  next: WorkspaceDirectorySummary,
): WorkspaceDirectorySummary {
  return {
    totalSizeBytes: base.totalSizeBytes + next.totalSizeBytes,
    fileCount: base.fileCount + next.fileCount,
    latestMtime: next.latestMtime > base.latestMtime ? next.latestMtime : base.latestMtime,
  };
}

async function summarizeWorkspaceEntry(entryPath: string, entry: { isDirectory(): boolean; isFile(): boolean }): Promise<WorkspaceDirectorySummary> {
  try {
    const info = await stat(entryPath);
    if (entry.isDirectory()) {
      return summarizeWorkspaceDirectory(entryPath);
    }

    if (entry.isFile()) {
      return {
        totalSizeBytes: info.size,
        fileCount: 1,
        latestMtime: info.mtime,
      };
    }

    return emptyWorkspaceDirectorySummary(info.mtime);
  } catch {
    return emptyWorkspaceDirectorySummary();
  }
}

async function summarizeWorkspaceDirectory(dirPath: string): Promise<WorkspaceDirectorySummary> {
  let summary = emptyWorkspaceDirectorySummary();
  try {
    const rootInfo = await stat(dirPath);
    summary = emptyWorkspaceDirectorySummary(rootInfo.mtime);
  } catch {
    return summary;
  }

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return summary;
  }

  const childSummaries = await Promise.all(
    entries.map((entry) => summarizeWorkspaceEntry(path.join(dirPath, entry.name), entry)),
  );

  for (const childSummary of childSummaries) {
    summary = mergeWorkspaceDirectorySummaries(summary, childSummary);
  }

  return summary;
}

/** `~/…` for a path under the user's home, else the absolute path; trailing separator marks a directory. */
export function workspaceDisplayPath(dirPath: string, homeDir: string = os.homedir()): string {
  const resolved = path.resolve(dirPath);
  const home = path.resolve(homeDir);
  const prefix = `${home}${path.sep}`;
  const shown = resolved.startsWith(prefix) ? `~/${resolved.slice(prefix.length).split(path.sep).join("/")}` : resolved;
  return `${shown}/`;
}

export async function scanWorkspaceDirectories(dataDir: string): Promise<WorkspaceDirectoryInfo[]> {
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<WorkspaceDirectoryInfo | null> => {
      // RFC 071's outbox and the agents' daemon state live beside the workspaces; they are not ones.
      if (!entry.isDirectory() || DAEMON_STATE_DIR_NAMES.has(entry.name)) {
        return null;
      }

      const dirPath = path.join(dataDir, entry.name);
      try {
        const summary = await summarizeWorkspaceDirectory(dirPath);
        return {
          directoryName: entry.name,
          totalSizeBytes: summary.totalSizeBytes,
          lastModified: summary.latestMtime.toISOString(),
          fileCount: summary.fileCount,
          displayPath: workspaceDisplayPath(dirPath),
        } satisfies WorkspaceDirectoryInfo;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((entry): entry is WorkspaceDirectoryInfo => entry !== null);
}

/**
 * Which server's daemon last started an agent in its workspace:
 * `<agents dir>/.agent-state/<agentId>/workspace-owner.json`, `{"v":1,"serverId":"..."}`.
 *
 * The agents dir is shared by every server's daemon on a Computer, and a
 * `machine:workspace:delete` names a directory only. The marker lets a daemon
 * refuse to delete a workspace another server's agent uses. It lives in the
 * daemon's per-agent state, beside the workspaces and inside none of them
 * (agentStateFiles.ts: a file the daemon writes inside a workspace can be
 * redirected by a link the agent plants), so it is never in the agent's git
 * or file tree either.
 */
export const WORKSPACE_OWNER_MARKER_FILE = "workspace-owner.json";
const WORKSPACE_OWNER_MARKER_MAX_BYTES = 4 * 1024;

/** The server named by an agent's workspace owner marker; null when there is none, or it cannot be read or parsed. */
export function readWorkspaceOwnerServerId(agentsDir: string, agentId: string): string | null {
  const text = readPlainSmallFile(path.join(agentStateDir(agentsDir, agentId), WORKSPACE_OWNER_MARKER_FILE), WORKSPACE_OWNER_MARKER_MAX_BYTES);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { serverId?: unknown } | null;
    return parsed && typeof parsed === "object" && typeof parsed.serverId === "string" && parsed.serverId.length > 0
      ? parsed.serverId
      : null;
  } catch {
    return null;
  }
}

/** Record that `serverId`'s daemon runs the agent in its workspace. Rewritten only when it names another server. */
export function writeWorkspaceOwnerMarker(agentsDir: string, agentId: string, serverId: string): void {
  if (readWorkspaceOwnerServerId(agentsDir, agentId) === serverId) return;
  writeAgentStateText(
    agentStateFile(agentsDir, agentId, WORKSPACE_OWNER_MARKER_FILE),
    `${JSON.stringify({ v: 1, serverId })}\n`,
  );
}

function workspaceOwnerMarkerExists(agentsDir: string, agentId: string): boolean {
  try {
    lstatSync(path.join(agentStateDir(agentsDir, agentId), WORKSPACE_OWNER_MARKER_FILE));
    return true;
  } catch {
    return false;
  }
}

/** What a workspace delete must know about this daemon. */
export interface WorkspaceDeleteGuard {
  /** The server this daemon serves; null when not known (then a workspace with an owner marker is kept). */
  serverId: string | null;
  /** The agent runs (or is starting) in this daemon right now. */
  isAgentRunning: (agentId: string) => boolean;
}

export type WorkspaceDeleteRefusal =
  | "not_agent_id"
  | "outside_data_dir"
  | "agent_running"
  | "owner_server_unknown"
  | "owner_server_mismatch";

/**
 * Why `directoryName` must not be deleted, or null when it may be. The agents
 * dir is shared by every server's daemon on the Computer, so this daemon is
 * the last check against a wrong or older server: the name must be an agent
 * id (a UUID), the agent must not run here, and when the workspace has an
 * owner marker it must name this daemon's server. A workspace without a
 * readable marker (made before markers existed) is judged on the first two.
 */
export function workspaceDeleteRefusal(
  dataDir: string,
  directoryName: string,
  guard: WorkspaceDeleteGuard,
): WorkspaceDeleteRefusal | null {
  if (!looksLikeUuid(directoryName)) return "not_agent_id";
  if (!resolveWorkspaceDirectoryPath(dataDir, directoryName)) return "outside_data_dir";
  const ids = new Set([directoryName, directoryName.toLowerCase()]);
  if ([...ids].some((id) => guard.isAgentRunning(id))) return "agent_running";
  const owner = readWorkspaceOwnerServerId(dataDir, directoryName);
  if (owner !== null) {
    if (guard.serverId === null) return "owner_server_unknown";
    if (owner !== guard.serverId) return "owner_server_mismatch";
  } else if (workspaceOwnerMarkerExists(dataDir, directoryName)) {
    logger.warn(`[Workspace] Owner marker of ${JSON.stringify(directoryName)} is unreadable; deciding the delete without it`);
  }
  return null;
}

export async function deleteWorkspaceDirectory(
  dataDir: string,
  directoryName: string,
  guard: WorkspaceDeleteGuard,
): Promise<boolean> {
  const refusal = workspaceDeleteRefusal(dataDir, directoryName, guard);
  if (refusal) {
    logger.warn(`[Workspace] Refused to delete workspace directory ${JSON.stringify(directoryName.slice(0, 80))}: ${refusal}`);
    return false;
  }
  const targetDir = resolveWorkspaceDirectoryPath(dataDir, directoryName);
  if (!targetDir) {
    return false;
  }
  try {
    await rm(targetDir, { recursive: true, force: true });
    logger.info(`[Workspace] Deleted directory: ${targetDir}`);
    return true;
  } catch (err) {
    logger.error(`[Workspace] Failed to delete directory ${targetDir}`, err);
    return false;
  }
}
