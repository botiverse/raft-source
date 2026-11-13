// A command that can stop and ask is plain straight-line code over two calls,
// `ctx.step` and `ctx.ask`. Whether a call runs, replays or pauses is the
// runtime's business (runtime.ts), not the command's.

import type { MaybePromise } from "../maybePromise";
import type { JsonValue } from "../jsonValue";
import type { Answer, AskSpec, StepFailure } from "./record";

export type StepIdempotency = { idempotencyKey: string };

export type StepOptions = {
  /**
   * The step only reads: nothing outside changes when it runs (default
   * false: it may write). It only changes what the agent is told when a
   * continuation can't be resumed (expired, a different program version, a
   * command it no longer has, a replay that diverged): while every step
   * before the question was read-only, the agent gets the command to run
   * again; once one may have written, a command to check instead, since
   * running again starts a new chain with new idempotency keys. The runtime
   * cannot verify it. A step marked read-only that does write may write twice
   * after such a rerun.
   */
  readOnly?: boolean;
};

/**
 * Ids are fixed per call site and unique within a command. The command must
 * do the same thing on every replay: anything that reads or writes outside
 * state, the clock or randomness included, goes inside a step.
 */
export interface ContinuationContext {
  /**
   * Run `fn` once per continuation chain and journal its result; a replay
   * returns the journaled result without calling it. A crash after the write
   * but before the journal entry runs `fn` again with the same
   * `idempotencyKey`. And a step that alone outlasts the run lease
   * (CONTINUATION_RUN_LEASE_MS) can be taken over and run a second time,
   * concurrently. So every step with a side effect must pass `idempotencyKey`
   * to the external service, which drops the duplicate.
   *
   * When `fn` throws, the command gets a ContinuationStepError, the first
   * time and on every replay, so a command that catches it takes the same
   * path both times. A failure the command lets escape is not kept: a retry
   * of the continuation runs the step again. To ask and then try again, use
   * a new step id (`send#2`); a replayed id gives back its journaled outcome,
   * failure included, and ids are unique within a command.
   *
   * A step counts as a write unless `options.readOnly` says it only reads
   * (StepOptions: what that changes, and what it costs when wrong).
   */
  step<T extends JsonValue>(id: string, fn: (idempotency: StepIdempotency) => MaybePromise<T>, options?: StepOptions): Promise<T>;
  /**
   * Ask the agent. The first time, the command stops here (the call throws an
   * internal signal; do not swallow it) and the caller gets a continuation;
   * when the continuation is answered, this returns the answer.
   */
  ask(id: string, spec: AskSpec): Promise<Answer>;
}

/**
 * A step's function threw. Built only from what the journal keeps (the
 * error's name, message and code), so a replay throws the same thing.
 * `cause` holds the original error on the first run only, for diagnostics:
 * never branch on it.
 */
export class ContinuationStepError extends Error {
  readonly stepId: string;
  readonly failure: StepFailure;

  constructor(stepId: string, failure: StepFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "ContinuationStepError";
    this.stepId = stepId;
    this.failure = failure;
  }
}

export interface CommandDefinition<Args extends JsonValue = JsonValue, Result extends JsonValue = JsonValue> {
  /** How the program names the command (e.g. "message send"); a resumed record finds its command by it. */
  readonly name: string;
  run(ctx: ContinuationContext, args: Args): Promise<Result>;
}

export function defineCommand<Args extends JsonValue, Result extends JsonValue>(
  name: string,
  run: (ctx: ContinuationContext, args: Args) => Promise<Result>,
): CommandDefinition<Args, Result> {
  return { name, run };
}
