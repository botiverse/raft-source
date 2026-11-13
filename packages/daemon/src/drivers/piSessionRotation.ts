import { closeSync, constants as fsConstants, fstatSync, fsyncSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import type { PiSessionSeed, PiSessionSeedRefusal } from "./piSessionSeed";
import type { RuntimeSessionRotationHold } from "./types";

// pi session rotation (pi#10642, plan v2.1 in #wg-memory-usage:f66a5385): the
// rollout knobs, the daemon-owned gates, and the two file steps. The pi
// runtime session (pi.ts) decides when, disposes the old AgentSession and
// resumes; this module holds what does not need the live session.

/** Local off switch; it cannot turn rotation on without the server flag. */
export const PI_SESSION_ROTATION_ENV = "RAFT_PI_SESSION_ROTATION";
/** Session file size a rotation needs, in bytes. */
export const PI_SESSION_ROTATION_MIN_BYTES_ENV = "RAFT_PI_SESSION_ROTATION_MIN_BYTES";
export const DEFAULT_PI_SESSION_ROTATION_MIN_BYTES = 30 * 1024 * 1024;

export interface PiSessionRotationConfig {
  enabled: boolean;
  minBytes: number;
}

/**
 * Rotation runs only when the server turned `pi_session_rotation` on for the
 * agent's server (`AgentConfig.piSessionRotation`). The agent's `env_vars`
 * win over the daemon's process env, as for wake recycle.
 */
export function resolvePiSessionRotationConfig(
  serverEnabled: boolean | null | undefined,
  agentEnvVars: Record<string, string> | null | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): PiSessionRotationConfig {
  const pick = (key: string): string | undefined => agentEnvVars?.[key] ?? processEnv[key];
  const off = /^\s*(0|false|off)\s*$/i.test(pick(PI_SESSION_ROTATION_ENV) ?? "");
  const minBytes = Number.parseInt(pick(PI_SESSION_ROTATION_MIN_BYTES_ENV)?.trim() ?? "", 10);
  return {
    enabled: serverEnabled === true && !off,
    minBytes: Number.isSafeInteger(minBytes) && minBytes > 0 ? minBytes : DEFAULT_PI_SESSION_ROTATION_MIN_BYTES,
  };
}

/** Why a due rotation did not run. Holds keep it due; the rest wait for the next compaction. */
export type PiSessionRotationSkipReason =
  | RuntimeSessionRotationHold
  | "runtime_busy"
  | "user_extension"
  | "below_threshold"
  | "session_file_unreadable";

/**
 * The extension the daemon itself loads into every pi session
 * (createPiCompactionFitExtension). It keeps no session state. pi names an
 * inline extension `<inline:NAME>`.
 */
export const PI_DAEMON_EXTENSION_NAME = "raft-compaction-fit";
const PI_DAEMON_EXTENSION_PATHS: ReadonlySet<string> = new Set([`<inline:${PI_DAEMON_EXTENSION_NAME}>`]);

/**
 * Extensions loaded into the session beyond the daemon's own. The seed keeps
 * the last custom entry per type only for pi's router state; a user extension
 * may fold every entry it wrote (pi's codemode store does), so a session with
 * any is not rotated.
 */
export function countPiUserExtensions(extensions: ReadonlyArray<{ path: string }>): number {
  return extensions.filter((extension) => !PI_DAEMON_EXTENSION_PATHS.has(extension.path)).length;
}

const TRACE_CUSTOM_TYPE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The refusal as trace attrs. A custom type is a pi or extension identifier,
 * not user content; anything outside a short identifier shape is "other".
 */
export function piSessionSeedRefusalTraceAttrs(refusal: PiSessionSeedRefusal): { reason: PiSessionSeedRefusal["reason"]; custom_type?: string } {
  if (refusal.reason !== "unknown_custom_type") return { reason: refusal.reason };
  return { reason: refusal.reason, custom_type: TRACE_CUSTOM_TYPE.test(refusal.customType) ? refusal.customType : "other" };
}

/**
 * The file a resume of `sessionId` opens: the newest-named
 * `<timestamp>_<id>.jsonl` in `sessionDir`. A rotation writes a newer one
 * under the same id before it renames the old one away, so after a crash in
 * between the seed wins; `.jsonl.rotated` and `.jsonl.tmp` never match.
 */
export function newestPiSessionFile(sessionDir: string, sessionId: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return null;
  }
  const suffix = `_${sessionId}.jsonl`;
  // Only a regular file (a symlink to one included): opening a FIFO would
  // block the daemon until a writer appears.
  for (const entry of entries.filter((name) => name.endsWith(suffix)).sort().reverse()) {
    const file = path.join(sessionDir, entry);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // Gone, or a dangling link: the next one.
    }
  }
  return null;
}

/** How far back diagnostics follow a session's `parentSession` chain (plan v2, disk). */
export const PI_SESSION_CHAIN_MAX_DEPTH = 5;
/** A pi session header is one short JSON line; a longer first line is not one. */
const PI_SESSION_HEADER_MAX_BYTES = 64 * 1024;

/**
 * Why the walk back stopped. `root`: the oldest file has no parentSession.
 * The rest are where it refused or could not go on.
 */
export type PiSessionChainEnd =
  | "root"
  | "depth_limit"
  | "missing"
  | "not_a_file"
  | "outside_session_dir"
  | "unexpected_name"
  | "cycle"
  | "unreadable_header";

export interface PiSessionChain {
  /** The files the current one continues, oldest first; the current file is not among them. */
  earlier: string[];
  end: PiSessionChainEnd;
}

/**
 * Opens without following a symlink and without blocking on a FIFO, then
 * checks the open file itself, so nothing can swap the file between a check
 * and the read (Windows has neither flag; it has no FIFOs at a path either).
 */
const HEADER_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

type PiSessionHeaderRead =
  | { kind: "header"; parentSession: string | null }
  | { kind: "missing" | "not_a_file" | "unreadable" };

/** The file's header line: its `parentSession`, or why there is none to read. */
function readPiSessionHeader(file: string): PiSessionHeaderRead {
  let fd: number;
  try {
    fd = openSync(file, HEADER_OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: code === "ENOENT" ? "missing" : code === "ELOOP" ? "not_a_file" : "unreadable" };
  }
  let head: string;
  try {
    if (!fstatSync(fd).isFile()) return { kind: "not_a_file" };
    const buf = Buffer.alloc(PI_SESSION_HEADER_MAX_BYTES);
    const read = readSync(fd, buf, 0, buf.length, 0);
    const newline = buf.subarray(0, read).indexOf(0x0a);
    if (newline < 0 && read === buf.length) return { kind: "unreadable" };
    head = buf.subarray(0, newline < 0 ? read : newline).toString("utf8");
  } catch {
    return { kind: "unreadable" };
  } finally {
    closeSync(fd);
  }
  try {
    const header = JSON.parse(head) as { type?: unknown; parentSession?: unknown } | null;
    if (!header || typeof header !== "object" || header.type !== "session") return { kind: "unreadable" };
    return { kind: "header", parentSession: typeof header.parentSession === "string" && header.parentSession ? header.parentSession : null };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * The files a rotated session continues: from `currentFile`, follow each
 * header's `parentSession` back, at most `maxDepth` files. Diagnostics only;
 * the model context lives in the current file alone. A parent is followed
 * only when it is a regular file directly in the current file's directory
 * named `<timestamp>_<id>.jsonl[.rotated]` for the same id, and not seen yet;
 * anything else ends the walk and says why.
 */
export function piSessionParentChain(currentFile: string, sessionId: string, maxDepth = PI_SESSION_CHAIN_MAX_DEPTH): PiSessionChain {
  const dir = path.dirname(path.resolve(currentFile));
  const names = [`_${sessionId}.jsonl`, `_${sessionId}.jsonl.rotated`];
  const seen = new Set([path.basename(currentFile)]);
  const earlier: string[] = [];
  const done = (end: PiSessionChainEnd): PiSessionChain => ({ earlier: earlier.reverse(), end });
  let header = readPiSessionHeader(currentFile);
  for (;;) {
    if (header.kind !== "header") return done("unreadable_header");
    const parent = header.parentSession;
    if (parent === null) return done("root");
    if (earlier.length >= maxDepth) return done("depth_limit");
    const resolved = path.resolve(dir, parent);
    if (path.dirname(resolved) !== dir) return done("outside_session_dir");
    const name = path.basename(resolved);
    if (!names.some((suffix) => name.length > suffix.length && name.endsWith(suffix))) return done("unexpected_name");
    if (seen.has(name)) return done("cycle");
    header = readPiSessionHeader(resolved);
    if (header.kind === "missing" || header.kind === "not_a_file") return done(header.kind);
    seen.add(name);
    earlier.push(resolved);
  }
}

export type PiSessionRotationFileStage = "write_seed" | "rename_old";

export type PiSessionRotationFilesResult =
  | { ok: true }
  | {
      ok: false;
      stage: PiSessionRotationFileStage;
      error: unknown;
      /**
       * Which file a resume opens now. `old`: nothing a resume reads changed,
       * so the old session stays in place. `seed`: the old file could not be
       * renamed nor the seed removed; as after a crash between the steps, the
       * seed is what a resume opens, so the live session must move to it.
       */
      resumeFrom: "old" | "seed";
    };

/** File operations the steps use; a test seam for failures. */
export interface PiSessionRotationFs {
  writeDurable(file: string, content: string): void;
  rename(from: string, to: string): void;
  remove(file: string): void;
}

const NODE_FS: PiSessionRotationFs = {
  writeDurable(file, content) {
    const fd = openSync(file, "wx");
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
  remove: (file) => rmSync(file, { force: true }),
};

/**
 * Steps 1 and 2 of a rotation. Crash safe because a resume opens the newest
 * `<timestamp>_<id>.jsonl` (findPiSessionFile) and the seed's name sorts after
 * the old one's:
 *  1. the seed is written to a temp name (`.jsonl.tmp` matches no lookup) and
 *     renamed into place; a crash after it leaves both files, and the resume
 *     takes the seed, which rebuilds the same context;
 *  2. the old file is renamed `.jsonl.rotated`.
 * If step 2 fails the seed is removed again, so the old session keeps running
 * on the file a resume would open (`resumeFrom: "old"`). If that removal fails
 * too, the seed is what a resume opens (`resumeFrom: "seed"`).
 */
export function writePiSessionRotationFiles(seed: PiSessionSeed, oldFile: string, fs: PiSessionRotationFs = NODE_FS): PiSessionRotationFilesResult {
  const temp = `${seed.seedFile}.tmp`;
  try {
    fs.writeDurable(temp, seed.content);
    fs.rename(temp, seed.seedFile);
  } catch (error) {
    try {
      fs.remove(temp);
    } catch {
      // A leftover `.jsonl.tmp` matches no lookup.
    }
    return { ok: false, stage: "write_seed", error, resumeFrom: "old" };
  }
  try {
    fs.rename(oldFile, seed.rotatedOldFile);
  } catch (error) {
    try {
      fs.remove(seed.seedFile);
    } catch {
      return { ok: false, stage: "rename_old", error, resumeFrom: "seed" };
    }
    return { ok: false, stage: "rename_old", error, resumeFrom: "old" };
  }
  return { ok: true };
}

/**
 * Undo steps 2 and 1 after the resume failed, so the old session (still live:
 * a resume opens the seed before it lets the old session go) keeps running on
 * the file a resume opens. False when either rename or removal fails: the
 * seed is then what a resume opens, and the old session must not go on.
 */
export function undoPiSessionRotationFiles(seed: PiSessionSeed, oldFile: string, fs: PiSessionRotationFs = NODE_FS): boolean {
  try {
    fs.rename(seed.rotatedOldFile, oldFile);
    fs.remove(seed.seedFile);
    return true;
  } catch {
    return false;
  }
}
