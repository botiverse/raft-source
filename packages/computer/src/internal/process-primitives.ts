// Process primitives used by both the service (CLI adapter) and the
// services/* layer. Neutral relocation target: services/* must NOT
// import from service.ts (a CLI adapter) — these pidfile/liveness
// primitives have no CLI concerns and belong in a sibling-neutral
// module that either layer can depend on.
//
// Package-private: NOT exposed via `@botiverse/raft-computer/lib`
// (RFC v9 §3). The `/internal/` segment is an export hard gate; the
// `exports` field in `packages/computer/package.json` MUST NOT list any
// path under `./src/internal/*`.
//
// Pure relocation from `service.ts` (RFC v9 PR-impl-1 commit 1).
// 0 behavior change — identical signatures, identical bodies; only the
// import path moves.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parsePsLstartMs, parseWindowsCreationTimeUtcMicros, windowsCreationDateCommand } from "@botiverse/raft-shared";

/** Generic pidfile reader by absolute path. Returns null on missing / junk. */
export async function readPidfileAt(pidfilePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(pidfilePath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Liveness via signal 0. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How long a start read may take for a display (`status`, `doctor`): a slow one reads as unknown. */
export const START_TIME_READ_TIMEOUT_MS = 5_000;

/**
 * How long it may take before a command acts on the answer. There "unknown"
 * means the old behaviour (`stop` signals the pid, `start` answers "already
 * running"), and PowerShell with CIM on a cold Windows machine can take
 * longer than 5 s.
 */
export const START_TIME_READ_BEFORE_ACTING_TIMEOUT_MS = 20_000;

/** The start read of a command that acts on the answer (`stop`, `start`, setup's legacy-daemon stop). */
export function readProcessStartTimeMsBeforeActing(pid: number): Promise<number | undefined> {
  return readProcessStartTimeMs(pid, { timeoutMs: START_TIME_READ_BEFORE_ACTING_TIMEOUT_MS });
}

/**
 * When the process now holding `pid` started (epoch ms), read as the daemon's
 * machine lock reads it: Windows from the CIM CreationDate, other POSIX from
 * `ps lstart`. Undefined when the pid is gone, the read fails, or on Linux,
 * where a start time is derived from the current boot time and a clock
 * stepped after boot would make a live process look newer than its record. A
 * caller must take undefined as "unknown", never as "reused" (shared
 * `startedAfterRecord` does). Does not block:
 * a PowerShell start alone takes 0.5-2 s.
 * Follow-up for Linux: the runner would have to record its start identity
 * (boot id + starttime ticks, as the machine lock's owner.json does).
 */
export function readProcessStartTimeMs(
  pid: number,
  opts: { timeoutMs?: number; platform?: NodeJS.Platform; execFile?: typeof execFile } = {},
): Promise<number | undefined> {
  const platform = opts.platform ?? process.platform;
  if (!Number.isInteger(pid) || pid <= 0 || platform === "linux") return Promise.resolve(undefined);
  const [command, args, parse] = platform === "win32"
    ? (["powershell.exe", windowsCreationDateCommand(pid), (text: string) => {
        const micros = parseWindowsCreationTimeUtcMicros(text);
        return micros === undefined ? undefined : Math.floor(micros / 1000);
      }] as const)
    : (["ps", ["-o", "lstart=", "-p", String(pid)], parsePsLstartMs] as const);
  return new Promise((resolve) => {
    (opts.execFile ?? execFile)(
      command,
      args,
      { env: { ...process.env, LC_ALL: "C" }, timeout: opts.timeoutMs ?? START_TIME_READ_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (err, stdout) => resolve(err ? undefined : parse(String(stdout))),
    );
  });
}

export async function writePidfileAt(pidfilePath: string, pid: number): Promise<void> {
  await mkdir(dirname(pidfilePath), { recursive: true });
  await writeFile(pidfilePath, String(pid), { mode: 0o600 });
}

export async function clearPidfileAt(pidfilePath: string): Promise<void> {
  try {
    await unlink(pidfilePath);
  } catch {
    /* ignore */
  }
}
