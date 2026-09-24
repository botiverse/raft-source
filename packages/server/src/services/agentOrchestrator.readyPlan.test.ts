import assert from "node:assert/strict";
import { test } from "vitest";
import {
  narrowReadyReconcileStatus,
  planReadyReconcileAction,
  type ReadyReconcilePlanAction,
  type ReadyReconcilePlanInput,
} from "./agentOrchestrator.js";

type ReadyPlanCase = {
  name: string;
  input: ReadyReconcilePlanInput;
  expected: ReadyReconcilePlanAction;
};

const cases: ReadyPlanCase[] = [
  {
    name: "running active agent stays active",
    input: { status: "active", running: true, resetMode: null },
    expected: "mark-active-online",
  },
  {
    name: "running inactive agent is marked active again",
    input: { status: "inactive", running: true, resetMode: null },
    expected: "mark-active-online",
  },
  {
    name: "running stopped agent is forced back offline",
    input: { status: "stopped", running: true, resetMode: null },
    expected: "force-stop-and-stay-offline",
  },
  {
    name: "running agent under restart reset is forced back offline",
    input: { status: "active", running: true, resetMode: "restart" },
    expected: "force-stop-and-stay-offline",
  },
  {
    name: "running agent under session reset is forced back offline",
    input: { status: "active", running: true, resetMode: "session" },
    expected: "force-stop-and-stay-offline",
  },
  {
    name: "running agent under full reset is forced back offline",
    input: { status: "inactive", running: true, resetMode: "full" },
    expected: "force-stop-and-stay-offline",
  },
  {
    name: "missing active agent stays wakeable instead of eager-started or offline",
    input: { status: "active", running: false, resetMode: null },
    expected: "mark-wakeable-not-running",
  },
  {
    name: "missing active agent under reset is marked inactive instead of wakeable",
    input: { status: "active", running: false, resetMode: "session" },
    expected: "mark-inactive-offline",
  },
  {
    name: "missing inactive agent stays offline",
    input: { status: "inactive", running: false, resetMode: null },
    expected: "stay-offline",
  },
  {
    name: "missing stopped agent stays offline",
    input: { status: "stopped", running: false, resetMode: null },
    expected: "stay-offline",
  },
];

for (const c of cases) {
  test(`planReadyReconcileAction: ${c.name}`, () => {
    assert.equal(planReadyReconcileAction(c.input), c.expected);
  });
}

test("narrowReadyReconcileStatus accepts known agent statuses", () => {
  assert.equal(narrowReadyReconcileStatus("active"), "active");
  assert.equal(narrowReadyReconcileStatus("inactive"), "inactive");
  assert.equal(narrowReadyReconcileStatus("stopped"), "stopped");
});

test("narrowReadyReconcileStatus rejects unknown persisted statuses", () => {
  assert.equal(narrowReadyReconcileStatus("sleeping"), null);
});
