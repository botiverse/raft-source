// `raft-computer leftovers` (#raft-architecture:#34): read-only, what agents
// have running on this Computer outside Raft's own bookkeeping, for the
// machine owner: the daemon user's processes carrying an agent's
// SLOCK_AGENT_ID (pid, agent, age, command basename, listening TCP ports),
// `raftdev preview` units and raftdev containers with their owners.
//
// The Computer stops none of these when an agent is deleted or moves away
// (only its runtime and `raft proc` jobs): the owner decides. Rows the ledgers
// name are marked: an agent's runtime (`runtime-processes.json`) and its
// `raft proc` jobs (procJobs.ts). Nothing is signalled here. Windows: not in v1.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  listListeningPorts,
  listPreviewUnitRecords,
  listProcessesWithAgentEnv,
  listRaftdevContainers,
  resolvePreviewRegistryDir,
  runCommandResult,
  type CommandResult,
  type ListedProcess,
  type PreviewUnitRecord,
  type RaftdevContainer,
} from "@botiverse/raft-shared/src/agentLeftovers";
import { formatProcJobAge, listRunningProcJobs, type ProcJobsDeps } from "./procJobs";

export const LEFTOVERS_UNSUPPORTED_MESSAGE = "raft-computer leftovers is not supported on Windows yet.";

export type LeftoverProcessKind = "process" | "runtime" | "proc_job";

export interface LeftoverProcessRow {
  pid: number;
  agentId: string;
  /** Null where the start could not be read. */
  startedAtMs: number | null;
  command: string;
  /** `runtime` / `proc_job`: Raft's own (stopped with the agent); `process`: left by its shell. */
  kind: LeftoverProcessKind;
  listening: string[];
}

export interface LeftoverPreviewRow extends PreviewUnitRecord {
  /** `systemctl --user is-active`; null where it can't be asked. */
  state: string | null;
}

export interface LeftoversReport {
  supported: boolean;
  processes: LeftoverProcessRow[];
  /** Null off Linux (raftdev previews are systemd user units). */
  previews: LeftoverPreviewRow[] | null;
  /** Null when no docker CLI answers. */
  containers: RaftdevContainer[] | null;
}

export interface LeftoversDeps {
  platform?: NodeJS.Platform;
  selfPid?: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  listProcesses?: () => Promise<ListedProcess[]>;
  listeningPorts?: (pids: readonly number[]) => Promise<Map<number, string[]>>;
  previewUnits?: () => PreviewUnitRecord[];
  run?: (command: string, args: readonly string[]) => Promise<CommandResult>;
  procJobs?: ProcJobsDeps;
}

/** The runtimes the daemons' ledgers name (`<Raft home>/machines/<m>/runtime-processes.json`). */
function runtimeLedgerPids(raftHome: string): Map<number, string> {
  const pids = new Map<number, string>();
  let machines: string[];
  try {
    machines = readdirSync(join(raftHome, "machines"));
  } catch {
    return pids;
  }
  for (const machine of machines) {
    try {
      const parsed = JSON.parse(readFileSync(join(raftHome, "machines", machine, "runtime-processes.json"), "utf8")) as {
        version?: unknown;
        processes?: Array<{ pid?: unknown; startIdentity?: unknown }>;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.processes)) continue;
      for (const record of parsed.processes) {
        if (Number.isInteger(record.pid) && typeof record.startIdentity === "string") pids.set(record.pid as number, record.startIdentity);
      }
    } catch {
      // No ledger, or unreadable.
    }
  }
  return pids;
}

const ACTIVE_STATE = /^[a-z-]{1,20}$/;

export async function readLeftovers(raftHome: string, deps: LeftoversDeps = {}): Promise<LeftoversReport> {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return { supported: false, processes: [], previews: null, containers: null };
  const env = deps.env ?? process.env;
  const run = deps.run ?? ((command: string, args: readonly string[]) => runCommandResult(command, args, env));
  const selfPid = deps.selfPid ?? process.pid;
  const listed = await (deps.listProcesses ?? (() => listProcessesWithAgentEnv({ platform, env })))();
  const tagged = listed.filter((entry) => entry.agentId !== null && entry.pid !== selfPid);
  const runtimes = runtimeLedgerPids(raftHome);
  const jobs = await listRunningProcJobs(raftHome, { platform, ...deps.procJobs }).catch(() => []);
  const jobPids = new Map(jobs.map((job) => [job.pid, job.startIdentity]));
  // Linux identities are the ledgers' own format; `ps lstart` may be in another locale there.
  const same = (recorded: string | undefined, entry: ListedProcess) =>
    recorded !== undefined && (platform !== "linux" || recorded === entry.startIdentity);
  const ports = await (deps.listeningPorts ?? ((pids: readonly number[]) => listListeningPorts(pids, { platform, env })))(tagged.map((entry) => entry.pid))
    .catch(() => new Map<number, string[]>());
  const processes: LeftoverProcessRow[] = tagged
    .map((entry) => ({
      pid: entry.pid,
      agentId: entry.agentId!,
      startedAtMs: entry.startedAtMs,
      command: entry.command,
      kind: same(jobPids.get(entry.pid), entry) ? "proc_job" as const : same(runtimes.get(entry.pid), entry) ? "runtime" as const : "process" as const,
      listening: ports.get(entry.pid) ?? [],
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.pid - b.pid);

  let previews: LeftoverPreviewRow[] | null = null;
  if (platform === "linux") {
    const records = deps.previewUnits
      ? deps.previewUnits()
      : listPreviewUnitRecords(resolvePreviewRegistryDir(env, deps.home ?? homedir()));
    previews = await Promise.all(records.map(async (record) => {
      const answer = await run("systemctl", ["--user", "is-active", record.unitName]);
      const state = answer.stdout.trim();
      return { ...record, state: answer.code === -1 || !ACTIVE_STATE.test(state) ? null : state };
    }));
  }
  const containers = await listRaftdevContainers(null, run).catch(() => null);
  return { supported: true, processes, previews, containers };
}

const short = (agentId: string | null) => (agentId ? agentId.slice(0, 8) : "-");

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)) + 2);
  const line = (cells: string[]) => `  ${cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!))).join("")}`.trimEnd();
  return [line(header), ...rows.map(line)];
}

/** The human listing. */
export function formatLeftovers(report: LeftoversReport, nowMs: number): string[] {
  if (!report.supported) return [LEFTOVERS_UNSUPPORTED_MESSAGE];
  const lines: string[] = [];
  const kindLabel: Record<LeftoverProcessKind, string> = { process: "shell", runtime: "runtime", proc_job: "raft proc" };
  if (report.processes.length === 0) lines.push("Agent processes (SLOCK_AGENT_ID): none");
  else {
    lines.push(`Agent processes (SLOCK_AGENT_ID): ${report.processes.length}`);
    lines.push(...table(
      ["AGENT", "PID", "AGE", "FROM", "COMMAND", "LISTENING"],
      report.processes.map((row) => [
        short(row.agentId),
        String(row.pid),
        row.startedAtMs === null ? "?" : formatProcJobAge(nowMs - row.startedAtMs),
        kindLabel[row.kind],
        row.command,
        row.listening.join(" "),
      ]),
    ));
  }
  lines.push("");
  if (report.previews !== null) {
    if (report.previews.length === 0) lines.push("raftdev previews: none");
    else {
      lines.push(`raftdev previews: ${report.previews.length}`);
      lines.push(...table(
        ["OWNER", "STATE", "UNIT", "NAME"],
        report.previews.map((row) => [short(row.ownerAgentId), row.state ?? "?", row.unitName, row.name]),
      ));
    }
    lines.push("");
  }
  if (report.containers === null) lines.push("raftdev containers: docker not available");
  else if (report.containers.length === 0) lines.push("raftdev containers: none");
  else {
    lines.push(`raftdev containers: ${report.containers.length}`);
    lines.push(...table(
      ["OWNER", "STATE", "NAME"],
      report.containers.map((row) => [short(row.agentId), row.state, row.name]),
    ));
  }
  lines.push("");
  lines.push("Nothing was stopped. When an agent is deleted or moves to another computer, Raft stops its runtime and raft proc jobs;");
  lines.push("what its shell started, its previews and its containers keep running until you stop them.");
  return lines;
}
