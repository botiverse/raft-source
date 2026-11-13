import assert from "node:assert/strict";

import { createIntl } from "react-intl";

import { resolveAgentDisplayState } from "../src/store/agentStore";
import { formatAgentDisplayStateText } from "../src/utils/activity";
import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";

/**
 * #triage:#97 (artin): with no runtime state, only `status: "active"`, the
 * agent shows green but worded "Likely online", apart from a state the
 * server sent (idle "Online"). The server sends every agent's state with
 * `/agents` and channel rosters; a real state always wins.
 */

test("active without a state is green 'Likely online', not the server's 'Online'", () => {
  const state = resolveAgentDisplayState({ status: "active" }, undefined, false);
  assert.equal(state.likelyOnline, true);
  assert.equal(state.isOnline, true);
  assert.equal(state.activity, "online");
  assert.equal(formatAgentDisplayStateText(createIntl({ locale: "en", messages: en }), state), "Likely online");
  assert.equal(formatAgentDisplayStateText(createIntl({ locale: "zh-CN", messages: zhCn }), state), "可能在线");
});

test("a real state wins: idle reads Online, offline is offline; stopped and inactive stay offline", () => {
  const intl = createIntl({ locale: "en", messages: en });
  const idle = resolveAgentDisplayState({ status: "active" }, { activity: "online", activityDetail: "" }, false);
  assert.equal(idle.likelyOnline, undefined);
  assert.equal(formatAgentDisplayStateText(intl, idle), "Online");
  const offline = resolveAgentDisplayState({ status: "active" }, { activity: "offline", activityDetail: "" }, false);
  assert.equal(offline.isOnline, false);
  assert.equal(offline.likelyOnline, undefined);
  for (const status of ["stopped", "inactive"] as const) {
    const state = resolveAgentDisplayState({ status }, undefined, false);
    assert.equal(state.likelyOnline, undefined, status);
    assert.equal(state.isOnline, false, status);
  }
});

test("Start on an agent with no state shows it starting", async () => {
  const { default: api } = await import("../src/api/client");
  const { useAgentStore } = await import("../src/store/agentStore");
  const post = api.post;
  api.post = (async () => ({ data: {} })) as typeof api.post;
  const saved = useAgentStore.getState();
  try {
    useAgentStore.setState({ agents: [{ id: "a-97", name: "a", status: "inactive" }], agentActivities: {} } as never);
    await useAgentStore.getState().startAgent("a-97");
    assert.equal(useAgentStore.getState().agentActivities["a-97"]?.activity, "working");
  } finally {
    api.post = post;
    useAgentStore.setState(saved, true);
  }
});
