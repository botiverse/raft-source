import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveComputerConnectionProgress } from "../src/utils/computerConnectionProgress";
import type { AddMachineConnectionBaseline } from "../src/utils/addMachineConnection";

type Machine = {
  id: string;
  status: "online" | "offline";
  isComputer?: boolean;
  computerAttachedByCurrentUser?: boolean;
};

const owned = (id: string, status: "online" | "offline"): Machine => ({
  id,
  status,
  isComputer: true,
  computerAttachedByCurrentUser: true,
});

const baselineOf = (machines: Machine[]): AddMachineConnectionBaseline[] =>
  machines.map((m) => ({
    id: m.id,
    status: m.status,
    isComputer: m.isComputer,
    computerAttachedByCurrentUser: m.computerAttachedByCurrentUser,
  }));

test("nothing has happened yet on a fresh server", () => {
  const progress = resolveComputerConnectionProgress<Machine>([], "", []);
  assert.equal(progress.state, "idle");
  assert.equal(progress.machine, null);
});

test("a new computer row that is not online yet reads as waiting", () => {
  const progress = resolveComputerConnectionProgress([owned("c1", "offline")], "", []);
  assert.equal(progress.state, "waiting");
  assert.equal(progress.machine?.id, "c1");
});

test("the new computer coming online reads as connected, unambiguously", () => {
  const progress = resolveComputerConnectionProgress([owned("c1", "online")], "", []);
  assert.equal(progress.state, "connected");
  assert.equal(progress.machine?.id, "c1");
  assert.equal(progress.requiresConfirmation, false);
});

// The bug the onboarding gate shipped with: it picked
// `machines.find(isComputer) ?? machines[0]`, so a plain daemon row — or another
// member's computer — was reported as the computer this user was connecting.
test("a plain non-computer daemon row is NOT mistaken for this attempt", () => {
  const daemon: Machine = { id: "daemon", status: "offline" };
  const progress = resolveComputerConnectionProgress([daemon], "", baselineOf([daemon]));
  assert.equal(progress.state, "idle", "a daemon row is not this user's computer");
  assert.equal(progress.machine, null);
});

test("a computer belonging to someone else is not adopted", () => {
  const theirs: Machine = { id: "theirs", status: "online", isComputer: true, computerAttachedByCurrentUser: false };
  const progress = resolveComputerConnectionProgress([theirs], "", []);
  assert.equal(progress.state, "idle");
});

// Ownership, not novelty: reloading the page mid-connect must not throw the user
// back to the setup instructions for a computer they have already attached.
test("an owned offline computer still reads as waiting after a page reload", () => {
  const mine = owned("c1", "offline");
  const progress = resolveComputerConnectionProgress([mine], "", baselineOf([mine]));
  assert.equal(progress.state, "waiting");
  assert.equal(progress.machine?.id, "c1");
});

test("a computer already online before we started still reads as connected", () => {
  // The gate keeps showing this surface when a computer is online but has no
  // usable runtime. Reporting idle there would ask the user to set up a
  // computer they already have.
  const existing = owned("c1", "online");
  const progress = resolveComputerConnectionProgress([existing], "", baselineOf([existing]));
  assert.equal(progress.state, "connected");
  assert.equal(progress.machine?.id, "c1");
});

test("the registered placeholder row is tracked while it comes up", () => {
  const placeholder: Machine = { id: "placeholder", status: "offline" };
  const progress = resolveComputerConnectionProgress([placeholder], "placeholder", []);
  assert.equal(progress.state, "waiting");
  assert.equal(progress.machine?.id, "placeholder");
});

test("the registered placeholder coming online reads as connected", () => {
  const placeholder: Machine = { id: "placeholder", status: "online" };
  const progress = resolveComputerConnectionProgress([placeholder], "placeholder", []);
  assert.equal(progress.state, "connected");
  assert.equal(progress.machine?.id, "placeholder");
});

test("resuming a computer that already existed is flagged as ambiguous", () => {
  const resumed = owned("c1", "offline");
  const progress = resolveComputerConnectionProgress(
    [owned("c1", "online")],
    "",
    baselineOf([resumed]),
  );
  assert.equal(progress.state, "connected");
  assert.equal(progress.requiresConfirmation, true, "we cannot be sure this is the one they just set up");
});
