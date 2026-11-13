import assert from "node:assert/strict";
import { isMyComputer, orderMachinesLikeSidebar, orderSidebarMachineIds } from "../src/components/layout/sidebarMachineOrder";

// Task #124 follow-up: the sidebar's Computers list puts this device (the
// machine Raft Desktop runs on) first, then the user's own computers,
// then the rest — each group in the server's stable order. "Mine" is one I
// attached or one I own (artin, #triage:#332): isMyComputer.

const m = (id: string, mine = false) => ({ id, computerAttachedByCurrentUser: mine });

test("no pin: my computers first, then others, both stable", () => {
  assert.deepEqual(
    orderSidebarMachineIds([m("a"), m("b", true), m("c"), m("d", true)], null, "me"),
    ["b", "d", "a", "c"],
  );
});

test("the pinned machine leads even when it is not mine; the rest keeps its groups", () => {
  assert.deepEqual(
    orderSidebarMachineIds([m("a"), m("b", true), m("c"), m("d", true)], "c", "me"),
    ["c", "b", "d", "a"],
  );
  assert.deepEqual(
    orderSidebarMachineIds([m("a"), m("b", true), m("c"), m("d", true)], "d", "me"),
    ["d", "b", "a", "c"],
  );
});

test("a pin that matches no machine changes nothing; empty input stays empty", () => {
  assert.deepEqual(orderSidebarMachineIds([m("a"), m("b", true)], "zzz", "me"), ["b", "a"]);
  assert.deepEqual(orderSidebarMachineIds([], "a", "me"), []);
});

test("orderMachinesLikeSidebar returns the machines themselves in the Computers list's order", () => {
  const machines = [
    { id: "a", computerAttachedByCurrentUser: false, name: "A" },
    { id: "b", computerAttachedByCurrentUser: true, name: "B" },
    { id: "c", computerAttachedByCurrentUser: false, name: "C" },
  ];
  assert.deepEqual(orderMachinesLikeSidebar(machines, "c", "me").map((m) => m.name), ["C", "B", "A"]);
  assert.deepEqual(orderMachinesLikeSidebar(machines, null, "me").map((m) => m.name), ["B", "A", "C"]);
});

test("mine is a computer I attached or one I own; a Public one (no owner) I didn't attach is not", () => {
  assert.equal(isMyComputer({ computerAttachedByCurrentUser: true, ownerUserId: "someone" }, "me"), true);
  assert.equal(isMyComputer({ computerAttachedByCurrentUser: false, ownerUserId: "me" }, "me"), true);
  assert.equal(isMyComputer({ computerAttachedByCurrentUser: false, ownerUserId: null }, "me"), false);
  assert.equal(isMyComputer({ computerAttachedByCurrentUser: false, ownerUserId: "someone" }, "me"), false);
  // Signed out (no user id): only the attach flag counts, never a null owner.
  assert.equal(isMyComputer({ computerAttachedByCurrentUser: false, ownerUserId: null }, null), false);
});

test("a computer I own but did not attach goes with mine; a Public one stays with the rest", () => {
  const machines = [
    { id: "public", computerAttachedByCurrentUser: false, ownerUserId: null },
    { id: "owned", computerAttachedByCurrentUser: false, ownerUserId: "me" },
    { id: "theirs", computerAttachedByCurrentUser: false, ownerUserId: "someone" },
    { id: "attached", computerAttachedByCurrentUser: true, ownerUserId: null },
  ];
  assert.deepEqual(orderSidebarMachineIds(machines, null, "me"), ["owned", "attached", "public", "theirs"]);
  assert.deepEqual(orderSidebarMachineIds(machines, "theirs", "me"), ["theirs", "owned", "attached", "public"]);
});
