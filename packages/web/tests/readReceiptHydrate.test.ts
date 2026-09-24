import assert from "node:assert/strict";
import test from "node:test";
import type { Channel } from "../src/store/channelStore";
import { isReadReceiptScopeEligible } from "../src/hooks/useReadReceiptHydrate";

function channel(type: Channel["type"], name = "general"): Channel {
  return {
    id: `${type}-1`,
    name,
    description: null,
    type,
    createdAt: "2026-07-11T00:00:00.000Z",
  };
}

test("read receipt hydrate is limited to server-supported conversation scopes", () => {
  assert.equal(isReadReceiptScopeEligible(channel("channel")), true);
  assert.equal(isReadReceiptScopeEligible(channel("private")), true);
  assert.equal(isReadReceiptScopeEligible(channel("dm")), true);
  assert.equal(isReadReceiptScopeEligible(channel("joint")), false);
  assert.equal(isReadReceiptScopeEligible(channel("thread")), false);
  assert.equal(isReadReceiptScopeEligible(channel("channel", "all")), false);
  assert.equal(isReadReceiptScopeEligible(null), false);
});
