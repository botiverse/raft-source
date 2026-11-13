import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import api from "../src/api/client";
import { canStopSubagentsOf, stopSubagentWithFeedback } from "../src/components/agent/stopSubagent";
import { setToastManager } from "../src/components/toastBridge";
import { mergedMessages } from "../src/i18n/messages";

// #proj-runtime:#41: Stop Subagent, as Stop Current Turn: one toast, Retry on a plain failure.
const originalPost = api.post;
afterEach(() => {
  api.post = originalPost;
  setToastManager(null);
});

test("only a live Codex, Claude Code or Kimi agent, for a viewer with Stop turn's runtime authority, offers Stop", () => {
  assert.equal(canStopSubagentsOf({ runtime: "codex", deletedAt: null }, true), true);
  assert.equal(canStopSubagentsOf({ runtime: "claude", deletedAt: null }, true), true, "Claude Code: stop_task");
  assert.equal(canStopSubagentsOf({ runtime: "kimi-sdk", deletedAt: null }, true), true, "Kimi: a background subagent");
  assert.equal(canStopSubagentsOf({ runtime: "opencode", deletedAt: null }, true), false, "a runtime that cannot stop one subagent");
  assert.equal(canStopSubagentsOf({ runtime: "codex", deletedAt: "2026-11-03T00:00:00.000Z" }, true), false, "a deleted agent");
  assert.equal(canStopSubagentsOf({ runtime: "codex" }, false), false, "no runtime authority");
});

test("the stop says what happened; an older Computer is told apart; a plain failure offers Retry, which stops again", async () => {
  const intl = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  const toasts: Array<{ title: string; type?: string; actionProps?: { children: string; onClick: () => void } }> = [];
  setToastManager({ add: (toast) => { toasts.push(toast as never); } });
  const posted: string[] = [];
  const replies: Array<{ data: unknown } | Error> = [
    { data: { outcome: "interrupted" } },
    Object.assign(new Error("409"), { response: { data: { code: "computer_upgrade_required" } } }),
    new Error("504"),
    { data: { outcome: "not_running" } },
  ];
  api.post = (async (url: string) => {
    posted.push(url);
    const next = replies.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof api.post;

  await stopSubagentWithFeedback("agent-1", "thread/a", intl.formatMessage);
  assert.deepEqual(toasts.map((t) => [t.title, t.type]), [["Asked the subagent to stop.", "success"]]);
  assert.equal(posted[0], "/agents/agent-1/subagents/thread%2Fa/interrupt");

  await stopSubagentWithFeedback("agent-1", "thread/a", intl.formatMessage);
  assert.deepEqual([toasts.at(-1)!.title, toasts.at(-1)!.actionProps], ["Upgrade this agent's Computer to stop a single subagent.", undefined], "no Retry: it would not help");

  await stopSubagentWithFeedback("agent-1", "thread/a", intl.formatMessage);
  const failed = toasts.at(-1)!;
  assert.deepEqual([failed.title, failed.type, failed.actionProps?.children], ["Couldn't stop the subagent.", "error", "Retry"]);
  failed.actionProps!.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posted.length, 4, "Retry stops again");
  assert.equal(toasts.at(-1)!.title, "This subagent isn't running.");
});
