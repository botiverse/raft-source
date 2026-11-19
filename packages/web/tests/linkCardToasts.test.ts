import assert from "node:assert/strict";
import { beforeEach, vi } from "vitest";

// RFC 076 §6.9 (Kirby's #13978 review W1, W4): when an operation ends, the
// App's toast shows the App's words in the tone Raft gives the state, never a
// tone the App picks, so a refusal never looks like a success; blank words are
// no toast and the caller shows Raft's own hint. (The DOM tests that drew these
// went with the web DOM test prune; this keeps the rule.)
const shown = vi.hoisted(() => ({ calls: [] as Array<[string, string]> }));
vi.mock("@botiverse/raft-ui", () => ({
  toast: {
    success: (text: string) => shown.calls.push(["success", text]),
    warning: (text: string) => shown.calls.push(["warning", text]),
    info: (text: string) => shown.calls.push(["info", text]),
  },
}));

const { noteLinkCardApp, showAppToast } = await import("../src/components/message/linkCardToasts");

// The words are the App's, so they show under its name ("Stamp: Merged"), never as Raft's own sentence (W3).
const format = ((descriptor: { id: string }, values?: Record<string, string>) =>
  descriptor.id === "message.appLink.action.appSays" ? `${values?.app}: ${values?.text}` : `App: ${values?.text}`) as unknown as Parameters<typeof showAppToast>[0];
noteLinkCardApp("view-1", "Stamp");

beforeEach(() => { shown.calls.length = 0; });

test("the App's words take the tone Raft gives the state: success only for done", () => {
  for (const [state, tone] of [
    ["done", "success"], ["refused", "warning"], ["failed_not_sent", "warning"], ["unknown", "warning"],
    ["needs_reconciliation", "warning"], ["accepted", "info"], ["resolved_manually", "info"],
  ] as const) {
    shown.calls.length = 0;
    assert.equal(showAppToast(format, state, { text: "Merged!" }, "view-1"), true, state);
    assert.deepEqual(shown.calls, [[tone, "Stamp: Merged!"]], state);
  }
});

test("blank or missing words are no toast: false, so the caller shows Raft's hint", () => {
  assert.equal(showAppToast(format, "done", { text: "   " }, "view-1"), false);
  assert.equal(showAppToast(format, "refused", undefined, "view-1"), false);
  assert.deepEqual(shown.calls, []);
});

test("the words are trimmed", () => {
  showAppToast(format, "done", { text: "  Merged  " }, "view-1");
  assert.deepEqual(shown.calls, [["success", "Stamp: Merged"]]);
});

test("a card that isn't on screen names no App, and still isn't Raft's own sentence", () => {
  showAppToast(format, "done", { text: "Merged" }, "view-unknown");
  showAppToast(format, "done", { text: "Merged" }, undefined);
  assert.deepEqual(shown.calls, [["success", "App: Merged"], ["success", "App: Merged"]]);
});
