import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { writeAgentStateText } from "../agentStateFiles";

/**
 * View Context v0: the daemon's per-agent send index, under the Raft home and
 * inside no agent workspace (as `.agent-state`): an agent cannot plant a
 * link there.
 *
 *   <raftHome>/agent-context/<serverId>/<encodeURIComponent(agentId)>/index.jsonl
 *   <raftHome>/agent-context/<serverId>/<encodeURIComponent(agentId)>/off-since
 *   <raftHome>/agent-context/<serverId>/<encodeURIComponent(agentId)>/pi-requests/<sessionId>.jsonl (`piRequestLog.ts`)
 *
 * One directory per server: a Raft Computer runs one daemon per attached
 * server, all on one Raft home, and each server's flag gates (and its daemon
 * sweeps) only that server's agents. Every function here takes a
 * `ContextViewServerDir`, which only `contextViewServerDir` makes (from a
 * server id that is a plain path segment), so nothing reaches another
 * server's data or a path outside a server's directory.
 *
 * `index.jsonl` gets one line per message the agent sent while the feature
 * was on (`ContextViewIndexLine`). `off-since` holds the time the feature was
 * first seen off; the directory is removed once that is
 * `AGENT_CONTEXT_VIEW_OFF_GRACE_MS` old (a flag read that blips off must not
 * lose the data), and the marker is removed when the feature is seen on again.
 * Directories are 0700, files 0600; nothing is opened through a link.
 */
export const AGENT_CONTEXT_DIR_NAME = "agent-context";
export const PI_REQUEST_LOG_DIR_NAME = "pi-requests";
const INDEX_FILE = "index.jsonl";
const OFF_SINCE_FILE = "off-since";

/** The data is kept until the feature has been off this long without a break. */
export const AGENT_CONTEXT_VIEW_OFF_GRACE_MS = 24 * 60 * 60 * 1000;
/** Above this the index is cut to its newest lines that fit (a bound, not an expected size: ~250 bytes a send). */
export const AGENT_CONTEXT_INDEX_MAX_BYTES = 8 * 1024 * 1024;

export const CONTEXT_VIEW_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
export const CONTEXT_VIEW_APPEND_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** One message the agent sent, and where its session stood at that moment. */
export interface ContextViewIndexLine {
  messageId: string;
  /** ISO 8601. */
  sentAt: string;
  /** Raft runtime id. */
  runtime: string;
  sessionId: string;
  /** The session file, relative to the runtime's session root (Claude: `<home>/.claude/projects`). */
  transcript: string;
  /** The session file's byte length when the send was answered. */
  offset: number;
}

declare const contextViewServerDirBrand: unique symbol;
/** `<raftHome>/agent-context/<serverId>`: one server's View Context data. Made only by `contextViewServerDir`. */
export type ContextViewServerDir = string & { readonly [contextViewServerDirBrand]: true };

/** A server id usable as one path segment (as the Computer's `computer/servers/<serverId>`). */
const SERVER_ID_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export function isContextViewServerId(serverId: unknown): serverId is string {
  return typeof serverId === "string" && SERVER_ID_SEGMENT.test(serverId);
}

export function agentContextRoot(raftHome: string): string {
  return path.join(raftHome, AGENT_CONTEXT_DIR_NAME);
}

/** The server's data directory; null when the id is not a plain path segment (no data for it). */
export function contextViewServerDir(raftHome: string, serverId: string | null | undefined): ContextViewServerDir | null {
  if (!isContextViewServerId(serverId)) return null;
  return path.join(agentContextRoot(raftHome), serverId) as ContextViewServerDir;
}

export function agentContextDir(serverDir: ContextViewServerDir, agentId: string): string {
  // encodeURIComponent leaves "." and ".." as they are; neither is an agent id.
  if (agentId === "" || agentId === "." || agentId === "..") throw new Error("not an agent id");
  return path.join(serverDir, encodeURIComponent(agentId));
}

/** A directory the daemon made, not a link to one. */
function isOwnDir(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The agent's directory, when both it and its server's directory are plain directories. */
function isOwnAgentDir(serverDir: ContextViewServerDir, agentId: string): boolean {
  return isOwnDir(serverDir) && isOwnDir(agentContextDir(serverDir, agentId));
}

function ensureAgentDir(serverDir: ContextViewServerDir, agentId: string): string {
  const dir = agentContextDir(serverDir, agentId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isOwnAgentDir(serverDir, agentId)) throw new Error("agent context directory is not a plain directory");
  return dir;
}

/** A plain file's bytes (no link followed), up to `maxBytes`; null when absent; throws on anything else. */
function readPlainFile(file: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(file, CONTEXT_VIEW_READ_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("not a plain file");
    const size = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Where a runtime hosted in this daemon records its model requests, inside the agent's own directory. */
export function ensureContextViewRequestLogDir(serverDir: ContextViewServerDir, agentId: string): string {
  const dir = path.join(ensureAgentDir(serverDir, agentId), PI_REQUEST_LOG_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isOwnDir(dir)) throw new Error("request log directory is not a plain directory");
  return dir;
}

export function isContextViewIndexLine(value: unknown): value is ContextViewIndexLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.messageId === "string" && v.messageId.length > 0
    && typeof v.sentAt === "string" && !Number.isNaN(Date.parse(v.sentAt))
    && typeof v.runtime === "string"
    && typeof v.sessionId === "string"
    && typeof v.transcript === "string"
    && typeof v.offset === "number" && Number.isSafeInteger(v.offset) && v.offset >= 0;
}

/** Append one line (creating the directory and file as needed). */
export function appendContextViewIndexLine(serverDir: ContextViewServerDir, agentId: string, line: ContextViewIndexLine): void {
  const dir = ensureAgentDir(serverDir, agentId);
  const fd = openSync(path.join(dir, INDEX_FILE), CONTEXT_VIEW_APPEND_FLAGS, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("index is not a plain file");
    writeSync(fd, `${JSON.stringify(line)}\n`);
  } finally {
    closeSync(fd);
  }
}

/** Every well-formed line of the agent's index, oldest first; empty when there is none. */
export function readContextViewIndex(serverDir: ContextViewServerDir, agentId: string): ContextViewIndexLine[] {
  const buffer = readPlainFile(path.join(agentContextDir(serverDir, agentId), INDEX_FILE), AGENT_CONTEXT_INDEX_MAX_BYTES * 2);
  if (!buffer) return [];
  const lines: ContextViewIndexLine[] = [];
  for (const text of buffer.toString("utf8").split("\n")) {
    if (!text) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (isContextViewIndexLine(value)) lines.push(value);
    } catch {
      // a torn line (crash mid-append) is skipped
    }
  }
  return lines;
}

/** The first line for this message (a send reconciled later may be indexed twice; the first is the send). */
export function findContextViewIndexLine(serverDir: ContextViewServerDir, agentId: string, messageId: string): ContextViewIndexLine | null {
  return readContextViewIndex(serverDir, agentId).find((line) => line.messageId === messageId) ?? null;
}

export interface ContextViewIndexCompaction {
  kept: number;
  dropped: number;
  /** `sentAt` of the oldest kept line; null when none is kept. */
  oldestSentAt: string | null;
}

/**
 * Drop lines sent before `cutoffMs` (and the oldest ones beyond the size
 * bound); the file is rewritten only when something is dropped, and removed
 * when nothing is left.
 */
export function compactContextViewIndex(serverDir: ContextViewServerDir, agentId: string, cutoffMs: number): ContextViewIndexCompaction {
  const file = path.join(agentContextDir(serverDir, agentId), INDEX_FILE);
  const lines = readContextViewIndex(serverDir, agentId);
  let kept = lines.filter((line) => Date.parse(line.sentAt) >= cutoffMs);
  let bytes = kept.reduce((sum, line) => sum + Buffer.byteLength(JSON.stringify(line)) + 1, 0);
  while (bytes > AGENT_CONTEXT_INDEX_MAX_BYTES && kept.length > 0) {
    bytes -= Buffer.byteLength(JSON.stringify(kept[0])) + 1;
    kept = kept.slice(1);
  }
  const dropped = lines.length - kept.length;
  if (dropped > 0) {
    if (kept.length === 0) rmSync(file, { force: true });
    else writeAgentStateText(file, kept.map((line) => `${JSON.stringify(line)}\n`).join(""));
  }
  return { kept: kept.length, dropped, oldestSentAt: kept[0]?.sentAt ?? null };
}

/** When the feature was first seen off for this agent (ms), or null when it is not marked off. */
export function readContextViewOffSince(serverDir: ContextViewServerDir, agentId: string): number | null {
  try {
    const buffer = readPlainFile(path.join(agentContextDir(serverDir, agentId), OFF_SINCE_FILE), 256);
    if (!buffer) return null;
    const at = Date.parse(buffer.toString("utf8").trim());
    // An unreadable marker still means "off": count from the epoch, so it is removed at the next sweep.
    return Number.isNaN(at) ? 0 : at;
  } catch {
    return 0;
  }
}

/** Mark the agent's data as off since `nowMs`, unless already marked (the first time it was seen off counts). Only when it has data. */
export function markContextViewOff(serverDir: ContextViewServerDir, agentId: string, nowMs: number): boolean {
  if (!isOwnAgentDir(serverDir, agentId)) return false;
  const dir = agentContextDir(serverDir, agentId);
  if (readContextViewOffSince(serverDir, agentId) !== null) return false;
  writeAgentStateText(path.join(dir, OFF_SINCE_FILE), new Date(nowMs).toISOString());
  return true;
}

/** The feature is on again: keep the data. */
export function clearContextViewOff(serverDir: ContextViewServerDir, agentId: string): boolean {
  if (!isOwnAgentDir(serverDir, agentId)) return false;
  const file = path.join(agentContextDir(serverDir, agentId), OFF_SINCE_FILE);
  try {
    lstatSync(file);
  } catch {
    return false;
  }
  rmSync(file, { force: true });
  return true;
}

export function hasContextViewData(serverDir: ContextViewServerDir, agentId: string): boolean {
  return isOwnAgentDir(serverDir, agentId);
}

export function removeContextViewData(serverDir: ContextViewServerDir, agentId: string): void {
  // Through a linked server directory this would remove what the link points at.
  if (!isOwnDir(serverDir)) return;
  rmSync(agentContextDir(serverDir, agentId), { recursive: true, force: true });
}

/** This server's agents with a directory (decoded ids); empty when the server has none. Never another server's. */
export function listContextViewAgents(serverDir: ContextViewServerDir): string[] {
  if (!isOwnDir(path.dirname(serverDir)) || !isOwnDir(serverDir)) return [];
  let names: string[];
  try {
    names = readdirSync(serverDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    let id: string;
    try {
      id = decodeURIComponent(name);
    } catch {
      continue;
    }
    if (id === "" || id === "." || id === ".." || encodeURIComponent(id) !== name) continue;
    if (isOwnDir(path.join(serverDir, name))) ids.push(id);
  }
  return ids;
}
