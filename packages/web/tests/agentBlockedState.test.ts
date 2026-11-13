import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages/index";
import { agentBlockedState, agentRuntimeControls } from "../src/utils/agentBlockedState";
import { resolveAgentDisplayState } from "../src/store/agentStore";
import { formatAgentDisplayStateText } from "../src/utils/activity";

// PR #10343: the agent list's blockedReason is set while the agent's Computer is
// held below the version floor. The status must say the Computer is too old,
// not a generic Offline / Error.

test("no blockedReason keeps the normal status", () => {
  assert.equal(agentBlockedState(null), null);
  assert.equal(agentBlockedState(undefined), null);
  const state = resolveAgentDisplayState({ status: "active", blockedReason: null }, { activity: "online", activityDetail: "" }, false);
  assert.equal(state.blocked, undefined);
  assert.equal(state.activity, "online");
  assert.equal(state.isOnline, true);
});

test("both version reasons are the computer-too-old state, over any activity", () => {
  for (const reason of ["computer_version_unsupported", "computer_version_unknown"] as const) {
    assert.equal(agentBlockedState(reason), "computer_too_old");
    const state = resolveAgentDisplayState(
      { status: "active", blockedReason: reason },
      { activity: "working", activityDetail: "Reading files", detailKind: "none" } as never,
      false,
    );
    assert.equal(state.blocked, "computer_too_old");
    assert.equal(state.activity, "error", "warning tone: the error presence / warning chip");
    assert.equal(state.isOnline, false);
    assert.equal(state.activityText, "Computer update required");
  }
});

test("the status text says the update it needs in en and zh-cn, with or without detail", () => {
  const state = resolveAgentDisplayState({ status: "stopped", blockedReason: "computer_version_unknown" }, undefined, false);
  const expected = { en: "Computer update required", "zh-cn": "Computer 需要更新" } as const;
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    assert.equal(formatAgentDisplayStateText(intl, state), expected[locale]);
    assert.equal(formatAgentDisplayStateText(intl, state, { withDetail: false }), expected[locale]);
  }
});

// Reconciler step 15 (B15): the agent stays bound to a Computer whose access was
// revoked and gets no wakes; it never comes back by itself, so it does not read
// "Computer offline" (which says it will).
test("a revoked Computer's agent reads Computer access revoked, over its activity and an offline Computer", () => {
  assert.equal(agentBlockedState("computer_access_revoked"), "computer_access_revoked");
  const state = resolveAgentDisplayState(
    { status: "inactive", blockedReason: "computer_access_revoked" },
    { activity: "offline", activityDetail: "" },
    false,
    undefined,
    true,
  );
  assert.equal(state.blocked, "computer_access_revoked");
  assert.equal(state.activity, "error", "someone has to act: the warning chip");
  assert.equal(state.isOnline, false);
  assert.equal(state.activityText, "Computer access revoked: move the agent to another computer (re-attaching adds a new one)");
  const expected = { en: "Computer access revoked: move the agent to another computer (re-attaching adds a new one)", "zh-cn": "Computer 访问权限已撤销：请把 Agent 移到另一台 Computer（重新加入会新增一台 Computer）" } as const;
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    assert.equal(formatAgentDisplayStateText(intl, state), expected[locale]);
  }
});

test("a blockedReason this client does not know keeps the ordinary state (an older web against a newer server)", () => {
  assert.equal(agentBlockedState("computer_something_new" as never), null);
  const offline = resolveAgentDisplayState({ status: "inactive", blockedReason: "computer_something_new" as never }, undefined, false, undefined, true);
  assert.equal(offline.blocked, "computer_offline");
  const online = resolveAgentDisplayState({ status: "active", blockedReason: "computer_something_new" as never }, { activity: "online", activityDetail: "" }, false);
  assert.equal(online.blocked, undefined);
  assert.equal(online.activity, "online");
});

// #triage:#206: one rule for the runtime controls on every surface.
test("an offline Computer takes away Start and Restart / Reset, whatever the agent's state; Stop stays unless a person stopped it", () => {
  const base = { canControl: true, canStop: true, stoppedByPerson: false };
  // Waiting to come back with its Computer: Stop (the server applies it on reconnect).
  assert.deepEqual(agentRuntimeControls({ ...base, isOnline: false, computerOffline: true }), { start: false, stop: true, restartReset: false });
  assert.deepEqual(agentRuntimeControls({ ...base, stoppedByPerson: true, isOnline: false, computerOffline: true }), { start: false, stop: false, restartReset: false });
  assert.deepEqual(agentRuntimeControls({ ...base, canStop: false, isOnline: false, computerOffline: true }), { start: false, stop: false, restartReset: false });
  // A crashed agent counts as running (error), so it keeps Stop and loses Restart / Reset.
  assert.deepEqual(agentRuntimeControls({ ...base, isOnline: true, computerOffline: true }), { start: false, stop: true, restartReset: false });
  assert.deepEqual(agentRuntimeControls({ ...base, isOnline: false, computerOffline: false }), { start: true, stop: false, restartReset: true });
  assert.deepEqual(agentRuntimeControls({ ...base, stoppedByPerson: true, isOnline: false, computerOffline: false }), { start: true, stop: false, restartReset: true });
  assert.deepEqual(agentRuntimeControls({ ...base, isOnline: true, computerOffline: false }), { start: false, stop: true, restartReset: true });
  assert.deepEqual(agentRuntimeControls({ ...base, canControl: false, isOnline: true, computerOffline: false }), { start: false, stop: false, restartReset: false });
});
