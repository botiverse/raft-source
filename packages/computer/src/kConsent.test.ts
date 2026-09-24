import assert from "node:assert/strict";
import { test } from "vitest";

import { requestKTargetConsent } from "./kConsent.js";

test("K target consent names and approves only the exact resolved version", async () => {
  let prompt = "";
  assert.equal(await requestKTargetConsent("1.1.0", {
    isInteractive: () => true,
    ask: async (value) => {
      prompt = value;
      return "yes";
    },
  }), "confirmed");
  assert.equal(prompt, "Install Raft Computer 1.1.0? [y/N] ");
});

test("K target consent defaults to no and fails closed without a terminal", async () => {
  assert.equal(await requestKTargetConsent("1.1.0", {
    isInteractive: () => true,
    ask: async () => "",
  }), "declined");
  assert.equal(await requestKTargetConsent("1.1.0", {
    isInteractive: () => false,
    ask: async () => { throw new Error("non-interactive flows must not prompt"); },
  }), "non-interactive");
});
