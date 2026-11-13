import assert from "node:assert/strict";
import { hiddenMessageDateFormat, historyPaywallChannelName, historyPaywallPlace } from "../src/components/message/historyPaywallLabels";

/**
 * What the history paywall tells the upgrade dialog about where it is (task
 * #24, proposal C): only a named channel is named; a DM, a thread or an agent's
 * lounge reads as "this conversation" / "this thread" in the dialog.
 */

test("only a named channel gives the dialog its name", () => {
  assert.equal(historyPaywallChannelName({ type: "channel", name: "roadmap" }), "#roadmap");
  assert.equal(historyPaywallChannelName({ type: "channel", name: "ask-scout", loungeAgentId: "agent-1" }), undefined, "an agent's lounge");
  assert.equal(historyPaywallChannelName({ type: "dm", name: "dm-ada" }), undefined);
  assert.equal(historyPaywallChannelName({ type: "thread", name: "thread-1" }), undefined);
  assert.equal(historyPaywallChannelName({ type: "channel", name: "" }), undefined);
  assert.equal(historyPaywallChannelName(null), undefined);
});

test("a hidden message's date carries its year only when it is not this year's", () => {
  const thisYear = `${new Date().getUTCFullYear()}-03-03T12:00:00.000Z`;
  assert.deepEqual(hiddenMessageDateFormat(thisYear), { month: "long", day: "numeric" });
  assert.deepEqual(hiddenMessageDateFormat("2019-03-03T12:00:00.000Z", "Asia/Shanghai"), { month: "long", day: "numeric", year: "numeric", timeZone: "Asia/Shanghai" });
  assert.equal(new Date("2019-03-03T12:00:00.000Z").toLocaleDateString("en-US", hiddenMessageDateFormat("2019-03-03T12:00:00.000Z", "UTC")), "March 3, 2019");
});

test("historyPaywallPlace: a DM and a thread have their own scope; a channel's carries its name", () => {
  assert.deepEqual(historyPaywallPlace({ type: "channel", name: "roadmap" }), { scope: "channel", channelName: "#roadmap" });
  assert.deepEqual(historyPaywallPlace({ type: "dm", name: "dm-ada" }), { scope: "dm", channelName: undefined });
  assert.deepEqual(historyPaywallPlace({ type: "thread", name: "thread-1" }), { scope: "thread", channelName: undefined });
  assert.deepEqual(historyPaywallPlace(null), { scope: "channel", channelName: undefined });
});
