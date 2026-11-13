// The continuation record: what a command that stopped to ask leaves in a
// store, so a later call can answer the question and carry the command on.
// Its format is a contract between the program that writes it and whatever
// stores it (the CLI's agent ledger, a local file), versioned on its own:
// CONTINUATION_FORMAT_VERSION is not the program's version.

import type { Brand } from "../brandedIds";
import type { JsonValue } from "../jsonValue";

/** The stored record's format. A record of another format is never resumed (FORMAT_CHANGED). */
export const CONTINUATION_FORMAT_VERSION = 1;

/**
 * The exit status of a process whose command paused for an answer: neither
 * success (0) nor failure, so a harness or hook can tell "waiting for the
 * agent" apart. The raft CLI and CLIs built on the SDK use it.
 */
export const CONTINUATION_PAUSED_EXIT_CODE = 10;

/**
 * How long a continuation can be answered (its answer deadline, `expiresAt`)
 * unless its ask says otherwise, like a held draft.
 */
export const DEFAULT_CONTINUATION_TTL_MS = 10 * 60 * 1000;

/**
 * How long an answered continuation keeps its outcome once its run reached
 * one, for a retry with the same answer (a lost output, a compacted context).
 * Longer than the answer deadline: the agent may come back for the result
 * after the time to answer is over.
 */
export const DEFAULT_CONTINUATION_RESULT_RETENTION_MS = 30 * 60 * 1000;

/**
 * A continuation id: short enough to type, unguessable, bound to the agent
 * that created it. New ids come from `newContinuationId`.
 */
export type ContinuationId = Brand<string, "ContinuationId">;

/** Brand a string as a {@link ContinuationId} where it is first known to be one (a stored row, a parsed argument). */
export const asContinuationId = (id: string): ContinuationId => id as ContinuationId;

/** Crockford base32 in lower case: no i, l, o or u to misread. 32 symbols, so `byte & 31` picks one uniformly. */
export const CONTINUATION_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** 50 random bits: unguessable within a continuation's lifetime, short enough to type. */
export const CONTINUATION_ID_LENGTH = 10;

/** Crockford's look-alikes: what an agent may type for 1 and 0. A `u` is no symbol at all. */
const LOOK_ALIKES: Record<string, string> = { i: "1", l: "1", o: "0" };

/**
 * A continuation id as typed (`cont K7Q2…`): trimmed, lower-cased, look-alikes
 * read as the digits they resemble. Null unless it is then 10 symbols of the
 * id alphabet.
 */
export function parseContinuationId(input: string): ContinuationId | null {
  const id = input.trim().toLowerCase().replace(/[ilo]/g, (letter) => LOOK_ALIKES[letter] ?? letter);
  const valid = id.length === CONTINUATION_ID_LENGTH && [...id].every((symbol) => CONTINUATION_ID_ALPHABET.includes(symbol));
  return valid ? asContinuationId(id) : null;
}

/** The program that paused, and so the only one that can replay the record. */
export type ContinuationProgram = { name: string; version: string };

/** An option the agent can pick: its label, or a label and content the answer carries on stdin. */
export type AskOption = string | { label: string; input: "stdin" };

type AskCommon = {
  question: string;
  preview?: string;
  /** Overrides the default time this continuation can be answered in. */
  expiresInMs?: number;
};

/**
 * What an ask accepts: one of `options` (some of which may also take content),
 * or content alone. Option keys are what the agent types (`cont <id> b`).
 *
 * TODO(continuations): named fields described by a schema (like MCP
 * elicitation's requestedSchema), answered with `--field k=v` or JSON on
 * stdin. Not in format 1.
 */
export type AskSpec =
  | (AskCommon & { options: Record<string, AskOption>; input?: never })
  | (AskCommon & { input: "stdin"; options?: never });

/** An answer: the option picked and/or the content given. */
export type Answer = { choice?: string; input?: string };

/**
 * What a failed step keeps of its error: name, message and code. Never a
 * stack or a response body, which could carry message text.
 */
export type StepFailure = { name: string; message: string; code?: string };

/**
 * One `ctx.step` outcome or `ctx.ask` answer, in the order the command made
 * the calls. `readOnly` is there only when the command declared the step
 * read-only; without it the step may have written, whether it succeeded or
 * failed.
 */
export type JournalEntry =
  | { kind: "step"; id: string; result: JsonValue; error?: undefined; readOnly?: true }
  | { kind: "step"; id: string; error: StepFailure; result?: undefined; readOnly?: true }
  | { kind: "ask"; id: string; answer: Answer };

/**
 * Whether anything in `journal` may have taken effect outside: an answer
 * that ran on (a later link's journal holds it), or a step not declared
 * read-only. Read defensively, since it also judges records of another
 * format: anything it cannot read counts as having taken effect.
 */
export function journalMayHaveTakenEffect(journal: unknown): boolean {
  if (!Array.isArray(journal)) return true;
  return journal.some((entry: unknown) => (
    typeof entry !== "object" || entry === null
    || (entry as { kind?: unknown }).kind !== "step"
    || (entry as { readOnly?: unknown }).readOnly !== true
  ));
}

/**
 * pending: waiting for an answer. answered: the answer is fixed; the command
 * is running on it, failed, or paused again (`next`). done: `result` is the
 * outcome of the original call.
 */
export type ContinuationStatus = "pending" | "answered" | "done";

export type ContinuationRecord = {
  formatVersion: number;
  id: ContinuationId;
  /** The first record's id in this chain of pauses; step idempotency keys derive from it. */
  rootId: ContinuationId;
  /** Bumped on every write; stores update a record only from the revision the writer read. */
  revision: number;
  ownerAgentId: string;
  program: ContinuationProgram;
  /** The command that paused, as the program names it (e.g. "message send"). */
  command: string;
  /** The command's original arguments; every replay starts from them. */
  args: JsonValue;
  journal: JournalEntry[];
  /**
   * The ask this continuation paused at. Kept once answered, so an earlier
   * link in the chain can still describe it.
   */
  pending: { askId: string; spec: AskSpec };
  status: ContinuationStatus;
  createdAt: number;
  /** The answer deadline the agent sees. It only applies while pending: past it, the continuation is EXPIRED. */
  expiresAt: number;
  /**
   * When a store may delete the record (`deleteExpired`); the runtime owns it.
   * While pending, the answer deadline plus a short grace, so a late answer
   * still finds the record and is told it expired. Once answered, pushed to
   * now + run lease + result retention on every write by the run, so a live
   * run is never swept. Once it has an outcome, now + result retention.
   */
  deleteAfter: number;
  answer?: Answer;
  /** When the answer was fixed on the record. */
  answeredAt?: number;
  /**
   * While answered without an outcome: when the run holding the answer last
   * wrote. A retry takes the run over once this is older than the run lease
   * (its process died); a run that fails in-process clears it.
   */
  heartbeatAt?: number;
  result?: JsonValue;
  /** The continuation this one's answer led to, when the command paused again. */
  next?: ContinuationId;
};

/**
 * What is left of an answered continuation once its record is deleted:
 * enough to tell "its outcome is gone" (RESULT_EXPIRED) from "no such
 * continuation" (UNKNOWN), and none of its content. Deleted by the same
 * `deleteAfter` rule as records.
 */
export type ContinuationTombstone = {
  /** As on records: a tombstone of another format is not read (FORMAT_CHANGED). */
  formatVersion: number;
  id: ContinuationId;
  rootId: ContinuationId;
  ownerAgentId: string;
  command: string;
  /** When the answer's run reached an outcome (done, or paused again); null while it had none. */
  finishedAt: number | null;
  deleteAfter: number;
  /**
   * A command that shows whether the answer took effect, as the program
   * rendered it from the arguments when the run started (`checkLine`), for
   * RESULT_EXPIRED to name once the arguments are gone. Content-free by its
   * contract: no body, only what locates the effect (a target). Absent when
   * the program gave none.
   */
  check?: string;
};
