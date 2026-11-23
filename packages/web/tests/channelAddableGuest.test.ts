import assert from "node:assert/strict";
import { test } from "vitest";
import { isAddableToChannel, isAddableToNewChannel } from "../src/utils/channelLocalMembership";

// The add pickers' rule mirrors the server's addHuman (#15347): a Guest may be
// added only to its own bound channel, never to a joint one.
const bound = { id: "ch-bound", name: "bound" };

test("a member or an admin is addable anywhere", () => {
  assert.equal(isAddableToChannel({ role: "member" }, { id: "ch-other", type: "channel" }), true);
  assert.equal(isAddableToChannel({ role: "admin" }, { id: "ch-joint", type: "joint" }), true);
});

test("a Guest is addable only to its own bound, non-joint channel", () => {
  assert.equal(isAddableToChannel({ role: "guest", guestChannel: bound }, { id: "ch-bound", type: "channel" }), true);
  assert.equal(isAddableToChannel({ role: "guest", guestChannel: bound }, { id: "ch-other", type: "channel" }), false);
});

test("a Guest is never addable to a joint channel, even its bound one", () => {
  assert.equal(isAddableToChannel({ role: "guest", guestChannel: bound }, { id: "ch-bound", type: "joint" }), false);
});

test("a Guest whose binding is unknown, or with no channel, is left out", () => {
  assert.equal(isAddableToChannel({ role: "guest" }, { id: "ch-bound", type: "channel" }), false);
  assert.equal(isAddableToChannel({ role: "guest", guestChannel: null }, { id: "ch-bound", type: "channel" }), false);
  assert.equal(isAddableToChannel({ role: "guest", guestChannel: bound }, null), false);
});

test("no Guest is addable to a new channel; a member or an admin is (#15358)", () => {
  assert.equal(isAddableToNewChannel({ role: "guest" }), false);
  assert.equal(isAddableToNewChannel({ role: "member" }), true);
  assert.equal(isAddableToNewChannel({ role: "admin" }), true);
});
