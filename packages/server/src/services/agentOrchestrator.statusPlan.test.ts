import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildAgentLifecycleStateSnapshot,
  normalizeDaemonAgentStatus,
  planStatusSignalAction,
  type DaemonReportedAgentStatus,
  type StatusSignalPlanAction,
  type StatusSignalPlanInput,
} from "./agentOrchestrator.js";

type StatusPlanCase = {
  name: string;
  input: StatusSignalPlanInput;
  expected: StatusSignalPlanAction;
};

function input(
  currentStatus: Parameters<typeof buildAgentLifecycleStateSnapshot>[0]["dbStatus"],
  reportedStatus: DaemonReportedAgentStatus,
  resetMode: "restart" | "session" | "full" | null = null,
  launchId?: string,
): StatusSignalPlanInput {
  return {
    reportedStatus,
    state: buildAgentLifecycleStateSnapshot({ dbStatus: currentStatus, resetMode, launchId }),
  };
}

const cases: StatusPlanCase[] = [
  {
    name: "active signal for active agent persists active",
    input: input("active", "active"),
    expected: "persist-active",
  },
  {
    name: "active signal for stopped agent is ignored but still releases wake lock",
    input: input("stopped", "active"),
    expected: "ignore-and-release-wake-lock",
  },
  {
    name: "active signal during reset is ignored",
    input: input("active", "active", "session"),
    expected: "ignore",
  },
  {
    name: "active signal for the current guarded launch is accepted during reset",
    input: input("active", "active", "session", "launch-1"),
    expected: "persist-active",
  },
  {
    name: "inactive signal for active agent persists inactive",
    input: input("active", "inactive"),
    expected: "persist-inactive",
  },
  {
    name: "inactive signal preserves stopped state",
    input: input("stopped", "inactive"),
    expected: "persist-stopped",
  },
  {
    name: "unknown signal is ignored",
    input: input("active", null),
    expected: "ignore",
  },
];

for (const c of cases) {
  test(`planStatusSignalAction: ${c.name}`, () => {
    assert.equal(planStatusSignalAction(c.input), c.expected);
  });
}

test("normalizeDaemonAgentStatus maps sleeping to active", () => {
  assert.equal(normalizeDaemonAgentStatus("sleeping"), "active");
});

test("normalizeDaemonAgentStatus rejects unknown daemon status values", () => {
  assert.equal(normalizeDaemonAgentStatus("paused"), null);
});
