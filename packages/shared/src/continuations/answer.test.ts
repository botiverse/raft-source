import assert from "node:assert/strict";
import { assertAskSpec, checkAnswer, sameAnswer } from "./answer";
import type { AskSpec } from "./record";

const CHOICE_ONLY: AskSpec = { question: "Which?", options: { a: "Send", c: "Cancel" } };
const CHOICE_WITH_CONTENT: AskSpec = { question: "Which?", options: { a: "Send", b: { label: "Write a new one", input: "stdin" } } };
const CONTENT_ONLY: AskSpec = { question: "Input your content", input: "stdin" };

test("each of the three kinds of ask accepts its answers and names what is wrong with the rest", () => {
  const cases = [
    [CHOICE_ONLY, { choice: "a" }, null],
    [CHOICE_ONLY, { choice: "c", input: "" }, null],
    [CHOICE_ONLY, {}, "no_such_option"],
    [CHOICE_ONLY, { choice: "b" }, "no_such_option"],
    [CHOICE_ONLY, { choice: "constructor" }, "no_such_option"],
    [CHOICE_ONLY, { choice: "a", input: "text" }, "unexpected_input"],
    [CHOICE_WITH_CONTENT, { choice: "b", input: "New text\n" }, null],
    [CHOICE_WITH_CONTENT, { choice: "b" }, "missing_input"],
    [CHOICE_WITH_CONTENT, { choice: "b", input: "  \n" }, "missing_input"],
    [CHOICE_WITH_CONTENT, { choice: "a" }, null],
    [CONTENT_ONLY, { input: "Body" }, null],
    [CONTENT_ONLY, {}, "missing_input"],
    [CONTENT_ONLY, { choice: "a", input: "Body" }, "no_such_option"],
  ] as const;
  for (const [spec, answer, expected] of cases) {
    assert.equal(checkAnswer(spec, answer), expected, `${JSON.stringify(answer)} to ${JSON.stringify(spec)}`);
  }
});

test("answers compare with blank content counting as none", () => {
  assert.equal(sameAnswer({ choice: "a" }, { choice: "a", input: " " }), true);
  assert.equal(sameAnswer({ choice: "b", input: "x" }, { choice: "b", input: "x\n" }), true, "one trailing newline does not count");
  assert.equal(sameAnswer({ choice: "b", input: "x\r\n" }, { choice: "b", input: "x" }), true);
  assert.equal(sameAnswer({ choice: "b", input: "x" }, { choice: "b", input: "x\n\n" }), false);
  assert.equal(sameAnswer({ choice: "b", input: "\nx" }, { choice: "b", input: "x" }), false);
  assert.equal(sameAnswer({ input: "x" }, { choice: "a", input: "x" }), false);
});

test("an ask no answer could satisfy, or with keys an agent cannot type, is a bug in the command", () => {
  assert.doesNotThrow(() => assertAskSpec("ok", CHOICE_WITH_CONTENT));
  assert.doesNotThrow(() => assertAskSpec("ok", CONTENT_ONLY));
  const bad = [
    { question: "?", options: {} },
    { question: "?", options: { "two words": "x" } },
    { question: "?", options: { a: "x" }, input: "stdin" },
    { question: "?" },
    { question: "?", input: "stdin", expiresInMs: 0 },
    { question: "?", input: "stdin", expiresInMs: -5_000 },
    { question: "?", options: { a: "x" }, expiresInMs: Number.NaN },
  ] as unknown as AskSpec[];
  for (const spec of bad) assert.throws(() => assertAskSpec("bad", spec), /continuation ask "bad"/, JSON.stringify(spec));
});
