import assert from "node:assert/strict";
import { getServerCapabilities } from "@botiverse/raft-shared";
import type { ServerCapabilities } from "@botiverse/raft-shared";
import { canControlComputer, canManageMachine } from "../src/utils/canManageMachine";

// Restart and Upgrade call `/computer/:action`, which accepts the machine's
// creator or `controlComputers` only (routes/servers.ts). The web gate must
// not offer them to the rest of canManageMachine, who would get a 403.
const none = getServerCapabilities(null);
const caps = (extra: Partial<Record<keyof ServerCapabilities, boolean>>): ServerCapabilities => ({ ...none, ...extra });
const machine = (creatorId: string | null, attachedByMe = false) => ({
  creator: creatorId ? { id: creatorId } : null,
  computerAttachedByCurrentUser: attachedByMe,
}) as Parameters<typeof canControlComputer>[0];

test("an agent creator manages the machine but may not restart it", () => {
  const c = caps({ createAgents: true });
  assert.equal(canManageMachine(machine("someone-else"), "me", c), true);
  assert.equal(canControlComputer(machine("someone-else"), "me", c), false);
});

test("migrate, edit, remove and rotate-key roles may not restart it either", () => {
  for (const key of ["migrateAgents", "editMachines", "removeMachines", "rotateMachineKeys"] as const) {
    assert.equal(canControlComputer(machine("someone-else"), "me", caps({ [key]: true })), false, key);
  }
});

test("controlComputers, the creator and the person who attached it may restart it", () => {
  assert.equal(canControlComputer(machine("someone-else"), "me", caps({ controlComputers: true })), true);
  assert.equal(canControlComputer(machine("me"), "me", none), true);
  assert.equal(canControlComputer(machine("someone-else", true), "me", none), true);
});

test("no signed-in user and no capability: no restart", () => {
  assert.equal(canControlComputer(machine("me"), null, none), false);
});

// controlledByCurrentUser: the server's controller (computerControllerUserId), the live attacher only.
test("the live attacher, by the server's flag, manages and restarts it", () => {
  const live = { creator: null, computerAttachedByCurrentUser: false, controlledByCurrentUser: true, isComputer: true } as Parameters<typeof canControlComputer>[0];
  assert.equal(canManageMachine(live, "me", none), true);
  assert.equal(canControlComputer(live, "me", none), true);
});

test("a revoked Computer or a raw daemon has no controller: a plain member gets nothing, owner/admin capabilities still do", () => {
  // What the server sends for either now: no live attacher, so no flag, attacher or creator.
  const uncontrolled = { creator: null, computerAttachedByCurrentUser: false, controlledByCurrentUser: false, isComputer: false } as Parameters<typeof canControlComputer>[0];
  assert.equal(canManageMachine(uncontrolled, "me", none), false);
  assert.equal(canControlComputer(uncontrolled, "me", none), false);
  assert.equal(canManageMachine(uncontrolled, "me", caps({ editMachines: true, removeMachines: true })), true);
  assert.equal(canControlComputer(uncontrolled, "me", caps({ controlComputers: true })), true);
  // An older server still flagged the revoked controller: restart stays hidden for a non-Computer.
  assert.equal(canControlComputer({ ...uncontrolled, controlledByCurrentUser: true }, "me", none), false);
});
