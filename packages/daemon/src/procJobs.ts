/**
 * `raft proc` (#proj-raft-computer:#59): background jobs the Computer owns.
 *
 * An agent's long-running job (a dev server, a watcher, a bot) is spawned by
 * the daemon, not by the agent's shell: `detached: true`, so it leads its own
 * process group, with stdout and stderr opened straight onto
 * `<machine dir>/proc/<agent>/<name>.log`, so a daemon restart never breaks
 * its output. Every job is recorded in `proc-jobs.json` next to
 * `runtime-processes.json` (pid, group, start identity, agent, name, the
 * command's basename, start time), and a job is only ever signalled while
 * its pid still has the recorded start identity (`readProcessIdentity`), so
 * a reused pid is never touched.
 *
 * - What ends them: `raft proc stop`; the owner's Stop of the agent, its
 *   deletion (the `agent:stop` reason, the workspace delete) and its
 *   migration away (`stopAllForAgent`); `raft-computer stop --jobs`, which
 *   reads this ledger itself (packages/computer procJobs.ts). A lifecycle
 *   stop of the agent and a daemon restart leave them running, and so does a
 *   service restart, except on Linux for a job in the service's cgroup (no
 *   user systemd, below).
 * - Stop: the same path as the orphan sweep (`reapRecordedOrphans`): SIGTERM
 *   to the group, the stop grace (`AGENT_STOP_KILL_GRACE_MS`), SIGKILL of the
 *   group and of what left it; `--force` skips the grace.
 * - Daemon restart: the next daemon adopts the ledger's live jobs whose start
 *   identity still matches; the runtime orphan sweep never reaps them
 *   (`RuntimeProcessLedgerDeps.isForeignChild`, `filterProcJobsFromRuntimeRecords`).
 * - Logs: capped at `PROC_LOG_MAX_BYTES` with one rotation (`<name>.log.1`),
 *   checked on a timer and at every `logs` read. The job writes through an
 *   O_APPEND descriptor, so the rotation is copy-then-truncate.
 * - Environment: the caller's own, with the per-session CLI channel variables
 *   replaced by the agent's stable entry `cli-transport/<agent>/current/`
 *   (`procJobEnvironment`), so a job that calls `raft` keeps working after the
 *   agent's session rotates. The daemon's own environment is never added,
 *   except `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` when the caller has
 *   none and the job runs through `systemd-run` (it needs them to reach the
 *   user manager).
 * - Linux: where the agent's runtime runs in a cgroup of its own (an agent
 *   scope), the job joins it, and only for a caller the daemon confirms to
 *   descend from that runtime (`decideJobScope`); otherwise the start is
 *   refused. Where it has none and user systemd answers (`detectUserSystemd`),
 *   the job runs in a transient user scope of its own
 *   (`systemd-run --user --scope --unit raft-proc-<agent8>-<name> --collect -- argv`),
 *   so a restart of the Computer service (whose cgroup it would otherwise
 *   share) does not end it. `systemd-run --scope` registers its own pid as the
 *   scope and then execs the command: the recorded pid, group (it leads its
 *   own, `detached`) and start identity are the command's. Without user
 *   systemd the job stays in the service's cgroup and `start` says it stops
 *   with the service (`stopsWithService`). The ledger records `scope`.
 * - Windows: not in v1 (no daemon support, `proc@1` not declared).
 *
 * Invariant: a job runs as the daemon's user, outside the agent's runtime,
 * with everything that user can reach, not inside whatever the runtime
 * confines its tools to. That grants nothing new only because every runtime
 * runs its agent with full access today (`bypassPermissions`,
 * `danger-full-access`, `--dangerously-skip-permissions`, `--yolo`, ...;
 * `procRuntimeAccess.ts`). `start` refuses an agent whose runtime is not known
 * to run that way (unknown counts as not). If a runtime ever runs sandboxed,
 * its jobs need the same sandbox before it may be listed there.
 *
 * Trace events (`daemon.proc.started|stopped|exited|adopted`) carry counts and
 * codes only; never the command or its arguments.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  CLI_STABLE_ENTRY_DIRNAME,
  daemonApiProcStartBodySchema,
  isValidProcName,
  parseProcJobLedger,
  PROC_CAPABILITY,
  PROC_JOB_LEDGER_FILE,
  PROC_LOG_MAX_BYTES,
  PROC_LOGS_DEFAULT_TAIL,
  PROC_LOGS_MAX_TAIL,
  PROC_MAX_JOBS_PER_AGENT,
  PROC_NAME_MAX_LENGTH,
  type ProcErrorCode,
  type ProcJobLedgerEntry,
} from "@botiverse/raft-shared";
import { AGENT_STOP_KILL_CONFIRM_MS, AGENT_STOP_KILL_GRACE_MS } from "./drivers/processStop";
import { ancestorChain, readProcessIdentity, type ProcessIdentityDeps, type ProcessTreeDeps } from "./drivers/processTree";
import {
  reapRecordedOrphans,
  writeLedgerFileAtomic,
  type RuntimeProcessRecord,
} from "./drivers/runtimeProcessLedger";
import { ambientProcessEnv } from "./processEnvPatch";
import { runtimeRunsWithFullAccess } from "./procRuntimeAccess";

export { PROC_JOB_LEDGER_FILE };
/** Exited jobs one agent's list keeps (the newest), so `list` can show how a job ended. */
const PROC_EXITED_KEPT_PER_AGENT = 8;
const PROC_ROTATE_INTERVAL_MS = 15_000;
const PROC_LOGS_TAIL_READ_BYTES = 1024 * 1024;
const PROC_LOGS_FOLLOW_READ_BYTES = 256 * 1024;

// The per-session CLI channel (cliTransport.ts). Named here, not imported:
// cliTransport imports the proxy, which serves these jobs.
const SLOCK_CLI_TRANSPORT_DIR_ENV = "SLOCK_CLI_TRANSPORT_DIR";
const SLOCK_AGENT_LAUNCH_DIR_ENV = "SLOCK_AGENT_LAUNCH_DIR";
/**
 * Values the launch's wrapper set on the CLI process for that one launch: the
 * stable entry sets its own current ones each time a job runs `raft`.
 */
const PER_SESSION_ENV = [
  "SLOCK_AGENT_LAUNCH_ID",
  "SLOCK_AGENT_PROXY_URL",
  "SLOCK_AGENT_PROXY_TOKEN",
  "SLOCK_AGENT_PROXY_TOKEN_FILE",
  "SLOCK_AGENT_ACTIVE_CAPABILITIES",
  "SLOCK_CLI_MANAGED_FORWARD_ATTEMPT",
  "RAFT_CLI_ENTRY",
] as const;

export type ProcScope = "none" | "agent" | "created";
export type ProcStopReason = "agent" | "force" | "owner_stop" | "agent_deleted" | "migrated" | "uninstall";

/**
 * The job stop an `agent:stop` brings, from its optional `reason` (read as an
 * unknown value: an older server sends none). `owner_stop`, `deleted` and
 * `migrated` stop the agent's jobs; `lifecycle`, no reason or anything else
 * leave them running (null).
 */
export function procStopReasonForAgentStop(reason: unknown): ProcStopReason | null {
  switch (reason) {
    case "owner_stop":
      return "owner_stop";
    case "deleted":
      return "agent_deleted";
    case "migrated":
      return "migrated";
    default:
      return null;
  }
}

/** One ledger entry (shared `ProcJobLedgerEntry`: `raft-computer` reads the same file). */
export type ProcJobRecord = ProcJobLedgerEntry & { scope: ProcScope };

interface ProcLedgerFile {
  version: 1;
  jobs: ProcJobRecord[];
}

export interface ProcJobWire {
  name: string;
  pid: number;
  state: "running" | "exited";
  command: string;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  logPath: string;
  scope: ProcScope;
  adopted: boolean;
}

export type ProcTrace = (name: string, attrs: Record<string, unknown>, status?: "ok" | "error") => void;

export interface ProcJobManagerOptions {
  machineDir: string;
  platform?: NodeJS.Platform;
  /**
   * Running a job in a user systemd scope of its own (`detectUserSystemd`).
   * Default: on Linux, detected on the daemon's PATH; elsewhere off. Tests
   * turn it on with a PATH holding a fake `systemctl` and `systemd-run`.
   */
  userSystemd?: { pathEnv?: string } | false;
  trace?: ProcTrace;
  graceMs?: number;
  confirmMs?: number;
  maxJobsPerAgent?: number;
  logMaxBytes?: number;
  /** 0 turns the rotation/liveness timer off (tests drive `sweep()`). */
  rotateIntervalMs?: number;
  identity?: ProcessIdentityDeps;
  now?: () => number;
  /** Linux cgroup files (`/proc/<pid>/cgroup`, `cgroup.procs`); tests replace them. */
  cgroup?: ProcCgroupDeps;
  /** The process listing a caller's parent chain is read from (tests replace it). */
  tree?: ProcessTreeDeps;
  /** The agent's runtime processes, from the runtime ledger (`AgentProcessManager.runtimeProcessesForAgent`). */
  runtimeRoots?: (agentId: string) => readonly ProcRuntimeRoot[];
}

export interface ProcCgroupDeps {
  read(file: string): string;
  write(file: string, text: string): void;
  root: string;
}

export interface ProcStartInput {
  name?: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** The CLI's own pid: a claim, checked against the agent's runtime (`decideJobScope`). */
  callerPid?: number;
  /** `cli-transport/<agent>/current/` of the calling launch; null when it has none. */
  stableEntryDir: string | null;
  /** The calling launch's runtime id (`claude`, `codex`, ...); null when the launch didn't say. */
  runtime: string | null;
  /** The calling launch, when it has an id. */
  launchId: string | null;
}

export type ProcFailure = { ok: false; status: number; code: ProcErrorCode; message: string };
/** `stopsWithService`: the job shares the Computer service's cgroup (Linux without user systemd), so a service restart ends it. */
export type ProcStartResult = { ok: true; job: ProcJobRecord; autoNamed: boolean; stopsWithService: boolean } | ProcFailure;
export type ProcStopResult = { ok: true; job: ProcJobRecord; outcome: "exited" | "killed" | "already_exited"; graceMs: number } | ProcFailure;
export type ProcLogsResult = { ok: true; job: ProcJobRecord; text: string; offset: number; rotated: boolean } | ProcFailure;

const defaultCgroup: ProcCgroupDeps = {
  read: (file) => readFileSync(file, "utf8"),
  write: (file, text) => writeFileSync(file, text),
  root: "/sys/fs/cgroup",
};

const safePathPart = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "_");

/** `<machine dir>/proc/<agent>/<name>.log`: built only from the agent id and a validated name. */
export function procJobLogPath(machineDir: string, agentId: string, name: string): string {
  return path.join(machineDir, "proc", safePathPart(agentId), `${name}.log`);
}

/** Every refusal that leaves the agent no `raft proc` way ends with the one thing it can do instead. */
const PROC_FALLBACK = "start it with nohup inside your own process group and stop it with kill -- -<pgid>";

export function procRuntimeRestrictedMessage(runtime: string | null): string {
  const named = runtime && /^[a-z0-9-]{1,40}$/.test(runtime) ? `This agent's runtime (${runtime})` : "This agent's runtime";
  return `${named} isn't known to run with full access, and a job would run with more access than the agent has, so this Computer won't start it; ${PROC_FALLBACK}`;
}

export const PROC_SCOPE_UNCONFIRMED_MESSAGE =
  `This agent's commands run in their own resource scope on this Computer, and the daemon couldn't confirm this command runs inside it, so it won't start a job outside that budget; ${PROC_FALLBACK}`;

function failure(status: number, code: ProcErrorCode, message: string): ProcFailure {
  return { ok: false, status, code, message };
}

function key(agentId: string, name: string): string {
  return `${agentId}\u0000${name}`;
}

/**
 * The job's environment: the caller's own, with the per-session CLI channel
 * replaced by the agent's stable entry (#13975). PATH entries naming the
 * caller's launch directory become the stable entry directory (put first if
 * none did), and `SLOCK_CLI_TRANSPORT_DIR` / `SLOCK_AGENT_LAUNCH_DIR` name the
 * stable entry, so even a host-global `raft` hands the job's command to it
 * (`resolveManagedTransportWrapper`). The launch's own proxy URL, token file
 * and launch id are dropped: the stable entry sets the current ones.
 */
export function procJobEnvironment(
  callerEnv: Readonly<Record<string, string>>,
  stableEntryDir: string | null,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = { ...callerEnv };
  const launchDir = env[SLOCK_CLI_TRANSPORT_DIR_ENV];
  for (const name of PER_SESSION_ENV) delete env[name];
  delete env[SLOCK_CLI_TRANSPORT_DIR_ENV];
  delete env[SLOCK_AGENT_LAUNCH_DIR_ENV];
  const delimiter = platform === "win32" ? ";" : ":";
  const pathKey = platform === "win32"
    ? Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH"
    : "PATH";
  const isLaunchDir = (entry: string) => Boolean(launchDir) && path.resolve(entry) === path.resolve(launchDir!);
  const entries = (env[pathKey] ?? "").split(delimiter).filter((entry) => entry.length > 0);
  let next: string[];
  if (stableEntryDir) {
    next = [];
    for (const entry of entries) {
      const value: string = isLaunchDir(entry) ? stableEntryDir : entry;
      if (value === stableEntryDir && next.includes(stableEntryDir)) continue;
      next.push(value);
    }
    if (!next.includes(stableEntryDir)) next.unshift(stableEntryDir);
    env[SLOCK_CLI_TRANSPORT_DIR_ENV] = stableEntryDir;
    env[SLOCK_AGENT_LAUNCH_DIR_ENV] = CLI_STABLE_ENTRY_DIRNAME;
  } else {
    next = entries.filter((entry) => !isLaunchDir(entry));
  }
  env[pathKey] = next.join(delimiter);
  return env;
}

/** The cgroup v2 path of a `/proc/<pid>/cgroup` text (`0::<path>`), or null. */
export function cgroupV2Path(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.startsWith("0::")) {
      const value = line.slice(3).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** A runtime process of the agent, as the runtime ledger records it. */
export interface ProcRuntimeRoot {
  pid: number;
  startIdentity: string;
  launchId: string | null;
}

export type ProcScopeDecision =
  | { kind: "none" }
  | { kind: "agent"; cgroup: string }
  /** The agent runs in a scope of its own, and the caller could not be confirmed to be in it. */
  | { kind: "refuse" };

export interface ProcScopeDeps {
  cgroup?: ProcCgroupDeps;
  tree?: ProcessTreeDeps;
  identity?: ProcessIdentityDeps;
}

const inCgroupSubtree = (cgroup: string, root: string) => cgroup === root || cgroup.startsWith(`${root.replace(/\/+$/, "")}/`);

/**
 * Linux: which cgroup a new job of the agent joins. The daemon decides who
 * the caller is; the CLI's `callerPid` is only a claim.
 *
 * - The agent's runtime processes come from the runtime ledger (this launch's,
 *   when the ledger names launches), each still alive with its recorded start
 *   identity.
 * - The agent has a scope of its own when such a runtime runs in a cgroup
 *   other than the daemon's (`/proc/<runtime>/cgroup` vs `/proc/self/cgroup`).
 *   Without one, the job stays in the daemon's cgroup (`none`), whoever the
 *   caller is.
 * - With one, the caller is accepted only when its parent chain (one process
 *   listing, at most 64 steps) reaches one of those runtimes. The job then
 *   joins the caller's cgroup when that lies inside the runtime's, else the
 *   runtime's own. A caller that can't be confirmed is refused: the job never
 *   lands in the daemon's cgroup, out of the agent's budget.
 *
 * Off Linux there are no cgroups: `none`.
 */
export async function decideJobScope(
  input: { callerPid: number | undefined; launchId: string | null; roots: readonly ProcRuntimeRoot[]; platform: NodeJS.Platform },
  deps: ProcScopeDeps = {},
): Promise<ProcScopeDecision> {
  if (input.platform !== "linux") return { kind: "none" };
  const cgroup = deps.cgroup ?? defaultCgroup;
  const readCgroup = (pid: number | "self") => {
    try {
      return cgroupV2Path(cgroup.read(`/proc/${pid}/cgroup`));
    } catch {
      return null;
    }
  };
  const candidates = input.roots.filter((root) => !input.launchId || !root.launchId || root.launchId === input.launchId);
  const live = (await Promise.all(candidates.map(async (root) => {
    const identity = await readProcessIdentity(root.pid, { platform: input.platform, ...deps.identity });
    return identity?.startIdentity === root.startIdentity ? root : null;
  }))).filter((root): root is ProcRuntimeRoot => root !== null);
  if (live.length === 0) return { kind: "none" };
  const own = readCgroup("self");
  const rootCgroups = new Map(live.map((root) => [root.pid, readCgroup(root.pid)]));
  const scoped = (cg: string | null | undefined): cg is string => Boolean(cg) && cg !== "/" && cg !== own;
  if (![...rootCgroups.values()].some(scoped)) return { kind: "none" };
  const chain = input.callerPid ? await ancestorChain(input.callerPid, { platform: input.platform, ...deps.tree }) : [];
  const confirmed = live.find((root) => chain.includes(root.pid));
  if (!confirmed) return { kind: "refuse" };
  const rootCgroup = rootCgroups.get(confirmed.pid);
  if (!scoped(rootCgroup)) return { kind: "none" };
  const callerCgroup = readCgroup(input.callerPid!);
  return { kind: "agent", cgroup: callerCgroup && inCgroupSubtree(callerCgroup, rootCgroup) ? callerCgroup : rootCgroup };
}

/** Move a just-spawned job into a cgroup; false when the kernel refuses. */
export function moveJobIntoCgroup(cgroupPath: string, jobPid: number, deps: ProcCgroupDeps = defaultCgroup): boolean {
  try {
    deps.write(path.join(deps.root, cgroupPath, "cgroup.procs"), String(jobPid));
    return true;
  } catch {
    return false;
  }
}

/** The user systemd manager states in which it answers (`systemctl --user is-system-running`; `degraded` exits 1). */
const USER_SYSTEMD_REACHABLE_STATES = new Set(["initializing", "starting", "running", "degraded", "maintenance"]);
const AGENT_SHORT_PATTERN = /^[0-9a-f]{8}$/;

/** `name` on a PATH, as an absolute executable path, or null. */
function whichOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(":")) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/**
 * Whether user systemd can take a job: `systemd-run` is on the PATH and
 * `systemctl --user is-system-running` reports a state of a running user
 * manager (its exit code alone is not enough: `degraded` exits 1;
 * `systemd-run --version` alone never contacts the manager). The absolute
 * `systemd-run`, or null.
 */
export async function detectUserSystemd(pathEnv: string): Promise<string | null> {
  const systemdRun = whichOnPath("systemd-run", pathEnv);
  const systemctl = whichOnPath("systemctl", pathEnv);
  if (!systemdRun || !systemctl) return null;
  const state = await new Promise<string>((resolve) => {
    // The ambient env carries XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS, which `systemctl --user` needs.
    execFile(systemctl, ["--user", "is-system-running"], { env: ambientProcessEnv(), timeout: 3_000, windowsHide: true }, (_err, stdout) => {
      resolve(String(stdout ?? "").trim());
    });
  });
  return USER_SYSTEMD_REACHABLE_STATES.has(state) ? systemdRun : null;
}

/**
 * `raft-proc-<agent8>-<name>.scope`'s unit name, only from the first 8 hex
 * characters of the agent id and a valid job name (`^[A-Za-z0-9_-]{1,40}$`):
 * nothing else reaches systemd. Null for anything else.
 */
export function procScopeUnitName(agentId: string, name: string): string | null {
  const agentShort = agentId.slice(0, 8).toLowerCase();
  if (!AGENT_SHORT_PATTERN.test(agentShort) || !isValidProcName(name)) return null;
  return `raft-proc-${agentShort}-${name}`;
}

/** The argv that runs `argv` in a transient user scope (no shell: systemd-run execs it). */
export function procScopeArgv(systemdRun: string, unit: string, argv: readonly string[]): string[] {
  return [systemdRun, "--user", "--scope", "--unit", unit, "--collect", "--", ...argv];
}

/** An automatic name: the command's basename in the name alphabet, unique among the agent's jobs. */
function automaticName(argv0: string, taken: (name: string) => boolean): string {
  const base = (path.basename(argv0).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "job")
    .slice(0, PROC_NAME_MAX_LENGTH - 4);
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

function readLedger(file: string): ProcJobRecord[] {
  try {
    return parseProcJobLedger(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/**
 * The runtime orphan sweep's leftover without the proc jobs a ledger names
 * (same pid and start identity): those are adopted, never reaped.
 */
export function filterProcJobsFromRuntimeRecords(
  machineDir: string,
  records: readonly RuntimeProcessRecord[],
): RuntimeProcessRecord[] {
  const jobs = new Set(readLedger(path.join(machineDir, PROC_JOB_LEDGER_FILE))
    .filter((job) => job.state === "running" && job.startIdentity)
    .map((job) => `${job.pid}:${job.startIdentity}`));
  if (jobs.size === 0) return [...records];
  return records.filter((record) => !jobs.has(`${record.pid}:${record.startIdentity}`));
}

export function procJobToWire(job: ProcJobRecord): ProcJobWire {
  return {
    name: job.name,
    pid: job.pid,
    state: job.state,
    command: job.command,
    startedAt: new Date(job.startedAtMs).toISOString(),
    exitedAt: job.exitedAtMs === null ? null : new Date(job.exitedAtMs).toISOString(),
    exitCode: job.exitCode,
    exitSignal: job.exitSignal,
    logPath: job.logPath,
    scope: job.scope,
    adopted: job.adopted,
  };
}

function rotateIfNeeded(logPath: string, maxBytes: number): boolean {
  try {
    if (statSync(logPath).size <= maxBytes) return false;
    copyFileSync(logPath, `${logPath}.1`);
    truncateSync(logPath, 0);
    return true;
  } catch {
    return false;
  }
}

function readRange(file: string, start: number, end: number): string {
  if (end <= start) return "";
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export class ProcJobManager {
  private readonly jobs = new Map<string, ProcJobRecord>();
  /** Jobs this daemon spawned: their exit is observed (code and signal). */
  private readonly children = new Map<number, ChildProcess>();
  private readonly exitTraced = new WeakSet<ProcJobRecord>();
  private readonly file: string;
  private readonly platform: NodeJS.Platform;
  private readonly graceMs: number;
  private readonly confirmMs: number;
  private readonly maxJobs: number;
  private readonly logMaxBytes: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The absolute `systemd-run` when user systemd takes jobs; detected once. */
  private userSystemdRun: Promise<string | null> | null = null;

  private constructor(private readonly options: ProcJobManagerOptions) {
    this.file = path.join(options.machineDir, PROC_JOB_LEDGER_FILE);
    this.platform = options.platform ?? process.platform;
    this.graceMs = options.graceMs ?? AGENT_STOP_KILL_GRACE_MS;
    this.confirmMs = options.confirmMs ?? AGENT_STOP_KILL_CONFIRM_MS;
    this.maxJobs = options.maxJobsPerAgent ?? PROC_MAX_JOBS_PER_AGENT;
    this.logMaxBytes = options.logMaxBytes ?? PROC_LOG_MAX_BYTES;
    this.now = options.now ?? Date.now;
    this.ready = this.adopt().catch(() => {});
  }

  /** Settles once what an earlier daemon left running is adopted; every operation waits for it. */
  readonly ready: Promise<void>;

  /** Open the ledger and adopt what an earlier daemon left running. Never rejects. */
  static async open(options: ProcJobManagerOptions): Promise<ProcJobManager> {
    const manager = ProcJobManager.start(options);
    await manager.ready;
    return manager;
  }

  /** The same, usable at once: adoption runs in the background and operations wait for it. */
  static start(options: ProcJobManagerOptions): ProcJobManager {
    const manager = new ProcJobManager(options);
    const interval = options.rotateIntervalMs ?? PROC_ROTATE_INTERVAL_MS;
    if (interval > 0) {
      manager.timer = setInterval(() => manager.sweep(), interval);
      manager.timer.unref?.();
    }
    return manager;
  }

  private closed = false;

  /**
   * The jobs keep running: a daemon restart adopts them. Stops the sweep, and
   * from here on nothing writes the ledger (an exit observed later, a stop
   * still under way, adoption finishing): the next daemon reads the jobs as
   * they are. Settles once adoption has. Idempotent; a closed manager is not
   * reopened (the daemon opens a new one on its next start).
   */
  close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closed = true;
    return this.ready;
  }

  /** A running job's pid (not a runtime): the runtime ledger never records it. */
  ownsPid(pid: number): boolean {
    if (this.children.has(pid)) return true;
    for (const job of this.jobs.values()) if (job.state === "running" && job.pid === pid) return true;
    return false;
  }

  private userSystemdEnabled(): boolean {
    return this.options.userSystemd === undefined ? this.platform === "linux" : this.options.userSystemd !== false;
  }

  private detectUserSystemdOnce(): Promise<string | null> {
    if (!this.userSystemdEnabled()) return Promise.resolve(null);
    const pathEnv = (this.options.userSystemd || undefined)?.pathEnv ?? process.env.PATH ?? "";
    this.userSystemdRun ??= detectUserSystemd(pathEnv).catch(() => null);
    return this.userSystemdRun;
  }

  get maxJobsPerAgent(): number {
    return this.maxJobs;
  }

  private trace(name: string, attrs: Record<string, unknown>, status?: "ok" | "error"): void {
    try {
      this.options.trace?.(name, attrs, status);
    } catch {
      // Tracing never breaks a job.
    }
  }

  private persist(): void {
    if (this.closed) return;
    mkdirSync(this.options.machineDir, { recursive: true });
    writeLedgerFileAtomic(this.file, { version: 1, jobs: [...this.jobs.values()] } satisfies ProcLedgerFile);
  }

  private agentJobs(agentId: string): ProcJobRecord[] {
    return [...this.jobs.values()].filter((job) => job.agentId === agentId);
  }

  private async adopt(): Promise<void> {
    const recorded = readLedger(this.file);
    let adopted = 0;
    let gone = 0;
    await Promise.all(recorded.map(async (job) => {
      if (job.state === "running") {
        const identity = job.startIdentity ? await readProcessIdentity(job.pid, this.identityDeps()) : null;
        if (identity && identity.startIdentity === job.startIdentity) {
          job.adopted = true;
          adopted += 1;
        } else {
          // Gone, or the pid now belongs to another process: never signalled.
          this.markExited(job, null, null);
          gone += 1;
        }
      }
    }));
    for (const job of recorded) this.jobs.set(key(job.agentId, job.name), job);
    this.prune();
    this.persist();
    if (recorded.length > 0) {
      this.trace("daemon.proc.adopted", {
        recorded_count: recorded.length,
        adopted_count: adopted,
        gone_count: gone,
        agent_count: new Set(recorded.filter((job) => job.adopted && job.state === "running").map((job) => job.agentId)).size,
      });
    }
  }

  private identityDeps(): ProcessIdentityDeps {
    return { platform: this.platform, ...this.options.identity };
  }

  private markExited(job: ProcJobRecord, code: number | null, signal: string | null): void {
    job.state = "exited";
    job.exitCode = code;
    job.exitSignal = signal;
    job.exitedAtMs ??= this.now();
    if (this.exitTraced.has(job)) return;
    this.exitTraced.add(job);
    this.trace("daemon.proc.exited", {
      agentId: job.agentId,
      code: code ?? "unknown",
      signal: signal ?? "none",
      adopted: job.adopted,
      run_ms: Math.max(0, job.exitedAtMs - job.startedAtMs),
    });
  }

  /** Keep the newest exited records per agent. */
  private prune(): void {
    const exitedByAgent = new Map<string, ProcJobRecord[]>();
    for (const job of this.jobs.values()) {
      if (job.state !== "exited") continue;
      const list = exitedByAgent.get(job.agentId) ?? [];
      list.push(job);
      exitedByAgent.set(job.agentId, list);
    }
    for (const list of exitedByAgent.values()) {
      list.sort((a, b) => (b.exitedAtMs ?? 0) - (a.exitedAtMs ?? 0));
      for (const job of list.slice(PROC_EXITED_KEPT_PER_AGENT)) this.jobs.delete(key(job.agentId, job.name));
    }
  }

  /** An adopted job (not this daemon's child) is checked by identity; a spawned one reports its own exit. */
  private async refresh(job: ProcJobRecord): Promise<void> {
    if (job.state !== "running" || this.children.has(job.pid)) return;
    const identity = job.startIdentity ? await readProcessIdentity(job.pid, this.identityDeps()) : null;
    if (!identity || identity.startIdentity !== job.startIdentity) {
      this.markExited(job, null, null);
      this.persist();
    }
  }

  /** Rotate oversized logs; notice adopted jobs that are gone. Called on a timer. */
  sweep(): void {
    let changed = false;
    for (const job of this.jobs.values()) {
      if (job.state !== "running") continue;
      rotateIfNeeded(job.logPath, this.logMaxBytes);
      if (this.children.has(job.pid)) continue;
      try {
        process.kill(job.pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          this.markExited(job, null, null);
          changed = true;
        }
      }
    }
    if (changed) {
      this.prune();
      this.persist();
    }
  }

  async list(agentId: string): Promise<ProcJobRecord[]> {
    await this.ready;
    const jobs = this.agentJobs(agentId);
    await Promise.all(jobs.map((job) => this.refresh(job)));
    return this.agentJobs(agentId).sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  async start(agentId: string, input: ProcStartInput): Promise<ProcStartResult> {
    await this.ready;
    if (input.argv.length === 0 || !input.argv[0]) return failure(400, "proc_invalid_argv", "Give the command after --: raft proc start -- <command> [args...]");
    if (input.name !== undefined && !isValidProcName(input.name)) {
      return failure(400, "proc_invalid_name", `A job name uses letters, digits, - and _ only, at most ${PROC_NAME_MAX_LENGTH} characters; pick another --name`);
    }
    if (!path.isAbsolute(input.cwd)) return failure(400, "proc_invalid_cwd", `The working directory must be an absolute path: ${input.cwd}`);
    try {
      if (!statSync(input.cwd).isDirectory()) return failure(400, "proc_invalid_cwd", `Not a directory: ${input.cwd}`);
    } catch {
      return failure(400, "proc_invalid_cwd", `No such directory: ${input.cwd}`);
    }
    // The job is spawned in this directory as the Computer's own OS user. A
    // directory that user cannot enter (another user's home, e.g. /root when
    // the CLI ran from a root shell) fails the spawn's chdir with a bare
    // EACCES; name the directory instead (#proj-raft-computer:#59, AX42-1).
    try {
      accessSync(input.cwd, fsConstants.X_OK);
    } catch {
      return failure(
        400,
        "proc_invalid_cwd",
        `The Computer can't enter the working directory ${input.cwd}; run the command from a directory it can enter, or pass --cwd`,
      );
    }
    if (!runtimeRunsWithFullAccess(input.runtime)) {
      this.trace("daemon.proc.start_refused", { agentId, code: "proc_runtime_restricted", runtime_known: Boolean(input.runtime) }, "error");
      return failure(403, "proc_runtime_restricted", procRuntimeRestrictedMessage(input.runtime));
    }
    const scope = await decideJobScope({
      callerPid: input.callerPid,
      launchId: input.launchId,
      roots: this.options.runtimeRoots?.(agentId) ?? [],
      platform: this.platform,
    }, {
      ...(this.options.cgroup ? { cgroup: this.options.cgroup } : {}),
      ...(this.options.tree ? { tree: this.options.tree } : {}),
      ...(this.options.identity ? { identity: this.options.identity } : {}),
    });
    if (scope.kind === "refuse") {
      this.trace("daemon.proc.start_refused", { agentId, code: "proc_scope_unconfirmed" }, "error");
      return failure(403, "proc_scope_unconfirmed", PROC_SCOPE_UNCONFIRMED_MESSAGE);
    }
    // No scope of the agent's: a user scope of the job's own, where user systemd answers.
    const systemdRun = scope.kind === "none" ? await this.detectUserSystemdOnce() : null;
    // Make sure adopted jobs that ended no longer count.
    await Promise.all(this.agentJobs(agentId).map((job) => this.refresh(job)));

    // From here to the record, nothing awaits: two starts can't both pass the checks.
    const mine = this.agentJobs(agentId);
    const running = mine.filter((job) => job.state === "running");
    if (input.name !== undefined && running.some((job) => job.name === input.name)) {
      return failure(409, "proc_name_taken", `A job named ${input.name} is already running; stop it (raft proc stop ${input.name}) or pick another --name`);
    }
    if (running.length >= this.maxJobs) {
      return failure(409, "proc_limit", `This agent already runs ${running.length} jobs, the most it can run at once`);
    }
    const autoNamed = input.name === undefined;
    const name = input.name ?? automaticName(input.argv[0], (candidate) => mine.some((job) => job.name === candidate));
    const jobEnv = procJobEnvironment(input.env, input.stableEntryDir, this.platform);
    let argv = input.argv;
    if (systemdRun) {
      const unit = procScopeUnitName(agentId, name);
      if (!unit) {
        this.trace("daemon.proc.start_refused", { agentId, code: "proc_spawn_failed", stage: "scope_unit_name" }, "error");
        return failure(500, "proc_spawn_failed", "This job can't be given a systemd scope name on this Computer; it was not started");
      }
      // systemd-run execs the command itself, so a missing one would only
      // show as an exited job: refuse it here, as a direct spawn does.
      const command = input.argv[0];
      const found = command.includes("/")
        ? (() => { try { accessSync(path.resolve(input.cwd, command), fsConstants.X_OK); return true; } catch { return false; } })()
        : whichOnPath(command, jobEnv.PATH ?? "") !== null;
      if (!found) {
        this.trace("daemon.proc.start_failed", { agentId, code: "ENOENT", stage: "scope" }, "error");
        return failure(400, "proc_spawn_failed", `Could not start ${path.basename(command)}: command not found`);
      }
      // systemd-run reaches the user manager through these; only they are
      // taken from the daemon, and only when the caller had none.
      for (const variable of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const) {
        if (jobEnv[variable] === undefined && process.env[variable]) jobEnv[variable] = process.env[variable]!;
      }
      argv = procScopeArgv(systemdRun, unit, input.argv);
    }
    const jobScope: ProcScope = systemdRun ? "created" : scope.kind;
    const logPath = procJobLogPath(this.options.machineDir, agentId, name);
    let child: ChildProcess;
    try {
      mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
      // The previous log of this name (a job that has exited) is kept once.
      if (existsSync(logPath)) renameSync(logPath, `${logPath}.1`);
      const fd = openSync(logPath, "a", 0o600);
      try {
        child = spawn(argv[0]!, argv.slice(1), {
          cwd: input.cwd,
          env: jobEnv,
          detached: true,
          stdio: ["ignore", fd, fd],
          windowsHide: true,
        });
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      return failure(500, "proc_spawn_failed", `Could not start ${path.basename(input.argv[0])}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    // Later signal errors are expected (a job that already exited); never let them throw.
    const spawnError = new Promise<NodeJS.ErrnoException>((resolve) => child.once("error", resolve));
    child.on("error", () => {});
    const pid = child.pid;
    if (typeof pid !== "number") {
      const err = await spawnError;
      this.trace("daemon.proc.start_failed", { agentId, code: err.code ?? "unknown" }, "error");
      return failure(400, "proc_spawn_failed", `Could not start ${path.basename(input.argv[0])}: ${err.code === "ENOENT" ? "command not found" : err.code ?? err.message}`);
    }
    child.unref();
    if (scope.kind === "agent" && !moveJobIntoCgroup(scope.cgroup, pid, this.options.cgroup)) {
      // Never left running in the daemon's cgroup, out of the agent's budget.
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      this.trace("daemon.proc.start_refused", { agentId, code: "proc_scope_unconfirmed", stage: "move" }, "error");
      return failure(403, "proc_scope_unconfirmed", PROC_SCOPE_UNCONFIRMED_MESSAGE);
    }
    this.children.set(pid, child);
    const job: ProcJobRecord = {
      agentId,
      name,
      pid,
      pgid: pid,
      startIdentity: null,
      command: path.basename(input.argv[0]),
      startedAtMs: this.now(),
      logPath,
      scope: jobScope,
      state: "running",
      exitCode: null,
      exitSignal: null,
      exitedAtMs: null,
      adopted: false,
    };
    this.jobs.set(key(agentId, name), job);
    child.once("exit", (code, signal) => {
      this.children.delete(pid);
      this.markExited(job, code, signal);
      if (this.jobs.get(key(agentId, name)) === job) {
        this.prune();
        this.persist();
      }
    });
    const identity = await readProcessIdentity(pid, this.identityDeps());
    if (identity && job.state === "running") {
      job.startIdentity = identity.startIdentity;
      job.pgid = identity.pgid;
    }
    this.persist();
    this.trace("daemon.proc.started", {
      agentId,
      scope: job.scope,
      auto_named: autoNamed,
      running_count: running.length + 1,
      identity_read: job.startIdentity !== null,
    });
    // Linux, in the service's cgroup: a restart of the Computer service ends it.
    const stopsWithService = this.userSystemdEnabled() && jobScope === "none";
    return { ok: true, job, autoNamed, stopsWithService };
  }

  async stop(agentId: string, name: string, options: { force?: boolean; reason?: ProcStopReason } = {}): Promise<ProcStopResult> {
    await this.ready;
    const job = this.jobs.get(key(agentId, name));
    if (!job) return failure(404, "proc_not_found", `No job named ${name}; list them: raft proc list`);
    const graceMs = options.force ? 0 : this.graceMs;
    await this.refresh(job);
    if (job.state === "exited") return { ok: true, job, outcome: "already_exited", graceMs };
    if (!job.startIdentity) {
      const identity = await readProcessIdentity(job.pid, this.identityDeps());
      if (identity && this.children.has(job.pid)) {
        job.startIdentity = identity.startIdentity;
        job.pgid = identity.pgid;
      }
    }
    if (!job.startIdentity) {
      return failure(500, "proc_stop_unconfirmed", `Could not confirm that pid ${job.pid} is still ${name}; it was not signalled`);
    }
    const result = await reapRecordedOrphans([{
      pid: job.pid,
      pgid: job.pgid,
      startIdentity: job.startIdentity,
      agentId,
      launchId: null,
      host: "legacy",
      recordedAtMs: job.startedAtMs,
    }], {
      platform: this.platform,
      graceMs,
      confirmMs: this.confirmMs,
      ...(this.options.identity ? { identity: this.options.identity } : {}),
    });
    const reason: ProcStopReason = options.force ? "force" : options.reason ?? "agent";
    if (result.stillAlive.length > 0) {
      this.trace("daemon.proc.stopped", { agentId, reason, outcome: "unconfirmed", grace_ms: graceMs }, "error");
      return failure(500, "proc_stop_unconfirmed", `${name} (pid ${job.pid}) was sent SIGKILL but was not seen to exit`);
    }
    const outcome = result.skipped > 0 ? "already_exited" : result.escalated.length > 0 ? "killed" : "exited";
    // A spawned job's exit event brings its code and signal; give it a moment.
    const child = this.children.get(job.pid);
    if (child && job.state === "running") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (job.state === "running") this.markExited(job, null, outcome === "killed" ? "SIGKILL" : null);
    this.prune();
    this.persist();
    this.trace("daemon.proc.stopped", { agentId, reason, outcome, grace_ms: graceMs, adopted: job.adopted });
    return { ok: true, job, outcome, graceMs };
  }

  /**
   * Every running job of the agent: the owner's Stop and a delete
   * (`agent:stop` reason, `procStopReasonForAgentStop`), a deleted workspace,
   * a migration away (core.ts). A lifecycle stop leaves them running.
   */
  async stopAllForAgent(agentId: string, reason: ProcStopReason): Promise<number> {
    await this.ready;
    const running = this.agentJobs(agentId).filter((job) => job.state === "running");
    const results = await Promise.all(running.map((job) => this.stop(agentId, job.name, { reason })));
    return results.filter((result) => result.ok && result.outcome !== "already_exited").length;
  }

  async logs(agentId: string, name: string, options: { tail?: number; offset?: number } = {}): Promise<ProcLogsResult> {
    await this.ready;
    const job = this.jobs.get(key(agentId, name));
    if (!job) return failure(404, "proc_not_found", `No job named ${name}; list them: raft proc list`);
    await this.refresh(job);
    rotateIfNeeded(job.logPath, this.logMaxBytes);
    let size = 0;
    try {
      size = statSync(job.logPath).size;
    } catch {
      return { ok: true, job, text: "", offset: 0, rotated: false };
    }
    if (options.offset !== undefined) {
      const rotated = options.offset > size;
      const start = rotated ? 0 : options.offset;
      const end = Math.min(size, start + PROC_LOGS_FOLLOW_READ_BYTES);
      return { ok: true, job, text: readRange(job.logPath, start, end), offset: end, rotated };
    }
    const tail = Math.min(Math.max(1, options.tail ?? PROC_LOGS_DEFAULT_TAIL), PROC_LOGS_MAX_TAIL);
    const start = Math.max(0, size - PROC_LOGS_TAIL_READ_BYTES);
    const lines = readRange(job.logPath, start, size).split("\n");
    if (start > 0) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const kept = lines.slice(-tail);
    return { ok: true, job, text: kept.length > 0 ? `${kept.join("\n")}\n` : "", offset: size, rotated: false };
  }
}

/** One request to `/internal/agent-api/proc*`, already authenticated as a live launch of `agentId`. */
export interface ProcEndpointRequest {
  agentId: string;
  /** The launch's stable entry wrapper (`cli-transport/<agent>/current/raft`), or null. */
  stableEntryPath: string | null;
  /** The serving launch's id and runtime, as the daemon registered them (never the caller's word). */
  launchId: string | null;
  runtime: string | null;
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: Buffer | undefined;
}

export interface ProcEndpointResponse {
  status: number;
  body: Record<string, unknown>;
}

function errorResponse(result: ProcFailure): ProcEndpointResponse {
  return { status: result.status, body: { capability: PROC_CAPABILITY, error: result.message, code: result.code } };
}

function queryInt(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/** The proxy's proc routes. `manager` null: this daemon runs no jobs (Windows). */
export async function handleProcRequest(manager: ProcJobManager | null, request: ProcEndpointRequest): Promise<ProcEndpointResponse> {
  if (!manager) {
    return {
      status: 501,
      body: { error: "This Computer's daemon does not run jobs on this platform yet", code: "proc_unsupported" satisfies ProcErrorCode },
    };
  }
  const base = "/internal/agent-api/proc";
  const route = request.pathname === base ? "" : request.pathname.slice(base.length);
  if (request.method === "GET" && route === "") {
    const jobs = await manager.list(request.agentId);
    return { status: 200, body: { capability: PROC_CAPABILITY, jobs: jobs.map(procJobToWire), maxJobs: manager.maxJobsPerAgent } };
  }
  if (request.method === "GET" && route === "/logs") {
    const name = request.query.get("name") ?? "";
    if (!isValidProcName(name)) return errorResponse(failure(400, "proc_invalid_name", "Name a job: raft proc logs <name>"));
    const result = await manager.logs(request.agentId, name, {
      tail: queryInt(request.query.get("tail")),
      offset: queryInt(request.query.get("offset")),
    });
    if (!result.ok) return errorResponse(result);
    return { status: 200, body: { capability: PROC_CAPABILITY, job: procJobToWire(result.job), text: result.text, offset: result.offset, rotated: result.rotated } };
  }
  if (request.method === "POST" && (route === "/start" || route === "/stop")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body?.toString("utf8") ?? "");
    } catch {
      return errorResponse(failure(400, "proc_invalid_argv", "The request body is not JSON"));
    }
    if (route === "/start") {
      const body = daemonApiProcStartBodySchema.safeParse(parsed);
      if (!body.success) return errorResponse(failure(400, "proc_invalid_argv", "Give the command after --: raft proc start -- <command> [args...]"));
      const result = await manager.start(request.agentId, {
        ...(body.data.name !== undefined ? { name: body.data.name } : {}),
        argv: body.data.argv,
        cwd: body.data.cwd,
        env: body.data.env,
        ...(body.data.callerPid !== undefined ? { callerPid: body.data.callerPid } : {}),
        stableEntryDir: request.stableEntryPath ? path.dirname(request.stableEntryPath) : null,
        runtime: request.runtime,
        launchId: request.launchId,
      });
      if (!result.ok) return errorResponse(result);
      return {
        status: 200,
        body: {
          capability: PROC_CAPABILITY,
          job: procJobToWire(result.job),
          autoNamed: result.autoNamed,
          ...(result.stopsWithService ? { stopsWithService: true } : {}),
        },
      };
    }
    const body = parsed as { name?: unknown; force?: unknown } | null;
    const name = body?.name;
    if (!isValidProcName(name)) return errorResponse(failure(400, "proc_invalid_name", "Name a job: raft proc stop <name>"));
    const result = await manager.stop(request.agentId, name, { force: body?.force === true });
    if (!result.ok) return errorResponse(result);
    return { status: 200, body: { capability: PROC_CAPABILITY, job: procJobToWire(result.job), outcome: result.outcome, graceMs: result.graceMs } };
  }
  return { status: 404, body: { capability: PROC_CAPABILITY, error: `No such proc route: ${request.method} ${request.pathname}`, code: "proc_not_found" } };
}
