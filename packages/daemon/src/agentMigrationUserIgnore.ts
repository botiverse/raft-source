import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isPortableAbsolutePath } from "@botiverse/raft-shared/src/agentMigrationBundleReader";
import {
  MAX_AGENT_MIGRATION_USER_IGNORE_PATH_BYTES,
  MAX_AGENT_MIGRATION_USER_IGNORE_RECEIPT_REJECTED,
  MIGRATION_USER_IGNORE_WRITE_FAILED,
  readAgentMigrationUserIgnoreAdditions,
  type AgentMigrationTransportLeaseMessage,
  type AgentMigrationUserIgnoreAdditionsReceipt,
  type AgentMigrationUserIgnoreRejectReason,
  type AgentMigrationUserIgnoreWriteFailureReason,
} from "@botiverse/raft-shared";
import { AGENT_MIGRATION_USER_IGNORE_FILE, parseAgentMigrationIgnoreLine } from "./agentMigrationExport";

/** The source fails the migration with this; its message is `MIGRATION_USER_IGNORE_WRITE_FAILED:<reason>`. */
export class AgentMigrationUserIgnoreWriteError extends Error {
  constructor(readonly reason: AgentMigrationUserIgnoreWriteFailureReason) {
    super(`${MIGRATION_USER_IGNORE_WRITE_FAILED}:${reason}`);
    this.name = "AgentMigrationUserIgnoreWriteError";
  }
}

export interface AgentMigrationUserIgnoreWriteOutcome {
  receipt: AgentMigrationUserIgnoreAdditionsReceipt;
  /** Every rejected path; the receipt lists only the first few. */
  rejectedCount: number;
}

// No symlink is followed on open (where the platform has O_NOFOLLOW; the lstat
// before it covers the others), and a FIFO cannot block the read.
const READ_EXISTING_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
const ADDED_BY_MAX_CHARS = 64;
const ADDED_BY_FALLBACK = "someone";
// C0/C1 controls (\r \n \t among them) and the Unicode line/paragraph separators.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const CONTROL_CHAR = new RegExp(CONTROL_CHARS.source);

/**
 * Appends the source lease's `userIgnoreAdditions` to the workspace's
 * `.raftbackupignore.user`, before the export reads the ignore files. Each path
 * goes through the reader's own line rule (parseAgentMigrationIgnoreLine) and
 * is written in the form the reader applies, so a written line means exactly
 * that; a line the file already has is counted, not written again (a re-sent
 * lease writes nothing). Null when the lease has nothing to write. Throws
 * AgentMigrationUserIgnoreWriteError, and then the migration must not pack.
 */
export async function writeAgentMigrationUserIgnoreAdditions(input: {
  workspacePath: string;
  lease: Pick<AgentMigrationTransportLeaseMessage, "role" | "userIgnoreAdditions">;
  now: Date;
}): Promise<AgentMigrationUserIgnoreWriteOutcome | null> {
  const read = readAgentMigrationUserIgnoreAdditions(input.lease);
  if (read.kind === "absent") return null;
  if (read.kind === "invalid") throw new AgentMigrationUserIgnoreWriteError("invalid");
  const { additions } = read;
  if (additions.paths.length === 0) return null;

  const workspace = path.resolve(input.workspacePath);
  const filePath = path.join(workspace, AGENT_MIGRATION_USER_IGNORE_FILE);
  const existing = await readExistingUserIgnoreFile(filePath);

  const present = new Set<string>();
  for (const line of existing.text.split(/\r?\n/)) {
    const key = ignoreLineKey(line, workspace);
    if (typeof key === "string") present.add(key);
  }
  const added: string[] = [];
  const rejected: AgentMigrationUserIgnoreAdditionsReceipt["rejected"] = [];
  let rejectedCount = 0;
  let alreadyPresent = 0;
  for (const value of additions.paths) {
    const key = ignoreLineKey(value, workspace, { strict: true });
    if (typeof key !== "string") {
      rejectedCount += 1;
      if (rejected.length < MAX_AGENT_MIGRATION_USER_IGNORE_RECEIPT_REJECTED) {
        rejected.push({ path: value.slice(0, MAX_AGENT_MIGRATION_USER_IGNORE_PATH_BYTES), reason: key.rejected });
      }
      continue;
    }
    if (present.has(key)) {
      alreadyPresent += 1;
      continue;
    }
    present.add(key);
    added.push(key);
  }
  const outcome = { receipt: { written: added.length, alreadyPresent, rejected }, rejectedCount };
  if (added.length === 0) {
    if (alreadyPresent === 0) throw new AgentMigrationUserIgnoreWriteError("all_rejected");
    return outcome;
  }

  const base = existing.text && !existing.text.endsWith("\n") ? `${existing.text}\n` : existing.text;
  const comment = `# added by ${sanitizeAddedBy(additions.addedBy)} at ${addedAtIso(additions.addedAt, input.now)} (Raft)`;
  const content = `${base}${base ? "\n" : ""}${comment}\n${added.join("\n")}\n`;
  await replaceFileAtomically(filePath, content, existing.mode);
  return outcome;
}

/**
 * The line as the reader applies it (`**\/<name>` or a normalized path), or
 * why it is not applied. `strict` (a line Raft is about to write) also refuses
 * what the reader would tolerate in a hand-edited file: an absolute path, and
 * characters that would break the line or hide in it.
 */
function ignoreLineKey(
  line: string,
  workspace: string,
  options: { strict?: boolean } = {},
): string | { rejected: AgentMigrationUserIgnoreRejectReason } {
  if (options.strict && (CONTROL_CHAR.test(line) || isPortableAbsolutePath(line.trim()))) {
    return { rejected: "invalid_line" };
  }
  const parsed = parseAgentMigrationIgnoreLine(line, workspace, true);
  switch (parsed.kind) {
    case "path":
      // Written as is, `#name` would read back as a comment (`./#name` is how a hand-edited file says it).
      return options.strict && parsed.path.startsWith("#") ? { rejected: "invalid_line" } : parsed.path;
    case "directoryName":
      return `**/${parsed.name}`;
    case "forcedKeep":
      return { rejected: "forced_keep" };
    case "skipped":
      return { rejected: "invalid_line" };
  }
}

async function readExistingUserIgnoreFile(filePath: string): Promise<{ text: string; mode: number }> {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { text: "", mode: 0o644 };
    throw new AgentMigrationUserIgnoreWriteError("write_failed");
  }
  if (stat.isSymbolicLink()) throw new AgentMigrationUserIgnoreWriteError("symlink");
  if (!stat.isFile()) throw new AgentMigrationUserIgnoreWriteError("not_regular_file");
  // Read through a handle checked by fstat: a symlink swapped in after the lstat is not followed.
  let handle;
  try {
    handle = await open(filePath, READ_EXISTING_FLAGS);
  } catch (err) {
    throw new AgentMigrationUserIgnoreWriteError((err as NodeJS.ErrnoException).code === "ELOOP" ? "symlink" : "write_failed");
  }
  try {
    let opened;
    try {
      opened = await handle.stat();
    } catch {
      throw new AgentMigrationUserIgnoreWriteError("write_failed");
    }
    if (!opened.isFile()) throw new AgentMigrationUserIgnoreWriteError("not_regular_file");
    try {
      return { text: await handle.readFile("utf8"), mode: opened.mode & 0o777 };
    } catch {
      throw new AgentMigrationUserIgnoreWriteError("write_failed");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Temp file in the same directory, fsync, rename over: a crash leaves the old or the new file whole. */
async function replaceFileAtomically(filePath: string, content: string, mode: number): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tempPath, "wx", mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
  } catch {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new AgentMigrationUserIgnoreWriteError("write_failed");
  }
}

/** One line of display text: no control characters or line breaks, trimmed, at most 64 characters. */
export function sanitizeAddedBy(value: string): string {
  const cleaned = Array.from(value.replace(CONTROL_CHARS, "").trim()).slice(0, ADDED_BY_MAX_CHARS).join("").trim();
  return cleaned || ADDED_BY_FALLBACK;
}

function addedAtIso(value: string, now: Date): string {
  const ms = Date.parse(value);
  return new Date(Number.isFinite(ms) ? ms : now.getTime()).toISOString();
}
