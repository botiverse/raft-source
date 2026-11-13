import { isPiRequestLogRuntime } from "./piRequestLog";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathWithinAllowedRoots } from "../sessionTranscriptReader";

/**
 * A session file larger than this is not read for a context view (`too_large`).
 *
 * A view reads the file into one Buffer and parses every line into objects, so
 * its cost grows with the file, however small the answer is. It runs in its own
 * process with a heap limit (contextViewRestoreRunner.ts), one at a time, so
 * running out of heap fails that view alone. Measured on Claude Code sessions
 * built from a real 28 MiB one with every copy made unique (2026-11-06, one
 * fast host; a 1.2 MB answer each): 141 MiB 0.7 s, 666 MiB RSS; 253 MiB 1.2 s,
 * 918 MiB RSS; 507 MiB 2.4 s, 1.5 GiB RSS, 750 MiB heap. Other readers cost
 * more, measured at 128 MiB only: Pi's 0.5-0.8 GiB RSS, 1 GiB at worst (334k
 * messages); Codex's 0.7-1.4 GiB. Past the heap limit they fail that view.
 */
export const CONTEXT_VIEW_SOURCE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * The heap limit doesn't cover the Buffer, so on a small machine the file is
 * bounded too: a quarter of the machine or container, at most the constant.
 */
export function contextViewSourceMaxBytes(memoryBytes: number = contextViewMemoryBytes()): number {
  return Math.min(CONTEXT_VIEW_SOURCE_MAX_BYTES, Math.floor(memoryBytes / 4));
}

/**
 * The memory a view is sized against: this process's cgroup limit, if it has
 * one, within the machine's. Node reports 2^64 for a cgroup with no limit of
 * its own, or 0 where there are no cgroups. A limit only on a parent cgroup
 * isn't seen here.
 */
export function contextViewMemoryBytes(constrained: number = process.constrainedMemory(), total: number = os.totalmem()): number {
  return constrained > 0 ? Math.min(constrained, total) : total;
}

const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Where a Codex agent's context is read from: the rollouts under its Codex
 * home (`homeDir` for Codex is CODEX_HOME, else ~/.codex), not the home
 * itself, which also holds auth.json, history.jsonl and logs.
 */
export function codexContextSessionRoot(codexHome: string): string {
  return path.join(codexHome, "sessions");
}

/**
 * The session file a relative index path names under `sessionRoot`, or null
 * when the path could leave it (absolute, `..`, not a `.jsonl`).
 */
export function contextViewSessionPath(sessionRoot: string, transcript: string): string | null {
  if (!transcript || path.isAbsolute(transcript) || !transcript.endsWith(".jsonl")) return null;
  const parts = transcript.split(/[\\/]/);
  if (parts.some((part) => part === ".." || part === "." || part === "")) return null;
  const resolved = path.resolve(sessionRoot, transcript);
  const rel = path.relative(path.resolve(sessionRoot), resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** `file` relative to `sessionRoot`, or null when it is not under it. */
export function contextViewRelativeTranscript(sessionRoot: string, file: string): string | null {
  const rel = path.relative(path.resolve(sessionRoot), path.resolve(file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

export type ContextViewSourceRead =
  | { ok: true; buffer: Buffer }
  | { ok: false; failure: "missing" | "rejected" | "too_large" | "read_error" };

/**
 * Read a session file the way the feedback transcript reader does: inside the
 * runtime's allowed roots (after resolving links in its directories), the
 * file itself not a link (symbolic or hard), opened without following one, a plain file, and
 * no larger than the cap.
 */
export async function readContextViewSource(file: string, allowedRoots: readonly string[], maxBytes = contextViewSourceMaxBytes()): Promise<ContextViewSourceRead> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) return { ok: false, failure: "rejected" };
  } catch (error) {
    return { ok: false, failure: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "read_error" };
  }
  if (!(await isPathWithinAllowedRoots(file, [...allowedRoots]))) return { ok: false, failure: "rejected" };
  let handle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, failure: code === "ELOOP" ? "rejected" : code === "ENOENT" ? "missing" : "read_error" };
  }
  try {
    const info = await handle.stat();
    // A hard link may name a file outside the allowed roots; a runtime never
    // hard-links its own session files.
    if (!info.isFile() || info.nlink > 1) return { ok: false, failure: "rejected" };
    if (info.size > maxBytes) return { ok: false, failure: "too_large" };
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < info.size) {
      const { bytesRead } = await handle.read(buffer, read, info.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { ok: true, buffer: buffer.subarray(0, read) };
  } catch (error) {
    // No memory for the Buffer: a retry fails the same way.
    return { ok: false, failure: error instanceof RangeError ? "too_large" : "read_error" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The file's size now (the index offset), without following a link; null when it cannot be had. */
export async function contextViewSourceSize(file: string): Promise<number | null> {
  try {
    const info = await lstat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

const API_REQUEST_MARKER = Buffer.from("\"type\":\"api-request\"", "utf8");
const KIMI_REQUEST_MARKER = Buffer.from("\"type\":\"llm.request\"", "utf8");
const CODEX_TOOLS_MARKER = Buffer.from("\"type\":\"additional_tools\"", "utf8");
const PI_REQUEST_MARKER = Buffer.from("{\"type\":\"request\",", "utf8");
const SUPPORT_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Whether the session file records model requests (Claude: `api-request`
 * records, Claude Code 2.1.30x and later; kimi-sdk: `llm.request`; Pi and
 * Built-in: the daemon's own log, `piRequestLog.ts`; Codex: the
 * `additional_tools` that hold its tool list); only its
 * first 8 MiB are scanned: the first request is written right after the first
 * prompt.
 */
export async function contextViewSessionRecordsRequests(runtime: string, file: string): Promise<boolean> {
  const marker = isPiRequestLogRuntime(runtime) ? PI_REQUEST_MARKER
    : runtime === "kimi-sdk" ? KIMI_REQUEST_MARKER
      : runtime === "codex" ? CODEX_TOOLS_MARKER
        : API_REQUEST_MARKER;
  let handle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch {
    return false;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return false;
    const size = Math.min(info.size, SUPPORT_SCAN_BYTES);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).includes(marker);
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
