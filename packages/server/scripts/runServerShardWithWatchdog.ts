/**
 * Bound the Server shard launcher independently from runner-level test timers.
 *
 * A per-test timeout only observes time spent inside a test. It cannot detect
 * a runner whose assertions have finished but whose process stays alive because
 * of an open handle or an unsettled background operation. This wrapper keeps
 * that second event observable: a shard launcher that does not exit within the
 * wall-clock budget emits a fail-closed PROCESS_DID_NOT_EXIT receipt, records
 * its live Linux process tree, and terminates the whole child process group.
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_SHARD_WATCHDOG_TIMEOUT_MS = 20 * 60_000;
export const SERVER_SHARD_WATCHDOG_KILL_GRACE_MS = 5_000;
export const SERVER_SHARD_WATCHDOG_EXIT_CODE = 124;

const MAX_PROCESS_TREE_ENTRIES = 64;
const MAX_COMMAND_LENGTH = 1_000;

export interface ProcessTreeEntry {
  pid: number;
  ppid: number;
  pgid: number;
  elapsed: string;
  state: string;
  command: string;
}

export interface ProcessTreeSnapshot {
  entries: ProcessTreeEntry[];
  truncated: boolean;
  error?: string;
}

export interface ProcessDidNotExitReceipt {
  classification: "PROCESS_DID_NOT_EXIT";
  shard: number;
  exitCode: typeof SERVER_SHARD_WATCHDOG_EXIT_CODE;
  timeoutMs: number;
  childPid: number;
  processTree: ProcessTreeSnapshot;
}

interface RunWithWatchdogOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shard: number;
  timeoutMs: number;
  killGraceMs: number;
  stdio?: StdioOptions;
  emit?: (receipt: ProcessDidNotExitReceipt) => void;
}

type PsRow = ProcessTreeEntry;

function parseProcessTable(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/,
    );
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      elapsed: match[4],
      state: match[5],
      command:
        match[6].length > MAX_COMMAND_LENGTH
          ? `${match[6].slice(0, MAX_COMMAND_LENGTH)}…`
          : match[6],
    });
  }
  return rows;
}

/** Capture only the watched process and its descendants, never the host tree. */
export function inspectLinuxProcessTree(rootPid: number): ProcessTreeSnapshot {
  if (process.platform !== "linux") {
    return {
      entries: [],
      truncated: false,
      error: "process-tree inspection is Linux-only",
    };
  }

  const result = spawnSync(
    "ps",
    ["-eo", "pid=,ppid=,pgid=,etime=,stat=,args="],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.error || result.status !== 0) {
    return {
      entries: [],
      truncated: false,
      error:
        result.error?.message ??
        `ps exited ${result.status ?? "without a status"}: ${result.stderr.trim()}`,
    };
  }

  const rows = parseProcessTable(result.stdout);
  const byParent = new Map<number, PsRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  for (const children of byParent.values()) {
    children.sort((a, b) => a.pid - b.pid);
  }

  const root = rows.find((row) => row.pid === rootPid);
  if (!root) {
    return {
      entries: [],
      truncated: false,
      error: `pid ${rootPid} left before inspection`,
    };
  }

  const queue = [root];
  const entries: ProcessTreeEntry[] = [];
  while (queue.length > 0 && entries.length < MAX_PROCESS_TREE_ENTRIES) {
    const row = queue.shift()!;
    entries.push(row);
    queue.push(...(byParent.get(row.pid) ?? []));
  }
  return {
    entries,
    truncated: queue.length > 0,
  };
}

export function formatProcessDidNotExitReceipt(
  receipt: ProcessDidNotExitReceipt,
): string {
  return `[serverShardWatchdog] outcome ${JSON.stringify(receipt)}`;
}

function emitProcessDidNotExitReceipt(receipt: ProcessDidNotExitReceipt): void {
  const line = formatProcessDidNotExitReceipt(receipt);
  console.error(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  try {
    appendFileSync(summary, `${line}\n`);
  } catch {
    // Diagnostic persistence must never rewrite the fail-closed exit code.
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch {
    // The child may have raced to exit. The watchdog outcome remains RED.
  }
}

/**
 * Run one process under a wall-clock exit watchdog.
 *
 * Normal zero/non-zero child exits are passed through byte-for-byte. Only a
 * child that remains live for the full budget is classified by this layer.
 */
export function runWithExitWatchdog(
  options: RunWithWatchdogOptions,
): Promise<number> {
  return new Promise((resolve) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
      detached: process.platform !== "win32",
    };
    const child = spawn(options.command, options.args, spawnOptions);
    let settled = false;
    let timedOut = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve(exitCode);
    };

    child.once("error", (error) => {
      if (timedOut) return;
      clearTimeout(watchdog);
      console.error(
        `[serverShardWatchdog] outcome ${JSON.stringify({
          classification: "SPAWN_ERROR",
          shard: options.shard,
          exitCode: 1,
          error: error.message,
        })}`,
      );
      finish(1);
    });

    // Settle on process termination, not stdio closure. A descendant can inherit
    // a pipe and keep `close` pending after the watched shard itself has exited.
    child.once("exit", (code) => {
      if (timedOut) return;
      clearTimeout(watchdog);
      finish(code ?? 1);
    });

    const watchdog = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const childPid = child.pid ?? -1;
      const receipt: ProcessDidNotExitReceipt = {
        classification: "PROCESS_DID_NOT_EXIT",
        shard: options.shard,
        exitCode: SERVER_SHARD_WATCHDOG_EXIT_CODE,
        timeoutMs: options.timeoutMs,
        childPid,
        processTree:
          childPid > 0
            ? inspectLinuxProcessTree(childPid)
            : { entries: [], truncated: false, error: "child pid unavailable" },
      };
      try {
        (options.emit ?? emitProcessDidNotExitReceipt)(receipt);
      } catch (error) {
        console.error(
          `[serverShardWatchdog] receipt emission failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      signalProcessGroup(child, "SIGTERM");

      setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
        finish(SERVER_SHARD_WATCHDOG_EXIT_CODE);
      }, options.killGraceMs);
    }, options.timeoutMs);
  });
}

const SERVER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SHARD_RUNNER = fileURLToPath(
  new URL("./runTestShard.ts", import.meta.url),
);

async function main(): Promise<void> {
  const shard = Number(process.argv[2]);
  if (!Number.isInteger(shard) || shard < 1) {
    console.error(
      "Usage: tsx scripts/runServerShardWithWatchdog.ts <shard-index>",
    );
    process.exit(2);
  }

  const exitCode = await runWithExitWatchdog({
    command: process.execPath,
    args: ["--import", "tsx", SHARD_RUNNER, String(shard)],
    cwd: SERVER_DIR,
    env: { ...process.env, TZ: process.env.TZ || "Asia/Singapore" },
    shard,
    timeoutMs: SERVER_SHARD_WATCHDOG_TIMEOUT_MS,
    killGraceMs: SERVER_SHARD_WATCHDOG_KILL_GRACE_MS,
  });
  process.exit(exitCode);
}

const isDirectInvocation =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
