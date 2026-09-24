import assert from "node:assert/strict";
import { test } from "vitest";
import { planResetActions, type ResetPlanAction, type ResetPlanInput } from "./agentOrchestrator.js";

type ResetPlanCase = {
  name: string;
  input: ResetPlanInput;
  expected: ResetPlanAction[];
};

const cases: ResetPlanCase[] = [
  {
    name: "restart reset stops and restarts without clearing session",
    input: { mode: "restart", hasMachine: true },
    expected: ["stop-internal", "restart"],
  },
  {
    name: "session reset clears session and restarts",
    input: { mode: "session", hasMachine: true },
    expected: ["stop-internal", "clear-session", "restart"],
  },
  {
    name: "session reset can clear session without restarting",
    input: { mode: "session", hasMachine: true, restart: false },
    expected: ["stop-internal", "clear-session"],
  },
  {
    name: "full reset with machine clears session, resets workspace, and restarts",
    input: { mode: "full", hasMachine: true },
    expected: ["stop-internal", "clear-session", "reset-workspace", "restart"],
  },
  {
    name: "full reset without machine skips workspace reset but still clears session and restarts",
    input: { mode: "full", hasMachine: false },
    expected: ["stop-internal", "clear-session", "restart"],
  },
];

for (const c of cases) {
  test(`planResetActions: ${c.name}`, () => {
    assert.deepEqual(planResetActions(c.input), c.expected);
  });
}
