// Date-based log rotation for the service + per-server runner logs.
//
// Both logs are written by SPAWNED CHILD PROCESSES via an inherited stdio fd
// (service.ts opens `<log>` with "a" and hands the fd to the child as its
// stdout/stderr). We can't intercept each write, so the clean hook is
// ROTATE-ON-SPAWN: every time the supervisor is about to open a child's log
// fd, rotate first. The supervisor opens these fds on every (re)start — service
// start, runner spawn, crash-respawn, upgrade-restart — which are frequent.
//
// Scheme (date-based, find a crash by date): the ACTIVE log keeps its fixed
// name (`service.log` / `runner.log`) so `logs` and `status` need no resolver.
// On spawn, if the existing active log was last written on an earlier UTC
// calendar day, it is archived to a dated sibling `<base>.<YYYY-MM-DD>.<ext>`
// (the UTC day it covered) and a fresh active log is opened; same-day spawns
// just keep appending. Dated archives older than `maxDays` are pruned.
// Best-effort: any fs error is swallowed so rotation NEVER blocks a spawn.
//
// Day-keys are UTC ("log in UTC", RFC 3339) — see `ymd()` — so the rotation
// boundary is deterministic, DST-immune, and identical across time zones.
//
// Caveat (the inherited-fd constraint): a single child that runs across
// midnight keeps writing to the file it opened (no mid-flight redirect). Its
// log is archived under its last-write date at the next spawn. The crash
// budget (≥3 crashes/60s → degraded, auto-restart paused) caps the chattiest
// case (crash-loops), so a single day's file does not grow without bound in
// practice.

import { stat, rename, unlink, readdir } from "node:fs/promises";
import { dirname, basename, extname, join } from "node:path";

export const LOG_MAX_DAYS = 14; // keep ~2 weeks of dated archives
export const LOG_MAX_BYTES = 64 * 1024 * 1024;

export interface RotateLogOptions {
  maxDays?: number;
  maxBytes?: number;
  /** Injectable "now" for tests; defaults to the current date. */
  now?: Date;
}

/**
 * UTC calendar date as `YYYY-MM-DD`. The rotation day-key is computed in UTC
 * ("log in UTC" — RFC 3339), NOT local time: it makes the active-vs-prior-day
 * decision deterministic and DST-immune, and identical across machines/time
 * zones (an archive named `service.2026-06-18.log` covers the UTC-18 day on
 * every host). A local day-key would make the boundary depend on the host TZ
 * (and made the tests TZ-sensitive — they passed in UTC-5 but failed in UTC+8).
 */
function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** `service.log` + `2026-06-18` → `service.2026-06-18.log`. */
function datedName(logPath: string, date: string, index?: number): string {
  const ext = extname(logPath); // ".log"
  const stem = basename(logPath, ext); // "service"
  return join(dirname(logPath), `${stem}.${date}${index === undefined ? "" : `.${index}`}${ext}`);
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.\d+)?$/;

async function nextArchivePath(logPath: string, date: string): Promise<string> {
  const first = datedName(logPath, date);
  if (!(await stat(first).then(() => true, () => false))) return first;
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = datedName(logPath, date, index);
    if (!(await stat(candidate).then(() => true, () => false))) return candidate;
  }
  return datedName(logPath, date, 10_000);
}

/**
 * Rotate `logPath` by date if needed, then prune old dated archives.
 * Best-effort and idempotent; never throws. Call BEFORE opening the log for
 * append on a child spawn so a new calendar day starts a fresh active file.
 */
export async function rotateLogIfNeeded(
  logPath: string,
  opts: RotateLogOptions = {},
): Promise<void> {
  const maxDays = opts.maxDays ?? LOG_MAX_DAYS;
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const now = opts.now ?? new Date();
  const today = ymd(now);
  try {
    const st = await stat(logPath).catch(() => null);
    if (st && st.isFile()) {
      const lastDay = ymd(st.mtime);
      if (lastDay < today || st.size > maxBytes) {
        // Archive the completed day's log under its date, then the caller's
        // subsequent open("a") creates a fresh active log for today.
        await rename(logPath, await nextArchivePath(logPath, lastDay)).catch(() => undefined);
      }
    }
    await pruneOldDatedLogs(logPath, maxDays, now);
  } catch {
    /* never block a spawn on a rotation/prune failure. */
  }
}

/** Delete dated archives of `logPath` whose date is older than `maxDays`. */
async function pruneOldDatedLogs(logPath: string, maxDays: number, now: Date): Promise<void> {
  const ext = extname(logPath);
  const stem = basename(logPath, ext);
  const dir = dirname(logPath);
  const cutoff = ymd(new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000));
  const prefix = `${stem}.`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(ext)) continue;
    const middle = name.slice(prefix.length, name.length - ext.length);
    const m = DATE_RE.exec(middle);
    if (m && m[1] < cutoff) {
      await unlink(join(dir, name)).catch(() => undefined);
    }
  }
}
