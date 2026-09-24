import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Local message state directory is not owned by this user");
  }
  fs.chmodSync(directory, 0o700);
}

function configuredHome(): string | undefined {
  for (const name of ["RAFT_HOME", "SLOCK_HOME"]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function privateStatePath(baseOverride: string | undefined, namespace: string, agentId: string, filename: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error("Invalid local state agent identity");
  const base = baseOverride?.trim() || configuredHome() || path.join(os.homedir(), ".slock");
  // The user-data root is shared with the daemon, Computer and profiles and may
  // be a symlink; only the namespaces this module owns are hardened.
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const namespaceDir = path.join(base, namespace);
  privateDirectory(namespaceDir);
  const directory = path.join(namespaceDir, agentId);
  privateDirectory(directory);
  return path.join(directory, filename);
}

export function readPrivateState(filePath: string): string {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error("Unsafe local message state file");
    }
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

export function writePrivateState(filePath: string, content: string): void {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Rename replaces a pre-existing leaf symlink without following it.
    fs.renameSync(temporary, filePath);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Where the pre-hardening CLI kept this state: the shared OS tmpdir. When an
 * explicit base override is set, old and new layouts share the same base, so
 * there is nothing to import. */
export function legacyStatePath(baseOverride: string | undefined, namespace: string, agentId: string, filename: string): string | null {
  if (baseOverride?.trim()) return null;
  return path.join(os.tmpdir(), namespace, agentId, filename);
}

const LEGACY_STATE_MAX_BYTES = 1024 * 1024;

/** One-time import of state written by the pre-hardening layout. The legacy
 * file lived in a world-readable directory, so it is only trusted when it is a
 * regular file owned by this user (no symlink following), small, and valid
 * JSON; it is then rewritten into the private location and the shared copy is
 * removed. Anything else is left alone and reported as rejected. */
export function importLegacyPrivateState(legacyPath: string, filePath: string): "imported" | "absent" | "rejected" {
  let fd: number;
  try {
    fd = fs.openSync(legacyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return "absent";
  }
  let content: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || stat.size > LEGACY_STATE_MAX_BYTES) return "rejected";
    content = fs.readFileSync(fd, "utf8");
    JSON.parse(content);
  } catch {
    return "rejected";
  } finally {
    fs.closeSync(fd);
  }
  writePrivateState(filePath, content);
  try { fs.rmSync(legacyPath, { force: true }); } catch { /* the private copy is authoritative from here on */ }
  return "imported";
}

/** Read private state; when it does not exist yet, import the legacy copy once
 * and read that. Other failures (unsafe file, unreadable) propagate unchanged. */
export function readPrivateStateWithLegacyImport(filePath: string, legacyPath: string | null): string {
  try {
    return readPrivateState(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !legacyPath) throw err;
  }
  if (importLegacyPrivateState(legacyPath, filePath) !== "imported") {
    const missing = new Error(`No local message state at ${filePath}`) as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    throw missing;
  }
  return readPrivateState(filePath);
}
