import "./helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AgentUsageNoFigures } from "../src/features/agent/AgentUsageSections";
import type { UsageUnreportedReason } from "../src/features/agent/agentUsage";
import { useAgentStore } from "../src/store/agentStore";
import { renderWithIntl } from "./helpers/intl";

// The Usage tab with no usage reported: "Update Raft Computer" and the way to
// the Computer only when updating it helps (too old, or an older server that
// doesn't say); an agent that hasn't run yet, or runs on no Computer, gets its
// own line and no button, even when it has a Computer.

const AGENT = "agent-1";

afterEach(() => {
  cleanup();
  useAgentStore.setState({ agents: [] });
});

function show(reason: UsageUnreportedReason) {
  useAgentStore.setState({ agents: [{ id: AGENT, machineId: "machine-1" }] as never });
  renderWithIntl(
    <MemoryRouter>
      <AgentUsageNoFigures summary={{ kind: "unsupported", reason }} agentId={AGENT} range={7} />
    </MemoryRouter>,
  );
}

for (const reason of ["computer_too_old", "unknown"] as const) {
  test(`${reason}: Update Raft Computer, with Open computer`, () => {
    show(reason);
    assert.equal(screen.getByTestId("agent-usage-unsupported").textContent?.includes("Update Raft Computer to see usage."), true);
    assert.ok(screen.getByRole("button", { name: "Open computer" }));
  });
}

const WITHOUT_BUTTON = [
  ["not_run", "agent-usage-not-run", "No usage yet. It shows after this agent's next turn."],
  ["no_computer", "agent-usage-no-computer", "This agent doesn't run on a Raft Computer, so it has no usage to show."],
  ["runtime_no_usage", "agent-usage-runtime-no-usage", "This agent's runtime doesn't report token usage, so there is none to show."],
] as const;

for (const [reason, testId, line] of WITHOUT_BUTTON) {
  test(`${reason}: its own line and no button`, () => {
    show(reason);
    assert.equal(screen.getByTestId(testId).textContent, line);
    assert.ok(screen.queryByTestId("agent-usage-unsupported") === null, "not the Update state");
    assert.ok(screen.queryByRole("button") === null, "no Open computer button");
  });
}
