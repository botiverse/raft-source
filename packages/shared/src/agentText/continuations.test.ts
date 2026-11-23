import assert from "node:assert/strict";
import { formatContinuationPaused, formatContinuationRefusal, heldSendContinuationAsk, type ContinuationRefusalView } from "./continuations";

const CHECK = 'raft message read --target "#ops"';
const RERUN = 'raft message send --target "#ops"';
const PART_RAN = "Part of this command already ran and may have taken effect, so check before running anything again:";

test("once part of the command may have taken effect, every refusal that could send the agent to run it again gives the check line instead", () => {
  const id = "k7q2m3x9ab";
  const flagged = { id, mayHaveTakenEffect: true, rerun: RERUN, check: CHECK };
  const views: ContinuationRefusalView[] = [
    { code: "EXPIRED", createdAt: 0, expiresAt: 600_000, ...flagged },
    { code: "PROGRAM_CHANGED", ...flagged },
    { code: "FORMAT_CHANGED", ...flagged },
    { code: "UNKNOWN_COMMAND", ...flagged },
    { code: "REPLAY_DIVERGED", ...flagged },
  ];
  for (const view of views) {
    const text = formatContinuationRefusal(view);
    assert.ok(text.endsWith(` ${PART_RAN}\n  ${CHECK}`), `${view.code}: ${text}`);
    assert.ok(!text.includes(RERUN), `${view.code} offers no rerun: ${text}`);
  }
  // Nothing ran: the rerun line, and none of the wording above.
  const text = formatContinuationRefusal({ code: "PROGRAM_CHANGED", ...flagged, mayHaveTakenEffect: false });
  assert.ok(text.endsWith(`Run the original command again:\n  ${RERUN}`) && !text.includes("Part of this command"), text);
});

test("a held send's pause: the `cont` line per option by default, or with the answer tool offered the options once and one line naming it", () => {
  const id = "k7q2m3x9ab";
  const view = {
    id,
    ask: heldSendContinuationAsk("#ops", { cardOnlyLead: null, preview: "1 unread message.", anywayOffered: true }),
    expiresAt: Date.UTC(2026, 9, 26, 13, 12),
  };
  const lead = ["New messages arrived in #ops since you last read it.", "  1 unread message."];
  const labels = {
    a: "Don't send it: what's shown above already says it (for example, someone already answered), or makes it unnecessary",
    b: "Write a new message",
    c: "Send your message as it is",
    d: "Send it anyway, without reading the new messages",
  };
  const withoutTool = [
    ...lead,
    `Answer with one of these (continuation ${id}, expires at 13:12 UTC):`,
    `  a) ${labels.a}`,
    `     cont ${id} a`,
    `  b) ${labels.b} (your text on stdin)`,
    `     cont ${id} b <<'RAFTMSG'`,
    "     <your text>",
    "     RAFTMSG",
    `  c) ${labels.c}`,
    `     cont ${id} c`,
    `  d) ${labels.d}`,
    `     cont ${id} d`,
  ].join("\n");
  assert.equal(formatContinuationPaused(view), withoutTool);
  assert.equal(formatContinuationPaused(view, { answerTool: false }), withoutTool);
  assert.equal(formatContinuationPaused(view, { answerTool: true }), [
    ...lead,
    `Choose one of these (continuation ${id}, expires at 13:12 UTC):`,
    `  a) ${labels.a}`,
    `  b) ${labels.b} (your text)`,
    `  c) ${labels.c}`,
    `  d) ${labels.d}`,
    `Answer with the answer_continuation tool (id ${id}, choice, and text for an option that takes text); or in a shell: cont ${id} <choice> (text on stdin)`,
  ].join("\n"));
});

test("with the answer tool offered, an ask whose options take no text gives the shell fallback without the stdin note", () => {
  const text = formatContinuationPaused(
    { id: "k7q2m3x9ab", ask: { question: "Post the rest?", options: { y: "Yes", n: "No" } }, expiresAt: Date.UTC(2026, 9, 26, 13, 12) },
    { answerTool: true },
  );
  assert.equal(text, [
    "Post the rest?",
    "Choose one of these (continuation k7q2m3x9ab, expires at 13:12 UTC):",
    "  y) Yes",
    "  n) No",
    "Answer with the answer_continuation tool (id k7q2m3x9ab, choice, and text for an option that takes text); or in a shell: cont k7q2m3x9ab <choice>",
  ].join("\n"));
});
