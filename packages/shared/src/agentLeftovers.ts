// What agents have running on this Computer outside their runtime
// (#raft-architecture:#34): processes their shells started (`nohup vite &`,
// `cloudflared`, `setsid ...`), `raftdev preview` units they own and raftdev
// containers labelled with them. `raft-computer leftovers` lists them
// read-only; nothing here stops anything, and the Computer stops none of it
// when an agent is deleted or moves away. raftdev shares the labels and the
// preview registry path; the Computer's lite bundle carries no daemon code.
//
// Node-only (fs, child_process): import it through its subpath
// (`@botiverse/raft-shared/src/agentLeftovers`), never from a browser bundle.
//
// - Processes: the daemon user's processes whose environment names the agent
//   (`SLOCK_AGENT_ID`, which every process an agent's runtime starts
//   inherits). Linux reads /proc/<pid>/environ, macOS `ps -E`; what can't be
//   read is skipped. Never the working directory.
// - Start identity: the daemon's `readProcessIdentity` format
//   (`linux:<starttime>`, `ps:<lstart>`), matched against the ledgers.
// - tmux: panes inherit the tmux SERVER's environment, so on a server agent A
//   started, agent B's panes carry A's id: the listed agent is whoever's
//   environment the process inherited.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";
import { parsePsLstartMs } from "./processStartTime";

export const SLOCK_AGENT_ID_ENV = "SLOCK_AGENT_ID";
/** raftdev's durable Docker ownership marker (scripts/dev/raftdev.ts). */
export const RAFTDEV_MANAGED_LABEL = "com.botiverse.raftdev.managed";
/** The agent that created a raftdev container (from its caller's `SLOCK_AGENT_ID`). */
export const RAFTDEV_AGENT_LABEL = "com.botiverse.raftdev.agent";

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** An agent id that may be matched, put in a label filter or shown. */
export function isLeftoverAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID_PATTERN.test(value);
}

/** The caller's own agent id (`SLOCK_AGENT_ID`), when it has a usable one. */
export function callerAgentId(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env[SLOCK_AGENT_ID_ENV]?.trim();
  return isLeftoverAgentId(value) ? value : null;
}

export interface ListedProcess {
  pid: number;
  ppid: number;
  pgid: number;
  /** Null where the owner could not be read. */
  uid: number | null;
  /** `linux:<starttime>` / `ps:<lstart>`; null when unreadable. */
  startIdentity: string | null;
  startedAtMs: number | null;
  /** The basename of argv[0], never the arguments. */
  command: string;
  /** `SLOCK_AGENT_ID` of its environment; null when none or unreadable. */
  agentId: string | null;
}

export interface ProcessListingDeps {
  platform?: NodeJS.Platform;
  /** Linux: file reads under /proc (tests replace them). */
  readFile?: (file: string) => Buffer;
  readDir?: (dir: string) => string[];
  ownerUid?: (file: string) => number | null;
  /** macOS and other POSIX: runs `ps` with this environment (tests fake its output). */
  runCommand?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
  /** Linux: boot time in ms and USER_HZ, for `startedAtMs` only. */
  bootTimeMs?: number | null;
  clockTicksPerSecond?: number;
}

/** Runs with exactly `env` (the caller's own). */
export function runCommandText(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, [...args], {
      env,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

export interface CommandResult {
  /** 0 on success; the exit code, or -1 when it could not run (not found, timed out). */
  code: number;
  stdout: string;
}

export function runCommandResult(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

/** argv[0]'s basename (a rewritten title such as `tmux: server (...)` gives its first word). */
export function commandBasename(argv0: string): string {
  const first = argv0.trim();
  if (!first) return "?";
  // A process title rewritten with spaces (`tmux: server (/tmp/tmux-1000/default)`).
  // A full path keeps its spaces (`/Applications/Android Studio.app/.../java`).
  const word = /\s/.test(first) && !first.startsWith("/") ? first.split(/\s+/)[0]!.replace(/:$/, "") : first;
  const base = path.posix.basename(word).replace(/[^\w.+@-]/g, "_").slice(0, 64);
  return base || "?";
}

/** Values of the named variables in a NUL-separated environ block. */
export function parseEnvironBlock(block: string, names: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of block.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (names.includes(name)) found.set(name, entry.slice(eq + 1));
  }
  return found;
}

/** `/proc/<pid>/stat`: comm can hold spaces and parens, so fields count from the last ')'. */
export function parseLinuxStat(text: string): { ppid: number; pgid: number; startTime: string } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTime = fields[19];
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || !startTime || !/^\d+$/.test(startTime)) return null;
  return { ppid, pgid, startTime };
}

function linuxBootTimeMs(readFile: (file: string) => Buffer): number | null {
  try {
    const match = /^btime\s+(\d+)/m.exec(readFile("/proc/stat").toString("utf8"));
    return match ? Number(match[1]) * 1000 : null;
  } catch {
    return null;
  }
}

const defaultOwnerUid = (file: string): number | null => {
  try {
    return statSync(file).uid;
  } catch {
    return null;
  }
};

/**
 * Linux: every process (/proc/<pid>/stat, cmdline), with the environment of
 * the ones `uid` owns (/proc/<pid>/environ; unreadable ones have none).
 */
export function listLinuxProcesses(uid: number | null, deps: ProcessListingDeps = {}): ListedProcess[] {
  const readFile = deps.readFile ?? ((file: string) => readFileSync(file));
  const readDir = deps.readDir ?? ((dir: string) => readdirSync(dir));
  const ownerUid = deps.ownerUid ?? defaultOwnerUid;
  const bootMs = deps.bootTimeMs !== undefined ? deps.bootTimeMs : linuxBootTimeMs(readFile);
  // USER_HZ is 100 on every mainstream Linux; only an age is derived from it.
  const ticks = deps.clockTicksPerSecond ?? 100;
  const out: ListedProcess[] = [];
  let names: string[];
  try {
    names = readDir("/proc");
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat: ReturnType<typeof parseLinuxStat>;
    try {
      stat = parseLinuxStat(readFile(`/proc/${pid}/stat`).toString("utf8"));
    } catch {
      continue;
    }
    if (!stat) continue;
    const owner = ownerUid(`/proc/${pid}`);
    let argv: string[] = [];
    try {
      argv = readFile(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter((arg, index, all) => arg !== "" || index < all.length - 1);
    } catch {
      // Gone, or a kernel thread.
    }
    let argv0 = argv[0] ?? "";
    if (!argv0) {
      try {
        argv0 = readFile(`/proc/${pid}/comm`).toString("utf8").trim();
      } catch {
        argv0 = "";
      }
    }
    let env = new Map<string, string>();
    if (uid !== null && owner === uid) {
      try {
        env = parseEnvironBlock(readFile(`/proc/${pid}/environ`).toString("utf8"), [SLOCK_AGENT_ID_ENV]);
      } catch {
        // Unreadable: no environment, never matched.
      }
    }
    const startedAtMs = bootMs === null ? null : bootMs + Math.round((Number(stat.startTime) / ticks) * 1000);
    out.push({
      pid,
      ppid: stat.ppid,
      pgid: stat.pgid,
      uid: owner,
      startIdentity: `linux:${stat.startTime}`,
      startedAtMs,
      command: commandBasename(argv0),
      agentId: env.get(SLOCK_AGENT_ID_ENV)?.trim() || null,
    });
  }
  return out;
}

/** The `ps` listing with environments (BSD/macOS `ps -E`), in the C locale. */
export const PS_ENV_LISTING_ARGS = ["-A", "-E", "-ww", "-o", "pid=,ppid=,pgid=,uid=,lstart=,command="] as const;
/** The same processes' arguments alone (no -E): what separates arguments from environment. */
export const PS_ARGS_LISTING_ARGS = ["-A", "-ww", "-o", "pid=,lstart=,command="] as const;
const LSTART = "[A-Z][a-z]{2}\\s+[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{1,2}:\\d{2}:\\d{2}\\s+\\d{4}";
const PS_ROW = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(${LSTART})\\s(.*)$`);
const PS_ARGS_ROW = new RegExp(`^\\s*(\\d+)\\s+(${LSTART})\\s(.*)$`);

/** Each process's executable (`comm`: the full path, which may hold spaces), for its basename. */
export const PS_COMM_LISTING_ARGS = ["-A", "-ww", "-o", "pid=,lstart=,comm="] as const;

/** `ps -A -o pid=,lstart=,comm=` output: pid → its start and its executable. */
export function parsePsCommListing(stdout: string): Map<number, { lstart: string; comm: string }> {
  const rows = new Map<number, { lstart: string; comm: string }>();
  for (const line of stdout.split("\n")) {
    const match = PS_ARGS_ROW.exec(line);
    if (!match) continue;
    rows.set(Number(match[1]), { lstart: match[2]!.replace(/\s+/g, " "), comm: (match[3] ?? "").trim() });
  }
  return rows;
}

/** `ps -A -ww -o pid=,lstart=,command=` output: pid → its start and its arguments as ps prints them. */
export function parsePsArgsListing(stdout: string): Map<number, { lstart: string; args: string }> {
  const rows = new Map<number, { lstart: string; args: string }>();
  for (const line of stdout.split("\n")) {
    const match = PS_ARGS_ROW.exec(line);
    if (!match) continue;
    rows.set(Number(match[1]), { lstart: match[2]!.replace(/\s+/g, " "), args: (match[3] ?? "").replace(/^\s+/, "") });
  }
  return rows;
}

function lastEnvValue(text: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}=(\\S*)`, "g");
  let value: string | null = null;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) value = match[1] ?? null;
  return value;
}

/**
 * `ps -A -E -ww -o pid=,ppid=,pgid=,uid=,lstart=,command=` output (C locale),
 * joined with the arguments-only listing (`parsePsArgsListing`). `ps -E`
 * prints the arguments and the environment as one string; only what follows
 * the row's exact arguments is its environment. A row that does not line up
 * (missing from either listing, another start, arguments not a prefix) has
 * no readable environment: never matched. So `ssh box SLOCK_AGENT_ID=<id>`
 * names no agent; only an inherited environment does.
 */
export function parsePsEnvListing(
  stdout: string,
  uid: number | null,
  argsByPid: ReadonlyMap<number, { lstart: string; args: string }>,
  commByPid: ReadonlyMap<number, { lstart: string; comm: string }> = new Map(),
): ListedProcess[] {
  const out: ListedProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = PS_ROW.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const owner = Number(match[4]);
    const lstart = match[5]!.replace(/\s+/g, " ");
    const rest = (match[6] ?? "").replace(/^\s+/, "");
    const plain = argsByPid.get(pid);
    const lined = plain !== undefined && plain.lstart === lstart && rest.startsWith(plain.args)
      && (rest.length === plain.args.length || rest[plain.args.length] === " ");
    const envText = lined ? rest.slice(plain.args.length) : "";
    const own = uid !== null && owner === uid && lined;
    const started = parsePsLstartMs(lstart);
    const exe = commByPid.get(pid);
    const argsText = plain?.args ?? rest;
    // The executable's own path when it lines up (spaces and all); else argv[0]'s first word.
    // Only a whole leading word (or words, for a path with spaces) of the
    // arguments: a `comm` ps cut short is no prefix ending at a space.
    const commFits = exe !== undefined && exe.lstart === lstart && exe.comm !== ""
      && argsText.startsWith(exe.comm) && (argsText.length === exe.comm.length || argsText[exe.comm.length] === " ");
    const basename = commandBasename(commFits ? exe.comm : argsText.split(/\s+/)[0] ?? "");
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      uid: owner,
      startIdentity: `ps:${lstart}`,
      startedAtMs: started ?? null,
      command: basename,
      agentId: own ? lastEnvValue(envText, SLOCK_AGENT_ID_ENV) : null,
    });
  }
  return out;
}

const cLocale = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, LC_ALL: "C", LANG: "C" });

/**
 * Every process, with the environment of the daemon user's own. Empty on
 * Windows (not in v1). `env`: what `ps` runs with (the caller's own).
 */
export async function listProcessesWithAgentEnv(deps: ProcessListingDeps & { uid?: number | null; env: NodeJS.ProcessEnv }): Promise<ListedProcess[]> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return [];
  const uid = deps.uid !== undefined ? deps.uid : typeof process.getuid === "function" ? process.getuid() : null;
  if (platform === "linux") return listLinuxProcesses(uid, deps);
  const run = deps.runCommand ?? runCommandText;
  // Arguments first: a process started between the two calls is in the -E listing only, so unreadable.
  const args = parsePsArgsListing(await run("ps", PS_ARGS_LISTING_ARGS, cLocale(deps.env)));
  const comm = parsePsCommListing(await run("ps", PS_COMM_LISTING_ARGS, cLocale(deps.env)));
  return parsePsEnvListing(await run("ps", PS_ENV_LISTING_ARGS, cLocale(deps.env)), uid, args, comm);
}

// ───────────────── raftdev preview units ─────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `RAFT_PREVIEW_REGISTRY` of the preview cleaner's env file (`~/.config/raft/preview-cleaner.env`), or null. */
function registryFromCleanerEnv(text: string | null): string | null {
  if (text === null) return null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("RAFT_PREVIEW_REGISTRY=")) continue;
    const value = line.slice("RAFT_PREVIEW_REGISTRY=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value) return value;
  }
  return null;
}

function normalizeRegistryPath(value: string, home: string, cwd: string): string {
  const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

/**
 * The `raftdev preview` registry, resolved as raftdev and the preview cleaner
 * do (scripts/dev/raftdev-preview.ts `previewRegistryDir`, kept equal by a
 * test there): `$RAFT_PREVIEW_REGISTRY`, else the cleaner env file's value,
 * else `${XDG_STATE_HOME:-~/.local/state}/raft/previews`.
 */
export function previewRegistryDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  cleanerEnvText: string | null = null,
  cwd: string = process.cwd(),
): string {
  const override = env.RAFT_PREVIEW_REGISTRY?.trim();
  if (override) return normalizeRegistryPath(override, home, cwd);
  const configured = registryFromCleanerEnv(cleanerEnvText);
  if (configured) return normalizeRegistryPath(configured, home, cwd);
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state");
  return path.join(stateHome, "raft", "previews");
}

/** The registry this user's previews are in (reads the cleaner env file). */
export function resolvePreviewRegistryDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  let text: string | null = null;
  try {
    text = readFileSync(path.join(home, ".config", "raft", "preview-cleaner.env"), "utf8");
  } catch {
    text = null;
  }
  return previewRegistryDir(env, home, text, home);
}

export interface PreviewUnitRecord {
  id: string;
  /** `raft-preview-<id>.service`. */
  unitName: string;
  name: string;
  ownerAgentId: string | null;
}

/** One registry record, only what the leave needs: a valid id, its unit and its owner. */
export function parsePreviewUnitRecord(text: string, filenameId: string): PreviewUnitRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { schemaVersion?: unknown; id?: unknown; unitName?: unknown; name?: unknown; owner?: unknown };
  if (record.schemaVersion !== 1 || record.id !== filenameId || typeof record.id !== "string" || !UUID_RE.test(record.id)) return null;
  const unitName = `raft-preview-${record.id}.service`;
  if (record.unitName !== unitName) return null;
  const owner = record.owner && typeof record.owner === "object" ? (record.owner as { agentId?: unknown }).agentId : null;
  return {
    id: record.id,
    unitName,
    name: typeof record.name === "string" ? record.name.slice(0, 80) : "",
    ownerAgentId: typeof owner === "string" && UUID_RE.test(owner) ? owner : null,
  };
}

/** The registry's `<uuid>.json` records (the cleaner's subdirectories and temp files are skipped). */
export function listPreviewUnitRecords(
  registryDir: string,
  deps: { readDir?: (dir: string) => string[]; readFile?: (file: string) => string } = {},
): PreviewUnitRecord[] {
  const readDir = deps.readDir ?? ((dir: string) => readdirSync(dir));
  const readFile = deps.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  let entries: string[];
  try {
    entries = readDir(registryDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json") && UUID_RE.test(entry.slice(0, -5)))
    .sort()
    .flatMap((entry) => {
      try {
        const record = parsePreviewUnitRecord(readFile(path.join(registryDir, entry)), entry.slice(0, -5));
        return record ? [record] : [];
      } catch {
        return [];
      }
    });
}

// ───────────────── raftdev containers ─────────────────

export interface RaftdevContainer {
  id: string;
  name: string;
  /** `running`, `exited`, ... */
  state: string;
  /** Its `com.botiverse.raftdev.agent` label; null when it has none. */
  agentId: string | null;
}

const RAFTDEV_CONTAINER_FORMAT = `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "${RAFTDEV_AGENT_LABEL}"}}`;

/** `docker ps -a` arguments listing raftdev's containers (only the agent's, given one). */
export function raftdevContainerListArgs(agentId: string | null = null): string[] {
  return [
    "ps", "-a",
    "--filter", `label=${RAFTDEV_MANAGED_LABEL}=true`,
    ...(agentId ? ["--filter", `label=${RAFTDEV_AGENT_LABEL}=${agentId}`] : []),
    "--format", RAFTDEV_CONTAINER_FORMAT,
  ];
}

/** The listing's rows (`<id>\t<name>\t<state>\t<agent label>`). */
export function parseRaftdevContainers(stdout: string): RaftdevContainer[] {
  const out: RaftdevContainer[] = [];
  for (const line of stdout.split("\n")) {
    const [id, name, state, agent] = line.split("\t");
    if (!id || !/^[0-9a-f]{12,64}$/.test(id.trim())) continue;
    const label = agent?.trim() ?? "";
    out.push({
      id: id.trim(),
      name: name?.trim() ?? "",
      state: state?.trim() ?? "",
      agentId: isLeftoverAgentId(label) ? label : null,
    });
  }
  return out;
}

/**
 * raftdev's containers on this machine (only the agent's, given one); null
 * when no docker CLI answers (not installed, its daemon down).
 */
export async function listRaftdevContainers(
  agentId: string | null,
  run: (command: string, args: readonly string[]) => Promise<CommandResult>,
): Promise<RaftdevContainer[] | null> {
  if (agentId !== null && !isLeftoverAgentId(agentId)) return [];
  const listed = await run("docker", raftdevContainerListArgs(agentId));
  if (listed.code !== 0) return null;
  const containers = parseRaftdevContainers(listed.stdout);
  return agentId === null ? containers : containers.filter((container) => container.agentId === agentId);
}

// ───────────────── listening ports ─────────────────

function hexIpv4(hex: string): string {
  const bytes = hex.match(/../g)?.map((byte) => Number.parseInt(byte, 16)).reverse() ?? [];
  return bytes.join(".");
}

function hexIpv6(hex: string): string {
  // Four 32-bit words, each in host (little-endian) order.
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((word) => (word.match(/../g) ?? []).reverse());
  const groups: string[] = [];
  for (let i = 0; i < bytes.length; i += 2) groups.push(String(Number.parseInt(`${bytes[i]}${bytes[i + 1]}`, 16).toString(16)));
  const text = groups.join(":");
  if (/^(0:){7}0$/.test(text)) return "::";
  if (/^(0:){7}1$/.test(text)) return "::1";
  return text.replace(/(^|:)0(:0)+(:|$)/, "::");
}

/** `/proc/net/tcp*` LISTEN sockets: inode → `addr:port` (`*:port` for any address). */
export function parseProcNetTcpListeners(text: string, v6: boolean): Map<string, string> {
  const listeners = new Map<string, string>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A") continue;
    const [addrHex, portHex] = (fields[1] ?? "").split(":");
    const inode = fields[9];
    if (!addrHex || !portHex || !inode || inode === "0") continue;
    const port = Number.parseInt(portHex, 16);
    const addr = v6 ? hexIpv6(addrHex) : hexIpv4(addrHex);
    const any = addr === "0.0.0.0" || addr === "::";
    listeners.set(inode, any ? `*:${port}` : v6 ? `[${addr}]:${port}` : `${addr}:${port}`);
  }
  return listeners;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pn` output: pid → listening addresses. */
export function parseLsofListeners(stdout: string): Map<number, string[]> {
  const byPid = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null && Number.isInteger(pid)) {
      const list = byPid.get(pid) ?? [];
      const addr = line.slice(1);
      if (!list.includes(addr)) list.push(addr);
      byPid.set(pid, list);
    }
  }
  return byPid;
}

/**
 * The TCP ports these processes listen on. Linux: /proc/net/tcp{,6} matched
 * to each pid's socket descriptors; elsewhere `lsof`. Missing where unreadable.
 */
export async function listListeningPorts(
  pids: readonly number[],
  deps: {
    platform?: NodeJS.Platform;
    readFile?: (file: string) => string;
    readDir?: (dir: string) => string[];
    readLink?: (file: string) => string;
    runCommand?: ProcessListingDeps["runCommand"];
    /** What `lsof` runs with (the caller's own environment). */
    env: NodeJS.ProcessEnv;
  },
): Promise<Map<number, string[]>> {
  const platform = deps.platform ?? process.platform;
  const result = new Map<number, string[]>();
  if (pids.length === 0 || platform === "win32") return result;
  if (platform === "linux") {
    const readFile = deps.readFile ?? ((file: string) => readFileSync(file, "utf8"));
    const readDir = deps.readDir ?? ((dir: string) => readdirSync(dir));
    const readLink = deps.readLink ?? ((file: string) => readlinkSync(file));
    const listeners = new Map<string, string>();
    for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]] as const) {
      try {
        for (const [inode, addr] of parseProcNetTcpListeners(readFile(file), v6)) listeners.set(inode, addr);
      } catch {
        // No such family.
      }
    }
    if (listeners.size === 0) return result;
    for (const pid of pids) {
      let fds: string[];
      try {
        fds = readDir(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      const addrs: string[] = [];
      for (const fd of fds) {
        try {
          const inode = /^socket:\[(\d+)\]$/.exec(readLink(`/proc/${pid}/fd/${fd}`))?.[1];
          const addr = inode ? listeners.get(inode) : undefined;
          if (addr && !addrs.includes(addr)) addrs.push(addr);
        } catch {
          // Closed meanwhile.
        }
      }
      if (addrs.length > 0) result.set(pid, addrs);
    }
    return result;
  }
  const run = deps.runCommand ?? runCommandText;
  const stdout = await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-F", "pn"], deps.env);
  for (const [pid, addrs] of parseLsofListeners(stdout)) if (pids.includes(pid)) result.set(pid, addrs);
  return result;
}
