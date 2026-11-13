// External supervisor (task #917): when an init system such as systemd owns
// the Computer service, the service must not spawn its own replacement on
// restart or upgrade, and `raft-computer start` / `stop` must act through the
// supervisor rather than beside it. Otherwise the replacement is either killed
// with the unit's cgroup or left as a process systemd does not track, which
// then collides with the duplicate-key guard (task #914) on the next start.
//
// Detection is deliberately strict: Linux, systemd's INVOCATION_ID in the
// environment, our own cgroup naming a `*.service`, and that unit's MainPID
// being this process. A terminal `raft-computer start --foreground` matches
// none of these and keeps today's behaviour. Non-systemd supervisors (a
// container entrypoint, runit) opt in with RAFT_COMPUTER_EXTERNAL_SUPERVISOR=1
// and get the exit-and-relaunch contract without any systemctl delegation.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serviceRunDir } from "./paths";

/** Opt-in for supervisors other than systemd: "I relaunch you when you exit". */
export const EXTERNAL_SUPERVISOR_ENV_VAR = "RAFT_COMPUTER_EXTERNAL_SUPERVISOR";
/** systemd sets this for every process it starts as a unit. */
export const SYSTEMD_INVOCATION_ENV_VAR = "INVOCATION_ID";

/**
 * Exit code of a supervised service that wants to be relaunched (restart or
 * upgrade). EX_TEMPFAIL: the supervisor's `Restart=` policy brings it back.
 * MUST NOT appear in INTENTIONAL_STOP_EXIT_CODES.
 */
export const SUPERVISED_RELAUNCH_EXIT_CODE = 75;

/**
 * Exit codes of a service that stopped on purpose and must stay stopped. A
 * unit template lists them in `RestartPreventExitStatus=`; the contract test
 * in externalSupervisor.test.ts pins every non-zero `process.exit` in the
 * service to this list so a new terminal path cannot silently loop under
 * `Restart=always`.
 *   77 — the machine was unlinked/revoked on the server (COMPUTER_MACHINE_UNLINKED_EXIT_CODE)
 *   78 — refused to start on configuration (EX_CONFIG_EXIT_CODE, e.g. RAFT_HOME_AMBIGUOUS)
 */
export const INTENTIONAL_STOP_EXIT_CODES: readonly number[] = [77, 78];

/**
 * Exit codes after which a supervisor SHOULD relaunch the service: the
 * deliberate hand-off (75) and a crash / unexpected error (1). The contract
 * test requires every non-zero exit in the service to be in exactly one of
 * the two classes, so a new terminal path must say which it is.
 */
export const RELAUNCH_EXIT_CODES: readonly number[] = [SUPERVISED_RELAUNCH_EXIT_CODE, 1];

export type SupervisorScope = "user" | "system";

export interface ExternalSupervisorRecord {
  kind: "systemd";
  scope: SupervisorScope;
  unit: string;
  invocationId: string;
  /** Pid of the service process that wrote the record (the unit's MainPID). */
  pid: number;
  recordedAt: string;
}

export const SUPERVISOR_RECORD_FILE = "supervisor.json";

export function supervisorRecordPath(slockHome: string): string {
  return path.join(serviceRunDir(slockHome), SUPERVISOR_RECORD_FILE);
}

/**
 * The `*.service` unit this process runs in, from /proc/self/cgroup. cgroup v2
 * has one `0::<path>` line; v1 lists one `<n>:<controllers>:<path>` per
 * controller and the systemd hierarchy carries the unit. The scope is `user`
 * when the path passes through a per-user manager (`user@<uid>.service`).
 */
export function parseSystemdUnitFromCgroup(text: string): { unit: string; scope: SupervisorScope } | null {
  for (const line of text.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const controllers = parts[1] ?? "";
    const cgroupPath = parts.slice(2).join(":").trim();
    if (!cgroupPath.startsWith("/")) continue;
    // v1: only the systemd hierarchy names units; other controllers may be mounted elsewhere.
    if (parts[0] !== "0" && !controllers.split(",").includes("name=systemd")) continue;
    const segments = cgroupPath.split("/").filter(Boolean);
    const unit = [...segments].reverse().find((segment) => segment.endsWith(".service"));
    if (!unit) continue;
    // The per-user manager's own unit is the scope boundary, never the answer.
    if (/^user@\d+\.service$/u.test(unit)) continue;
    const scope: SupervisorScope = segments.some((segment) => /^user@\d+\.service$/u.test(segment)) ? "user" : "system";
    return { unit, scope };
  }
  return null;
}

export interface SystemctlResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type SystemctlRunner = (scope: SupervisorScope, args: string[]) => Promise<SystemctlResult>;

const SYSTEMCTL_TIMEOUT_MS = 15_000;

/** Run `systemctl [--user] <args>` with a bound; never a shell. */
export const runSystemctl: SystemctlRunner = (scope, args) => new Promise((resolve) => {
  const child = spawn("systemctl", scope === "user" ? ["--user", ...args] : args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, SYSTEMCTL_TIMEOUT_MS);
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

/** `systemctl show -P <property>`; null when systemctl is unreachable or the unit is unknown. */
export async function showUnitProperty(
  runner: SystemctlRunner,
  scope: SupervisorScope,
  unit: string,
  property: string,
): Promise<string | null> {
  const result = await runner(scope, ["show", "-P", property, unit]);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

export interface DetectDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  readCgroup?: () => Promise<string>;
  systemctl?: SystemctlRunner;
  now?: () => Date;
}

/**
 * Is THIS process the main process of a systemd unit? All of: Linux,
 * INVOCATION_ID present, own cgroup names a service unit, that unit's MainPID
 * is us. Returns the record to persist, or null.
 */
export async function detectSystemdSupervisor(deps: DetectDeps = {}): Promise<ExternalSupervisorRecord | null> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const pid = deps.pid ?? process.pid;
  if (platform !== "linux") return null;
  const invocationId = env[SYSTEMD_INVOCATION_ENV_VAR]?.trim();
  if (!invocationId) return null;
  let cgroup: string;
  try {
    cgroup = await (deps.readCgroup ?? (() => readFile("/proc/self/cgroup", "utf8")))();
  } catch {
    return null;
  }
  const parsed = parseSystemdUnitFromCgroup(cgroup);
  if (!parsed) return null;
  const mainPid = await showUnitProperty(deps.systemctl ?? runSystemctl, parsed.scope, parsed.unit, "MainPID");
  if (mainPid === null || Number(mainPid) !== pid) return null;
  return {
    kind: "systemd",
    scope: parsed.scope,
    unit: parsed.unit,
    invocationId,
    pid,
    recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}

/** Generic opt-in (non-systemd supervisor that relaunches on exit). */
export function externalSupervisorOptIn(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EXTERNAL_SUPERVISOR_ENV_VAR]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export async function writeSupervisorRecord(slockHome: string, record: ExternalSupervisorRecord): Promise<void> {
  await mkdir(serviceRunDir(slockHome), { recursive: true });
  await writeFile(supervisorRecordPath(slockHome), JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
}

export async function clearSupervisorRecord(slockHome: string): Promise<void> {
  await rm(supervisorRecordPath(slockHome), { force: true });
}

export async function readSupervisorRecord(slockHome: string): Promise<ExternalSupervisorRecord | null> {
  try {
    const raw = JSON.parse(await readFile(supervisorRecordPath(slockHome), "utf8"));
    if (raw?.kind !== "systemd" || (raw.scope !== "user" && raw.scope !== "system")) return null;
    if (typeof raw.unit !== "string" || !raw.unit.endsWith(".service")) return null;
    if (typeof raw.pid !== "number" || typeof raw.invocationId !== "string") return null;
    return { kind: "systemd", scope: raw.scope, unit: raw.unit, invocationId: raw.invocationId, pid: raw.pid, recordedAt: String(raw.recordedAt ?? "") };
  } catch {
    return null;
  }
}

export interface SupervisorInspection {
  record: ExternalSupervisorRecord;
  /** The unit file is known to systemd (loaded). Absent unit ⇒ the record is stale. */
  unitLoaded: boolean;
  /** `systemctl is-enabled` verdict text (enabled/disabled/static/…), null when unknown. */
  enabledState: string | null;
  activeState: string | null;
  /** The unit's current main pid (0 when inactive). */
  mainPid: number | null;
  killMode: string | null;
  /** systemctl itself was reachable (a `--user` manager needs a session bus). */
  reachable: boolean;
}

export interface InspectDeps {
  systemctl?: SystemctlRunner;
}

/**
 * What systemd currently says about the recorded unit. Callers decide:
 *   start  → delegate when the unit is loaded (archer: existence, not liveness)
 *   stop   → delegate when the live service pid is the unit's MainPID
 *   upgrade→ requires KillMode process|mixed so the detached installer survives the stop
 */
export async function inspectSupervisor(slockHome: string, deps: InspectDeps = {}): Promise<SupervisorInspection | null> {
  const record = await readSupervisorRecord(slockHome);
  if (!record) return null;
  const runner = deps.systemctl ?? runSystemctl;
  const load = await runner(record.scope, ["show", "-P", "LoadState", record.unit]);
  if (load.code === null) {
    return { record, unitLoaded: false, enabledState: null, activeState: null, mainPid: null, killMode: null, reachable: false };
  }
  const loadState = load.stdout.trim();
  const unitLoaded = load.code === 0 && loadState === "loaded";
  if (!unitLoaded) {
    return { record, unitLoaded: false, enabledState: null, activeState: null, mainPid: null, killMode: null, reachable: true };
  }
  const [enabled, active, mainPid, killMode] = await Promise.all([
    runner(record.scope, ["is-enabled", record.unit]).then((r) => r.stdout.trim() || null),
    showUnitProperty(runner, record.scope, record.unit, "ActiveState"),
    showUnitProperty(runner, record.scope, record.unit, "MainPID"),
    showUnitProperty(runner, record.scope, record.unit, "KillMode"),
  ]);
  return {
    record,
    unitLoaded: true,
    enabledState: enabled,
    activeState: active,
    mainPid: mainPid === null ? null : Number(mainPid),
    killMode,
    reachable: true,
  };
}

/** KillMode values under which a detached installer survives `systemctl stop`. */
export const UPGRADE_SAFE_KILL_MODES: readonly string[] = ["process", "mixed"];

export function describeKillModeRequirement(unit: string, killMode: string | null): string {
  return `The Computer service runs under systemd unit ${unit} with KillMode=${killMode ?? "unknown"}. `
    + "A remote upgrade launches the installer inside that unit's control group, and systemd would kill it together with the "
    + "service when the installer stops the service. Set `KillMode=process` in the unit's [Service] section, run "
    + "`systemctl daemon-reload` (with `--user` for a user unit), restart the unit, then retry the upgrade.";
}

export interface SupervisorOomPolicy {
  record: ExternalSupervisorRecord;
  /** `OOMPolicy` as systemd reports it (stop/continue/kill); null on a systemd too old to have it. */
  oomPolicy: string | null;
  /** Made by `systemd-run`: there is no unit file to edit. */
  transient: boolean;
}

/**
 * The OOM policy of the unit this Computer runs under. Raft never edits a
 * user's own unit (#917), so an upgrade cannot fix an old `OOMPolicy=stop`:
 * doctor reports it instead. Null when not under systemd or it can't be read.
 */
export async function readSupervisorOomPolicy(slockHome: string, deps: InspectDeps = {}): Promise<SupervisorOomPolicy | null> {
  const record = await readSupervisorRecord(slockHome);
  if (!record) return null;
  const runner = deps.systemctl ?? runSystemctl;
  const [loadState, oomPolicy, transient] = await Promise.all([
    showUnitProperty(runner, record.scope, record.unit, "LoadState"),
    showUnitProperty(runner, record.scope, record.unit, "OOMPolicy"),
    showUnitProperty(runner, record.scope, record.unit, "Transient"),
  ]);
  if (loadState !== "loaded") return null;
  return { record, oomPolicy: oomPolicy || null, transient: transient === "yes" };
}

export function describeOomPolicyRequirement(policy: SupervisorOomPolicy): string {
  const { unit, scope } = policy.record;
  const systemctl = scope === "user" ? "systemctl --user" : "sudo systemctl";
  const fix = policy.transient
    ? `It was made by systemd-run, so it cannot be edited: stop it, run \`${systemctl} reset-failed ${unit}\`, and start it again with \`-p OOMPolicy=continue\` added to the systemd-run command.`
    : `Run \`${systemctl} edit ${unit}\`, add the two lines \`[Service]\` and \`OOMPolicy=continue\`, save, then restart the unit when no agent is busy.`;
  return `systemd unit ${unit} has OOMPolicy=${policy.oomPolicy}: when the kernel kills one agent for memory, systemd ends the whole Computer. ${fix}`;
}

export function describeSupervisorUnreachable(record: ExternalSupervisorRecord, detail: string): string {
  const scopeHint = record.scope === "user"
    ? " A `systemctl --user` call needs the user's session bus: run it from a session of that user with XDG_RUNTIME_DIR set (for example after `loginctl enable-linger`)."
    : "";
  return `The Computer service is managed by systemd unit ${record.unit} (${record.scope} scope) but systemctl could not be used: ${detail}.${scopeHint} Not starting a second service beside the unit.`;
}
