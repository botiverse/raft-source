import assert from "node:assert/strict";
import { test } from "vitest";

import { deriveDefaultComputerName } from "./paths.js";

test("deriveDefaultComputerName: strips common local-network suffixes", () => {
  assert.equal(deriveDefaultComputerName("MacBook-Pro.local"), "MacBook-Pro");
  assert.equal(deriveDefaultComputerName("devbox.fritz.box"), "devbox");
  assert.equal(deriveDefaultComputerName("runner.localdomain"), "runner");
  assert.equal(deriveDefaultComputerName("labbox.lan"), "labbox");
  assert.equal(deriveDefaultComputerName("homebox.home"), "homebox");
});

test("deriveDefaultComputerName: normalizes spaces and quotes", () => {
  assert.equal(deriveDefaultComputerName("August's MacBook"), "August-s-MacBook");
  assert.equal(deriveDefaultComputerName('QA "Rig"'), "QA-Rig");
  assert.equal(deriveDefaultComputerName("Build Box   "), "Build-Box");
});

test("deriveDefaultComputerName: empty result falls back to stable hash suffix", () => {
  assert.match(deriveDefaultComputerName(".local"), /^raft-computer-[0-9a-f]{8}$/);
  assert.equal(deriveDefaultComputerName(".local"), deriveDefaultComputerName(".local"));
});
