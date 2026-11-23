// #triage:#494: an agent whose start failed because its runtime is not signed
// in (`runtime_login_required`) reads "Sign-in needed" on every status surface.
// One check decides it, from typed data only: the live failed start's
// `spawnFailure.reason` or the stored record's `spawnFailureReason`.
import assert from "node:assert/strict";
import { test } from "vitest";
import { createIntl, createIntlCache } from "react-intl";
import { SPAWN_FAILURE_REASONS } from "@botiverse/raft-shared";

import { runtimeSignInNeededOf } from "../src/utils/activity";
import { formatRuntimeSignInNeededDetail, formatRuntimeSignInNeededText } from "../src/utils/runtimeSignInNeededCopy";
import { mergedMessages } from "../src/i18n/messages";

test("the live failed start's reason says the runtime needs its sign-in", () => {
  assert.equal(runtimeSignInNeededOf({ activity: "offline", spawnFailure: { reason: "runtime_login_required" } }), true);
  assert.equal(runtimeSignInNeededOf({ activity: "error", spawnFailure: { reason: "runtime_login_required" } }), true);
});

test("the stored record's start-failure reason says it too, with no live failed start", () => {
  assert.equal(runtimeSignInNeededOf({ activity: "offline", lastRuntimeError: { spawnFailureReason: "runtime_login_required" } }), true);
  assert.equal(runtimeSignInNeededOf({ activity: "error", spawnFailure: null, lastRuntimeError: { spawnFailureReason: "runtime_login_required" } }), true);
});

test("every other start-failure reason, from either place, keeps its own display", () => {
  const others = SPAWN_FAILURE_REASONS.filter((reason) => reason !== "runtime_login_required");
  assert.ok(others.length > 0);
  for (const reason of others) {
    assert.equal(runtimeSignInNeededOf({ activity: "offline", spawnFailure: { reason } }), false, reason);
    assert.equal(runtimeSignInNeededOf({ activity: "offline", lastRuntimeError: { spawnFailureReason: reason } }), false, reason);
  }
  assert.equal(runtimeSignInNeededOf({ activity: "offline" }), false, "offline with no failed start");
  assert.equal(runtimeSignInNeededOf({ activity: "offline", lastRuntimeError: {} }), false, "a stored error that is no failed start");
});

test("only while it is down, and not while another state already says why", () => {
  const login = { spawnFailure: { reason: "runtime_login_required" as const } };
  for (const activity of ["online", "thinking", "working"] as const) {
    assert.equal(runtimeSignInNeededOf({ activity, ...login }), false, activity);
  }
  assert.equal(runtimeSignInNeededOf({ activity: "offline", ...login, blocked: "computer_offline" }), false);
  assert.equal(runtimeSignInNeededOf({ activity: "offline", ...login, paused: true }), false);
  assert.equal(runtimeSignInNeededOf({ activity: "offline", ...login, likelyOnline: true }), false);
  assert.equal(runtimeSignInNeededOf({ activity: "offline", ...login, isExternal: true }), false);
});

test("the words: full and short status, and the sentence with display names (Cat's copy)", () => {
  const en = createIntl({ locale: "en", messages: mergedMessages("en") }, createIntlCache());
  assert.equal(formatRuntimeSignInNeededText(en.formatMessage, "kimi-sdk"), "Sign-in needed for Kimi Code");
  assert.equal(formatRuntimeSignInNeededText(en.formatMessage, "kimi-sdk", "short"), "Sign-in needed");
  assert.equal(
    formatRuntimeSignInNeededDetail(en.formatMessage, { name: "Cindy", runtime: "kimi-sdk", computer: "Mei's PC" }),
    "Cindy can't start until Kimi Code is signed in on Mei's PC. Sign in there, or switch Cindy to another runtime.",
  );
  const zh = createIntl({ locale: "zh-CN", messages: mergedMessages("zh-cn") }, createIntlCache());
  assert.equal(formatRuntimeSignInNeededText(zh.formatMessage, "kimi-sdk"), "需要登录 Kimi Code");
  assert.equal(formatRuntimeSignInNeededText(zh.formatMessage, "kimi-sdk", "short"), "需要登录");
  assert.equal(
    formatRuntimeSignInNeededDetail(zh.formatMessage, { name: "Cindy", runtime: "kimi-sdk", computer: "Mei 的电脑" }),
    "Kimi Code 在 Mei 的电脑 上登录后，Cindy 才能启动。请在那台电脑上登录，或者把 Cindy 换到其他运行时。",
  );
  assert.equal(en.formatMessage({ id: "agent.runtimeError.code.authRequired.title" }), "Sign-in needed", "one wording for this concept");
});
