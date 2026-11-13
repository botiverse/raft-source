import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_STOP_KILL_CONFIRM_MS, AGENT_STOP_KILL_GRACE_MS } from "./processStop";
import {
  createProcessTreeOps,
  descendantsOfOrphan,
  killProcessTreeSnapshot,
  listOwnGroupLeaderChildren,
  readProcessIdentity,
  type ProcessIdentity,
  type ProcessIdentityDeps,
  type ProcessTreeDeps,
  type ProcessTreeEntry,
} from "./processTree";

/**
 * Reconciler step 5, the orphan sweep. Runtimes lead their own process
 * group (`spawnRuntimeChild`), so a daemon that crashes leaves them running:
 * nothing reaps them (on macOS launchd only reaps the job's own group). The
 * next daemon would then start the same agents again, two processes per
 * agent answering and repeating tool side effects.
 *
 * Every runtime process this daemon spawns is recorded here (pid, group,
 * start identity, agent, launch) in one file per runner under its machine
 * directory, and removed once its exit is confirmed. At the next start the
 * daemon reaps what the file still names, only where the pid still has the
 * recorded start identity (a reused pid is never signalled): SIGTERM to the
 * group, the stop grace, then SIGKILL of the group and of what left it.
 * Windows: `taskkill /T /F` on the root.
 */

export const RUNTIME_PROCESS_LEDGER_FILE = "runtime-processes.json";

export interface RuntimeProcessRecord {
  pid: number;
  pgid: number;
  startIdentity: string;
  agentId: string;
  launchId: string | null;
  host: "legacy" | "oar";
  recordedAtMs: number;
}

interface LedgerFile {
  version: 1;
  processes: RuntimeProcessRecord[];
}

export interface RuntimeProcessLedgerDeps {
  identity?: ProcessIdentityDeps;
  tree?: ProcessTreeDeps;
  now?: () => number;
  /**
   * A child of this daemon that is not a runtime: a `raft proc` job
   * (procJobs.ts). OAR's unrecorded-children pass never records it, so the
   * next daemon's sweep adopts the job instead of reaping it.
   */
  isForeignChild?: (pid: number) => boolean;
}

export class RuntimeProcessLedger {
  private readonly records = new Map<number, RuntimeProcessRecord>();
  /** Pids whose exit was confirmed while their identity was still being read. */
  private readonly forgotten = new Set<number>();
  /** What the previous daemon left in the file, taken once for the sweep. */
  private leftover: RuntimeProcessRecord[] | null;
  /** Updates still reading process identities; each ends with a write of the file. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly file: string, private readonly deps: RuntimeProcessLedgerDeps = {}) {
    this.leftover = readLedger(file);
  }

  static inMachineDir(machineDir: string, deps: RuntimeProcessLedgerDeps = {}): RuntimeProcessLedger {
    return new RuntimeProcessLedger(path.join(machineDir, RUNTIME_PROCESS_LEDGER_FILE), deps);
  }

  /** The previous daemon's records, once. */
  takeLeftover(): RuntimeProcessRecord[] {
    const leftover = this.leftover ?? [];
    this.leftover = null;
    return leftover;
  }

  /** Keep records the sweep could not confirm gone, for the next daemon to retry. */
  keep(records: readonly RuntimeProcessRecord[]): void {
    for (const record of records) this.records.set(record.pid, record);
    this.persist();
  }

  /**
   * Every update started so far has written the file (or found nothing to
   * write). The daemon's stop waits for it: the callers fire and forget, so
   * an identity read still running would otherwise write into the machine
   * dir after the daemon stopped and released its lock.
   */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private track(update: Promise<void>): Promise<void> {
    this.inFlight.add(update);
    void update.catch(() => {}).finally(() => this.inFlight.delete(update));
    return update;
  }

  /** A runtime process was spawned: record it once its identity is read (not if it already exited). */
  record(pid: number | undefined, entry: { agentId: string; launchId: string | null; host: "legacy" | "oar" }): Promise<void> {
    return this.track(this.recordNow(pid, entry));
  }

  private async recordNow(pid: number | undefined, entry: { agentId: string; launchId: string | null; host: "legacy" | "oar" }): Promise<void> {
    if (typeof pid !== "number") return;
    this.forgotten.delete(pid);
    const identity = await readProcessIdentity(pid, this.deps.identity);
    if (!identity || this.forgotten.delete(pid)) return;
    this.records.set(pid, {
      pid,
      pgid: identity.pgid,
      startIdentity: identity.startIdentity,
      agentId: entry.agentId,
      launchId: entry.launchId,
      host: entry.host,
      recordedAtMs: (this.deps.now ?? Date.now)(),
    });
    this.persist();
  }

  /** Its exit was confirmed. */
  forget(pid: number | undefined): void {
    if (typeof pid !== "number") return;
    if (!this.records.delete(pid)) {
      this.forgotten.add(pid);
      return;
    }
    this.persist();
  }

  has(pid: number): boolean {
    return this.records.has(pid);
  }

  /** The agent's recorded runtime processes (`raft proc` confirms a caller descends from one). */
  recordsForAgent(agentId: string): RuntimeProcessRecord[] {
    return [...this.records.values()].filter((record) => record.agentId === agentId);
  }

  /**
   * OAR keeps its runtimes' pids to itself: after a session opened, every
   * group-leading child of this daemon not recorded yet is recorded for the
   * agent (a probe that happens to run then is recorded too; it is this
   * daemon's child all the same and is dropped once gone).
   */
  recordUnrecordedChildren(entry: { agentId: string; launchId: string | null }): Promise<void> {
    return this.track(this.recordUnrecordedChildrenNow(entry));
  }

  private async recordUnrecordedChildrenNow(entry: { agentId: string; launchId: string | null }): Promise<void> {
    for (const pid of await listOwnGroupLeaderChildren(this.deps.tree)) {
      if (this.records.has(pid) || this.deps.isForeignChild?.(pid)) continue;
      await this.recordNow(pid, { ...entry, host: "oar" });
    }
  }

  /** Drop the agent's OAR records whose process is gone (after its session was disposed). */
  pruneGone(agentId: string): Promise<void> {
    return this.track(this.pruneGoneNow(agentId));
  }

  private async pruneGoneNow(agentId: string): Promise<void> {
    let changed = false;
    for (const record of [...this.records.values()]) {
      if (record.agentId !== agentId || record.host !== "oar") continue;
      const identity = await readProcessIdentity(record.pid, this.deps.identity);
      if (identity?.startIdentity === record.startIdentity) continue;
      this.records.delete(record.pid);
      changed = true;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    writeLedger(this.file, { version: 1, processes: [...this.records.values()] });
  }
}

function readLedger(file: string): RuntimeProcessRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LedgerFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.processes)) return [];
    return parsed.processes.filter((record): record is RuntimeProcessRecord =>
      Boolean(record)
      && Number.isInteger(record.pid) && record.pid > 0
      && Number.isInteger(record.pgid) && record.pgid > 0
      && typeof record.startIdentity === "string" && record.startIdentity.length > 0
      && typeof record.agentId === "string");
  } catch {
    return [];
  }
}

function writeLedger(file: string, contents: LedgerFile): void {
  writeLedgerFileAtomic(file, contents);
}

/** Atomic: a crash mid-write leaves the previous file, never a torn one. Shared with the proc job ledger. */
export function writeLedgerFileAtomic(file: string, contents: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(contents)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
  }
}

export interface OrphanReapResult {
  recorded: number;
  reaped: number[];
  escalated: number[];
  stillAlive: RuntimeProcessRecord[];
  /** Gone already, or the pid now belongs to another process: never signalled. */
  skipped: number;
}

export interface OrphanReapDeps {
  platform?: NodeJS.Platform;
  graceMs?: number;
  confirmMs?: number;
  pollMs?: number;
  identity?: ProcessIdentityDeps;
  tree?: ProcessTreeDeps;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  readIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  sleep?: (ms: number) => Promise<void>;
}

/** Reap every recorded process the previous daemon left alive. Never rejects. */
export async function reapRecordedOrphans(records: readonly RuntimeProcessRecord[], deps: OrphanReapDeps = {}): Promise<OrphanReapResult> {
  const result: OrphanReapResult = { recorded: records.length, reaped: [], escalated: [], stillAlive: [], skipped: 0 };
  await Promise.all(records.map(async (record) => {
    try {
      const outcome = await reapOne(record, deps);
      if (outcome === "skipped") result.skipped += 1;
      else if (outcome === "alive") result.stillAlive.push(record);
      else {
        result.reaped.push(record.pid);
        if (outcome === "escalated") result.escalated.push(record.pid);
      }
    } catch {
      result.stillAlive.push(record);
    }
  }));
  return result;
}

async function reapOne(record: RuntimeProcessRecord, deps: OrphanReapDeps): Promise<"skipped" | "exited" | "escalated" | "alive"> {
  const platform = deps.platform ?? process.platform;
  const readIdentity = deps.readIdentity ?? ((pid: number) => readProcessIdentity(pid, { platform, ...deps.identity }));
  const identity = await readIdentity(record.pid);
  if (!identity || identity.startIdentity !== record.startIdentity) return "skipped";
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => { process.kill(pid, signal); });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const graceMs = deps.graceMs ?? AGENT_STOP_KILL_GRACE_MS;
  const confirmMs = deps.confirmMs ?? AGENT_STOP_KILL_CONFIRM_MS;
  const pollMs = deps.pollMs ?? 100;
  const ownGroup = platform !== "win32" && identity.pgid === record.pid && record.pgid === record.pid;
  const target = ownGroup ? -record.pid : record.pid;
  const alive = () => {
    try {
      kill(target, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const waitGone = async (ms: number) => {
    for (let waited = 0; waited < ms && alive(); waited += pollMs) await sleep(pollMs);
    return !alive();
  };

  if (platform === "win32") {
    createProcessTreeOps({ ...deps.tree, platform }).forceKill(record.pid, []);
    return (await waitGone(confirmMs)) ? "escalated" : "alive";
  }
  // Read before the signal: what left the group is found only below the root.
  const outsideGroup: ProcessTreeEntry[] = (await descendantsOfOrphan(record.pid, { ...deps.tree, platform }))
    .filter((entry) => !ownGroup || entry.pgid !== record.pid);
  try {
    kill(target, "SIGTERM");
  } catch {
    // Gone between the identity check and the signal.
  }
  if (await waitGone(graceMs)) return "exited";
  try {
    kill(target, "SIGKILL");
  } catch {
    // Gone meanwhile.
  }
  killProcessTreeSnapshot(outsideGroup, { ...deps.tree, kill: (pid, signal) => kill(pid, signal) });
  return (await waitGone(confirmMs)) ? "escalated" : "alive";
}
