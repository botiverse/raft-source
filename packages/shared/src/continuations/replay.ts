// Running a command over a journal. Up to the journal's end, ctx.step returns
// the journaled result without calling its function and ctx.ask the
// journaled answer; past it, steps run and are journaled, and an ask stops
// the run. A call whose kind or id differs from the journal entry at its
// position stops the run as diverged: the command no longer does what the
// journal recorded.

import type { MaybePromise } from "../maybePromise";
import { cloneJson, type JsonValue } from "../jsonValue";
import { assertAskSpec } from "./answer";
import { ContinuationStepError, type CommandDefinition, type ContinuationContext, type StepIdempotency, type StepOptions } from "./command";
import { stepIdempotencyKey } from "./id";
import type { Answer, AskSpec, ContinuationId, JournalEntry, StepFailure } from "./record";

export type CallRef = { kind: JournalEntry["kind"]; id: string };

export type RunOutcome<Result> =
  | { kind: "returned"; result: Result }
  /** The command asked something the journal holds no answer for. */
  | { kind: "paused"; askId: string; spec: AskSpec }
  /** `actual` is null when the command returned before reaching the journal's end. */
  | { kind: "diverged"; position: number; expected: CallRef; actual: CallRef | null }
  /** `onProgress` reported that another run took the record over. */
  | { kind: "lost" }
  /** `onProgress` threw: the store failed. The command never sees this error. */
  | { kind: "store_failed"; error: unknown };

type Stop = Exclude<RunOutcome<never>, { kind: "returned" }>;

export type ReplayOptions = {
  rootId: ContinuationId;
  journal: readonly JournalEntry[];
  /**
   * Called with the whole journal before a new step runs and after it is
   * journaled: the runner stores it and renews its lease. False stops the run
   * as lost, a throw as store_failed; the step's function does not run.
   */
  onProgress(journal: readonly JournalEntry[]): Promise<boolean>;
};

/** Unwinds the command when the run stops; `replay` catches it. */
class RunStopped extends Error {
  constructor() {
    super("continuation run stopped (paused, diverged, taken over, or its store failed); rethrow it, do not handle it");
  }
}

/** A bug in how the command calls ctx; never journaled as a step failure. */
class ContinuationUsageError extends Error {}

/** Only the error's name, message and code: a stack or a thrown body could carry content. */
function stepFailureOf(error: unknown): StepFailure {
  if (!(error instanceof Error)) return { name: "Error", message: "a non-Error value was thrown" };
  const code = (error as { code?: unknown }).code;
  return { name: error.name, message: error.message, ...(typeof code === "string" ? { code } : {}) };
}

export async function replay<Args extends JsonValue, Result extends JsonValue>(
  def: CommandDefinition<Args, Result>,
  args: Args,
  options: ReplayOptions,
): Promise<{ outcome: RunOutcome<Result>; journal: JournalEntry[] }> {
  const journal = [...options.journal];
  const replayLength = journal.length;
  const usedIds = new Set<string>();
  let position = 0;
  let stepRunning = false;
  let stopped: Stop | undefined;

  const stop = (reason: Stop): never => {
    stopped = reason;
    throw new RunStopped();
  };

  const progress = async (): Promise<void> => {
    let kept: boolean;
    try {
      kept = await options.onProgress(journal);
    } catch (error) {
      return stop({ kind: "store_failed", error });
    }
    if (!kept) stop({ kind: "lost" });
  };

  // The journal entry this call replays, or undefined past the journal's end.
  const enter = (kind: CallRef["kind"], id: string): JournalEntry | undefined => {
    // A command that swallowed the stop is stopped again on its next call.
    if (stopped) throw new RunStopped();
    // Concurrent calls would journal in completion order, not call order.
    if (stepRunning) throw new ContinuationUsageError(`continuation call "${id}" in ${def.name} started while a step was running`);
    if (usedIds.has(id)) throw new ContinuationUsageError(`continuation call id "${id}" is used twice in ${def.name}`);
    usedIds.add(id);
    const at = position++;
    if (at >= replayLength) return undefined;
    const entry = journal[at];
    if (entry.kind !== kind || entry.id !== id) {
      stop({ kind: "diverged", position: at, expected: { kind: entry.kind, id: entry.id }, actual: { kind, id } });
    }
    return entry;
  };

  const ctx: ContinuationContext = {
    async step<T extends JsonValue>(id: string, fn: (idempotency: StepIdempotency) => MaybePromise<T>, stepOptions?: StepOptions): Promise<T> {
      const entry = enter("step", id);
      // Kept only when declared: an entry without it may have written.
      const readOnly = stepOptions?.readOnly === true ? { readOnly: true as const } : {};
      if (entry?.kind === "step") {
        if (entry.error) throw new ContinuationStepError(id, entry.error);
        return cloneJson(entry.result as T);
      }
      // A step can take long: renew the lease before it starts, not only after.
      await progress();
      stepRunning = true;
      let value: T;
      try {
        value = await fn({ idempotencyKey: stepIdempotencyKey(options.rootId, id) });
      } catch (error) {
        if (error instanceof RunStopped || error instanceof ContinuationUsageError) throw error;
        const failure = stepFailureOf(error);
        // Stored with the command's next call or outcome. A failure the
        // command lets escape is never stored, so a retry runs the step again.
        journal.push({ kind: "step", id, error: failure, ...readOnly });
        throw new ContinuationStepError(id, failure, { cause: error });
      } finally {
        stepRunning = false;
      }
      const result = cloneJson(value);
      journal.push({ kind: "step", id, result, ...readOnly });
      await progress();
      return cloneJson(result);
    },
    async ask(id: string, spec: AskSpec): Promise<Answer> {
      const entry = enter("ask", id);
      if (entry?.kind === "ask") return { ...entry.answer };
      assertAskSpec(id, spec);
      return stop({ kind: "paused", askId: id, spec: cloneJson(spec) });
    },
  };

  try {
    const result = await def.run(ctx, cloneJson(args));
    if (stopped) return { outcome: stopped, journal };
    if (position < replayLength) {
      const entry = journal[position];
      return { outcome: { kind: "diverged", position, expected: { kind: entry.kind, id: entry.id }, actual: null }, journal };
    }
    return { outcome: { kind: "returned", result: cloneJson(result) }, journal };
  } catch (error) {
    if (stopped) return { outcome: stopped, journal };
    throw error;
  }
}
