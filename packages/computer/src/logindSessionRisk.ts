import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { INTENTIONAL_STOP_EXIT_CODES } from "./externalSupervisor";

// task #37: a Computer started from a terminal or the install script on Linux
// runs detached, but inside the caller's login session scope
// (`session-N.scope`). When systemd-logind is set to kill a user's processes
// at logout (KillUserProcesses=yes, the default on some distributions), the
// whole scope is stopped when that session ends, so the Computer "disappears"
// after the user closes SSH. Linger does not exempt the session scope; it only
// keeps the per-user manager (and units under it) running, which is what the
// fix relies on. We only detect and explain: Raft never changes logind or
// linger settings for the user.

export interface LogindSessionRisk {
  /** The login session scope the service would be stopped with, e.g. `session-3.scope`. */
  sessionScope: string;
  user: string;
  /** Whether the user manager survives logout; null when loginctl could not tell. */
  linger: boolean | null;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface LogindSessionRiskDeps {
  platform?: NodeJS.Platform;
  readCgroup?: () => Promise<string>;
  run?: CommandRunner;
  user?: string;
  uid?: number | null;
}

// The suggested user unit restarts like a supervised Computer did: a short
// pause between starts, and a start limit high enough never to refuse a
// legitimate relaunch (20 starts per StartLimitIntervalSec).
const SYSTEMD_RESTART_SEC = 5;
const SYSTEMD_START_LIMIT_BURST = 20;

// Advisory only: a hung system bus must not hold up start for long.
const COMMAND_TIMEOUT_MS = 2_000;
// The transient unit's name, kept out of the template so the CLI reference
// contract (cliCommandReferenceContract.test.ts) does not read it as a command.
const TRANSIENT_UNIT = "raft-computer";

const runCommand: CommandRunner = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, COMMAND_TIMEOUT_MS);
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
});

/**
 * The `session-N.scope` this process runs in and the uid of the session's
 * owner (its `user-<uid>.slice`), from a cgroup v2 or v1 (name=systemd) listing.
 */
export function sessionScopeFromCgroup(text: string): { scope: string; ownerUid: number | null } | null {
  for (const line of text.split("\n")) {
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const controllers = parts[1] ?? "";
    if (parts[0] !== "0" && !controllers.split(",").includes("name=systemd")) continue;
    const cgroupPath = parts.slice(2).join(":").trim();
    const match = /\/(session-[^/]+\.scope)(?:\/|$)/.exec(cgroupPath);
    if (!match) continue;
    const owner = /\/user-(\d+)\.slice\//.exec(cgroupPath);
    return { scope: match[1]!, ownerUid: owner ? Number(owner[1]) : null };
  }
  return null;
}

const LOGIN1 = ["org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager"];

/** `busctl get-property` output: `b true`, or `as 2 "root" "alice"`. */
export function parseBusctlBoolean(text: string): boolean | null {
  const match = /^b (true|false)$/.exec(text.trim());
  return match ? match[1] === "true" : null;
}

export function parseBusctlStrings(text: string): string[] | null {
  const trimmed = text.trim();
  if (!/^as \d+/.test(trimmed)) return null;
  return [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
}

/**
 * Whether logind stops this user's session scope at logout: the same rule as
 * logind's manager_shall_kill (KillUserProcesses, then KillExcludeUsers, then
 * KillOnlyUsers). null when logind cannot be asked.
 */
async function logindKillsSessionOf(run: CommandRunner, user: string): Promise<boolean | null> {
  const get = async (property: string) => {
    const result = await run("busctl", ["get-property", ...LOGIN1, property]);
    return result.code === 0 ? result.stdout : null;
  };
  const killText = await get("KillUserProcesses");
  const kill = killText === null ? null : parseBusctlBoolean(killText);
  if (kill !== true) return kill;
  const [excludeText, onlyText] = await Promise.all([get("KillExcludeUsers"), get("KillOnlyUsers")]);
  if ((parseBusctlStrings(excludeText ?? "") ?? []).includes(user)) return false;
  const only = parseBusctlStrings(onlyText ?? "") ?? [];
  return only.length === 0 || only.includes(user);
}

async function lingerOf(run: CommandRunner, user: string): Promise<boolean | null> {
  const result = await run("loginctl", ["show-user", user, "-p", "Linger", "--value"]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value === "yes" ? true : value === "no" ? false : null;
}

/**
 * The risk that a detached service started from here is stopped when the
 * current login session ends; null when there is none or it cannot be shown
 * (not Linux, not in a session scope, logind unreachable or not killing).
 */
export async function detectLogindSessionRisk(deps: LogindSessionRiskDeps = {}): Promise<LogindSessionRisk | null> {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  let cgroup: string;
  try {
    cgroup = await (deps.readCgroup ?? (() => readFile("/proc/self/cgroup", "utf8")))();
  } catch {
    return null;
  }
  const session = sessionScopeFromCgroup(cgroup);
  if (!session) return null;
  // logind decides by the session's owner. Under sudo/su the effective user
  // differs, and the advice (linger, user units) would not apply to it.
  const uid = deps.uid !== undefined ? deps.uid : (process.getuid?.() ?? null);
  if (session.ownerUid !== null && uid !== null && session.ownerUid !== uid) return null;
  const sessionScope = session.scope;
  const run = deps.run ?? runCommand;
  const user = deps.user ?? userInfo().username;
  if ((await logindKillsSessionOf(run, user)) !== true) return null;
  return { sessionScope, user, linger: await lingerOf(run, user) };
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * What `raft-computer start` prints when the service would stop at logout.
 * `command` is the absolute argv that runs this CLI (the SEA binary, or node
 * plus the script: a user unit does not get the login shell's PATH). The
 * transient unit restarts the service unless it stopped on purpose (the
 * intentional-stop exit codes), bounds its start rate and keeps running past an
 * OOM kill of one child (OOMPolicy=continue), and the
 * service detects systemd as its external supervisor (externalSupervisor.ts).
 */
export function formatLogindSessionRisk(risk: LogindSessionRisk, input: { command: string[]; raftHome: string }): string[] {
  const cli = input.command.map(shellWord).join(" ");
  const stay = INTENTIONAL_STOP_EXIT_CODES.join(" ");
  const properties = [
    "KillMode=mixed",
    "OOMPolicy=continue",
    "Restart=on-failure",
    `RestartSec=${SYSTEMD_RESTART_SEC}`,
    `RestartPreventExitStatus="${stay}"`,
    "StartLimitIntervalSec=600",
    `StartLimitBurst=${SYSTEMD_START_LIMIT_BURST}`,
  ].map((property) => `-p ${property}`).join(" ");
  return [
    `Warning: this service runs inside your login session (${risk.sessionScope}), and this machine stops a user's processes when they log out (systemd-logind KillUserProcesses=yes). It will stop when this session ends.`,
    "To keep it running after you log out, run it as a user service instead:",
    ...(risk.linger === true ? [] : [`  loginctl enable-linger ${shellWord(risk.user)}    # if refused: sudo loginctl enable-linger ${shellWord(risk.user)}`]),
    `  ${cli} stop`,
    `  systemd-run --user --unit=${TRANSIENT_UNIT} --setenv=RAFT_HOME=${shellWord(input.raftHome)} ${properties} ${cli} start --foreground`,
    "That user service is not kept after a reboot or `raft-computer stop`: start it again with the systemd-run line (if systemd says the unit exists, run `systemctl --user reset-failed raft-computer` first).",
    "Raft does not change these settings for you; if you cannot enable linger, ask the machine's administrator.",
  ];
}
