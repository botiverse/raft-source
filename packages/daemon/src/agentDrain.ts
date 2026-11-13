// Reconciler step 13 (PR 2): the drain of one agent host. A drain holds new
// work (message deliveries, reminders, notices and agent starts) and waits
// until every live process of the host is quiet, or until its deadline. It
// never stops an agent itself (decision Q-A): once quiet, the ordinary
// shutdown stops everything, on the one stop path. `end` releases what was
// held (an upgrade that did not happen).
//
// Quiet is the one idle definition (agentIdle.ts) with `ignoreUntoldInbox`:
// the input a drain holds on purpose does not keep a process busy, because
// it stays unread on the server (acceptance conditions of step 13 §8: the
// server's read position decides whether a wake is still owed). Background
// tasks, unconsumed stdin, queued input and told-but-unsettled mentions still
// do. A process the host's own wakeup starts a new turn in becomes not quiet
// again; the deadline is the backstop.
// An agent that cannot run a model turn (agentStopWaitReason: a credential
// hold, an exhausted quota, a runtime mismatch, no live process) with no turn
// in flight is quiet too: the clauses only a turn settles are not waited for
// (`notRunnable`, traced). What it holds stays unread on the server.
//
// Control is never held: a Stop, an interrupt of the turn (Claude's
// `control_request interrupt`) and a sub-agent stop reach the runtime as
// they always do; the hosts gate only their delivery paths.
//
// What re-checks: each host's one reconcile entry (the "became idle" edges:
// turn end, background tasks done, queued input settled, delivery consumed,
// sweep) calls `check`; a poll (DRAIN_POLL_MS) is the backstop for edges no
// reconcile sees (a process that exits), and the deadline timer resolves the
// waiter whatever the state.

import { COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS } from "@botiverse/raft-shared";
import type { AgentNotIdleReason, AgentNotRunnableReason } from "./agentIdle";

/**
 * The longest a drain waits, whatever the caller asks for (Tenny Q-B: the
 * server decides the deadline, the daemon clamps it). The server's upgrade
 * request deadline (30 min) and the installer's own budgets must still fit
 * after it.
 */
export const AGENT_DRAIN_MAX_DEADLINE_MS = COMPUTER_UPGRADE_DRAIN_MAX_DEADLINE_MS;
/**
 * How long past its deadline a drain may still hold work (Tenny f8ae3b79
 * condition 1). After the deadline the shutdown normally comes within
 * seconds; when nothing comes (the upgrade never stopped this process and
 * nobody ended the drain), the drain ends itself at the deadline plus this
 * grace, so a hold lasts at most 15 min. Traced `daemon.agent.drain.expired`.
 */
export const AGENT_DRAIN_RELEASE_GRACE_MS = 5 * 60_000;
/** The backstop re-check while a drain waits (a process exit is no reconcile edge). */
export const AGENT_DRAIN_POLL_MS = 1_000;

/** The deadline a drain runs with: the caller's, at most AGENT_DRAIN_MAX_DEADLINE_MS; not a finite non-negative number → 0. */
export function clampAgentDrainDeadlineMs(deadlineMs: number): number {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return 0;
  return Math.min(Math.floor(deadlineMs), AGENT_DRAIN_MAX_DEADLINE_MS);
}

export interface AgentDrainOptions {
  /** How long to wait for quiet, from now; clamped to AGENT_DRAIN_MAX_DEADLINE_MS. */
  deadlineMs: number;
  /**
   * Reconciler step 14 (Q-H): drain this agent only (a /migrate source stop).
   * Absent: every agent of the host (step 13, a web upgrade).
   */
  agentId?: string;
}

/** A live process (or a spawn already under way) that is not quiet, and why (agentNotIdleReason). */
export interface AgentDrainNotQuiet {
  agentId: string;
  reason: AgentNotIdleReason;
}

/**
 * A live process (or a spawn under way) counted quiet although it is not
 * idle, because it cannot run a model turn (agentStopWaitReason): the
 * reason, and the clause it would have been waited for.
 */
export interface AgentDrainNotRunnable {
  agentId: string;
  reason: AgentNotRunnableReason;
  settled: AgentNotIdleReason;
}

/** The host's state, read in one tick. */
export interface AgentDrainProgress {
  /** Live processes (and spawns under way) the drain looked at. */
  live: number;
  notQuiet: AgentDrainNotQuiet[];
  /** Counted quiet only because they cannot run (absent: none). */
  notRunnable?: AgentDrainNotRunnable[];
}

export interface AgentDrainSummary {
  /** `quiet`: every process was quiet; `deadline`: the deadline passed first; `ended`: `endDrain` came first. */
  finished: "quiet" | "deadline" | "ended";
  /** The clamped deadline, on the host's clock. */
  deadlineAtMs: number;
  durationMs: number;
  /** The agents that were not quiet when the drain began: the ones it waited for. */
  waitedFor: string[];
  /** Not quiet when it finished (empty when `quiet`). */
  notQuiet: AgentDrainNotQuiet[];
  /** When it finished: the ones counted quiet only because they cannot run (not waited for); absent from a host that predates it. */
  notRunnable?: AgentDrainNotRunnable[];
  live: number;
}

type Timer = ReturnType<typeof setTimeout>;

/** Counts and categories only, as `not_quiet_reasons`. */
function notRunnableTraceAttrs(notRunnable: readonly AgentDrainNotRunnable[]): Record<string, unknown> {
  if (notRunnable.length === 0) return {};
  return {
    not_runnable: notRunnable.length,
    not_runnable_reasons: notRunnable.map((each) => each.reason).join(","),
    not_runnable_settled: notRunnable.map((each) => each.settled).join(","),
  };
}

export interface AgentDrainDeps {
  host: "legacy" | "oar";
  progress(): AgentDrainProgress;
  /** After `end`: hand over what the drain held (deliveries, notices, starts). */
  release(): void;
  recordEvent(name: string, attrs: Record<string, unknown>): void;
  now?: () => number;
  pollMs?: number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

interface Waiting {
  startedAtMs: number;
  deadlineAtMs: number;
  waitedFor: string[];
  promise: Promise<AgentDrainSummary>;
  resolve(summary: AgentDrainSummary): void;
  settled: boolean;
  deadlineTimer: Timer | null;
  poll: Timer | null;
  /** The self-release at the deadline plus AGENT_DRAIN_RELEASE_GRACE_MS; outlives the waiter (the hold does). */
  releaseTimer: Timer | null;
}

export class AgentDrain {
  private waiting: Waiting | null = null;
  /** Released by `end`: what a start held for the drain waits on. */
  private released: { promise: Promise<void>; resolve(): void } | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  constructor(private readonly deps: AgentDrainDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** New work is held: from `begin` until `end`, also after the waiter resolved (the shutdown comes next). */
  get holding(): boolean {
    return this.waiting !== null;
  }

  /**
   * Hold new work and wait for quiet. A drain already running is not begun
   * again (a second upgrade is a no-op, Q-G): the same wait, with its
   * deadline, is returned.
   */
  begin(options: AgentDrainOptions): Promise<AgentDrainSummary> {
    if (this.waiting) return this.waiting.promise;
    const startedAtMs = this.now();
    const deadlineMs = clampAgentDrainDeadlineMs(options.deadlineMs);
    const progress = this.deps.progress();
    let resolve!: (summary: AgentDrainSummary) => void;
    const promise = new Promise<AgentDrainSummary>((done) => { resolve = done; });
    const waiting: Waiting = {
      startedAtMs,
      deadlineAtMs: startedAtMs + deadlineMs,
      waitedFor: progress.notQuiet.map((each) => each.agentId),
      promise,
      resolve,
      settled: false,
      deadlineTimer: null,
      poll: null,
      releaseTimer: null,
    };
    this.waiting = waiting;
    let release!: () => void;
    const released = new Promise<void>((done) => { release = done; });
    this.released = { promise: released, resolve: release };
    this.deps.recordEvent("daemon.agent.drain.began", {
      host: this.deps.host,
      deadline_ms: deadlineMs,
      requested_deadline_ms: options.deadlineMs,
      live: progress.live,
      not_quiet: progress.notQuiet.length,
      // Categories only (agentNotIdleReason), as on `finished`: why it waits, from the start.
      not_quiet_reasons: progress.notQuiet.map((each) => each.reason).join(",") || undefined,
      ...notRunnableTraceAttrs(progress.notRunnable ?? []),
    });
    this.armRelease(waiting, waiting.deadlineAtMs + AGENT_DRAIN_RELEASE_GRACE_MS);
    if (!this.settleIfDone(waiting, progress)) {
      this.armDeadline(waiting, deadlineMs);
      this.armPoll(waiting);
    }
    return promise;
  }

  /** The host's progress while a drain holds; null when none does. */
  progress(): AgentDrainProgress | null {
    return this.waiting ? this.deps.progress() : null;
  }

  /** A reconcile edge (or the poll): resolve the waiter once every process is quiet, or the deadline passed. */
  check(): void {
    const waiting = this.waiting;
    if (!waiting || waiting.settled) return;
    this.settleIfDone(waiting, this.deps.progress());
  }

  /** Stop holding and release what was held. A waiter still waiting resolves `ended`. */
  end(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    if (!waiting.settled) this.settle(waiting, "ended", this.deps.progress());
    if (waiting.releaseTimer) this.clearTimer(waiting.releaseTimer);
    waiting.releaseTimer = null;
    this.waiting = null;
    const released = this.released;
    this.released = null;
    this.deps.recordEvent("daemon.agent.drain.ended", { host: this.deps.host, held_ms: this.now() - waiting.startedAtMs });
    released?.resolve();
    this.deps.release();
  }

  /** Resolves once no drain holds starts (at once when none does), or when `signal` aborts. */
  startsReleased(signal?: AbortSignal): Promise<void> {
    const released = this.released;
    if (!released || signal?.aborted) return Promise.resolve();
    if (!signal) return released.promise;
    return new Promise<void>((resolve) => {
      const done = () => { signal.removeEventListener("abort", done); resolve(); };
      signal.addEventListener("abort", done, { once: true });
      void released.promise.then(done);
    });
  }

  /** Daemon shutdown: no timer outlives the host (what is held is the shutdown's). */
  dispose(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.clearTimers(waiting);
    if (waiting.releaseTimer) this.clearTimer(waiting.releaseTimer);
    waiting.releaseTimer = null;
  }

  /** The hold cap (absolute, on the host's clock): like the deadline timer, re-armed when it fires before the clock got there. */
  private armRelease(waiting: Waiting, releaseAtMs: number): void {
    waiting.releaseTimer = this.setTimer(() => {
      waiting.releaseTimer = null;
      if (this.waiting !== waiting) return;
      if (releaseAtMs - this.now() > 0) {
        this.armRelease(waiting, releaseAtMs);
        return;
      }
      this.deps.recordEvent("daemon.agent.drain.expired", {
        host: this.deps.host,
        held_ms: this.now() - waiting.startedAtMs,
        deadline_ms: waiting.deadlineAtMs - waiting.startedAtMs,
      });
      this.end();
    }, Math.max(0, releaseAtMs - this.now()));
  }

  private settleIfDone(waiting: Waiting, progress: AgentDrainProgress): boolean {
    if (progress.notQuiet.length === 0) {
      this.settle(waiting, "quiet", progress);
      return true;
    }
    if (this.now() >= waiting.deadlineAtMs) {
      this.settle(waiting, "deadline", progress);
      return true;
    }
    return false;
  }

  private settle(waiting: Waiting, finished: AgentDrainSummary["finished"], progress: AgentDrainProgress): void {
    waiting.settled = true;
    this.clearTimers(waiting);
    const summary: AgentDrainSummary = {
      finished,
      deadlineAtMs: waiting.deadlineAtMs,
      durationMs: this.now() - waiting.startedAtMs,
      waitedFor: waiting.waitedFor,
      notQuiet: finished === "quiet" ? [] : progress.notQuiet,
      notRunnable: progress.notRunnable ?? [],
      live: progress.live,
    };
    this.deps.recordEvent("daemon.agent.drain.finished", {
      host: this.deps.host,
      finished,
      duration_ms: summary.durationMs,
      waited_for: summary.waitedFor.length,
      not_quiet: summary.notQuiet.length,
      not_quiet_reasons: summary.notQuiet.map((each) => each.reason).join(",") || undefined,
      ...notRunnableTraceAttrs(summary.notRunnable ?? []),
      live: summary.live,
    });
    waiting.resolve(summary);
  }

  /**
   * The deadline timer re-reads the clock when it fires: a Node timer may
   * fire before the clock has moved its full delay (#13385), and then it is
   * armed again for the time still left.
   */
  private armDeadline(waiting: Waiting, delayMs: number): void {
    waiting.deadlineTimer = this.setTimer(() => {
      waiting.deadlineTimer = null;
      if (waiting.settled) return;
      const leftMs = waiting.deadlineAtMs - this.now();
      if (leftMs > 0) {
        this.armDeadline(waiting, leftMs);
        return;
      }
      this.settle(waiting, "deadline", this.deps.progress());
    }, Math.max(0, delayMs));
  }

  private armPoll(waiting: Waiting): void {
    waiting.poll = this.setTimer(() => {
      waiting.poll = null;
      if (waiting.settled) return;
      this.check();
      if (!waiting.settled) this.armPoll(waiting);
    }, Math.max(1, this.deps.pollMs ?? AGENT_DRAIN_POLL_MS));
  }

  private clearTimers(waiting: Waiting): void {
    if (waiting.deadlineTimer) this.clearTimer(waiting.deadlineTimer);
    if (waiting.poll) this.clearTimer(waiting.poll);
    waiting.deadlineTimer = null;
    waiting.poll = null;
  }
}

export interface AgentDrainsDeps {
  host: "legacy" | "oar";
  /** The host's state: every live process (`null`), or only `agentId`'s. */
  progress(agentId: string | null): AgentDrainProgress;
  /** After `end`: hand over what the drain held, for every agent (`null`) or only `agentId`. */
  release(agentId: string | null): void;
  recordEvent(name: string, attrs: Record<string, unknown>): void;
  now?: () => number;
}

/**
 * Reconciler step 14 (Q-H): the drains of one host. The machine-wide drain
 * (step 13, a web upgrade) and a drain of one agent (a /migrate source stop:
 * hold that agent's input, wait for it to be quiet, then the migration stops
 * it) are the same AgentDrain: the same quiet predicate, the same hold sites
 * (`holds`), the same deadline clamp and self-release cap, the same
 * `daemon.agent.drain.*` events (with `agentId` for one agent). A drain of
 * one agent looks at and releases only that agent, and holds no start: the
 * start queue is the machine's, and the agent it waits for already runs.
 */
export class AgentDrains {
  private readonly machine: AgentDrain;
  private readonly byAgent = new Map<string, AgentDrain>();

  constructor(private readonly deps: AgentDrainsDeps) {
    this.machine = new AgentDrain({
      host: deps.host,
      progress: () => deps.progress(null),
      release: () => deps.release(null),
      recordEvent: deps.recordEvent,
      now: deps.now,
    });
  }

  /** The machine-wide drain holds new starts (`startsReleased`). */
  get holdingStarts(): boolean {
    return this.machine.holding;
  }

  /** New input for `agentId` is held: by the machine-wide drain, or by a drain of that agent. */
  holds(agentId: string): boolean {
    return this.machine.holding || this.byAgent.has(agentId);
  }

  /** As AgentDrain.begin; `agentId` drains that agent only (a second begin for it returns the same wait). */
  begin(options: AgentDrainOptions): Promise<AgentDrainSummary> {
    const agentId = options.agentId;
    if (agentId === undefined) return this.machine.begin(options);
    let drain = this.byAgent.get(agentId);
    if (!drain) {
      drain = this.agentDrain(agentId);
      this.byAgent.set(agentId, drain);
    }
    return drain.begin(options);
  }

  /** End the machine-wide drain, or `agentId`'s; the other drains go on holding. */
  end(agentId?: string): void {
    if (agentId === undefined) this.machine.end();
    else this.byAgent.get(agentId)?.end();
  }

  /** The machine-wide drain's progress, or `agentId`'s; null when that drain does not hold. */
  progress(agentId?: string): AgentDrainProgress | null {
    return agentId === undefined ? this.machine.progress() : this.byAgent.get(agentId)?.progress() ?? null;
  }

  /** A reconcile edge: every drain re-checks. */
  check(): void {
    this.machine.check();
    for (const drain of [...this.byAgent.values()]) drain.check();
  }

  startsReleased(signal?: AbortSignal): Promise<void> {
    return this.machine.startsReleased(signal);
  }

  dispose(): void {
    this.machine.dispose();
    for (const drain of this.byAgent.values()) drain.dispose();
  }

  private agentDrain(agentId: string): AgentDrain {
    const drain: AgentDrain = new AgentDrain({
      host: this.deps.host,
      progress: () => this.deps.progress(agentId),
      release: () => {
        // No longer held before the host hands over (its flush re-checks `holds`).
        if (this.byAgent.get(agentId) === drain) this.byAgent.delete(agentId);
        this.deps.release(agentId);
      },
      recordEvent: (name, attrs) => this.deps.recordEvent(name, { ...attrs, agentId }),
      now: this.deps.now,
    });
    return drain;
  }
}
