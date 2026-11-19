import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The runner child a service spawned for one server, kept from spawn until
 * that child exits (`runner.spawned.json`). The service writes `runner.pid`
 * only once a runner has connected, so without this record a runner that is
 * alive but cannot reach its server reads exactly like no runner at all.
 *
 * It is a pid claim only. Readiness counts it as a runner when the runner's
 * own version evidence (`runner-version.json`, written by the runner once it
 * holds the machine lock) names the same pid, so a pid reused by another
 * program, or a child that lost the machine lock, never reads as a runner.
 * Bound to the service that spawned it, like the lock-conflict record.
 */
export interface RunnerSpawnRecord {
  readonly pid: number;
  readonly servicePid: number;
  readonly spawnedAt: number;
}

function positivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function readRunnerSpawnRecord(recordPath: string): RunnerSpawnRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as Partial<RunnerSpawnRecord>;
    const { pid, servicePid, spawnedAt } = parsed;
    if (!positivePid(pid) || !positivePid(servicePid)) return null;
    if (typeof spawnedAt !== "number" || !Number.isFinite(spawnedAt)) return null;
    return { pid, servicePid, spawnedAt };
  } catch {
    return null;
  }
}

/** Written whole (temporary file + rename): a reader never sees half a record. */
export async function writeRunnerSpawnRecord(recordPath: string, record: RunnerSpawnRecord): Promise<void> {
  const temporary = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(recordPath), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, recordPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Remove the record when it still names `pid` (the child that exited); a
 * record a later spawn already replaced is left alone. Without `pid`: remove
 * whatever is there.
 */
export async function clearRunnerSpawnRecord(recordPath: string, pid?: number): Promise<void> {
  if (pid !== undefined && readRunnerSpawnRecord(recordPath)?.pid !== pid) return;
  await rm(recordPath, { force: true });
}

/**
 * The service's side of the record for one child: written now (best-effort,
 * `onWriteError` told), and `childExited` removes it once that write settled,
 * only while it still names this child.
 */
export function recordSpawnedRunner(
  recordPath: string,
  pid: number,
  servicePid: number,
  onWriteError: (err: unknown) => void,
  now: () => number = Date.now,
): { readonly written: Promise<void>; childExited(): Promise<void> } {
  const written = writeRunnerSpawnRecord(recordPath, { pid, servicePid, spawnedAt: now() }).catch(onWriteError);
  return {
    written,
    async childExited() {
      await written;
      await clearRunnerSpawnRecord(recordPath, pid).catch(() => undefined);
    },
  };
}
