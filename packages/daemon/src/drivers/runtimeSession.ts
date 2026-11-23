import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { logger } from "../logger";
import { AGENT_STOP_KILL_CONFIRM_MS, AGENT_STOP_KILL_GRACE_MS, stopProcess, type StopProcessHandle } from "./processStop";
import { defaultProcessTreeOps, entriesStartedSince, type ProcessTreeOps } from "./processTree";
import { takeEarlyChildEvents } from "./runtimeChild";
import type {
  ParsedEvent,
  RuntimeDriver,
  RuntimeExitInfo,
  RuntimeQuietOutputDeadline,
  RuntimeSendResult,
  RuntimeSession,
  RuntimeSessionDescriptor,
  RuntimeStopOptions,
  SpawnContext,
} from "./types";
import { RuntimeTurnOriginHolder, type RuntimeTurnOrigin } from "../runtimeTurnOrigin";

export { RUNTIME_OOM_SCORE_ADJ } from "./oomScore";

function descriptorFromDriver(driver: RuntimeDriver): RuntimeSessionDescriptor {
  const lifecycle = driver.lifecycle.kind === "per_turn" ? "turn_based" : "persistent_stream";
  const idle = driver.supportsStdinNotification ? "stdin" : "unsupported";
  const busy = driver.supportsStdinNotification ? "stdin_steer" : "unsupported";
  return {
    transport: "child_process",
    lifecycle,
    stdout: {
      channel: driver.stdoutChannel ?? "diagnostic",
    },
    input: {
      initial: "start",
      idle,
      busy,
    },
    readiness: "spawned",
    turnBoundary: driver.lifecycle.kind === "per_turn" ? "process_exit" : "parsed_event",
    startPolicy: driver.lifecycle.kind === "per_turn" ? driver.lifecycle.start : "immediate",
    inFlightWake: driver.lifecycle.inFlightWake,
    busyDelivery: driver.busyDeliveryMode,
    postTurn: driver.terminateProcessOnTurnEnd
      ? "terminate_process"
      : driver.endStdinOnTurnEnd
        ? "close_stdin"
        : "keep_alive",
  };
}

type RuntimeSessionEvents = {
  runtime_event: [ParsedEvent];
  stdout: [string];
  stderr: [string];
  error: [Error];
  exit: [RuntimeExitInfo];
  close: [RuntimeExitInfo];
};

type RuntimeSessionEventName = keyof RuntimeSessionEvents;

/** How long a runtime's exit may go without `close` (a child still holds its stdio) before the session releases the process and drains the pipes. */
export const CLOSE_AFTER_EXIT_GRACE_MS = 5_000;

export class ChildProcessRuntimeSession implements RuntimeSession {
  readonly descriptor: RuntimeSessionDescriptor;
  private readonly events = new EventEmitter();
  private process: import("node:child_process").ChildProcess | null = null;
  private started = false;
  private stdoutBuffer = "";
  private stdoutDecoder = new StringDecoder("utf8");
  private requestedStopReason: string | undefined;
  private readonly turnOrigin: RuntimeTurnOriginHolder;
  /** Reconciler step 5: the stop in progress; a later stop joins it. */
  private stopRequest: { done: Promise<void>; escalateNow(): void } | null = null;
  private exitEmitted = false;
  private closeEmitted = false;
  /** Set when the exit was not followed by `close` in time (#o11y-alerts:#5); carried on `close`. */
  private stdioHeldAfterExit: { waitedMs: number } | null = null;
  private closeAfterExitArmed = false;
  /** RuntimeDriver.quietOutputDeadline as armed: its instant, its timer, and the driver's latest view of it. */
  private quietDeadline: { atMs: number; timer: ReturnType<typeof setTimeout>; deadline: RuntimeQuietOutputDeadline } | null = null;

  constructor(
    private readonly driver: RuntimeDriver,
    private readonly ctx: SpawnContext,
    private readonly processTree: ProcessTreeOps = defaultProcessTreeOps,
  ) {
    this.descriptor = descriptorFromDriver(driver);
    this.turnOrigin = new RuntimeTurnOriginHolder(ctx.processInstanceId);
    // Registered in the constructor so these run BEFORE any manager listener: on turn_end the
    // manager may immediately send the next idle prompt, which must see the previous turn closed.
    this.events.on("runtime_event", (event: ParsedEvent) => {
      if (event.kind === "turn_end") this.turnOrigin.endTurn();
    });
    this.events.on("exit", () => {
      this.clearQuietDeadline();
      this.turnOrigin.close();
    });
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get currentSessionId(): string | null | undefined {
    return this.driver.currentSessionId;
  }

  get currentRuntimeHomeDir(): string | null | undefined {
    return this.driver.currentRuntimeHomeDir;
  }

  get exitCode(): number | null {
    return this.process?.exitCode ?? null;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.process?.signalCode ?? null;
  }

  get closed(): boolean {
    return this.process ? this.process.exitCode != null || this.process.signalCode != null : false;
  }

  /**
   * Read-only OS liveness introspection (signal-0), NOT control IO — exposed so
   * managers query liveness through the session boundary (RS-011) instead of
   * poking the raw pid. Preserves the historic `probeRuntimeProcessLiveness`
   * semantics exactly: undefined when there is no pid, true on success or EPERM,
   * false otherwise. Deliberately does NOT short-circuit on `this.closed` — the
   * original probe checked only pid + signal-0.
   */
  isAlive(): boolean | undefined {
    const pid = this.process?.pid;
    if (typeof pid !== "number") return undefined;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
      return code === "EPERM" ? true : false;
    }
  }

  on<T extends RuntimeSessionEventName>(
    event: T,
    cb: (...args: RuntimeSessionEvents[T]) => void,
  ): void {
    this.events.on(event, cb as (...args: unknown[]) => void);
  }

  async start(input: { text: string; sessionId?: string | null; origin?: RuntimeTurnOrigin | null }): Promise<RuntimeSendResult> {
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "runtime session already started" };
    }
    this.started = true;
    const launchCtx: SpawnContext = {
      ...this.ctx,
      prompt: input.text,
      readTurnOrigin: this.turnOrigin.read,
      config: {
        ...this.ctx.config,
        sessionId: input.sessionId ?? this.ctx.config.sessionId,
      },
    };
    // The prompt rides the spawn itself, so the turn begins before the process can make a call.
    this.turnOrigin.beginTurn(input.origin);
    let spawned: Awaited<ReturnType<RuntimeDriver["spawn"]>>;
    try {
      spawned = await this.driver.spawn(launchCtx);
    } catch (error) {
      this.turnOrigin.close();
      throw error;
    }
    const { process } = spawned;
    this.process = process;
    const abandoned = this.attachProcess(process);
    if (abandoned) {
      // The child exists (its exit/close are still reported above), but it was
      // given up before this session took it over: the start failed.
      this.turnOrigin.close();
      return { ok: false, reason: "runtime_error", error: abandoned };
    }
    return { ok: true, acceptedAs: "prompt" };
  }

  send(input: {
    mode: "idle" | "busy";
    text: string;
    sessionId?: string | null;
    origin?: RuntimeTurnOrigin | null;
  }): RuntimeSendResult {
    const proc = this.process;
    // Reconciler step 5: nothing is written to a process being stopped; the
    // caller keeps the delivery for the next process.
    if (!proc || this.closed || this.stopRequest || this.exitEmitted) return { ok: false, reason: "closed" };
    const encoded = this.driver.encodeStdinMessage(input.text, input.sessionId ?? null, { mode: input.mode });
    if (!encoded) return { ok: false, reason: "unsupported" };
    // Accepted from here on. Only a new prompt opens a turn; a steer leaves the current origin alone.
    if (input.mode === "idle") this.turnOrigin.beginTurn(input.origin);
    proc.stdin?.write(encoded + "\n");
    return { ok: true, acceptedAs: input.mode === "busy" ? "steer" : "prompt" };
  }

  interruptTurn(): "sent" | "unsupported" {
    const proc = this.process;
    if (!proc || this.closed || this.stopRequest || !this.driver.encodeInterruptRequest) return "unsupported";
    const line = this.driver.encodeInterruptRequest();
    if (!line) return "unsupported";
    proc.stdin?.write(line + "\n");
    return "sent";
  }

  /** #proj-runtime:#41: ask the runtime to stop one sub-agent's turn. */
  interruptSubagent(subagentTaskId: string): "sent" | "not_running" | "unsupported" {
    const proc = this.process;
    if (!this.driver.encodeSubagentInterruptRequest) return "unsupported";
    if (!proc || this.closed || this.stopRequest) return "not_running";
    const line = this.driver.encodeSubagentInterruptRequest(subagentTaskId);
    if (!line) return "not_running";
    proc.stdin?.write(line + "\n");
    return "sent";
  }

  /** Kills what started inside [from, to]: a queued message may already have started the next turn. */
  async killTurnProcesses(startedAtOrAfterMs: number, startedAtOrBeforeMs: number): Promise<{ killed: number; leftAlone: number }> {
    const proc = this.process;
    if (!proc || this.closed || typeof proc.pid !== "number") return { killed: 0, leftAlone: 0 };
    const descendants = await this.processTree.snapshotDescendants(proc.pid);
    const { selected, leftAlone } = entriesStartedSince(descendants, startedAtOrAfterMs);
    const inTurn = selected.filter((entry) => entry.startedAtMs !== undefined && entry.startedAtMs <= startedAtOrBeforeMs);
    return { killed: this.processTree.killEntries(inTurn), leftAlone: leftAlone + (selected.length - inTurn.length) };
  }

  stop(opts: RuntimeStopOptions = {}): Promise<void> {
    this.clearQuietDeadline();
    // A stopping process may still issue calls until it exits; none of them belong to a live turn.
    this.turnOrigin.close();
    const proc = this.process;
    if (!proc || this.closed || this.exitEmitted) return Promise.resolve();
    if (this.stopRequest) {
      // Joins the stop in progress (one grace, one escalation per process).
      if (opts.signal === "SIGKILL") this.stopRequest.escalateNow();
      return this.stopRequest.done;
    }
    this.requestedStopReason = opts.reason;
    let handle: StopProcessHandle | null = null;
    let escalateEarly = opts.signal === "SIGKILL";
    const request = {
      done: Promise.resolve(),
      escalateNow: () => {
        if (handle) handle.escalateNow();
        else escalateEarly = true;
      },
    };
    this.stopRequest = request;
    request.done = this.runStop(proc, opts, () => escalateEarly, (created) => { handle = created; });
    return request.done;
  }

  private async runStop(
    proc: import("node:child_process").ChildProcess,
    opts: RuntimeStopOptions,
    escalateEarly: () => boolean,
    onHandle: (handle: StopProcessHandle) => void,
  ): Promise<void> {
    const pid = proc.pid;
    // Taken before the signal: once the runtime exits, its children are
    // reparented and can no longer be found from it.
    const tree = typeof pid === "number" ? await this.processTree.snapshotTree(pid) : { descendants: [], rootLeadsGroup: false };
    const graceMs = opts.forceAfterMs ?? AGENT_STOP_KILL_GRACE_MS;
    const turnTreeKill = opts.turnTreeKill;
    if (turnTreeKill) {
      // task #25 step 2: a person stopped this turn. What the turn started is
      // killed at the deadline whether or not the runtime exited (Codex
      // leaves the command running); anything older, or of unknown age,
      // stays. This is not the process stop's tree kill below.
      setTimeout(() => {
        const { selected, leftAlone } = entriesStartedSince(tree.descendants, turnTreeKill.startedAtOrAfterMs);
        const killed = this.processTree.killEntries(selected);
        turnTreeKill.onResult?.({ killed, leftAlone });
      }, graceMs);
    }
    const handle = stopProcess({
      pid,
      exited: () => this.exitEmitted || this.closed,
      onExit: (listener) => this.events.once("exit", listener),
      signal: (signal) => { proc.kill(signal); },
    }, {
      signal: escalateEarly() ? "SIGKILL" : (opts.signal ?? "SIGTERM"),
      graceMs,
      confirmMs: opts.confirmAfterMs ?? AGENT_STOP_KILL_CONFIRM_MS,
      // A turn stop's restart keeps what older turns left (the session's MCP
      // servers, a dev server): only the runtime itself is SIGKILLed. Every
      // other stop SIGKILLs the whole tree: the runtime's process group plus
      // whatever left it (task #25: a runtime still alive at the deadline is
      // typically waiting on a hung command).
      killTree: turnTreeKill ? () => 1 : () => this.processTree.forceKill(pid, tree),
      onEscalated: opts.onEscalated,
      onKillUnconfirmed: (info) => {
        opts.onKillUnconfirmed?.(info);
        logger.warn(`[RuntimeSession ${this.ctx.agentId}] runtime pid=${info.pid ?? "none"} not seen to exit ${info.confirmMs}ms after SIGKILL; releasing it as exited`);
        // The last resort: report the exit so the agent is released and a
        // later start can proceed. A real exit that comes after is ignored.
        this.emitExitOnce({ code: null, signal: "SIGKILL", reason: "kill_unconfirmed" });
        this.emitCloseOnce({ code: null, signal: "SIGKILL", reason: "kill_unconfirmed" });
      },
    });
    onHandle(handle);
    if (escalateEarly()) handle.escalateNow();
    await handle.done;
  }

  private clearQuietDeadline(): void {
    if (!this.quietDeadline) return;
    clearTimeout(this.quietDeadline.timer);
    this.quietDeadline = null;
  }

  /**
   * RuntimeDriver.quietOutputDeadline, asked after each stdout line: the same
   * instant keeps the armed timer, another re-arms it, none clears it. When
   * it passes, the driver's events go out (its turn_end makes a
   * terminate_on_turn_end host stop the process through the usual turn end
   * path) and, should nothing have started a stop by then, the session stops
   * the process itself (SIGTERM, then the tree).
   */
  private syncQuietDeadline(): void {
    const next = this.exitEmitted || this.stopRequest ? null : this.driver.quietOutputDeadline?.() ?? null;
    if (!next) {
      this.clearQuietDeadline();
      return;
    }
    if (this.quietDeadline && this.quietDeadline.atMs === next.atMs) {
      this.quietDeadline.deadline = next;
      return;
    }
    this.clearQuietDeadline();
    const timer = setTimeout(() => {
      const armed = this.quietDeadline;
      this.quietDeadline = null;
      if (!armed || this.stopRequest || this.exitEmitted || this.closed) return;
      const events = armed.deadline.expire();
      if (events.length === 0) return;
      for (const event of events) this.events.emit("runtime_event", event);
      if (!this.stopRequest && !this.exitEmitted && !this.closed) void this.stop({ reason: armed.deadline.stopReason });
    }, Math.max(0, next.atMs - Date.now()));
    this.quietDeadline = { atMs: next.atMs, timer, deadline: next };
  }

  private emitExitOnce(info: RuntimeExitInfo, beforeExit?: () => void): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    // Runs with the session already marked exited (a stop it triggers is a no-op).
    beforeExit?.();
    this.events.emit("exit", info);
  }

  /**
   * #o11y-alerts:#5: Node's `close` waits for the child's stdio to close, and
   * a runtime's own children (an MCP server, a command a tool started)
   * inherit those pipes. A runtime that exits (on the stop's SIGTERM, or on
   * its own) leaves those children holding the pipes, and the agent's process
   * entry, released on `close`, stayed for hours: a new start was answered
   * "already running", a reminder took the busy path. After
   * `CLOSE_AFTER_EXIT_GRACE_MS` with no `close`, the session closes as the
   * child's `close` would (the stdout tail, end-of-stdout events), stops
   * reading their output and keeps draining the pipes into nothing. The
   * children are left alone, as a routine stop leaves what the agent started
   * (task #25): the pipes are never destroyed, which would kill a child that
   * still writes to them (SIGPIPE). The cost: the two pipe fds stay open
   * until that child exits.
   */
  private armCloseAfterExit(
    proc: import("node:child_process").ChildProcess,
    exitedAtMs: number,
    detachOutput: () => void,
    close: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    if (this.closeAfterExitArmed) return;
    this.closeAfterExitArmed = true;
    const timer = setTimeout(() => {
      if (this.closeEmitted) return;
      const held = { waitedMs: Math.max(0, Date.now() - exitedAtMs) };
      this.stdioHeldAfterExit = held;
      logger.warn(`[RuntimeSession ${this.ctx.agentId}] runtime pid=${proc.pid ?? "none"} exited ${held.waitedMs}ms ago but its stdio is still open (a child holds it); releasing the process, still draining the pipes`);
      // Never destroyed: a child still writing to a pipe with no reader dies
      // of SIGPIPE. Their output is drained into nothing until they exit.
      detachOutput();
      for (const stream of [proc.stdout, proc.stderr]) {
        stream?.on?.("data", () => {});
        stream?.resume?.();
      }
      close(proc.exitCode, proc.signalCode);
    }, CLOSE_AFTER_EXIT_GRACE_MS);
    timer.unref?.();
  }

  private emitCloseOnce(info: RuntimeExitInfo): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.events.emit("close", this.stdioHeldAfterExit ? { ...info, stdioHeldAfterExit: this.stdioHeldAfterExit } : info);
  }

  /** Returns the abandonment message when the child was given up before the hand-off. */
  private attachProcess(process: import("node:child_process").ChildProcess): string | null {
    const onStdout = (chunk: Buffer) => {
      const chunkText = this.stdoutDecoder.write(chunk);
      this.events.emit("stdout", chunkText);
      this.stdoutBuffer += chunkText;
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        for (const event of this.driver.parseLine(line)) {
          this.events.emit("runtime_event", event);
        }
        this.syncQuietDeadline();
      }
    };
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.events.emit("stderr", text);
    };
    // The driver's end-of-stdout events: once per child, only when stdout has
    // ended (its `end`, or at the latest `close`: a child that ended before
    // this session listened has no `end` to see) AND the child exited
    // cleanly (code 0, no signal) without a stop the daemon asked for. A
    // crash or kill mid-turn is not a finished turn; nor is output a stall,
    // interrupt or recycle cut short (that stop keeps its own reason).
    // With stdout ending first (the usual order) they go out just before the
    // session's `exit`.
    let stdoutEnded = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let endEventsDone = false;
    const emitEndEvents = () => {
      if (endEventsDone || !stdoutEnded || !exited) return;
      endEventsDone = true;
      if (this.stopRequest || exited.code !== 0 || exited.signal) return;
      for (const event of this.driver.parseStdoutEnd?.() ?? []) {
        this.events.emit("runtime_event", event);
      }
    };
    const onStdoutEnd = () => {
      if (stdoutEnded) return;
      stdoutEnded = true;
      // A last line without a trailing newline is still a line.
      const tail = this.stdoutDecoder.end();
      if (tail) this.events.emit("stdout", tail);
      const rest = this.stdoutBuffer + tail;
      this.stdoutBuffer = "";
      if (rest.trim()) {
        for (const event of this.driver.parseLine(rest)) {
          this.events.emit("runtime_event", event);
        }
      }
      emitEndEvents();
    };
    process.stdout?.on("data", onStdout);
    process.stdout?.on?.("end", onStdoutEnd);
    process.stderr?.on("data", onStderr);

    let errored = false;
    const onError = (err: Error) => {
      errored = true;
      this.events.emit("error", err);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      // One exit per child. Node emits it once; a test double may emit more
      // (e.g. after a kill it already honoured), which must not become a
      // second process_exited frame.
      this.emitExitOnce({
        code,
        signal,
        reason: this.requestedStopReason ? "requested" : "runtime_exit",
      } satisfies RuntimeExitInfo, () => {
        exited = { code, signal };
        emitEndEvents();
      });
      this.armCloseAfterExit(process, Date.now(), () => {
        process.stdout?.off?.("data", onStdout);
        process.stdout?.off?.("end", onStdoutEnd);
        process.stderr?.off?.("data", onStderr);
      }, (code, signal) => onClose(code, signal));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      // A failed spawn (EACCES, ENOENT) gets `error` and `close`, never
      // `exit`; `exit` is the session's one end-of-process event, so emit it.
      if (errored) this.emitExitOnce({ code, signal, reason: "error" } satisfies RuntimeExitInfo);
      exited ??= errored ? { code: code ?? -1, signal } : { code, signal };
      onStdoutEnd();
      this.emitCloseOnce({
        code,
        signal,
        reason: this.requestedStopReason ? "requested" : "runtime_exit",
      } satisfies RuntimeExitInfo);
    };
    // A child that exits before reading its stdin makes the next write fail
    // with EPIPE. That is not a session error: the child's own exit/close ends
    // the session. Unlistened, it would be thrown and take the daemon down.
    const onStdinError = (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code ?? err.name;
      logger.warn(`[RuntimeSession ${this.ctx.agentId}] runtime stdin write failed (${code}); the process exit decides the outcome`);
    };
    process.on("error", onError);
    process.on("exit", onExit);
    process.on("close", onClose);
    // Test doubles may give a stdin without `on`.
    process.stdin?.on?.("error", onStdinError);

    // Task #366: replay what the child reported before this session listened
    // (no await between attaching above and taking here, so nothing is missed
    // or doubled).
    let abandonedMessage: string | null = null;
    const early = takeEarlyChildEvents(process);
    if (early) {
      for (const err of early.stdinErrors) onStdinError(err);
      if (early.abandoned) {
        // Its output is gone; never replay a partial run as complete.
        abandonedMessage = `runtime child was abandoned before this session took it over: ${early.abandoned}`;
        onError(new Error(abandonedMessage));
      }
      // Arrival order, output included: a child that printed its last line
      // and exited before the hand-off still delivers that line before its
      // exit and close.
      for (const event of early.events) {
        if (event.kind === "stdout") onStdout(event.chunk);
        else if (event.kind === "stderr") onStderr(event.chunk);
        else if (event.kind === "error") onError(event.error);
        else if (event.kind === "exit") onExit(event.code, event.signal);
        else onClose(event.code, event.signal);
      }
    }
    return abandonedMessage;
  }
}

export function createChildProcessRuntimeSession(driver: RuntimeDriver, ctx: SpawnContext): RuntimeSession {
  return new ChildProcessRuntimeSession(driver, ctx);
}
