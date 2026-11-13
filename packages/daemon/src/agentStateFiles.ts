import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The daemon's own per-agent records (standing-prompt ledger, compaction
 * failures): `<agents dir>/.agent-state/<agentId>/<name>`, beside the agent
 * workspaces and inside none of them, as the runtime outcome outbox.
 *
 * They used to live in each workspace's `.raft/`. A file the daemon writes
 * inside a workspace can be redirected by a symlink the agent plants (the
 * predictable `<file>.<pid>.tmp`, or `.raft` itself), so the daemon would
 * overwrite a file outside the workspace with its own rights, which a
 * sandboxed runtime must not be able to cause (Tenny, #12626 review).
 *
 * The old standing-prompt record is read once, when an agent's state
 * directory is first created: without it a resume plans `baseline_unknown`
 * and would miss a pending prompt update. Agent migration forces a cold
 * session, so a stale carried copy cannot matter. Remove the carry-over once
 * every Computer has run a release with it. The old compaction-failure count is dropped: a
 * stale one could refuse a session a later compaction had cleared, and
 * losing a count costs at most a few more failed compactions. The daemon
 * never reads or writes the old files otherwise; they stay where they are.
 *
 * Agent migration does not carry this directory: both records are caches.
 */
export const AGENT_STATE_DIR_NAME = ".agent-state";

/** Records carried over from the workspace's `.raft/`, once, at an agent's first access. */
const LEGACY_WORKSPACE_RECORDS = ["standing-prompt.json"] as const;
const LEGACY_RECORD_MAX_BYTES = 64 * 1024;
/** One open, checked on the open file: no link followed, no FIFO waited on, nothing swapped between a check and the read. */
const LEGACY_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

export function agentStateDir(agentsDir: string, agentId: string): string {
  // encodeURIComponent leaves "." and ".." as they are; neither is an agent id.
  if (agentId === "" || agentId === "." || agentId === "..") throw new Error("not an agent id");
  return path.join(agentsDir, AGENT_STATE_DIR_NAME, encodeURIComponent(agentId));
}

/** A plain file's text, up to `maxBytes`; null for anything else (a link, a FIFO, a device, too large). */
function readPlainSmallFile(file: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(file, LEGACY_OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < info.size) {
      const n = readSync(fd, buffer, read, info.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The agent's state directory, created (and its old workspace records carried over) on first use. */
function ensureAgentStateDir(agentsDir: string, agentId: string): string {
  const dir = agentStateDir(agentsDir, agentId);
  if (existsSync(dir)) return dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of LEGACY_WORKSPACE_RECORDS) {
    const text = readPlainSmallFile(path.join(agentsDir, agentId, ".raft", name), LEGACY_RECORD_MAX_BYTES);
    if (text === null) continue;
    try {
      writeAgentStateText(path.join(dir, name), text);
    } catch {
      // Not carried over: the agent starts without that record.
    }
  }
  return dir;
}

export function agentStateFile(agentsDir: string, agentId: string, name: string): string {
  return path.join(ensureAgentStateDir(agentsDir, agentId), name);
}

/** Write through a fresh temp file nobody can guess, created exclusively, then rename. */
export function writeAgentStateText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
