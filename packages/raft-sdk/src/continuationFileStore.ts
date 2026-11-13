// A ContinuationStore on local files, for programs built on the SDK. One JSON
// file per record and per tombstone, under a directory that belongs to one
// agent. Records can hold a draft's text (the command's arguments, step
// results), so the directory is created 0700 and every file 0600, and nothing
// beyond what the runtime wrote is stored.
//
// Several processes of the same agent may share the directory:
// - put publishes with link(2), which fails when the name exists, so two
//   inserts of one id cannot both win;
// - update and expiry deletion hold a per-record lock file (O_EXCL create)
//   while they read, compare the revision and replace the file by rename(2).
//   A lock older than LOCK_STALE_MS belongs to a process that died, and is
//   taken over by rename(2), so only one process removes it, and only the
//   lock it judged stale (takeStaleLock).
// The runtime owns every rule (ownership, expiry, retention); this store only
// keeps files and makes updates conditional (store.ts in raft-shared).
import { closeSync, chmodSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseContinuationId, type ContinuationId, type ContinuationRecord, type ContinuationStore, type ContinuationTombstone } from "@botiverse/raft-shared/src/continuations/index";

export type FileContinuationStoreOptions = {
  /**
   * A directory private to one agent (for example inside its own state
   * directory). Created if missing, with mode 0700.
   */
  dir: string;
};

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Far longer than one read-compare-rename; shorter than the runtime's run lease. */
const LOCK_STALE_MS = 10_000;
/** How long an update waits for another process's read-compare-rename of the same record. */
const LOCK_WAIT_MS = 500;
const LOCK_POLL_MS = 5;

export function createFileContinuationStore(options: FileContinuationStoreOptions): ContinuationStore {
  const records = join(options.dir, "records");
  const tombstones = join(options.dir, "tombstones");
  for (const dir of [options.dir, records, tombstones]) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);
  }

  const recordPath = (id: ContinuationId) => join(records, `${fileName(id)}.json`);
  const tombstonePath = (id: ContinuationId) => join(tombstones, `${fileName(id)}.json`);

  const writeTemp = (dir: string, json: string): string => {
    const temp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    writeFileSync(temp, json, { mode: FILE_MODE, flag: "wx" });
    return temp;
  };
  const replace = (dir: string, path: string, json: string): void => {
    renameSync(writeTemp(dir, json), path);
  };

  return {
    put(record) {
      const temp = writeTemp(records, JSON.stringify(record));
      try {
        linkSync(temp, recordPath(record.id));
        return true;
      } catch (error) {
        if (isCode(error, "EEXIST")) return false;
        throw error;
      } finally {
        unlinkQuietly(temp);
      }
    },
    get(id) {
      return readJson<ContinuationRecord>(recordPath(id));
    },
    update(record, expectedRevision) {
      const path = recordPath(record.id);
      return withLock(path, LOCK_WAIT_MS, () => {
        const current = readJson<ContinuationRecord>(path);
        if (current?.revision !== expectedRevision) return false;
        replace(records, path, JSON.stringify(record));
        return true;
      }) ?? false;
    },
    delete(id) {
      unlinkQuietly(recordPath(id));
    },
    putTombstone(tombstone) {
      replace(tombstones, tombstonePath(tombstone.id), JSON.stringify(tombstone));
    },
    getTombstone(id) {
      return readJson<ContinuationTombstone>(tombstonePath(id));
    },
    deleteExpired(now) {
      let deleted = 0;
      for (const dir of [records, tombstones]) {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith(".json")) continue;
          const path = join(dir, name);
          // Under the record's lock, re-read: an update may have moved
          // `deleteAfter` on since the directory was listed.
          const removed = withLock(path, 0, () => {
            const row = readJson<{ deleteAfter?: unknown }>(path);
            if (!row || typeof row.deleteAfter !== "number" || row.deleteAfter >= now) return false;
            unlinkQuietly(path);
            return true;
          });
          if (removed) deleted += 1;
        }
      }
      return deleted;
    },
  };
}

/** Ids come from the runtime; refuse anything that is not one, so a name never escapes the directory. */
function fileName(id: ContinuationId): string {
  const parsed = parseContinuationId(id);
  if (parsed === null || parsed !== id) throw new TypeError(`not a continuation id: ${JSON.stringify(id)}`);
  return parsed;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Run `fn` holding `<path>.lock`, waiting up to `waitMs` for another process
 * to release it. Undefined when a live process still holds it (the caller
 * treats that as "moved on": update returns false and the runtime re-reads;
 * expiry skips the file until the next sweep).
 */
function withLock<T>(path: string, waitMs: number, fn: () => T): T | undefined {
  const lock = `${path}.lock`;
  const deadline = Date.now() + waitMs;
  let tookOverStale = false;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", FILE_MODE);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      if (!tookOverStale && takeStaleLock(lock)) {
        tookOverStale = true;
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    try {
      return fn();
    } finally {
      releaseLock(lock, fd);
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove `lock` if it is stale, so that exactly one process does, and only
 * the lock it judged stale. Unlinking would race: two processes both judge
 * the same stale lock, one removes it and creates a fresh one, the other's
 * unlink then removes that fresh lock and both hold it. Instead the lock is
 * renamed aside (one rename wins; the loser gets ENOENT), and the renamed
 * file is checked to be the one judged stale (same inode and mtime). If it
 * is not, it was a live process's fresh lock: it is put back.
 */
function takeStaleLock(lock: string): boolean {
  let judged;
  try {
    judged = statSync(lock);
  } catch (error) {
    // Released meanwhile: not stale, the caller simply tries again.
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
  if (Date.now() - judged.mtimeMs <= LOCK_STALE_MS) return false;
  const aside = `${lock}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
  const moved = statSync(aside);
  if (moved.ino === judged.ino && moved.mtimeMs === judged.mtimeMs) {
    unlinkQuietly(aside);
    return true;
  }
  // A live lock: hand it back. If yet another process created a lock
  // meanwhile, that one stands and this one is dropped; its holder's release
  // then finds a different file under the name and leaves it (releaseLock).
  try {
    linkSync(aside, lock);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  } finally {
    unlinkQuietly(aside);
  }
  return false;
}

/**
 * Close the lock and remove it only while the name still points at the file
 * this process created. Unlinking by path alone could remove another
 * process's lock: if this one was renamed aside and dropped (takeStaleLock)
 * and a third process created a fresh lock under the name meanwhile.
 */
/** Exported for tests only; not part of `./continuations`. */
export function releaseLock(lock: string, fd: number): void {
  try {
    const mine = fstatSync(fd);
    let current;
    try {
      current = statSync(lock);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    if (current.ino === mine.ino && current.dev === mine.dev) unlinkQuietly(lock);
  } finally {
    closeSync(fd);
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
