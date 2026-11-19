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

// controlledByCurrentUser: the server's controller (computerControllerUserId), still set after the key is revoked.
test("the controller manages a revoked Computer (rename, description) but may not restart it: the route refuses a non-Computer", () => {
  const revoked = { creator: null, computerAttachedByCurrentUser: false, controlledByCurrentUser: true, isComputer: false } as Parameters<typeof canControlComputer>[0];
  assert.equal(canManageMachine(revoked, "me", none), true);
  assert.equal(canControlComputer(revoked, "me", none), false);
  const live = { ...revoked, isComputer: true };
  assert.equal(canControlComputer(live, "me", none), true);
  const notController = { ...revoked, controlledByCurrentUser: false };
  assert.equal(canManageMachine(notController, "me", none), false);
});
