import { ambientProcessEnv } from "../processEnvPatch";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { logger } from "../logger";
import { raiseRuntimeOomScore } from "./oomScore";
import { AGENT_STOP_KILL_GRACE_MS } from "./processStop";
import { defaultProcessTreeOps } from "./processTree";

/**
 * Task #366. A runtime child can report its end before anyone listens:
 *  - a spawn failure (EACCES, ENOENT) arrives as `error` on a later tick, and
 *    whether RuntimeSession has attached by then depends on how the driver
 *    awaited after creating the child (spawnErrorListenerOrder.test.ts);
 *  - a child that exits before reading stdin turns the driver's prompt write,
 *    or any later stdin write, into an EPIPE `error` on `stdin`.
 * An `error` with no listener is thrown by Node and takes the daemon down.
 *
 * So the listener is attached where the child is created. Until the session
 * takes over, stdout/stderr chunks, `error`, `exit` and `close` are recorded
 * in arrival order; the session replays them through its own handlers, so
 * nothing that happened in the gap is lost, reordered or reported twice.
 * Output has to be captured too: when a child exits, Node resumes any stdio
 * stream nobody reads and its buffered output is discarded, so a child that
 * printed its last line and exited before the hand-off would lose it.
 * Holding is bounded: a child not taken over in time, or one that prints more
 * than the cap first, is abandoned (output dropped, process terminated).
 * Stdin errors are held the same way and never thrown: the process's own
 * exit/close is what ends the session.
 */

export type EarlyChildEvent =
  | { kind: "stdout"; chunk: Buffer }
  | { kind: "stderr"; chunk: Buffer }
  | { kind: "error"; error: Error }
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "close"; code: number | null; signal: NodeJS.Signals | null };

interface EarlyChildRecorder {
  events: EarlyChildEvent[];
  stdinErrors: Error[];
  abandoned: string | null;
  release(): void;
}

const recorders = new WeakMap<ChildProcess, EarlyChildRecorder>();

/**
 * Every driver hands its child over synchronously after creating it, so a
 * child still not taken over after this long never will be: it is a runtime
 * process nobody manages. It is abandoned (see below).
 */
const ORPHAN_AFTER_MS = 10_000;

/**
 * Output held for a session that has not taken over yet. A real hand-off
 * happens within the same tick or a few, so only a child nobody takes over
 * can reach this; reaching it abandons the child rather than truncating
 * output and still replaying it as complete.
 */
const MAX_EARLY_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Reconciler step 5: a runtime child leads its own process group on POSIX
 * (`detached`, never unref'd: stdio and exit tracking are unchanged), so a
 * stop's SIGKILL reaches everything it started in one signal (MCP servers,
 * tool shells), not only the runtime. It also leaves the terminal's job
 * control: a Ctrl-C reaches the daemon only, which stops its agents itself.
 * Windows has no groups (and a detached child there gets its own console):
 * `taskkill /T /F` walks the tree instead.
 */
export function runtimeChildProcessGroupOptions(platform: NodeJS.Platform = process.platform): Pick<SpawnOptions, "detached"> {
  return { detached: platform !== "win32" };
}

/** `spawn()` for runtime children: the child is guarded before it is returned. */
export function spawnRuntimeChild(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  // Never inherit a Pi session-create patch in flight (task #28).
  const child = spawn(command, args, { ...runtimeChildProcessGroupOptions(), ...options, env: options.env ?? ambientProcessEnv() });
  guardRuntimeChild(child, { killTree: (pid) => defaultProcessTreeOps.forceKill(pid, { descendants: [], rootLeadsGroup: runtimeChildProcessGroupOptions().detached === true }) });
  // Linux: under memory exhaustion the kernel kills this runtime (and the
  // tools it starts) before the Computer service (#triage:#169).
  raiseRuntimeOomScore(child.pid);
  return child;
}

/** Attach the recording listeners. Idempotent. `killTree` ends an abandoned child's tree (its group); the child alone by default. */
export function guardRuntimeChild(child: ChildProcess, deps: { killTree?: (pid: number) => void } = {}): void {
  if (recorders.has(child)) return;
  const events: EarlyChildEvent[] = [];
  const stdinErrors: Error[] = [];
  const describe = (error: Error) => (error as NodeJS.ErrnoException).code ?? error.name;
  let heldOutputBytes = 0;
  let abandonedReason: string | null = null;

  const onError = (error: Error) => {
    events.push({ kind: "error", error });
    if (abandonedReason) logger.warn(`[RuntimeChild pid=${child.pid ?? "none"}] error on an abandoned runtime child: ${describe(error)}`);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => events.push({ kind: "exit", code, signal });
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => events.push({ kind: "close", code, signal });
  const onStdinError = (error: Error) => {
    // Kept only until a hand-off; an abandoned child's stdin errors are just absorbed.
    if (!abandonedReason) stdinErrors.push(error);
  };
  const onStdout = (chunk: Buffer) => holdOutput("stdout", chunk);
  const onStderr = (chunk: Buffer) => holdOutput("stderr", chunk);

  /**
   * Stop holding anything for a child that will not be handed over: drop its
   * output listeners and buffered output (Node then discards further output
   * itself), keep the error/exit/close listeners until it is gone so nothing is
   * thrown, and terminate it. A late hand-off, if one ever came, is told the
   * child was abandoned instead of being given a partial replay.
   */
  const abandon = (reason: string) => {
    if (abandonedReason) return;
    abandonedReason = reason;
    clearTimeout(orphanTimer);
    child.stdout?.off?.("data", onStdout);
    child.stderr?.off?.("data", onStderr);
    child.stdout?.resume?.();
    child.stderr?.resume?.();
    const kept = events.filter((event) => event.kind !== "stdout" && event.kind !== "stderr");
    events.length = 0;
    events.push(...kept);
    heldOutputBytes = 0;
    const errors = kept.filter((event): event is Extract<EarlyChildEvent, { kind: "error" }> => event.kind === "error");
    const exited = kept.some((event) => event.kind === "exit");
    logger.warn(
      `[RuntimeChild pid=${child.pid ?? "none"}] abandoning a runtime child no session took over: ${reason}`
        + ` (errors=${errors.map((event) => describe(event.error)).join(",") || "none"}, exited=${exited})`,
    );
    if (exited) return;
    try {
      child.kill?.("SIGTERM");
    } catch {
      // Already gone.
    }
    // The same grace and tree kill as every other stop (reconciler step 5).
    const killTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          if (typeof child.pid === "number") deps.killTree?.(child.pid);
        } catch {
          // Already gone.
        }
        try {
          child.kill?.("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }, AGENT_STOP_KILL_GRACE_MS);
    killTimer.unref?.();
  };

  function holdOutput(kind: "stdout" | "stderr", chunk: Buffer) {
    if (abandonedReason) return;
    if (heldOutputBytes + chunk.length > MAX_EARLY_OUTPUT_BYTES) {
      abandon(`output before hand-off exceeded ${MAX_EARLY_OUTPUT_BYTES} bytes`);
      return;
    }
    heldOutputBytes += chunk.length;
    events.push({ kind, chunk });
  }

  child.stdout?.on?.("data", onStdout);
  child.stderr?.on?.("data", onStderr);
  child.on("error", onError);
  child.on("exit", onExit);
  child.on("close", onClose);
  // Test doubles may give a stdin without `on`.
  child.stdin?.on?.("error", onStdinError);
  const orphanTimer = setTimeout(() => abandon(`not taken over within ${ORPHAN_AFTER_MS}ms`), ORPHAN_AFTER_MS);
  orphanTimer.unref?.();

  const recorder: EarlyChildRecorder = {
    events,
    stdinErrors,
    get abandoned() {
      return abandonedReason;
    },
    release: () => {
      clearTimeout(orphanTimer);
      child.stdout?.off?.("data", onStdout);
      child.stderr?.off?.("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.stdin?.off?.("error", onStdinError);
    },
  };
  recorders.set(child, recorder);
}

/**
 * Hand the child to its owner: returns what happened before the owner
 * listened and removes the recorders. `abandoned` is set when the recorder
 * already gave the child up; its output is then gone and the owner must treat
 * the start as failed rather than replay it as complete. Call only after the owner's own
 * listeners are attached, so no event can fall between the two. Returns null
 * for a child that was never guarded.
 */
export function takeEarlyChildEvents(
  child: ChildProcess,
): { events: EarlyChildEvent[]; stdinErrors: Error[]; abandoned: string | null } | null {
  const recorder = recorders.get(child);
  if (!recorder) return null;
  recorders.delete(child);
  recorder.release();
  return { events: recorder.events, stdinErrors: recorder.stdinErrors, abandoned: recorder.abandoned };
}
