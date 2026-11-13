// Reconciler step 13 (PR 3): the runner's half of a drained web upgrade.
//
// The Computer service drains every runner it supervises (Tenny Q-J) through
// two files per server (shared computerUpgradeDrain.ts): it writes
// `upgrade-drain.json` once the upgrade passed its refusal checks and its
// installer is ready, and this channel, which checks for it every second,
// begins the agent hosts' drain (agentDrain.ts: new deliveries, reminders and
// starts held; resolves when every process is quiet or at the deadline). The
// channel writes how far it is to `upgrade-drain-state.json`, which the
// service waits on before it spawns the installer, and the runner of the
// Server that asked sends the same as `computer:upgrade:draining`.
//
// The hold ends (`endDrain`, what was held is delivered or started):
//   - when the service removes the request file (the upgrade did not go on);
//   - on a re-established Server connection (Tenny f8ae3b79 condition 2: the
//     upgrade intent of the old connection is gone);
//   - by itself at the deadline plus a grace (agentDrain.ts, condition 1).
// A request it ended is not begun again. The daemon's shutdown ends nothing:
// the held work is the shutdown's, and the next `ready` wakes it (F9).

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION,
  COMPUTER_UPGRADE_DRAIN_MAX_LISTED_AGENTS,
  parseComputerUpgradeDrainRequestFile,
  type ComputerUpgradeDrainFinished,
  type ComputerUpgradeDrainingMessage,
  type ComputerUpgradeDrainRequestFile,
  type ComputerUpgradeDrainStateFile,
} from "@botiverse/raft-shared";
import type { AgentDrainOptions, AgentDrainProgress, AgentDrainSummary } from "./agentDrain";

/** How often the runner looks for the service's drain request. */
export const COMPUTER_UPGRADE_DRAIN_POLL_MS = 1_000;

export interface ComputerUpgradeDrainPaths {
  /** Service → runner (`upgrade-drain.json`). */
  requestPath: string;
  /** Runner → service (`upgrade-drain-state.json`). */
  statePath: string;
}

/** The agent hosts as the channel drives them (AgentLifecycleHost's optional drain methods). */
export interface ComputerUpgradeDrainHosts {
  beginDrain?(options: AgentDrainOptions): Promise<AgentDrainSummary>;
  endDrain?(): void;
  drainProgress?(): AgentDrainProgress | null;
}

type Timer = ReturnType<typeof setInterval>;

export interface ComputerUpgradeDrainChannelDeps {
  paths: ComputerUpgradeDrainPaths;
  hosts: ComputerUpgradeDrainHosts;
  /** Whether the Server connection is up (a draining frame is sent only then). */
  connected(): boolean;
  send(frame: ComputerUpgradeDrainingMessage): void;
  recordEvent(name: string, attrs: Record<string, unknown>): void;
  now?: () => number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  pollMs?: number;
}

interface ActiveDrain {
  request: ComputerUpgradeDrainRequestFile;
  finished: ComputerUpgradeDrainFinished | null;
  lastReported: string | null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export class ComputerUpgradeDrainChannel {
  private active: ActiveDrain | null = null;
  /** Requests this runner already let go of: never begun again. */
  private readonly ended = new Set<string>();
  private timer: Timer | null = null;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(private readonly deps: ComputerUpgradeDrainChannelDeps) {
    this.now = deps.now ?? Date.now;
    this.pid = deps.pid ?? process.pid;
    this.isAlive = deps.isAlive ?? processAlive;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), Math.max(1, this.deps.pollMs ?? COMPUTER_UPGRADE_DRAIN_POLL_MS));
    this.timer.unref?.();
  }

  /** The daemon stops: the poll ends, the drain does not (what it holds is the shutdown's). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The request this runner drains for, while it holds. */
  get activeRequestId(): string | null {
    return this.active?.request.requestId ?? null;
  }

  /** A (re-)established Server connection: a drain still holding is let go (condition 2). */
  onConnected(): void {
    if (this.active) this.release("reconnected");
  }

  /** One look at the request file (the poll; tests call it directly). */
  tick(): void {
    const request = this.readRequest();
    const active = this.active;
    if (active) {
      if (!request || request.requestId !== active.request.requestId) {
        this.release("request_removed");
      } else if ((this.deps.hosts.drainProgress?.() ?? null) === null) {
        // The hosts let go by themselves (the hold cap).
        this.release("expired");
      } else {
        this.report();
        return;
      }
    }
    if (!request || this.ended.has(request.requestId) || !this.isAlive(request.servicePid)) return;
    this.begin(request);
  }

  private begin(request: ComputerUpgradeDrainRequestFile): void {
    const beginDrain = this.deps.hosts.beginDrain;
    if (!beginDrain) return;
    const deadlineMs = Math.max(0, request.deadlineAtMs - this.now());
    const active: ActiveDrain = { request, finished: null, lastReported: null };
    this.active = active;
    this.deps.recordEvent("daemon.computer_upgrade.drain.began", {
      request_id: request.requestId,
      origin: request.origin,
      deadline_ms: deadlineMs,
    });
    void beginDrain.call(this.deps.hosts, { deadlineMs }).then((summary) => {
      if (this.active !== active) return;
      active.finished = summary.finished;
      this.deps.recordEvent("daemon.computer_upgrade.drain.finished", {
        request_id: request.requestId,
        finished: summary.finished,
        duration_ms: summary.durationMs,
        waited_for: summary.waitedFor.length,
        not_quiet: summary.notQuiet.length,
      });
      this.report();
    }, (error: unknown) => {
      this.deps.recordEvent("daemon.computer_upgrade.drain.failed", {
        request_id: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.report();
  }

  private release(reason: "request_removed" | "reconnected" | "expired"): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.ended.add(active.request.requestId);
    this.deps.hosts.endDrain?.();
    if (active.finished === null) {
      active.finished = "ended";
      this.report(active);
    }
    this.deps.recordEvent("daemon.computer_upgrade.drain.released", {
      request_id: active.request.requestId,
      reason,
    });
  }

  /** Write the state file and tell the Server, when anything changed. */
  private report(active: ActiveDrain | null = this.active): void {
    if (!active) return;
    const progress = this.deps.hosts.drainProgress?.() ?? { live: 0, notQuiet: [] };
    const notQuietAgentIds = active.finished === "quiet"
      ? []
      : [...new Set(progress.notQuiet.map((each) => each.agentId))].slice(0, COMPUTER_UPGRADE_DRAIN_MAX_LISTED_AGENTS);
    const key = JSON.stringify([progress.live, notQuietAgentIds, active.finished]);
    if (key === active.lastReported) return;
    active.lastReported = key;
    const state: ComputerUpgradeDrainStateFile = {
      formatVersion: COMPUTER_UPGRADE_DRAIN_FILE_FORMAT_VERSION,
      requestId: active.request.requestId,
      pid: this.pid,
      live: progress.live,
      notQuietAgentIds,
      ...(active.finished ? { finished: active.finished } : {}),
      updatedAtMs: this.now(),
    };
    this.writeState(state);
    if (!active.request.origin || !this.deps.connected()) return;
    this.deps.send({
      type: "computer:upgrade:draining",
      requestId: active.request.requestId,
      deadlineAt: new Date(active.request.deadlineAtMs).toISOString(),
      live: progress.live,
      notQuietAgentIds,
      ...(active.finished ? { finished: active.finished } : {}),
    });
  }

  private readRequest(): ComputerUpgradeDrainRequestFile | null {
    let raw: string;
    try {
      raw = readFileSync(this.deps.paths.requestPath, "utf8");
    } catch {
      return null;
    }
    try {
      return parseComputerUpgradeDrainRequestFile(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Atomic (temp + rename), best effort: a failed write never affects the agents. */
  private writeState(state: ComputerUpgradeDrainStateFile): void {
    const file = this.deps.paths.statePath;
    const temporary = `${file}.${this.pid}.tmp`;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    } catch {
      try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }
}
