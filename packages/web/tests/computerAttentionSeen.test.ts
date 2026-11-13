import assert from "node:assert/strict";

import {
  computerAttentionKey,
  computerAttentionPairs,
  hasUnseenComputerAttention,
  markComputerAttentionSeen,
  parseComputerAttentionKey,
  pruneComputerAttentionSeen,
} from "../src/utils/computerAttentionSeen";
import type { ComputerAttentionMachine } from "../src/utils/computerUpgradeIndicator";

// Raft DS › Attention dots (raft-design #620): the Computers dot marks a
// change you have not seen, not a lasting state.

const online = (id: string): ComputerAttentionMachine => ({ id, status: "online", isComputer: true });
const offline = (id: string): ComputerAttentionMachine => ({ id, status: "offline", isComputer: true });
const outdated = (id: string, status = "online"): ComputerAttentionMachine => ({
  id,
  status,
  isComputer: true,
  computerUpgradeAvailable: true,
});

/** One observation of the machine list: prune, then read the dot. */
function observe(seen: string[], machines: ComputerAttentionMachine[]) {
  const pairs = computerAttentionPairs(machines);
  const pruned = pruneComputerAttentionSeen(seen, pairs);
  return { seen: pruned, dot: hasUnseenComputerAttention(pairs, pruned), pairs };
}

test("healthy computers never light the dot", () => {
  assert.equal(observe([], [online("a"), online("b")]).dot, false);
  assert.equal(observe([], []).dot, false);
});

test("entering an attention state lights the dot; opening Computers sees it", () => {
  const entered = observe([], [offline("a")]);
  assert.equal(entered.dot, true);
  const seen = markComputerAttentionSeen(entered.pairs);
  assert.equal(observe(seen, [offline("a")]).dot, false);
});

test("the same computer in the same state does not light it again", () => {
  let seen = markComputerAttentionSeen(computerAttentionPairs([outdated("a")]));
  for (let i = 0; i < 3; i++) {
    const next = observe(seen, [outdated("a"), online("b")]);
    assert.equal(next.dot, false);
    seen = next.seen;
  }
});

test("back online, then offline again, lights it again", () => {
  let seen = markComputerAttentionSeen(computerAttentionPairs([offline("a")]));
  const backOnline = observe(seen, [online("a")]);
  assert.equal(backOnline.dot, false);
  assert.deepEqual(backOnline.seen, [], "leaving the state drops its seen entry");
  seen = backOnline.seen;
  assert.equal(observe(seen, [offline("a")]).dot, true);
});

test("a new attention state on a seen computer lights it again", () => {
  const seen = markComputerAttentionSeen(computerAttentionPairs([offline("a")]));
  assert.equal(observe(seen, [outdated("a", "offline")]).dot, true);
});

test("another computer needing attention lights it again", () => {
  const seen = markComputerAttentionSeen(computerAttentionPairs([offline("a")]));
  assert.equal(observe(seen, [offline("a"), offline("b")]).dot, true);
  assert.equal(observe(seen, [offline("a"), outdated("c")]).dot, true);
});

test("a legacy daemon's upgrade flag is not an attention state; offline still is", () => {
  const legacy = { id: "d", status: "offline", isComputer: false, computerUpgradeAvailable: true };
  assert.deepEqual(computerAttentionPairs([legacy]).map((p) => p.split("\u0000")[1]), ["offline"]);
});

test("the attention key round-trips and is order-independent", () => {
  const machines = [offline("b"), outdated("a", "offline")];
  const key = computerAttentionKey(machines);
  assert.equal(key, computerAttentionKey([...machines].reverse()));
  assert.deepEqual(parseComputerAttentionKey(key), computerAttentionPairs(machines));
  assert.deepEqual(parseComputerAttentionKey(""), []);
});
