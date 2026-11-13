// Starting a command and resuming it with an answer (the replay driver).
//
// `start` runs the command; at its first unanswered `ctx.ask` it stores a
// record (args, journal so far, the ask) and returns a continuation. `resume`
// checks the record and the answer, fixes the answer on the record with a
// conditional update (so two calls can't both run it), and replays the
// command from the start: journaled steps return their results, the ask its
// answer, new steps run and are stored one by one. Another ask pauses again
// under a new record carrying the whole journal; the old one links to it.
//
// A continuation is answered once: the same answer again returns the stored
// outcome without running anything; another answer is ALREADY_ANSWERED. The
// ask deadline (`expiresAt`, 10 minutes by default) only applies while
// pending, and a pending record outlives it by a short grace so a late answer
// is told it expired. Once answered, the record is kept while its run lives
// and for the result retention (30 minutes by default) after its outcome,
// then leaves a content-free tombstone for a day (RESULT_EXPIRED, not UNKNOWN).
// Refusals are data (`code` plus what a renderer needs), never text. Errors
// the command itself throws propagate to the caller.

import { currentTimeMs } from "../clock";
import { cloneJson, type JsonValue } from "../jsonValue";
import { checkAnswer, normalizeAnswer, sameAnswer, type InvalidAnswerCategory } from "./answer";
import type { CommandDefinition } from "./command";
import { newContinuationId } from "./id";
import {
  CONTINUATION_FORMAT_VERSION,
  DEFAULT_CONTINUATION_RESULT_RETENTION_MS,
  DEFAULT_CONTINUATION_TTL_MS,
  type Answer,
  type AskSpec,
  type ContinuationId,
  type ContinuationProgram,
  type ContinuationRecord,
  type ContinuationTombstone,
  journalMayHaveTakenEffect,
  type JournalEntry,
} from "./record";
import { replay, type CallRef } from "./replay";
import type { ContinuationStore } from "./store";

/**
 * How long an answered run may go without writing before a retry with the
 * same answer takes it over (its process is presumed dead). A takeover of a
 * run that was only slow is safe: its steps' external writes carry the same
 * idempotency keys, and its next write fails.
 */
export const CONTINUATION_RUN_LEASE_MS = 30 * 1000;

/** How long a tombstone outlives its record (`deleteAfter`): a day of telling RESULT_EXPIRED from UNKNOWN. */
export const CONTINUATION_TOMBSTONE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a pending record outlives its answer deadline before a sweep may
 * delete it. Any command's start sweeps; without the grace, an answer a moment
 * late would find nothing (UNKNOWN) instead of being told it expired, with
 * the command to run again (EXPIRED).
 */
export const CONTINUATION_EXPIRY_GRACE_MS = 2 * 60 * 1000;

export type PausedContinuation = { id: ContinuationId; ask: AskSpec; expiresAt: number };

export type ContinuationOutcome<Result extends JsonValue = JsonValue> =
  | { kind: "done"; result: Result }
  | { kind: "paused"; continuation: PausedContinuation };

type PausedOutcome = Extract<ContinuationOutcome, { kind: "paused" }>;

/**
 * Why a continuation was not resumed. `command` and `args` let a renderer say
 * what to run again. `args` and an answer's `input` may hold content such as
 * a draft body: show them to the agent, never log or trace them.
 *
 * `mayHaveTakenEffect`, on the refusals that would otherwise send the agent
 * to run the command again: something in its chain may already have taken
 * effect. Either a step before its question may have written (one not
 * declared read-only, including the first continuation's own steps), an
 * earlier continuation's answer ran (this one paused after it), or a run on
 * this one's own answer started before this call. Running the command again then starts a new
 * chain, with new idempotency keys, and can do a write twice: say what to
 * check instead. `check` is that command (the program's `checkLine`, else
 * the line a tombstone of the chain kept), null when there is none; it is
 * only looked up when `mayHaveTakenEffect` is set.
 */
export type ContinuationError =
  | { code: "UNKNOWN"; id: ContinuationId }
  | { code: "NOT_YOURS"; id: ContinuationId }
  /** The record, or the tombstone left of it, is of another format: not ours to read. */
  | { code: "FORMAT_CHANGED"; id: ContinuationId; recorded: number; current: number; mayHaveTakenEffect: boolean; check: string | null }
  /**
   * Not answered by its deadline; nothing ran on its answer. It paused at
   * `createdAt`, so it had `expiresAt - createdAt` to be answered. An earlier
   * answer in its chain may have (`mayHaveTakenEffect`).
   */
  | {
    code: "EXPIRED";
    id: ContinuationId;
    command: string;
    args: JsonValue;
    createdAt: number;
    expiresAt: number;
    mayHaveTakenEffect: boolean;
    check: string | null;
  }
  /**
   * It was answered, and its record, outcome included, is gone. The answer
   * may already have taken effect: check before running the command again
   * (a new run is a new chain, with new idempotency keys).
   */
  | {
    code: "RESULT_EXPIRED";
    id: ContinuationId;
    rootId: ContinuationId;
    command: string;
    finishedAt: number | null;
    /** The tombstone's `check`: what to run to see whether it took effect; null when it has none. */
    check: string | null;
  }
  | {
    code: "PROGRAM_CHANGED";
    id: ContinuationId;
    command: string;
    args: JsonValue;
    recorded: ContinuationProgram;
    current: ContinuationProgram;
    mayHaveTakenEffect: boolean;
    check: string | null;
  }
  /** The program has no command by the recorded name. */
  | { code: "UNKNOWN_COMMAND"; id: ContinuationId; command: string; mayHaveTakenEffect: boolean; check: string | null }
  | { code: "INVALID_ANSWER"; id: ContinuationId; category: InvalidAnswerCategory; ask: AskSpec }
  /** `answeredAt`: when `previous` was fixed on it (null for a record that does not say). */
  | { code: "ALREADY_ANSWERED"; id: ContinuationId; command: string; args: JsonValue; previous: Answer; answeredAt: number | null }
  /** Another call is running on this continuation's answer; it has no outcome yet. */
  | { code: "IN_PROGRESS"; id: ContinuationId }
  | {
    code: "REPLAY_DIVERGED";
    id: ContinuationId;
    command: string;
    args: JsonValue;
    position: number;
    expected: CallRef;
    /** null: the command returned before reaching the journal's end. */
    actual: CallRef | null;
    /**
     * An earlier answer in the chain ran, or the run that diverged took over
     * an earlier one. A run that claimed the answer itself diverges inside
     * the journal, before any new step: nothing after the question ran. One
     * that took over cannot tell what the run before it did.
     */
    mayHaveTakenEffect: boolean;
    check: string | null;
  };

export type ResumeOutcome = ContinuationOutcome | { kind: "error"; error: ContinuationError };

export type RuntimeOptions = {
  store: ContinuationStore;
  /** The agent running the command; only it can resume what it paused. */
  ownerAgentId: string;
  program: ContinuationProgram;
  /** How long an ask can be answered (an ask's `expiresInMs` wins). Defaults to DEFAULT_CONTINUATION_TTL_MS. */
  ttlMs?: number;
  /**
   * How long an answered continuation keeps its outcome once its run reached
   * one. Defaults to DEFAULT_CONTINUATION_RESULT_RETENTION_MS.
   */
  resultRetentionMs?: number;
  now?: () => number;
  newId?: () => ContinuationId;
};

export type StartOptions<Args extends JsonValue> = RuntimeOptions & { args: Args };

/**
 * Render the command that shows whether a run's answer took effect, from the
 * command's name and arguments; kept on the tombstone (`check`). It outlives
 * the record by a day, so it must hold no content: a target, never a body.
 * Undefined or a throw keeps none.
 */
export type ContinuationCheckLine = (command: string, args: JsonValue) => string | null | undefined;

/**
 * `commands`: every command the program can resume, found by the record's
 * command name. `checkLine`: what the tombstone keeps for RESULT_EXPIRED.
 */
export type ResumeOptions = RuntimeOptions & { commands: readonly CommandDefinition[]; checkLine?: ContinuationCheckLine };

type Env = RuntimeOptions & {
  now: () => number;
  newId: () => ContinuationId;
  ttlMs: number;
  resultRetentionMs: number;
  checkLine?: ContinuationCheckLine;
};

function envOf(options: RuntimeOptions & { checkLine?: ContinuationCheckLine }): Env {
  return {
    ...options,
    now: options.now ?? currentTimeMs,
    newId: options.newId ?? newContinuationId,
    ttlMs: options.ttlMs ?? DEFAULT_CONTINUATION_TTL_MS,
    resultRetentionMs: options.resultRetentionMs ?? DEFAULT_CONTINUATION_RESULT_RETENTION_MS,
  };
}

/** `deleteAfter` while a run holds the answer: the lease, then the retention. */
const runningDeleteAfter = (env: Env): number => env.now() + CONTINUATION_RUN_LEASE_MS + env.resultRetentionMs;

/** The program's check line for this record, or undefined: a failing renderer must not stop the run. */
function checkLineOf(env: Env, record: ContinuationRecord): string | undefined {
  try {
    const line = env.checkLine?.(record.command, cloneJson(record.args));
    return typeof line === "string" && line.length > 0 ? line : undefined;
  } catch {
    return undefined;
  }
}

const tombstoneOf = (record: ContinuationRecord, finishedAt: number | null, check: string | undefined): ContinuationTombstone => ({
  formatVersion: CONTINUATION_FORMAT_VERSION,
  id: record.id,
  rootId: record.rootId,
  ownerAgentId: record.ownerAgentId,
  command: record.command,
  finishedAt,
  deleteAfter: record.deleteAfter + CONTINUATION_TOMBSTONE_MS,
  ...(check === undefined ? {} : { check }),
});

const refuse = (error: ContinuationError): ResumeOutcome => ({ kind: "error", error });

/**
 * Whether anything in this record's chain may already have taken effect: a
 * step before its question that may have written (one not declared
 * read-only, run before the first question too), an earlier continuation's
 * answer (this one is a later link: its journal holds that answer and
 * whatever steps followed it), or this record's own. Read defensively, since
 * it also judges records of another format, where a missing field may only
 * turn the answer into "yes".
 */
function answerRanBefore(record: ContinuationRecord): boolean {
  const { id, rootId, status, journal } = record as Partial<ContinuationRecord>;
  return (typeof rootId === "string" && rootId !== id)
    || status !== "pending"
    || journalMayHaveTakenEffect(journal);
}

/** A run writes the tombstone before anything else (`run`), so one is there once a run on the answer started. */
const answerRan = async (env: Env, id: ContinuationId): Promise<boolean> => (await env.store.getTombstone(id)) !== undefined;

/**
 * What to run to see whether the chain's answers took effect: the program's
 * line from the record's arguments, else the line a tombstone of the chain
 * kept (this record's, or its root's, written when an earlier answer ran).
 * `readable: false` for a record of another format: tombstones only.
 */
async function chainCheck(env: Env, record: ContinuationRecord, readable = true): Promise<string | null> {
  const line = readable ? checkLineOf(env, record) : undefined;
  if (line !== undefined) return line;
  for (const id of new Set([record.id, record.rootId])) {
    if (typeof id !== "string") continue;
    const tombstone = await env.store.getTombstone(id);
    if (tombstone?.formatVersion === CONTINUATION_FORMAT_VERSION && typeof tombstone.check === "string" && tombstone.check.length > 0) {
      return tombstone.check;
    }
  }
  return null;
}

/** `check` for a refusal: looked up only when an answer may have taken effect. */
const checkWhen = (env: Env, record: ContinuationRecord, mayHaveTakenEffect: boolean, readable = true): Promise<string | null> =>
  mayHaveTakenEffect ? chainCheck(env, record, readable) : Promise.resolve(null);

async function expired(env: Env, record: ContinuationRecord): Promise<ResumeOutcome> {
  const mayHaveTakenEffect = answerRanBefore(record);
  return refuse({
    code: "EXPIRED", id: record.id, command: record.command, args: record.args, createdAt: record.createdAt, expiresAt: record.expiresAt,
    mayHaveTakenEffect, check: await checkWhen(env, record, mayHaveTakenEffect),
  });
}

/** No record (or outcome) by this id: an answered one whose outcome is gone, else `otherwise`. */
async function missing(env: Env, id: ContinuationId, otherwise: ResumeOutcome = refuse({ code: "UNKNOWN", id })): Promise<ResumeOutcome> {
  const tombstone = await env.store.getTombstone(id);
  if (!tombstone) return otherwise;
  if (tombstone.ownerAgentId !== env.ownerAgentId) return refuse({ code: "NOT_YOURS", id });
  if (tombstone.formatVersion !== CONTINUATION_FORMAT_VERSION) {
    return refuse({ code: "FORMAT_CHANGED", id, recorded: tombstone.formatVersion, current: CONTINUATION_FORMAT_VERSION, mayHaveTakenEffect: true, check: null });
  }
  return refuse({
    code: "RESULT_EXPIRED", id, rootId: tombstone.rootId, command: tombstone.command, finishedAt: tombstone.finishedAt,
    check: typeof tombstone.check === "string" ? tombstone.check : null,
  });
}

const paused = (record: ContinuationRecord): PausedOutcome => ({
  kind: "paused",
  continuation: { id: record.id, ask: record.pending.spec, expiresAt: record.expiresAt },
});

async function putPaused(
  env: Env,
  fields: { id: ContinuationId; rootId: ContinuationId; command: string; args: JsonValue; journal: JournalEntry[]; askId: string; spec: AskSpec },
): Promise<ContinuationRecord> {
  const { id, rootId, command, args, journal, askId, spec } = fields;
  const now = env.now();
  const expiresAt = now + (spec.expiresInMs ?? env.ttlMs);
  const record: ContinuationRecord = {
    formatVersion: CONTINUATION_FORMAT_VERSION,
    id,
    rootId,
    revision: 0,
    ownerAgentId: env.ownerAgentId,
    program: { name: env.program.name, version: env.program.version },
    command,
    args,
    journal,
    pending: { askId, spec },
    status: "pending",
    createdAt: now,
    expiresAt,
    deleteAfter: expiresAt + CONTINUATION_EXPIRY_GRACE_MS,
  };
  if (!(await env.store.put(record))) throw new Error(`continuation id ${id} is already taken`);
  return record;
}

export async function start<Args extends JsonValue, Result extends JsonValue>(
  def: CommandDefinition<Args, Result>,
  options: StartOptions<Args>,
): Promise<ContinuationOutcome<Result>> {
  const env = envOf(options);
  try {
    await env.store.deleteExpired(env.now());
  } catch {
    // Best-effort: a pending record left behind past its deadline is still refused as EXPIRED.
  }
  const args = cloneJson(options.args);
  // The chain's root id is known before anything runs: steps derive their idempotency keys from it.
  const rootId = env.newId();
  const { outcome, journal } = await replay(def, args, { rootId, journal: [], onProgress: async () => true });
  if (outcome.kind === "returned") return { kind: "done", result: outcome.result };
  // An empty journal cannot diverge, and nothing is stored to lose.
  if (outcome.kind !== "paused") throw new Error(`continuation start of ${def.name} stopped as ${outcome.kind}`);
  const record = await putPaused(env, { id: rootId, rootId, command: def.name, args, journal, askId: outcome.askId, spec: outcome.spec });
  return paused(record);
}

export async function resume(id: ContinuationId, answer: Answer, options: ResumeOptions): Promise<ResumeOutcome> {
  const env = envOf(options);
  const record = await env.store.get(id);
  if (!record) return missing(env, id);
  // Owner first: someone else's id tells them nothing more about the record.
  if (record.ownerAgentId !== env.ownerAgentId) return refuse({ code: "NOT_YOURS", id });
  // Another format (a newer program's, perhaps) is not ours to read or delete.
  if (record.formatVersion !== CONTINUATION_FORMAT_VERSION) {
    const mayHaveTakenEffect = answerRanBefore(record) || await answerRan(env, id);
    return refuse({
      code: "FORMAT_CHANGED", id, recorded: record.formatVersion, current: CONTINUATION_FORMAT_VERSION,
      mayHaveTakenEffect, check: await checkWhen(env, record, mayHaveTakenEffect, false),
    });
  }
  if (record.status === "pending" && env.now() > record.expiresAt) {
    const refusal = await expired(env, record);
    await env.store.delete(id);
    return refusal;
  }
  const mayHaveTakenEffect = answerRanBefore(record);
  // Replaying under other code could go anywhere; the sweep drops the record at its deleteAfter.
  if (record.program.name !== env.program.name || record.program.version !== env.program.version) {
    return refuse({
      code: "PROGRAM_CHANGED", id, command: record.command, args: record.args,
      recorded: record.program, current: { name: env.program.name, version: env.program.version },
      mayHaveTakenEffect, check: await checkWhen(env, record, mayHaveTakenEffect),
    });
  }
  const def = options.commands.find((command) => command.name === record.command);
  if (!def) {
    return refuse({ code: "UNKNOWN_COMMAND", id, command: record.command, mayHaveTakenEffect, check: await checkWhen(env, record, mayHaveTakenEffect) });
  }
  return answerRecord(env, def, record, normalizeAnswer(answer));
}

async function answerRecord(env: Env, def: CommandDefinition, record: ContinuationRecord, answer: Answer): Promise<ResumeOutcome> {
  const { store } = env;
  if (record.status === "pending") {
    const { askId, spec } = record.pending;
    const category = checkAnswer(spec, answer);
    if (category) return refuse({ code: "INVALID_ANSWER", id: record.id, category, ask: spec });
    const claimed: ContinuationRecord = {
      ...record,
      revision: record.revision + 1,
      status: "answered",
      answer,
      answeredAt: env.now(),
      journal: [...record.journal, { kind: "ask", id: askId, answer }],
      heartbeatAt: env.now(),
      deleteAfter: runningDeleteAfter(env),
    };
    // A divergence in this run happens inside the journal, before any new step: only earlier answers can have run.
    if (await store.update(claimed, record.revision)) return run(env, def, claimed, { ranBefore: answerRanBefore(record) });
    // Another call answered first: answer against what it left. Gone: swept past its deadline, or answered and swept.
    const current = await store.get(record.id);
    return current ? answerRecord(env, def, current, answer) : missing(env, record.id, await expired(env, record));
  }

  if (!record.answer || !sameAnswer(record.answer, answer)) {
    return refuse({
      code: "ALREADY_ANSWERED", id: record.id, command: record.command, args: record.args,
      previous: record.answer ?? {}, answeredAt: record.answeredAt ?? null,
    });
  }
  if (record.status === "done") return { kind: "done", result: record.result ?? null };
  if (record.next) {
    // Gone, the next continuation took this answer's outcome with it: the answer took effect up to that ask.
    const next = await store.get(record.next);
    return next ? paused(next) : missing(env, record.id);
  }
  if (record.heartbeatAt !== undefined && env.now() - record.heartbeatAt < CONTINUATION_RUN_LEASE_MS) {
    return refuse({ code: "IN_PROGRESS", id: record.id });
  }
  // The run holding the answer stopped without an outcome (it failed, or its process died): take it over.
  const claimed: ContinuationRecord = { ...record, revision: record.revision + 1, heartbeatAt: env.now(), deleteAfter: runningDeleteAfter(env) };
  return (await store.update(claimed, record.revision)) ? run(env, def, claimed, { ranBefore: true }) : refuse({ code: "IN_PROGRESS", id: record.id });
}

/**
 * Replay the command on a record this call has just claimed: from pending, or
 * by taking over an earlier run. `ranBefore`: an answer in the chain may have
 * taken effect before this run (an earlier link's, or a run taken over).
 */
async function run(env: Env, def: CommandDefinition, claimed: ContinuationRecord, { ranBefore }: { ranBefore: boolean }): Promise<ResumeOutcome> {
  let current = claimed;
  // Rendered once, while the arguments are at hand; every tombstone of this run keeps it.
  const check = checkLineOf(env, claimed);
  const write = async (changes: Partial<ContinuationRecord>): Promise<boolean> => {
    const next: ContinuationRecord = { ...current, ...changes, revision: current.revision + 1 };
    if (!(await env.store.update(next, current.revision))) return false;
    current = next;
    return true;
  };
  // Another run holds the record, or it is gone.
  const lost = async (): Promise<ResumeOutcome> => (
    (await env.store.get(current.id)) ? refuse({ code: "IN_PROGRESS", id: current.id }) : missing(env, current.id)
  );
  // Best-effort: the tombstone written when the run started still stands.
  const finish = async (finishedAt: number): Promise<void> => {
    try {
      await env.store.putTombstone(tombstoneOf(current, finishedAt, check));
    } catch {
      // Keep the outcome; only its tombstone's finishedAt is missing.
    }
  };

  let replayed;
  try {
    // From here the answer may take effect: once the record is gone, say so (RESULT_EXPIRED).
    await env.store.putTombstone(tombstoneOf(current, null, check));
    replayed = await replay(def, current.args, {
      rootId: current.rootId,
      journal: current.journal,
      onProgress: (journal) => write({ journal: [...journal], heartbeatAt: env.now(), deleteAfter: runningDeleteAfter(env) }),
    });
  } catch (error) {
    // Let a retry take over at once instead of waiting out the lease.
    await write({ heartbeatAt: undefined }).catch(() => false);
    throw error;
  }

  const { outcome, journal } = replayed;
  switch (outcome.kind) {
    case "returned": {
      // The steps ran; the result stands even if the record moved on meanwhile.
      const finishedAt = env.now();
      const stored = await write({
        status: "done", result: outcome.result, journal, heartbeatAt: undefined, deleteAfter: finishedAt + env.resultRetentionMs,
      });
      if (stored) await finish(finishedAt);
      return { kind: "done", result: outcome.result };
    }
    case "paused": {
      const next = await putPaused(env, {
        id: env.newId(), rootId: current.rootId, command: current.command, args: current.args,
        journal, askId: outcome.askId, spec: outcome.spec,
      });
      const finishedAt = env.now();
      // Kept at least as long as the next one is, so a retry here can still point to it.
      const deleteAfter = Math.max(finishedAt + env.resultRetentionMs, next.deleteAfter);
      if (await write({ next: next.id, journal, heartbeatAt: undefined, deleteAfter })) {
        await finish(finishedAt);
        return paused(next);
      }
      // Only one continuation may carry the chain on.
      await env.store.delete(next.id);
      return lost();
    }
    case "diverged":
      await write({ heartbeatAt: undefined });
      return refuse({
        code: "REPLAY_DIVERGED", id: current.id, command: current.command, args: current.args,
        position: outcome.position, expected: outcome.expected, actual: outcome.actual,
        mayHaveTakenEffect: ranBefore, check: await checkWhen(env, current, ranBefore),
      });
    case "lost":
      return lost();
    case "store_failed":
      await write({ heartbeatAt: undefined }).catch(() => false);
      throw outcome.error;
  }
}
