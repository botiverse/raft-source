import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { ambientProcessEnv } from "../processEnvPatch";
// The start-time commands and parsers live in shared (the Computer's commands read them without daemon code).
import { parsePsLstartMs, parseWindowsCreationTimeUtcMicros, windowsCreationDateCommand } from "@botiverse/raft-shared";

/**
 * The processes below a runtime child, taken while the child is still alive:
 * once it dies its children are reparented and can no longer be found from it.
 * A stop that has to SIGKILL the runtime uses this to kill what the runtime
 * itself would have cleaned up on SIGTERM (Claude Code kills its tool shells'
 * process trees then; a SIGKILLed runtime cannot).
 *
 * `startTime` (Linux /proc only) tells a still-running entry from a new
 * process that reused its pid by the time the kill is sent.
 */
export interface ProcessTreeEntry {
  pid: number;
  pgid: number;
  startTime?: string;
  /**
   * Wall-clock start (Linux: boot time + starttime ticks; elsewhere on POSIX
   * `ps lstart`, only for a reader that asks, `psStartTimes`); absent where
   * it cannot be read.
   */
  startedAtMs?: number;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  startTime?: string;
  /** Wall-clock start from `ps lstart` (whole seconds); never a pid-reuse identity. */
  startedAtMs?: number;
}

export interface ProcessTreeDeps {
  platform?: NodeJS.Platform;
  /** The daemon's pid: only a direct child of it is walked. */
  ownPid?: number;
  listProcesses?: () => Promise<ProcessRow[]>;
  readStartTime?: (pid: number) => string | undefined;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Linux boot time (ms since epoch), for turning starttime ticks into wall-clock time. */
  bootTimeMs?: () => number | undefined;
  /** USER_HZ, the unit of /proc/<pid>/stat starttime. */
  clockTicksPerSecond?: () => number;
  /** Windows: run `taskkill` with these arguments (tests record them). */
  taskkill?: (args: readonly string[]) => void;
  /**
   * Off Linux, list processes with their `ps lstart` start (one `ps -A`
   * call) so entries carry `startedAtMs`. Off by default: a stop's
   * "started during this turn" selection stays Linux-only.
   */
  psStartTimes?: boolean;
  /** Runs `ps` for the `psStartTimes` listing (tests fake its output). */
  runCommand?: (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<string>;
}

let cachedClockTicksPerSecond: number | undefined;

/**
 * USER_HZ: 100 on every mainstream Linux, read once from `getconf CLK_TCK`
 * anyway so a kernel built otherwise cannot shift every start time (and with
 * it "started during this turn"). The value is traced with each turn kill.
 */
export function linuxClockTicksPerSecond(): number {
  if (cachedClockTicksPerSecond !== undefined) return cachedClockTicksPerSecond;
  let ticks = 100;
  try {
    const result = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2_000, env: ambientProcessEnv() });
    const parsed = Number(String(result.stdout ?? "").trim());
    if (result.status === 0 && Number.isInteger(parsed) && parsed > 0) ticks = parsed;
  } catch {
    // Keep the standard value.
  }
  cachedClockTicksPerSecond = ticks;
  return ticks;
}

/**
 * Boot time from /proc/uptime (centiseconds), not /proc/stat btime (whole
 * seconds): a whole-second boot time puts a process started just after a
 * turn began up to a second earlier, before the turn.
 *
 * In an LXC container /proc/uptime is the container's (lxcfs) while
 * /proc/<pid>/stat start times count from the host's boot, so every process
 * would look hours younger and a turn's kill would take processes from
 * before it. When this module loads, the daemon's own start gives the
 * host's boot time; its gap to the /proc/uptime one is the container's
 * offset, applied to every later reading. Reading /proc/uptime each time
 * keeps following wall-clock steps; measuring the offset at load keeps it
 * clear of suspend, during which process.uptime() stops.
 */
function readLinuxBootTimeMs(): number | undefined {
  const fromUptime = readUptimeBootTimeMs();
  return fromUptime === undefined ? undefined : fromUptime - containerBootOffsetMs();
}

const BOOT_TIME_AGREEMENT_MS = 1_000;

function readUptimeBootTimeMs(): number | undefined {
  try {
    const uptimeSeconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return Number.isFinite(uptimeSeconds) ? Date.now() - Math.round(uptimeSeconds * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** This process's start: wall clock and ticks since boot. */
export interface SelfStart {
  wallMs: number;
  ticks: number;
}

export function readSelfStart(
  read: { selfStat: () => string; nowMs: () => number; uptimeSeconds: () => number } = {
    selfStat: () => readFileSync("/proc/self/stat", "utf8"),
    nowMs: Date.now,
    uptimeSeconds: () => process.uptime(),
  },
): SelfStart | undefined {
  try {
    const stat = parseProcStat(read.selfStat());
    const ticks = stat ? Number(stat.startTime) : Number.NaN;
    if (!Number.isFinite(ticks)) return undefined;
    return { wallMs: read.nowMs() - Math.round(read.uptimeSeconds() * 1000), ticks };
  } catch {
    return undefined;
  }
}

/** Boot time from this process: its wall-clock start minus its start in ticks since boot. */
export function calibratedBootTimeMs(self: SelfStart, ticksPerSecond: number): number {
  return self.wallMs - Math.round((self.ticks * 1000) / ticksPerSecond);
}

/**
 * How far the /proc/uptime boot time is from the host's (0 outside a
 * container: within a second is measurement noise, and /proc/uptime is the
 * more precise of the two).
 */
export function containerOffsetMs(uptimeBootMs: number | undefined, calibratedBootMs: number | undefined): number {
  if (uptimeBootMs === undefined || calibratedBootMs === undefined) return 0;
  const offset = uptimeBootMs - calibratedBootMs;
  return Math.abs(offset) <= BOOT_TIME_AGREEMENT_MS ? 0 : offset;
}

// Both read together at load, before any suspend could split them apart.
const LOAD_READINGS = process.platform === "linux" ? { self: readSelfStart(), uptimeBootMs: readUptimeBootTimeMs() } : undefined;
let cachedContainerOffsetMs: number | undefined;

function containerBootOffsetMs(): number {
  if (cachedContainerOffsetMs === undefined) {
    const self = LOAD_READINGS?.self;
    cachedContainerOffsetMs = containerOffsetMs(
      LOAD_READINGS?.uptimeBootMs,
      self ? calibratedBootTimeMs(self, linuxClockTicksPerSecond()) : undefined,
    );
  }
  return cachedContainerOffsetMs;
}


/** `/proc/<pid>/stat`: comm can hold spaces and parens, so fields count from the last ')'. */
function parseProcStat(text: string): { ppid: number; pgid: number; startTime: string } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  // After ")": state(3) ppid(4) pgrp(5) ... starttime(22).
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || !startTime) return null;
  return { ppid, pgid, startTime };
}

function readLinuxStartTime(pid: number): string | undefined {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"))?.startTime;
  } catch {
    return undefined;
  }
}

async function listLinuxProcesses(): Promise<ProcessRow[]> {
  const rows: ProcessRow[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (stat) rows.push({ pid, ...stat });
    } catch {
      // Exited while listing.
    }
  }
  return rows;
}

function listPsProcesses(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,pgid="], { env: ambientProcessEnv(), timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const rows: ProcessRow[] = [];
      for (const line of String(stdout).split("\n")) {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) rows.push({ pid, ppid, pgid });
      }
      resolve(rows);
    });
  });
}

/** `ps -A -o pid=,ppid=,pgid=,lstart=` output as rows. */
export function parsePsRowsWithStart(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const started = parsePsLstartMs(match[4]!);
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      ...(started !== undefined ? { startedAtMs: started } : {}),
    });
  }
  return rows;
}

/**
 * The `ps` listing with each process's start, in one call (the source
 * readProcessIdentity reads per pid). A `ps` without `lstart` falls back to
 * the plain listing: no start times, never no tree.
 */
async function listPsProcessesWithStart(deps: ProcessTreeDeps): Promise<ProcessRow[]> {
  const run = deps.runCommand ?? runCommandText;
  const rows = parsePsRowsWithStart(await run("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { LC_ALL: "C" }));
  return rows.length > 0 ? rows : listPsProcesses();
}

function processLister(platform: NodeJS.Platform, deps: ProcessTreeDeps): () => Promise<ProcessRow[]> {
  if (deps.listProcesses) return deps.listProcesses;
  if (platform === "linux") return listLinuxProcesses;
  return deps.psStartTimes ? () => listPsProcessesWithStart(deps) : listPsProcesses;
}

/**
 * Reconciler step 5 (orphan sweep): who a pid is right now. `startIdentity`
 * tells the process recorded at spawn from a later one that reused its pid:
 * Linux /proc starttime ticks, `ps lstart` elsewhere on POSIX, the process
 * start time on Windows. Null when the pid is gone or cannot be read; a
 * caller then never signals it.
 */
export interface ProcessIdentity {
  pid: number;
  pgid: number;
  startIdentity: string;
}

export interface ProcessIdentityDeps {
  platform?: NodeJS.Platform;
  /** Linux: the text of /proc/<pid>/stat. */
  readProcStat?: (pid: number) => string;
  /** Other POSIX: `ps -o pgid=,lstart= -p <pid>` output; Windows: the start time in ticks. */
  runCommand?: (command: string, args: readonly string[]) => Promise<string>;
}

function runCommandText(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, [...args], { env: { ...ambientProcessEnv(), ...env }, timeout: 5_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

export async function readProcessIdentity(pid: number, deps: ProcessIdentityDeps = {}): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "linux") {
      const stat = parseProcStat((deps.readProcStat ?? ((id: number) => readFileSync(`/proc/${id}/stat`, "utf8")))(pid));
      return stat ? { pid, pgid: stat.pgid, startIdentity: `linux:${stat.startTime}` } : null;
    }
    const run = deps.runCommand ?? runCommandText;
    if (platform === "win32") {
      const ticks = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`])).trim();
      return /^\d+$/.test(ticks) ? { pid, pgid: pid, startIdentity: `win32:${ticks}` } : null;
    }
    const line = (await run("ps", ["-o", "pgid=,lstart=", "-p", String(pid)])).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    return match ? { pid, pgid: Number(match[1]), startIdentity: `ps:${match[2]!.replace(/\s+/g, " ")}` } : null;
  } catch {
    return null;
  }
}

export interface ProcessStartTimeDeps {
  platform?: NodeJS.Platform;
  /** Linux: the text of /proc/<pid>/stat. */
  readProcStat?: (pid: number) => string;
  /** Linux boot time (ms since epoch). */
  bootTimeMs?: () => number | undefined;
  /** Linux USER_HZ. */
  clockTicksPerSecond?: () => number;
  /** Linux: /proc/sys/kernel/random/boot_id. */
  readBootId?: () => string;
  /** Linux: the target of /proc/self/ns/pid, the pid namespace this process reads pids in. */
  readPidNamespace?: () => string;
  /** Linux: the target of /proc/self/ns/time; starttime ticks are shifted by the reader's time namespace boot offset. */
  readTimeNamespace?: () => string;
  /** Linux: the text of /proc/self/stat, to check that /proc is this process's own pid namespace. */
  readSelfStat?: () => string;
  /** Linux: this process's pid (process.pid). */
  selfPid?: number;
  /**
   * Runs a command synchronously and returns its stdout; throws when it
   * fails. Windows: PowerShell; other POSIX: `ps -o lstart= -p <pid>`.
   */
  runCommandSync?: (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => string;
}

const START_TIME_COMMAND_TIMEOUT_MS = 5_000;

function runCommandTextSync(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return String(
    execFileSync(command, [...args], {
      env: { ...ambientProcessEnv(), ...env },
      timeout: START_TIME_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }),
  );
}

function readWindowsCreationTimeUtcMicros(pid: number, run: NonNullable<ProcessStartTimeDeps["runCommandSync"]>): number | undefined {
  return parseWindowsCreationTimeUtcMicros(run("powershell.exe", windowsCreationDateCommand(pid)));
}

function readLinuxStartTicks(pid: number, deps: ProcessStartTimeDeps): string | undefined {
  const stat = parseProcStat((deps.readProcStat ?? ((id: number) => readFileSync(`/proc/${id}/stat`, "utf8")))(pid));
  return stat && /^\d+$/.test(stat.startTime) ? stat.startTime : undefined;
}

/**
 * When the process now holding `pid` started, in epoch ms, read
 * synchronously (the machine lock is taken synchronously): Linux from
 * /proc/<pid>/stat starttime ticks plus the boot time, Windows from its CIM
 * CreationDate, other POSIX from `ps lstart` (whole seconds, rounded down).
 * Undefined when the pid is gone or its start cannot be read: a caller must
 * treat that as "unknown", never as "reused".
 */
export function readProcessStartTimeMsSync(pid: number, deps: ProcessStartTimeDeps = {}): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "linux") {
      const ticks = Number(readLinuxStartTicks(pid, deps));
      if (!Number.isFinite(ticks)) return undefined;
      const bootTimeMs = (deps.bootTimeMs ?? readLinuxBootTimeMs)();
      if (bootTimeMs === undefined) return undefined;
      return bootTimeMs + Math.round((ticks * 1000) / (deps.clockTicksPerSecond ?? linuxClockTicksPerSecond)());
    }
    const run = deps.runCommandSync ?? runCommandTextSync;
    if (platform === "win32") {
      const micros = readWindowsCreationTimeUtcMicros(pid, run);
      return micros === undefined ? undefined : Math.floor(micros / 1000);
    }
    return parsePsLstartMs(run("ps", ["-o", "lstart=", "-p", String(pid)], { LC_ALL: "C" }));
  } catch {
    return undefined;
  }
}

/**
 * Which process holds a pid, as the OS itself records its start: equal for
 * the same process on every read, different for a later process that
 * reused the pid. Nothing here is derived from the current clock.
 *
 * - Linux: `value` is /proc/<pid>/stat starttime (ticks since boot), only
 *   meaningful within one boot (`bootId`, /proc/sys/kernel/random/boot_id)
 *   and one pid namespace (`pidNamespace`, the reader's /proc/self/ns/pid:
 *   the namespace the pid number was read in).
 * - Windows: `value` is the CIM CreationDate as UTC epoch microseconds.
 * - Other POSIX: `value` is `ps lstart` as epoch ms (whole seconds).
 */
export type ProcessStartIdentity =
  | { platform: "linux"; value: string; bootId: string; pidNamespace?: string; timeNamespace?: string }
  | { platform: Exclude<NodeJS.Platform, "linux">; value: string };

function readLinuxBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
}

function readLinuxPidNamespace(): string {
  return readlinkSync("/proc/self/ns/pid");
}

function readLinuxTimeNamespace(): string {
  return readlinkSync("/proc/self/ns/time");
}

function readOptionalLink(read: () => string): string | undefined {
  try {
    return read().trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether /proc shows this process's own pid namespace. A /proc mounted for
 * an outer namespace (`unshare -pf` without `--mount-proc`) maps
 * /proc/<pid> to a different process than the pid this daemon sees, so
 * nothing read there identifies anything: treat it as unreadable.
 */
function procIsOwnNamespace(deps: ProcessStartTimeDeps): boolean {
  try {
    const text = (deps.readSelfStat ?? (() => readFileSync("/proc/self/stat", "utf8")))();
    const first = Number(/^\s*(\d+)\s/.exec(text)?.[1]);
    return Number.isInteger(first) && first === (deps.selfPid ?? process.pid);
  } catch {
    return false;
  }
}

function readLinuxStartIdentity(pid: number, deps: ProcessStartTimeDeps): ProcessStartIdentity | undefined {
  if (!procIsOwnNamespace(deps)) return undefined;
  const ticks = readLinuxStartTicks(pid, deps);
  const bootId = (deps.readBootId ?? readLinuxBootId)().trim();
  if (ticks === undefined || !bootId) return undefined;
  const pidNamespace = readOptionalLink(deps.readPidNamespace ?? readLinuxPidNamespace);
  const timeNamespace = readOptionalLink(deps.readTimeNamespace ?? readLinuxTimeNamespace);
  return {
    platform: "linux",
    value: ticks,
    bootId,
    ...(pidNamespace ? { pidNamespace } : {}),
    ...(timeNamespace ? { timeNamespace } : {}),
  };
}

/** The command that reads a non-Linux start identity, and how its output becomes one. Shared by the sync and async readers so both yield the same value. */
function spawnedStartIdentityRead(pid: number, platform: Exclude<NodeJS.Platform, "linux">): {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  parse: (stdout: string) => ProcessStartIdentity | undefined;
} {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: windowsCreationDateCommand(pid),
      parse: (stdout) => {
        const micros = parseWindowsCreationTimeUtcMicros(stdout);
        return micros === undefined ? undefined : { platform, value: String(micros) };
      },
    };
  }
  return {
    command: "ps",
    args: ["-o", "lstart=", "-p", String(pid)],
    env: { LC_ALL: "C" },
    parse: (stdout) => {
      const ms = parsePsLstartMs(stdout);
      return ms === undefined ? undefined : { platform, value: String(ms) };
    },
  };
}

/**
 * The start identity of the process now holding `pid`, read synchronously;
 * undefined when the pid is gone or it cannot be read (a caller must take
 * that as "unknown"). Linux reads files only; Windows spawns PowerShell and
 * other POSIX `ps`, each bounded by a timeout.
 */
export function readProcessStartIdentitySync(pid: number, deps: ProcessStartTimeDeps = {}): ProcessStartIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "linux") return readLinuxStartIdentity(pid, deps);
    const read = spawnedStartIdentityRead(pid, platform);
    return read.parse((deps.runCommandSync ?? runCommandTextSync)(read.command, read.args, read.env));
  } catch {
    return undefined;
  }
}

/**
 * Whether reading a start identity on this platform needs a child process
 * (everywhere but Linux). Such a read stays off a synchronous startup path.
 */
export function startIdentityReadSpawns(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "linux";
}

export interface ProcessStartIdentityAsyncDeps {
  platform?: NodeJS.Platform;
  /** Runs a command; resolves with its stdout, rejects when it fails. */
  runCommand?: (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<string>;
}

/** Like runCommandText, but the child never keeps the event loop alive. */
function runCommandTextUnref(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { env: { ...ambientProcessEnv(), ...env }, timeout: START_TIME_COMMAND_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as { unref?: () => void } | null)?.unref?.();
    }
  });
}

/**
 * readProcessStartIdentitySync without blocking: the same command and the
 * same value, read asynchronously by a child that does not hold the event
 * loop open. Never rejects; undefined when unreadable.
 */
export async function readProcessStartIdentity(pid: number, deps: ProcessStartIdentityAsyncDeps = {}): Promise<ProcessStartIdentity | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "linux") return readLinuxStartIdentity(pid, {});
    const read = spawnedStartIdentityRead(pid, platform);
    return read.parse(await (deps.runCommand ?? runCommandTextUnref)(read.command, read.args, read.env));
  } catch {
    return undefined;
  }
}

/**
 * `pid` and its ancestors, nearest first, from one process listing: at most
 * `maxDepth` entries, stopping at pid 1 or a parent that is not listed.
 * Empty on Windows or when `pid` is not listed. `raft proc` uses it to
 * confirm that a caller descends from its agent's runtime.
 */
export async function ancestorChain(pid: number, deps: ProcessTreeDeps = {}, maxDepth = 64): Promise<number[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32" || !Number.isInteger(pid) || pid <= 0) return [];
  let rows: ProcessRow[];
  try {
    rows = await (deps.listProcesses ?? (platform === "linux" ? listLinuxProcesses : listPsProcesses))();
  } catch {
    return [];
  }
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
  if (!parentOf.has(pid)) return [];
  const chain: number[] = [];
  for (let current: number | undefined = pid; current !== undefined && current > 0 && chain.length < maxDepth; current = parentOf.get(current)) {
    if (chain.includes(current)) break;
    chain.push(current);
    if (current === 1) break;
  }
  return chain;
}

/**
 * This process's live children that lead their own process group (POSIX):
 * the runtimes it spawned detached, OAR's included, whose pids OAR keeps to
 * itself. Empty on Windows.
 */
export async function listOwnGroupLeaderChildren(deps: ProcessTreeDeps = {}): Promise<number[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return [];
  const list = deps.listProcesses ?? (platform === "linux" ? listLinuxProcesses : listPsProcesses);
  const ownPid = deps.ownPid ?? process.pid;
  try {
    return (await list()).filter((row) => row.ppid === ownPid && row.pgid === row.pid).map((row) => row.pid);
  } catch {
    return [];
  }
}

/**
 * Every descendant of `rootPid`, whoever its parent is now: an orphan left
 * by an earlier daemon has been reparented. Only call it for a root whose
 * identity was just checked.
 */
export async function descendantsOfOrphan(rootPid: number, deps: ProcessTreeDeps = {}): Promise<ProcessTreeEntry[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return [];
  const list = deps.listProcesses ?? (platform === "linux" ? listLinuxProcesses : listPsProcesses);
  let rows: ProcessRow[];
  try {
    rows = await list();
  } catch {
    return [];
  }
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return [];
  return snapshotProcessTree(rootPid, { ...deps, platform, ownPid: root.ppid, listProcesses: async () => rows, bootTimeMs: () => undefined })
    .then((tree) => tree.descendants);
}

/**
 * What a stop reads of a runtime's tree while the runtime is alive: every
 * descendant, and whether the runtime leads a process group of its own (it
 * was spawned detached, `spawnRuntimeChild`), so the group can be killed as
 * one at the stop deadline.
 */
export interface ProcessTreeSnapshot {
  descendants: ProcessTreeEntry[];
  /** The root is this process's own child and leads its own process group. */
  rootLeadsGroup: boolean;
}

/**
 * Every descendant of `rootPid` (not the root itself), when the root is this
 * process's own child. Empty on Windows, where `taskkill /T` walks the tree
 * instead.
 */
export async function snapshotDescendants(rootPid: number, deps: ProcessTreeDeps = {}): Promise<ProcessTreeEntry[]> {
  return (await snapshotProcessTree(rootPid, deps)).descendants;
}

/** {@link snapshotDescendants}, plus whether the root leads its own process group. */
export async function snapshotProcessTree(rootPid: number, deps: ProcessTreeDeps = {}): Promise<ProcessTreeSnapshot> {
  return (await readProcessTree(rootPid, deps)) ?? { descendants: [], rootLeadsGroup: false };
}

/**
 * {@link snapshotDescendants}, but null when the tree could not be read:
 * Windows, a process listing that failed, or a root that is not (or no
 * longer) this process's own child. For a reader that must tell "no
 * descendants" from "unknown" (backgroundTaskHealth.ts holds a task on unknown).
 */
export async function readDescendants(rootPid: number, deps: ProcessTreeDeps = {}): Promise<ProcessTreeEntry[] | null> {
  return (await readProcessTree(rootPid, deps))?.descendants ?? null;
}

async function readProcessTree(rootPid: number, deps: ProcessTreeDeps): Promise<ProcessTreeSnapshot | null> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return null;
  const list = processLister(platform, deps);
  let rows: ProcessRow[];
  try {
    rows = await list();
  } catch {
    return null;
  }
  // Only a runtime this process spawned: a pid that has since been reused
  // (or a fake one in a test) must never lead to someone else's tree.
  const ownPid = deps.ownPid ?? process.pid;
  const root = rows.find((row) => row.pid === rootPid && row.ppid === ownPid);
  if (!root) return null;
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const bootTimeMs = platform === "linux" ? (deps.bootTimeMs ?? readLinuxBootTimeMs)() : undefined;
  const ticksPerSecond = bootTimeMs === undefined ? 100 : (deps.clockTicksPerSecond ?? linuxClockTicksPerSecond)();
  const startedAtMs = (startTime: string | undefined): number | undefined => {
    if (bootTimeMs === undefined || startTime === undefined) return undefined;
    const ticks = Number(startTime);
    return Number.isFinite(ticks) ? bootTimeMs + Math.round((ticks * 1000) / ticksPerSecond) : undefined;
  };
  const out: ProcessTreeEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      const started = startedAtMs(row.startTime) ?? row.startedAtMs;
      out.push({
        pid: row.pid,
        pgid: row.pgid,
        ...(row.startTime ? { startTime: row.startTime } : {}),
        ...(started !== undefined ? { startedAtMs: started } : {}),
      });
      queue.push(row.pid);
    }
  }
  return { descendants: out, rootLeadsGroup: root.pgid === rootPid };
}

/**
 * SIGKILL the snapshot's survivors. A descendant that leads its own process
 * group (a tool shell started detached) is killed as a group, which also
 * catches members that left the tree; any other descendant is killed by pid.
 * Groups led by something outside the snapshot, such as the daemon's own
 * group the runtime was spawned into, are never signalled.
 */
export function killProcessTreeSnapshot(entries: readonly ProcessTreeEntry[], deps: ProcessTreeDeps = {}): number {
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const readStartTime = deps.readStartTime ?? readLinuxStartTime;
  let signalled = 0;
  for (const entry of entries) {
    if (entry.startTime !== undefined && readStartTime(entry.pid) !== entry.startTime) continue;
    try {
      kill(entry.pid === entry.pgid ? -entry.pgid : entry.pid, "SIGKILL");
      signalled += 1;
    } catch {
      // Already gone.
    }
  }
  return signalled;
}

/**
 * task #25 step 2: an explicit "stop this turn" kills what the turn started
 * and nothing older. Entries started at or after `startedAtOrAfterMs` are
 * selected; older ones (a dev server from an earlier turn, the session's MCP
 * servers) and any whose start time cannot be read are left alone.
 */
export function entriesStartedSince(
  entries: readonly ProcessTreeEntry[],
  startedAtOrAfterMs: number,
): { selected: ProcessTreeEntry[]; leftAlone: number } {
  const selected = entries.filter((entry) => entry.startedAtMs !== undefined && entry.startedAtMs >= startedAtOrAfterMs);
  return { selected, leftAlone: entries.length - selected.length };
}

/** What a runtime session needs to clean up below a runtime it stops. */
export interface ProcessTreeOps {
  snapshotDescendants(rootPid: number): Promise<ProcessTreeEntry[]>;
  /** The tree a stop may have to kill, read before its first signal. */
  snapshotTree(rootPid: number): Promise<ProcessTreeSnapshot>;
  /**
   * At the stop deadline, before the root's SIGKILL: the whole tree. POSIX:
   * the root's own process group in one signal (when the snapshot showed the
   * root leading it), plus every snapshot entry that left the group (a tool
   * shell started detached, a setsid child). Windows walks the live tree with
   * `taskkill /T /F`. Returns how many processes were signalled.
   */
  forceKill(rootPid: number | undefined, snapshot: readonly ProcessTreeEntry[] | ProcessTreeSnapshot): number;
  /** SIGKILL exactly these entries (POSIX). Windows has no snapshot, so nothing is selected there. */
  killEntries(entries: readonly ProcessTreeEntry[]): number;
}

/** `taskkill` arguments that end `pid` and every process below it. */
export function taskkillTreeArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

export function createProcessTreeOps(deps: ProcessTreeDeps = {}): ProcessTreeOps {
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const taskkill = deps.taskkill ?? ((args: readonly string[]) => {
    spawn("taskkill", [...args], { stdio: "ignore", windowsHide: true, env: ambientProcessEnv() }).on("error", () => {});
  });
  return {
    snapshotDescendants: (rootPid) => snapshotDescendants(rootPid, deps),
    snapshotTree: (rootPid) => snapshotProcessTree(rootPid, deps),
    forceKill: (rootPid, snapshot) => {
      if (platform === "win32") {
        if (typeof rootPid !== "number") return 0;
        taskkill(taskkillTreeArgs(rootPid));
        return 1;
      }
      const { descendants, rootLeadsGroup } = Array.isArray(snapshot)
        ? { descendants: snapshot as readonly ProcessTreeEntry[], rootLeadsGroup: false }
        : snapshot as ProcessTreeSnapshot;
      let signalled = 0;
      let outsideGroup = descendants;
      if (rootLeadsGroup && typeof rootPid === "number") {
        try {
          kill(-rootPid, "SIGKILL");
          signalled += 1 + descendants.filter((entry) => entry.pgid === rootPid).length;
          outsideGroup = descendants.filter((entry) => entry.pgid !== rootPid);
        } catch {
          // The group is gone; what left it is still killed below.
        }
      }
      return signalled + killProcessTreeSnapshot(outsideGroup, deps);
    },
    killEntries: (entries) => (platform === "win32" ? 0 : killProcessTreeSnapshot(entries, deps)),
  };
}

export const defaultProcessTreeOps = createProcessTreeOps();
