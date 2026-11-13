// Commands that stop to ask the agent something, in the raft CLI: the
// continuation runtime (shared/src/continuations) over the agent's ledger
// (state/continuationStore.ts).
//
// A command that can pause runs through `runContinuable`: it either finishes
// (its output, exit 0) or prints the question with a `cont <id> …` line per
// answer and exits CONTINUATION_PAUSED_EXIT_CODE (10). The agent answers with
// `cont <id> [choice]`, text on stdin; the daemon's `cont` wrapper runs
// `raft __continue` (./continue.ts), which lands in `answerContinuation`: the
// original command replays to its result (exit 0), pauses again (exit 10), or
// the answer is refused with one paragraph and the next command on stderr
// (exit 1). Every command `cont` can resume is in the table passed here
// (./_commands.ts); each brings the two lines a refusal may need (`rerun`,
// `check`), so the refusal text never has to show the command's arguments.
//
// The rules on steps (command.ts in shared) hold here: a step with a side
// effect passes its `idempotencyKey` to the server, because a run that
// outlasts its lease can be taken over and the step run twice.

import type { Readable } from "node:stream";

import type { ContinuationRefusalView } from "@botiverse/raft-shared/src/agentText/continuations";
import {
  CONTINUATION_PAUSED_EXIT_CODE,
  ContinuationStepError,
  DEFAULT_CONTINUATION_RESULT_RETENTION_MS,
  DEFAULT_CONTINUATION_TTL_MS,
  journalMayHaveTakenEffect,
  parseContinuationId,
  resume,
  start,
  type Answer,
  type CommandDefinition,
  type ContinuationError,
  type ContinuationProgram,
  type ContinuationRecord,
  type ContinuationStore,
  type JsonValue,
  type MaybePromise,
  type PausedContinuation,
} from "@botiverse/raft-shared/src/continuations/index";

import type { CommandContext } from "../../core/context";
import { CliError, CliExit } from "../../core/errors";
import { NL, writeText, type CliReplyText } from "../../core/renderer";
import { createCliContinuationStore } from "../../state/continuationStore";
import { readCliVersion } from "../../version";
import { formatContinuationPausedOutput, formatContinuationRefusalOutput } from "./_format";
import {
  emitContinuationAnswered,
  emitContinuationCreated,
  emitContinuationRefused,
  type ContinuationTraceScope,
} from "./_trace";

/** How long `cont` waits for stdin to start before taking the answer as having no text (as `--send-draft` does). */
const CONTINUATION_STDIN_WINDOW_MS = 1_000;

/** A command `cont` can resume, with what the CLI prints for it. */
export interface CliContinuationCommand<Args extends JsonValue = JsonValue, Result extends JsonValue = JsonValue> {
  readonly definition: CommandDefinition<Args, Result>;
  /**
   * The original command line, to run again from scratch: what it read from
   * stdin is a placeholder, never the content (`raft message send --target
   * "#x" <<'RAFTMSG'`, `<your message>`, `RAFTMSG`).
   */
  rerun(args: Args): string;
  /**
   * A read-only command that shows whether the command already took effect
   * (`raft message read --target "#x"`), with no content either: it is also
   * rendered when a run starts and kept a day on the tombstone, so
   * RESULT_EXPIRED can name it after the record is gone. `args` is undefined
   * only for a tombstone that has no line: render a placeholder then.
   */
  check(args: Args | undefined): string;
  /** What the original call prints when it finishes. */
  renderResult(result: Result): CliReplyText;
  /**
   * Runs once the paused text has been written: what the command records only
   * after the agent was shown it (a card it has now seen).
   */
  onPaused?(): Promise<void>;
  /** Extra attrs on this command's `cli.continuation.created` spans: ids and flags only, never content. */
  readonly createdSpanAttrs?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * What a command is run for: its first run, or an answer to continuation
 * `id` (so a step can tell the agent the exact `cont` to run again).
 */
export type ContinuationInvocation = {
  answering: { id: string; choice: string | undefined; withInput: boolean } | null;
};

/**
 * How the table holds a command: as it is, or built for each invocation when
 * its steps need the invocation's context (its agent, API client and output).
 */
export type CliContinuationCommandSource =
  | CliContinuationCommand
  | ((ctx: CommandContext, invocation: ContinuationInvocation) => CliContinuationCommand);

const bindCommands = (
  ctx: CommandContext,
  sources: readonly CliContinuationCommandSource[],
  invocation: ContinuationInvocation,
): CliContinuationCommand[] => sources.map((source) => (typeof source === "function" ? source(ctx, invocation) : source));

export function defineCliContinuationCommand<Args extends JsonValue, Result extends JsonValue>(
  command: CliContinuationCommand<Args, Result>,
): CliContinuationCommand<Args, Result> {
  return command;
}

/** What `runContinuable` and `cont` run with; every field defaults for production (test seams). */
export interface CliContinuationOptions {
  /** Every command `cont` can resume. Default: CLI_CONTINUATION_COMMANDS. */
  commands?: readonly CliContinuationCommandSource[];
  /** The agent's store. Default: its ledger. */
  store?: (agentId: string, env: NodeJS.ProcessEnv) => ContinuationStore;
  /** Default: this CLI, `raft` at its package version. */
  program?: ContinuationProgram;
  now?: () => number;
  /** How long to wait for stdin to start. Default: 1 s. */
  stdinWindowMs?: number;
}

/** The store could not read or write; the runtime's own refusals are data, not this. */
class ContinuationStoreFailure extends Error {
  constructor(readonly operation: "read" | "write", options: ErrorOptions) {
    super(`continuation store ${operation} failed`, options);
    this.name = "ContinuationStoreFailure";
  }
}

/**
 * What the store saw this call, to tell a failure after which no step can
 * have run from one after which a step may have.
 * - `runStarted`: a run's tombstone was written. The runtime writes it before
 *   anything else of a run (shared runtime.ts `run`), so before it no step of
 *   this call ran; after it one may have.
 * - `unsavedPause`: the record a failed `put` was saving. A command's first
 *   run stores nothing until it pauses, so its journal says which steps ran.
 */
interface StoreTrace {
  runStarted: boolean;
  unsavedPause?: ContinuationRecord;
}

function guardStore(store: ContinuationStore, trace: StoreTrace): ContinuationStore {
  const guard = <A extends unknown[], R>(operation: "read" | "write", fn: (...args: A) => MaybePromise<R>, onFailure?: (...args: A) => void) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (cause) {
        onFailure?.(...args);
        throw new ContinuationStoreFailure(operation, { cause });
      }
    };
  return {
    put: guard("write", (record) => store.put(record), (record) => { trace.unsavedPause = record; }),
    get: guard("read", (id) => store.get(id)),
    update: guard("write", (record, expectedRevision) => store.update(record, expectedRevision)),
    delete: guard("write", (id) => store.delete(id)),
    putTombstone: guard("write", async (tombstone) => {
      await store.putTombstone(tombstone);
      trace.runStarted = true;
    }),
    getTombstone: guard("read", (id) => store.getTombstone(id)),
    deleteExpired: guard("write", (now) => store.deleteExpired(now)),
  };
}

/** Whether `error` is a continuation's refusal (rendered as is), not a failure of the command around it. */
export function isContinuationRefusal(error: unknown): boolean {
  return error instanceof ContinuationRefusedError;
}

/** A refused answer: its paragraph goes to stderr as is, the CLI's usual failure exit. */
class ContinuationRefusedError extends CliError {
  readonly machinePayload: { ok: false; error: { code: string; message: string } };
  readonly typedText: CliReplyText;

  constructor(code: string, text: CliReplyText) {
    super({ code: code === "STORE_FAILED" ? "CONTINUATION_STORE_FAILED" : "CONTINUATION_REFUSED", message: text });
    this.name = "ContinuationRefusedError";
    this.machinePayload = { ok: false, error: { code, message: text } };
    this.typedText = text;
  }
}

interface Session {
  io: CommandContext["io"];
  store: ContinuationStore;
  storeTrace: StoreTrace;
  commands: readonly CliContinuationCommand[];
  runtime: {
    store: ContinuationStore;
    ownerAgentId: string;
    program: ContinuationProgram;
    ttlMs: number;
    resultRetentionMs: number;
    now?: () => number;
  };
  now: () => number;
  trace: ContinuationTraceScope;
}

function openSession(ctx: CommandContext, options: CliContinuationOptions | undefined, commands: readonly CliContinuationCommand[]): Session {
  const agentContext = ctx.loadAgentContext();
  const storeTrace: StoreTrace = { runStarted: false };
  const store = guardStore((options?.store ?? createCliContinuationStore)(agentContext.agentId, ctx.env), storeTrace);
  return {
    io: ctx.io,
    store,
    storeTrace,
    commands,
    runtime: {
      store,
      ownerAgentId: agentContext.agentId,
      program: options?.program ?? { name: "raft", version: readCliVersion() },
      ttlMs: DEFAULT_CONTINUATION_TTL_MS,
      resultRetentionMs: DEFAULT_CONTINUATION_RESULT_RETENTION_MS,
      ...(options?.now ? { now: options.now } : {}),
    },
    now: options?.now ?? Date.now,
    trace: { agentId: agentContext.agentId, serverId: agentContext.serverId, env: ctx.env },
  };
}

function refuse(session: Session, view: ContinuationRefusalView, trace: { id: string | undefined; invalidAnswerCategory?: string }): never {
  emitContinuationRefused(session.trace, { id: trace.id, code: view.code, invalidAnswerCategory: trace.invalidAnswerCategory });
  throw new ContinuationRefusedError(view.code, formatContinuationRefusalOutput(view));
}

type StoreFailedView = Extract<ContinuationRefusalView, { code: "STORE_FAILED" }>;

/**
 * Run `fn`; a store failure becomes the store_failed refusal `describe` gives
 * for it. A step's own failure that the command let escape comes out of the
 * runtime as a ContinuationStepError; the CLI renders the error the step
 * threw (a send's CliError with its code and next action), as the command
 * would have without continuations.
 */
async function orStoreFailed<T>(session: Session, describe: (operation: "read" | "write") => StoreFailedView, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ContinuationStepError && error.cause !== undefined) throw error.cause;
    if (!(error instanceof ContinuationStoreFailure)) throw error;
    const view = describe(error.operation);
    return refuse(session, view, { id: view.id ?? undefined });
  }
}

/** A hook's line, or null when it cannot render these args. */
function safeLine(render: () => string): string | null {
  try {
    return render();
  } catch {
    return null;
  }
}

async function pause(
  session: Session,
  continuation: PausedContinuation,
  chain: { rootId: string; command: string },
  entry: CliContinuationCommand | undefined,
): Promise<never> {
  writeText(session.io, formatContinuationPausedOutput({ id: continuation.id, ask: continuation.ask, expiresAt: continuation.expiresAt }), NL);
  emitContinuationCreated(session.trace, {
    id: continuation.id,
    rootId: chain.rootId,
    command: chain.command,
    ask: continuation.ask,
    expiresInMs: continuation.ask.expiresInMs ?? session.runtime.ttlMs,
    ...(entry?.createdSpanAttrs ? { extra: entry.createdSpanAttrs } : {}),
  });
  await entry?.onPaused?.();
  throw new CliExit(CONTINUATION_PAUSED_EXIT_CODE);
}

/**
 * Run a command that may pause. Done: its result as `entry` renders it.
 * Paused: the question and how to answer it, then exit 10 (CliExit).
 */
export async function runContinuable<Args extends JsonValue, Result extends JsonValue>(
  ctx: CommandContext,
  options: CliContinuationOptions | undefined,
  entry: CliContinuationCommand<Args, Result>,
  args: Args,
): Promise<void> {
  const session = openSession(ctx, options, bindCommands(ctx, options?.commands ?? [], { answering: null }));
  // The question could not be saved, so the agent has no continuation: the
  // steps before it (all in its journal) ran, and if none of them may have
  // written (none ran, or all were declared read-only), nothing was done.
  const unsaved = (operation: "read" | "write"): StoreFailedView => {
    const stepsMayHaveWritten = journalMayHaveTakenEffect(session.storeTrace.unsavedPause?.journal);
    return {
      code: "STORE_FAILED", id: null, operation, mayHaveTakenEffect: stepsMayHaveWritten,
      rerun: safeLine(() => entry.rerun(args)), check: safeLine(() => entry.check(args)),
    };
  };
  const outcome = await orStoreFailed(session, unsaved, () => start(entry.definition, { ...session.runtime, args }));
  if (outcome.kind === "done") {
    writeText(ctx.io, entry.renderResult(outcome.result));
    return;
  }
  await pause(session, outcome.continuation, { rootId: outcome.continuation.id, command: entry.definition.name }, entry);
}

/** Read the answer's text from stdin: none on a terminal, nothing that has not started within the window, else all of it. */
async function readAnswerText(stream: NodeJS.ReadableStream | undefined, windowMs: number): Promise<string | undefined> {
  const input = stream as (Readable & { isTTY?: boolean }) | undefined;
  if (!input || input.isTTY || input.readableEnded) return undefined;
  input.setEncoding("utf8");
  return new Promise<string | undefined>((resolve, reject) => {
    let text = "";
    let started = false;
    const finish = (): void => {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    const onData = (chunk: string): void => {
      started = true;
      text += chunk;
    };
    const onEnd = (): void => {
      finish();
      resolve(text);
    };
    const onError = (error: Error): void => {
      finish();
      reject(error);
    };
    // An open pipe nobody writes to (a harness that keeps stdin open): no text.
    const timer = setTimeout(() => {
      if (started) return;
      finish();
      input.on("error", () => {});
      input.pause();
      resolve(undefined);
    }, windowMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

/** An id as typed, for saying it is not one: on one line, short. */
function typedId(raw: string): string {
  const flat = raw.trim().replace(/\s+/g, " ");
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

/** A command's line from its hook, or null when the program does not know the command or the hook cannot render these args. */
function hookLine(session: Session, command: string | undefined, render: (entry: CliContinuationCommand) => string): string | null {
  const entry = command === undefined ? undefined : session.commands.find((candidate) => candidate.definition.name === command);
  if (!entry) return null;
  try {
    return render(entry);
  } catch {
    return null;
  }
}

/** The refusal as the agent reads it: no args, no answer text. */
function refusalView(session: Session, error: ContinuationError, typedChoice: string | undefined): ContinuationRefusalView {
  switch (error.code) {
    case "UNKNOWN":
    case "NOT_YOURS":
    case "IN_PROGRESS":
      return { code: error.code, id: error.id };
    case "EXPIRED":
      return {
        code: "EXPIRED", id: error.id, createdAt: error.createdAt, expiresAt: error.expiresAt,
        mayHaveTakenEffect: error.mayHaveTakenEffect,
        rerun: hookLine(session, error.command, (entry) => entry.rerun(error.args)),
        check: error.check,
      };
    case "RESULT_EXPIRED":
      return {
        code: "RESULT_EXPIRED", id: error.id, retentionMs: session.runtime.resultRetentionMs,
        // The line kept on the tombstone names the exact command; without one, the command's placeholder form.
        check: error.check ?? hookLine(session, error.command, (entry) => entry.check(undefined)),
      };
    // `check` comes from the runtime when an answer may have taken effect: the
    // command's own line (checkLine below), else the one a tombstone of the chain kept.
    case "PROGRAM_CHANGED":
    case "REPLAY_DIVERGED":
      return {
        code: error.code, id: error.id, mayHaveTakenEffect: error.mayHaveTakenEffect,
        rerun: hookLine(session, error.command, (entry) => entry.rerun(error.args)),
        check: error.check,
      };
    case "UNKNOWN_COMMAND":
    case "FORMAT_CHANGED":
      // The program has no command by that name, or the record cannot be read: no rerun line to render.
      return { code: error.code, id: error.id, mayHaveTakenEffect: error.mayHaveTakenEffect, rerun: null, check: error.check };
    case "INVALID_ANSWER":
      return {
        code: "INVALID_ANSWER", id: error.id, category: error.category, ask: error.ask,
        ...(typedChoice === undefined ? {} : { choice: typedChoice }),
      };
    case "ALREADY_ANSWERED":
      return {
        code: "ALREADY_ANSWERED", id: error.id, answeredAt: error.answeredAt,
        previous: { ...(error.previous.choice === undefined ? {} : { choice: error.previous.choice }), withInput: error.previous.input !== undefined },
      };
  }
}

/** Whether this call can be the one that runs the answer: the record had no outcome yet (not done, not paused again). */
const awaitingOutcome = (record: ContinuationRecord | undefined): record is ContinuationRecord =>
  record !== undefined && record.status !== "done" && record.next === undefined;

/**
 * `cont <id> [choice]`, the answer's text on stdin: resume the continuation.
 * Its command finishes (its output, exit 0), pauses again (exit 10), or the
 * answer is refused (stderr, exit 1).
 */
export async function answerContinuation(
  ctx: CommandContext,
  options: CliContinuationOptions | undefined,
  sources: readonly CliContinuationCommandSource[],
  rawId: string,
  choice: string | undefined,
): Promise<void> {
  const id = parseContinuationId(rawId);
  if (id === null) refuse(openSession(ctx, options, []), { code: "UNKNOWN", id: typedId(rawId) }, { id: undefined });

  const text = await readAnswerText(ctx.io.stdin, options?.stdinWindowMs ?? CONTINUATION_STDIN_WINDOW_MS);
  // Empty stdin is no text (`/dev/null` is what Claude Code's Bash gives); the runtime treats blank text the same.
  const answer: Answer = { ...(choice === undefined ? {} : { choice }), ...(text === undefined ? {} : { input: text }) };
  const withInput = typeof text === "string" && text.trim().length > 0;
  const commands = bindCommands(ctx, sources, { answering: { id, choice, withInput } });
  const session = openSession(ctx, options, commands);
  // Read first, for what the spans need: which command, which chain, since when, and whether this call runs the answer.
  let before: ContinuationRecord | undefined;
  // Before this call's run started, no step of it ran: the same `cont` again is safe. After, one may have.
  const unsaved = (operation: "read" | "write"): StoreFailedView => {
    const known = before;
    return {
      code: "STORE_FAILED", id, operation, mayHaveTakenEffect: session.storeTrace.runStarted, rerun: null,
      check: known === undefined ? null : hookLine(session, known.command, (entry) => entry.check(known.args)),
    };
  };
  before = await orStoreFailed(session, unsaved, async () => session.store.get(id));
  const outcome = await orStoreFailed(session, unsaved, () => resume(id, answer, {
    ...session.runtime,
    commands: commands.map((command) => command.definition),
    checkLine: (command, args) => hookLine(session, command, (entry) => entry.check(args)),
  }));

  if (outcome.kind === "error") {
    const { error } = outcome;
    refuse(session, refusalView(session, error, choice), {
      id,
      ...(error.code === "INVALID_ANSWER" ? { invalidAnswerCategory: error.category } : {}),
    });
  }
  if (!before) throw new Error(`continuation ${id} reached an outcome without a record`);
  if (awaitingOutcome(before)) {
    emitContinuationAnswered(session.trace, {
      id,
      rootId: before.rootId,
      command: before.command,
      choice,
      outcome: outcome.kind === "done" ? "done" : "paused_again",
      elapsedMs: session.now() - before.createdAt,
    });
  }
  const entry = commands.find((command) => command.definition.name === before.command);
  if (outcome.kind === "paused") return await pause(session, outcome.continuation, { rootId: before.rootId, command: before.command }, entry);
  if (!entry) throw new Error(`continuation ${id} finished a command this CLI does not have`);
  writeText(ctx.io, entry.renderResult(outcome.result));
}
