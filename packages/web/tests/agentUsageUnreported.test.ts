import assert from "node:assert/strict";
import type { AgentUsageAgent, AgentUsageResponse } from "@botiverse/raft-shared";
import { USAGE_UNREPORTED_STATE, summarizeAgentUsage, usageUnreportedReason } from "../src/features/agent/agentUsage";
import type { UsageUnreportedReason } from "../src/features/agent/agentUsage";
import { USAGE_NOTE, summarizeMembersUsage } from "../src/features/members/membersAgentUsageModel";
import { en } from "../src/i18n/messages/en";

// An agent with no usage reported (`usage_reported: false`) reads differently
// by the server's `computer_reports_usage`: its Computer is too old (false),
// it has not run yet (true), it runs on no Computer (null); an older server
// omits the field and the page shows what it showed before.

const AGENT = "agent-1";
const VIEW = { range: 7, day: null } as const;

function answer(agent: Partial<AgentUsageAgent>): AgentUsageResponse {
  return {
    from: "2026-10-18",
    to: "2026-10-31",
    as_of: "2026-10-31T11:00:00.000Z",
    since: "2026-10-01",
    visible_agents: 1,
    agents: [{ agent_id: AGENT, since: null, usage_reported: false, ...agent }],
    rows: [],
    context: [],
  };
}

const CASES: readonly [label: string, agent: Partial<AgentUsageAgent>, reason: UsageUnreportedReason][] = [
  ["false: the Computer is too old", { computer_reports_usage: false }, "computer_too_old"],
  ["true: it has not run yet", { computer_reports_usage: true }, "not_run"],
  ["null: it runs on no Computer", { computer_reports_usage: null }, "no_computer"],
  ["absent: an older server", {}, "unknown"],
  ["runtime false wins over a new enough Computer", { computer_reports_usage: true, runtime_reports_usage: false }, "runtime_no_usage"],
  ["runtime false wins over an old Computer", { computer_reports_usage: false, runtime_reports_usage: false }, "runtime_no_usage"],
  ["runtime true changes nothing", { computer_reports_usage: false, runtime_reports_usage: true }, "computer_too_old"],
];

for (const [label, agent, reason] of CASES) {
  test(`computer_reports_usage ${label} is "${reason}" in the tab's summary and the Members row`, () => {
    const response = answer(agent);
    assert.equal(usageUnreportedReason(response, AGENT), reason);
    assert.deepEqual(summarizeAgentUsage(response, AGENT, VIEW, false), { kind: "unsupported", reason });
    const row = summarizeMembersUsage(response, new Set([AGENT]), VIEW, false).rows.get(AGENT);
    assert.equal(row?.noUsage, reason);
    assert.equal(row?.tokens, null);
  });
}

test("a wire value that is not true, false or null is unknown", () => {
  for (const value of ["true", 0, 1, {}]) {
    assert.equal(usageUnreportedReason(answer({ computer_reports_usage: value as never }), AGENT), "unknown");
  }
  assert.equal(usageUnreportedReason(answer({}), "another-agent"), "unknown");
});

test("an agent with usage reported has no reason on its Members row, whatever its Computer", () => {
  const response = answer({ usage_reported: true, since: "2026-10-20", computer_reports_usage: false });
  assert.equal(summarizeMembersUsage(response, new Set([AGENT]), VIEW, false).rows.get(AGENT)?.noUsage, null);
  assert.equal(summarizeAgentUsage(response, AGENT, VIEW, false).kind, "empty");
});

test("the Usage tab: Update with the way to the Computer only when updating helps", () => {
  const shown = (reason: UsageUnreportedReason) => {
    const state = USAGE_UNREPORTED_STATE[reason];
    return [en[state.titleId], state.testId, state.offersComputer];
  };
  assert.deepEqual(shown("computer_too_old"), ["Update Raft Computer to see usage.", "agent-usage-unsupported", true]);
  assert.deepEqual(shown("unknown"), shown("computer_too_old"));
  assert.deepEqual(shown("not_run"), ["No usage yet. It shows after this agent's next turn.", "agent-usage-not-run", false]);
  assert.deepEqual(shown("no_computer"), ["This agent doesn't run on a Raft Computer, so it has no usage to show.", "agent-usage-no-computer", false]);
  assert.deepEqual(shown("runtime_no_usage"), ["This agent's runtime doesn't report token usage, so there is none to show.", "agent-usage-runtime-no-usage", false]);
});

test("the Members row's note for each reason", () => {
  const note = (reason: UsageUnreportedReason) => [en[USAGE_NOTE[reason].labelId], USAGE_NOTE[reason].testId];
  assert.deepEqual(note("computer_too_old"), ["Computer needs an update", "members-usage-computer-too-old"]);
  assert.deepEqual(note("not_run"), ["No usage yet", "members-usage-no-usage"]);
  assert.deepEqual(note("no_computer"), ["Not on a Raft Computer", "members-usage-no-computer"]);
  assert.deepEqual(note("unknown"), note("not_run"));
  assert.deepEqual(note("runtime_no_usage"), ["Runtime reports no usage", "members-usage-runtime-no-usage"]);
});
