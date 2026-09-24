import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_ACTIVITY_TAB,
  openConversationAgentActivity,
  openConversationAgentProfile,
} from "../src/utils/profilePanelUrl.js";

/**
 * The activity affordance must land on the ACTIVITY tab — the destination IS
 * the requirement (task #608: "jump straight to that agent's activity").
 *
 * @Jianwei's CHANGES on the previous head: mutating the tab to "profile" left
 * every test green, because they only proved the callback fired and that the
 * hover card closed first. Opening the right panel for the right agent on the
 * WRONG tab looks correct and still fails the request, so the tab choice needs
 * its own tooth.
 */

function captureIntent(open: (openProfile: never, id: string, opts?: never) => void) {
  const calls: Array<{ type: string; id: string; intent?: string; openSource?: string }> = [];
  const spy = ((type: string, id: string, options?: { defaultAgentTabIntent?: string; openSource?: string }) => {
    calls.push({ type, id, intent: options?.defaultAgentTabIntent, openSource: options?.openSource });
  }) as never;
  open(spy, "agent-42", { openSource: "channel" } as never);
  return calls;
}

test("opening an agent's activity targets the activity tab", () => {
  const calls = captureIntent(openConversationAgentActivity as never);
  assert.equal(calls.length, 1, "must open the profile panel exactly once");
  assert.equal(calls[0]!.type, "agent");
  assert.equal(calls[0]!.id, "agent-42");
  assert.equal(
    calls[0]!.intent,
    "activity",
    "the tab intent must be `activity` — any other tab opens the right panel on the wrong thing",
  );
  assert.equal(calls[0]!.openSource, "channel", "the open source must still be forwarded");
});

test("AGENT_ACTIVITY_TAB is the literal the agent panel understands", () => {
  // AgentDetailPanel's AGENT_TABS includes "activity"; an unrecognised id would
  // silently fall back to the default tab, which is the failure this pins.
  assert.equal(AGENT_ACTIVITY_TAB, "activity");
});

test("opening a plain agent profile still defers to the user's tab order", () => {
  // Guards the sibling path: the new seam must not have changed how an ordinary
  // mention click chooses its tab.
  const calls = captureIntent(openConversationAgentProfile as never);
  assert.equal(calls[0]!.intent, "ordered-first");
});
