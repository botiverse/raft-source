import assert from "node:assert/strict";
import test from "node:test";
import type { Channel } from "../src/store/channelStore.js";

const mem = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
    removeItem: (key: string) => void mem.delete(key),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage,
  configurable: true,
});

const { canForwardToTarget, getForwardTargets } = await import("../src/components/message/ForwardComposerDialog.js");
const { forwardRequestFailureMessage } = await import("../src/components/message/forwardComposerModel.js");

function channel(overrides: Partial<Channel> & { id: string; name: string }): Channel {
  return {
    id: overrides.id,
    name: overrides.name,
    description: null,
    type: "channel",
    createdAt: "2026-06-30T00:00:00.000Z",
    archivedAt: null,
    archivedByUserId: null,
    joined: true,
    ...overrides,
  } as Channel;
}

test("forward composer only offers active sendable destinations", () => {
  assert.equal(canForwardToTarget(channel({ id: "active", name: "active", joined: true })), true);
  assert.equal(canForwardToTarget(channel({ id: "private", name: "private", type: "private", joined: true })), true);
  assert.equal(canForwardToTarget(channel({ id: "joint", name: "joint", type: "joint", joined: true })), true);
  assert.equal(canForwardToTarget(channel({ id: "dm", name: "Ada", type: "dm", joined: false })), true);

  assert.equal(
    canForwardToTarget(channel({ id: "archived", name: "archived", archivedAt: "2026-06-30T01:00:00.000Z" })),
    false,
    "archived channels are visible elsewhere for history but are not forward destinations",
  );
  assert.equal(
    canForwardToTarget(channel({ id: "unjoined", name: "unjoined", joined: false })),
    false,
    "unjoined channels are not sendable destinations",
  );
  assert.equal(
    canForwardToTarget(channel({ id: "locked-joint", name: "locked-joint", type: "joint", jointBillingLocked: true })),
    false,
    "billing-locked joint channels are read-only destinations",
  );
  assert.equal(
    canForwardToTarget(channel({ id: "thread", name: "thread", type: "thread", joined: true })),
    false,
    "thread forwarding is a separate surface and not a destination in this picker",
  );
});

test("forward composer lists destinations once in recent order", () => {
  const alpha = channel({ id: "alpha", name: "alpha", joined: true, createdAt: "2026-06-30T00:00:00.000Z" });
  const beta = channel({ id: "beta", name: "beta", joined: true, createdAt: "2026-06-30T00:01:00.000Z" });
  const gamma = channel({ id: "gamma", name: "gamma", type: "private", joined: true, createdAt: "2026-06-30T00:02:00.000Z" });
  const delta = channel({ id: "delta", name: "delta", type: "joint", joined: true, createdAt: "2026-06-30T00:03:00.000Z" });
  const erin = channel({
    id: "dm-erin",
    name: "Erin",
    type: "dm",
    peerName: "erin",
    peerDisplayName: "Erin",
    joined: false,
    createdAt: "2026-06-30T00:04:00.000Z",
  });
  const frank = channel({
    id: "dm-frank",
    name: "Frank",
    type: "dm",
    peerName: "frank",
    peerDisplayName: "Frank",
    joined: false,
    createdAt: "2026-06-30T00:05:00.000Z",
  });

  const targets = getForwardTargets([alpha, beta, gamma, delta], [erin, frank], "", {
    alpha: "2026-06-30T00:10:00.000Z",
    beta: "2026-06-30T00:14:00.000Z",
    gamma: "2026-06-30T00:11:00.000Z",
    delta: "2026-06-30T00:13:00.000Z",
    "dm-erin": "2026-06-30T00:15:00.000Z",
    "dm-frank": "2026-06-30T00:12:00.000Z",
  });

  assert.deepEqual(targets.map((target) => target.id), ["dm-erin", "beta", "delta", "dm-frank", "gamma", "alpha"]);
  assert.equal(new Set(targets.map((target) => target.id)).size, targets.length);
});

test("Forward diagnostics do not change the existing user-facing failure mapping", () => {
  const formatMessage = ({ id }: { id: string }) => id;
  assert.equal(
    forwardRequestFailureMessage({ response: { data: { code: "source_not_found" } } }, formatMessage as never),
    "message.forwardComposer.sourceNotFound",
  );
  for (const error of [
    new Error("network"),
    { response: { status: 401, data: {} } },
    { response: { status: 409, data: { code: "authority_changed" } } },
    { response: { status: 500, data: {} } },
  ]) {
    assert.equal(
      forwardRequestFailureMessage(error, formatMessage as never),
      "message.forwardComposer.uncertainOutcome",
    );
  }
});
