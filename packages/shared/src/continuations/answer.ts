// Checking an ask, and an answer against it. Every way of answering (the
// `cont` command, a call_continuation tool, an in-process driver) checks with
// checkAnswer, so a wrong answer is refused the same way everywhere, before
// anything runs.

import type { Answer, AskSpec } from "./record";

export type InvalidAnswerCategory = "no_such_option" | "missing_input" | "unexpected_input";

/** What an agent can type as an option key. */
const OPTION_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Throws on an ask no answer could satisfy or an agent could not type (a bug in the command). */
export function assertAskSpec(askId: string, spec: AskSpec): void {
  const { options, expiresInMs } = spec;
  if (expiresInMs !== undefined && !(Number.isFinite(expiresInMs) && expiresInMs > 0)) {
    throw new Error(`continuation ask "${askId}" has expiresInMs ${expiresInMs}; it must be a positive number of milliseconds`);
  }
  if (options === undefined) {
    if (spec.input !== "stdin") throw new Error(`continuation ask "${askId}" needs options or input: "stdin"`);
    return;
  }
  if (spec.input !== undefined) throw new Error(`continuation ask "${askId}" takes options or input, not both`);
  const keys = Object.keys(options);
  if (keys.length === 0) throw new Error(`continuation ask "${askId}" has no options`);
  const bad = keys.find((key) => !OPTION_KEY.test(key));
  if (bad !== undefined) throw new Error(`continuation ask "${askId}" has option key "${bad}", which is not a plain word`);
}

function hasInput(answer: Answer): boolean {
  return typeof answer.input === "string" && answer.input.trim().length > 0;
}

/** The answer as it is checked, stored and compared: blank content counts as none. */
export function normalizeAnswer(answer: Answer): Answer {
  return {
    ...(typeof answer.choice === "string" ? { choice: answer.choice } : {}),
    ...(hasInput(answer) ? { input: answer.input } : {}),
  };
}

/** Content as compared: one trailing newline (what a heredoc adds) does not count. */
const comparable = (input: string | undefined): string | undefined => input?.replace(/\r?\n$/, "");

/** Whether two answers are the same answer: same choice, same content up to one trailing newline. */
export function sameAnswer(a: Answer, b: Answer): boolean {
  const left = normalizeAnswer(a);
  const right = normalizeAnswer(b);
  return left.choice === right.choice && comparable(left.input) === comparable(right.input);
}

/**
 * Why `answer` does not fit `spec`, or null when it does. A missing choice is
 * `no_such_option` (the fix is the same: pick one of the options), and so is
 * a choice given to an ask that only takes content.
 */
export function checkAnswer(spec: AskSpec, answer: Answer): InvalidAnswerCategory | null {
  const { choice } = normalizeAnswer(answer);
  const given = hasInput(answer);
  if (spec.options === undefined) {
    if (choice !== undefined) return "no_such_option";
    return given ? null : "missing_input";
  }
  if (choice === undefined || !Object.hasOwn(spec.options, choice)) return "no_such_option";
  const option = spec.options[choice];
  const takesInput = typeof option === "object" && option.input === "stdin";
  if (takesInput && !given) return "missing_input";
  if (!takesInput && given) return "unexpected_input";
  return null;
}
