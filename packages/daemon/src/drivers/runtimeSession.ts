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
    this.events.on("exit", () => this.turnOrigin.close());
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

  private emitExitOnce(info: RuntimeExitInfo): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.events.emit("exit", info);
  }

  private emitCloseOnce(info: RuntimeExitInfo): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.events.emit("close", info);
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
      }
    };
    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.events.emit("stderr", text);
    };
    process.stdout?.on("data", onStdout);
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
      } satisfies RuntimeExitInfo);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      // A failed spawn (EACCES, ENOENT) gets `error` and `close`, never
      // `exit`; `exit` is the session's one end-of-process event, so emit it.
      if (errored) this.emitExitOnce({ code, signal, reason: "error" } satisfies RuntimeExitInfo);
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
