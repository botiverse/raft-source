// What an agent reads when a command stops to ask it something (a
// continuation, shared/src/continuations) and when answering one is refused.
// Pure functions over content-free views: the CLI wraps them in its axSurface
// registrations (commands/continuation/_format.ts) and the SDK will print the
// same words. A view never carries the command's arguments, an answer's text
// or the journal: what to run again comes as `rerun`/`check` lines the
// command renders itself, with placeholders where its stdin content goes.
// Like the runtime it describes, not on the package root: imported as
// "@botiverse/raft-shared/src/agentText/continuations".

import type { AskOption, AskSpec, InvalidAnswerCategory } from "../continuations/index";

/** Typed where a heredoc closes; the same delimiter `raft message send` teaches. */
const HEREDOC_DELIMITER = "RAFTMSG";

/** A paused continuation, as the agent is asked it. */
export interface ContinuationPausedView {
  id: string;
  ask: AskSpec;
  expiresAt: number;
}

/**
 * A refused answer, without content. `rerun` is the original command line and
 * `check` a command that shows whether it took effect; null when there is
 * none to give, and the text then says so in words alone. `mayHaveTakenEffect`:
 * part of the command (a step before its first question, an earlier
 * continuation's answer, or this one's own earlier run) may already have done
 * something, so the text gives `check`, never `rerun`.
 */
export type ContinuationRefusalView =
  | { code: "UNKNOWN"; id: string }
  | { code: "NOT_YOURS"; id: string }
  | { code: "EXPIRED"; id: string; createdAt: number; expiresAt: number; mayHaveTakenEffect: boolean; rerun: string | null; check: string | null }
  | { code: "RESULT_EXPIRED"; id: string; retentionMs: number; check: string | null }
  | {
    code: "PROGRAM_CHANGED" | "FORMAT_CHANGED" | "UNKNOWN_COMMAND" | "REPLAY_DIVERGED";
    id: string;
    mayHaveTakenEffect: boolean;
    rerun: string | null;
    check: string | null;
  }
  /** `choice`: the option key the agent typed, if any. */
  | { code: "INVALID_ANSWER"; id: string; category: InvalidAnswerCategory; ask: AskSpec; choice?: string }
  | { code: "ALREADY_ANSWERED"; id: string; previous: { choice?: string; withInput: boolean }; answeredAt: number | null }
  | { code: "IN_PROGRESS"; id: string }
  /**
   * The store failed (`read`: could not be read; `write`: could not be
   * saved). `id` is null when a command's first question could not be saved,
   * so there is no continuation yet. `mayHaveTakenEffect` unless it is
   * provable that no step ran: then `rerun` (a first question) or the same
   * `cont` again; else `check`.
   */
  | {
    code: "STORE_FAILED";
    id: string | null;
    operation: "read" | "write";
    mayHaveTakenEffect: boolean;
    rerun: string | null;
    check: string | null;
  };

/** HH:MM in UTC: the agent's clock may be anywhere, and the deadline is short. */
function utcClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A lifetime in words: "10 minutes", "45 seconds", "24 hours". */
export function formatContinuationSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 120 && minutes % 60 === 0) return plural(minutes / 60, "hour", "hours");
  if (minutes >= 1) return plural(minutes, "minute", "minutes");
  return plural(Math.max(1, Math.round(ms / 1_000)), "second", "seconds");
}

const indent = (text: string, by: string): string => text.split("\n").map((line) => (line ? `${by}${line}` : line)).join("\n");

const heredoc = (command: string, by: string): string[] => [
  `${by}${command} <<'${HEREDOC_DELIMITER}'`,
  `${by}<your text>`,
  `${by}${HEREDOC_DELIMITER}`,
];

/** One option and the command that picks it, as listed under "Answer with one of these". */
function optionLines(id: string, key: string, option: AskOption): string[] {
  const under = " ".repeat(key.length + 4);
  if (typeof option === "string") return [`  ${key}) ${option}`, `${under}cont ${id} ${key}`];
  return [`  ${key}) ${option.label} (your text on stdin)`, ...heredoc(`cont ${id} ${key}`, under)];
}

function answerLines(id: string, ask: AskSpec): string[] {
  if (ask.options === undefined) return heredoc(`cont ${id}`, "  ");
  return Object.entries(ask.options).flatMap(([key, option]) => optionLines(id, key, option));
}

/** The question, its preview, and every way to answer it. */
export function formatContinuationPaused(view: ContinuationPausedView): string {
  const { id, ask } = view;
  const lines = [ask.question];
  const preview = ask.preview?.replace(/\n+$/, "");
  if (preview) lines.push(indent(preview, "  "));
  const where = `continuation ${id}, expires at ${utcClock(view.expiresAt)} UTC`;
  lines.push(ask.options === undefined ? `Answer with your text on stdin (${where}):` : `Answer with one of these (${where}):`);
  lines.push(...answerLines(id, ask));
  return lines.join("\n");
}

/** A paragraph, then the command to run next (indented), or the paragraph closed when there is none. */
function thenRun(paragraph: string, command: string | null): string {
  return command === null ? `${paragraph}.` : `${paragraph}:\n${indent(command, "  ")}`;
}

function invalidAnswer(view: Extract<ContinuationRefusalView, { code: "INVALID_ANSWER" }>): string {
  const { id, ask, choice } = view;
  switch (view.category) {
    case "no_such_option": {
      const opening = choice === undefined ? `Continuation ${id} needs one of its options.` : `Continuation ${id} has no option "${choice}".`;
      const how = ask.options === undefined ? "Answer with your text on stdin:" : "Answer with one of these:";
      return [`${opening} ${how}`, ...answerLines(id, ask)].join("\n");
    }
    case "missing_input":
      if (choice === undefined || ask.options === undefined) {
        return [`Continuation ${id} needs your text on stdin:`, ...heredoc(`cont ${id}`, "  ")].join("\n");
      }
      return [`Option ${choice} needs your text on stdin:`, ...heredoc(`cont ${id} ${choice}`, "  ")].join("\n");
    case "unexpected_input":
      return `Option ${choice ?? ""} takes no text. Run it without stdin:\n  cont ${id} ${choice ?? ""}`;
  }
}

function alreadyAnswered(view: Extract<ContinuationRefusalView, { code: "ALREADY_ANSWERED" }>): string {
  const { id, previous } = view;
  const at = view.answeredAt === null ? "" : ` at ${utcClock(view.answeredAt)} UTC`;
  const choice = previous.choice;
  const given = choice === undefined ? "your text" : previous.withInput ? `"${choice}" and your text` : `"${choice}"`;
  const opening = `Continuation ${id} was already answered with ${given}${at}, so a different answer can't be applied.`;
  const command = choice === undefined ? `cont ${id}` : `cont ${id} ${choice}`;
  if (!previous.withInput) return `${opening} To get its result, run the same answer again: ${command}`;
  return [
    `${opening} To get its result, run the same answer again, with the same text on stdin:`,
    `  ${command} <<'${HEREDOC_DELIMITER}'`,
    "  <the same text>",
    `  ${HEREDOC_DELIMITER}`,
  ].join("\n");
}

/**
 * Whenever part of the command may have done something (an earlier answer, a
 * step before the first question, this continuation's own earlier run):
 * running it again could do it twice.
 */
const PART_MAY_HAVE_TAKEN_EFFECT = "Part of this command already ran and may have taken effect, so check before running anything again";

/** Why answering it did not work, and the next command; never the command's content. */
export function formatContinuationRefusal(view: ContinuationRefusalView): string {
  const { id } = view;
  switch (view.code) {
    case "UNKNOWN":
      return `No continuation ${id} here. Check the id in the output that gave it to you; a continuation can only be answered by the agent it was given to.`;
    case "NOT_YOURS":
      return `Continuation ${id} was given to another agent; only that agent can answer it.`;
    case "EXPIRED": {
      const expiredAt = `Continuation ${id} expired at ${utcClock(view.expiresAt)} UTC (${formatContinuationSpan(view.expiresAt - view.createdAt)} to answer); nothing after its question ran.`;
      return view.mayHaveTakenEffect
        ? thenRun(`${expiredAt} ${PART_MAY_HAVE_TAKEN_EFFECT}`, view.check)
        : thenRun(`${expiredAt} To start over, run the original command again`, view.rerun);
    }
    case "RESULT_EXPIRED":
      return thenRun(
        `The result of continuation ${id} is no longer kept (results are kept ${formatContinuationSpan(view.retentionMs)}). It may already have taken effect, so check before running anything again`,
        view.check,
      );
    case "PROGRAM_CHANGED":
    case "FORMAT_CHANGED":
    case "UNKNOWN_COMMAND":
    case "REPLAY_DIVERGED": {
      const why = view.code === "REPLAY_DIVERGED"
        ? `Continuation ${id} could not be resumed (the command changed while it waited)`
        : view.code === "UNKNOWN_COMMAND"
          // Same program and version, no such command: not "a different version".
          ? `Continuation ${id} can no longer be resumed by this raft CLI`
          : `Continuation ${id} was started by a different version of the raft CLI, so it can't be resumed safely`;
      return view.mayHaveTakenEffect
        ? thenRun(`${why}. ${PART_MAY_HAVE_TAKEN_EFFECT}`, view.check)
        : thenRun(`${why}; nothing after its question ran. Run the original command again`, view.rerun);
    }
    case "INVALID_ANSWER":
      return invalidAnswer(view);
    case "ALREADY_ANSWERED":
      return alreadyAnswered(view);
    case "IN_PROGRESS":
      return `Continuation ${id} is being answered right now. Wait a few seconds, then run the same command again to get its result.`;
    case "STORE_FAILED":
      return storeFailed(view);
  }
}

function storeFailed(view: Extract<ContinuationRefusalView, { code: "STORE_FAILED" }>): string {
  if (view.id === null) {
    return view.mayHaveTakenEffect
      ? thenRun("The command could not save its question on this computer; steps before it may already have taken effect. Check before running it again", view.check)
      : thenRun("The command could not save its question on this computer, so nothing was done. Run it again", view.rerun);
  }
  if (view.mayHaveTakenEffect) {
    return thenRun(`Continuation ${view.id} could not be saved on this computer, so its last step may already have taken effect. Check before running anything again`, view.check);
  }
  // Nothing ran in this call: the same `cont` again is safe (a run replays under the same idempotency keys).
  return `Continuation ${view.id} could not be ${view.operation === "read" ? "read" : "saved"} on this computer, so nothing was done this time. Run the same command again; if it keeps failing, report it.`;
}

/** A held send, as the continuation that asks instead of saving a draft has it. */
export interface HeldSendAskData {
  /** From renderAgentHoldPreview: what a hold for a card alone is about, or null for unread messages. */
  cardOnlyLead: string | null;
  preview: string;
  /** The server suggested sending anyway (the send was held 3 or more times), as `--send-draft --anyway` is offered today. */
  anywayOffered: boolean;
}

/**
 * The question a held `raft message send` asks when it keeps the message in
 * a continuation instead of a draft (the continuation pilot): don't send it
 * (first, as the held text puts sending nothing first), write a new one (text
 * on stdin), send it as it is, and, once the server suggests it, send anyway.
 */
export function heldSendContinuationAsk(target: string, held: HeldSendAskData): AskSpec {
  const lead = held.cardOnlyLead;
  return {
    question: lead
      ? `${lead.charAt(0).toUpperCase()}${lead.slice(1)} is not in your current context yet.`
      : `New messages arrived in ${target} since you last read it.`,
    preview: held.preview,
    options: {
      a: lead
        ? "Don't send it: what's shown above makes it unnecessary"
        : "Don't send it: what's shown above already says it (for example, someone already answered), or makes it unnecessary",
      b: { label: "Write a new message", input: "stdin" },
      c: "Send your message as it is",
      ...(held.anywayOffered && !lead ? { d: "Send it anyway, without reading the new messages" } : {}),
    },
  };
}
