import assert from "node:assert/strict";
import test from "node:test";
import { findAddMachineConnectedMachine, resolveAddMachineConnectedMachine } from "../src/utils/addMachineConnection";

type Machine = {
  id: string;
  status: "online" | "offline";
  isComputer?: boolean;
  computerAttachedByCurrentUser?: boolean;
};

test("Add Machine waiter accepts the registered daemon machine when it comes online", () => {
  const machines: Machine[] = [
    { id: "daemon-1", status: "online" },
    { id: "computer-old", status: "offline", isComputer: true },
  ];

  const connected = findAddMachineConnectedMachine(machines, "daemon-1", []);

  assert.equal(connected?.id, "daemon-1");
});

test("Add Machine waiter accepts a fresh Computer-linked machine created after waiting starts", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "computer-new", status: "online", isComputer: true, computerAttachedByCurrentUser: true },
  ];

  const connected = findAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [],
  );

  assert.equal(connected?.id, "computer-new");
});

test("Add Machine waiter accepts an existing offline Computer row that resumes online", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "computer-resumed", status: "online", isComputer: true, computerAttachedByCurrentUser: true },
  ];

  const connected = findAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [{ id: "computer-resumed", status: "offline" }],
  );

  assert.equal(connected?.id, "computer-resumed");
});

test("Add Machine waiter ignores already-online Computers from before the wizard started", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "computer-existing", status: "online", isComputer: true, computerAttachedByCurrentUser: true },
  ];

  const connected = findAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [{ id: "computer-existing", status: "online" }],
  );

  assert.equal(connected, null);
});

test("Add Machine waiter ignores unrelated raw daemon rows", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "daemon-other", status: "online" },
  ];

  const connected = findAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [],
  );

  assert.equal(connected, null);
});

test("Add Machine waiter ignores Computer rows not attached by the current user", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "computer-other-user", status: "online", isComputer: true, computerAttachedByCurrentUser: false },
  ];

  const connected = findAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [],
  );

  assert.equal(connected, null);
});

test("Add Machine waiter ignores Computer rows without attached-user proof", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "computer-no-user", status: "online", isComputer: true },
  ];

  const connected = findAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [],
  );

  assert.equal(connected, null);
});

test("Add Machine waiter marks exactly one new current-user Computer as safe fresh", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "computer-new", status: "online", isComputer: true, computerAttachedByCurrentUser: true },
  ];

  const match = resolveAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [],
  );

  assert.equal(match?.machine.id, "computer-new");
  assert.equal(match?.reason, "fresh-single-computer");
  assert.equal(match?.requiresConfirmation, false);
});

test("Add Machine waiter requires confirmation when baseline already had an eligible Computer", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "computer-old", status: "online", isComputer: true, computerAttachedByCurrentUser: true },
    { id: "computer-new", status: "online", isComputer: true, computerAttachedByCurrentUser: true },
  ];

  const match = resolveAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [{ id: "computer-old", status: "online", isComputer: true, computerAttachedByCurrentUser: true }],
  );

  assert.equal(match?.machine.id, "computer-new");
  assert.equal(match?.reason, "resumed-or-ambiguous-computer");
  assert.equal(match?.requiresConfirmation, true);
});

test("Add Machine waiter requires confirmation when setup produces two new current-user Computers", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "computer-new-a", status: "online", isComputer: true, computerAttachedByCurrentUser: true },
    { id: "computer-new-b", status: "online", isComputer: true, computerAttachedByCurrentUser: true },
  ];

  const match = resolveAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [],
  );

  assert.equal(match?.machine.id, "computer-new-a");
  assert.equal(match?.reason, "resumed-or-ambiguous-computer");
  assert.equal(match?.requiresConfirmation, true);
});

test("Add Machine waiter requires confirmation when an existing offline Computer resumes online", () => {
  const machines: Machine[] = [
    { id: "daemon-placeholder", status: "offline" },
    { id: "computer-resumed", status: "online", isComputer: true, computerAttachedByCurrentUser: true },
  ];

  const match = resolveAddMachineConnectedMachine(
    machines,
    "daemon-placeholder",
    [{ id: "computer-resumed", status: "offline" }],
  );

  assert.equal(match?.machine.id, "computer-resumed");
  assert.equal(match?.reason, "resumed-or-ambiguous-computer");
  assert.equal(match?.requiresConfirmation, true);
});
