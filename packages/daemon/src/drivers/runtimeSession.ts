import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type {
  ParsedEvent,
  RuntimeDriver,
  RuntimeExitInfo,
  RuntimeSendResult,
  RuntimeSession,
  RuntimeSessionDescriptor,
  SpawnContext,
} from "./types.js";

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

  constructor(
    private readonly driver: RuntimeDriver,
    private readonly ctx: SpawnContext,
  ) {
    this.descriptor = descriptorFromDriver(driver);
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

  async start(input: { text: string; sessionId?: string | null }): Promise<RuntimeSendResult> {
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "runtime session already started" };
    }
    this.started = true;
    const launchCtx: SpawnContext = {
      ...this.ctx,
      prompt: input.text,
      config: {
        ...this.ctx.config,
        sessionId: input.sessionId ?? this.ctx.config.sessionId,
      },
    };
    const { process } = await this.driver.spawn(launchCtx);
    this.process = process;
    this.attachProcess(process);
    return { ok: true, acceptedAs: "prompt" };
  }

  send(input: {
    mode: "idle" | "busy";
    text: string;
    sessionId?: string | null;
  }): RuntimeSendResult {
    const proc = this.process;
    if (!proc || this.closed) return { ok: false, reason: "closed" };
    const encoded = this.driver.encodeStdinMessage(input.text, input.sessionId ?? null, { mode: input.mode });
    if (!encoded) return { ok: false, reason: "unsupported" };
    proc.stdin?.write(encoded + "\n");
    return { ok: true, acceptedAs: input.mode === "busy" ? "steer" : "prompt" };
  }

  async stop(opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    reason?: string;
  }): Promise<void> {
    const proc = this.process;
    if (!proc || this.closed) return;
    this.requestedStopReason = opts?.reason;
    proc.kill(opts?.signal ?? "SIGTERM");
    if (!opts?.forceAfterMs) return;
    setTimeout(() => {
      if (!this.closed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }, opts.forceAfterMs).unref?.();
  }

  private attachProcess(process: import("node:child_process").ChildProcess): void {
    process.stdout?.on("data", (chunk: Buffer) => {
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
    });

    process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.events.emit("stderr", text);
    });

    process.on("error", (err) => {
      this.events.emit("error", err);
    });

    process.on("exit", (code, signal) => {
      this.events.emit("exit", {
        code,
        signal,
        reason: this.requestedStopReason ? "requested" : "runtime_exit",
      } satisfies RuntimeExitInfo);
    });

    process.on("close", (code, signal) => {
      this.events.emit("close", {
        code,
        signal,
        reason: this.requestedStopReason ? "requested" : "runtime_exit",
      } satisfies RuntimeExitInfo);
    });
  }
}

export function createChildProcessRuntimeSession(driver: RuntimeDriver, ctx: SpawnContext): RuntimeSession {
  return new ChildProcessRuntimeSession(driver, ctx);
}
