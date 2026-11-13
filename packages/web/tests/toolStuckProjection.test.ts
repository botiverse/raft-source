import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages/index";
import { useAgentStore } from "../src/store/agentStore";
import { toolStuckMinutes } from "../src/components/agent/AgentToolStuckNotice";

// task #25 (#triage #36): the daemon attaches `toolStuck` to every activity
// frame while the agent is stuck on one tool call. Those frames usually repeat
// the same "Running command" activity, so the store must not drop them as no-ops.

const toolStuck = {
  toolName: "bash",
  toolDetailKind: "running_command" as const,
  startedAtMs: 1_000,
  quietSinceMs: 1_000,
  thresholdMs: 600_000,
  queuedMessages: 3,
};

function frame(agentId: string, extra?: typeof toolStuck) {
  useAgentStore.getState().updateActivity(
    agentId, "working", "Running command…", undefined, Date.now(), undefined, "working", "running_command",
    undefined, true, true, undefined, undefined, undefined, extra,
  );
}

test("a stuck frame that repeats the same activity still sets toolStuck, and the next plain frame clears it", () => {
  frame("agent-stuck");
  assert.equal(useAgentStore.getState().agentActivities["agent-stuck"]?.toolStuck, undefined);

  frame("agent-stuck", toolStuck);
  assert.deepEqual(useAgentStore.getState().agentActivities["agent-stuck"]?.toolStuck, toolStuck);

  // A later heartbeat with a grown queue updates the count.
  frame("agent-stuck", { ...toolStuck, queuedMessages: 5 });
  assert.equal(useAgentStore.getState().agentActivities["agent-stuck"]?.toolStuck?.queuedMessages, 5);

  frame("agent-stuck");
  assert.equal(useAgentStore.getState().agentActivities["agent-stuck"]?.toolStuck, undefined, "a frame without it means not stuck");
});

test("stuck minutes count from the quiet start, never below the threshold", () => {
  assert.equal(toolStuckMinutes(toolStuck, 1_000 + 12 * 60_000 + 30_000), 12);
  // A slightly behind browser clock still shows at least the threshold.
  assert.equal(toolStuckMinutes(toolStuck, 1_000 + 2 * 60_000), 10);
});

test("the stuck copy names the tool, the minutes and what is waiting, in both catalogs", () => {
  for (const locale of ["en", "zh-cn"] as const) {
    const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
    const waiting = intl.formatMessage({ id: "agent.status.toolStuck" }, { tool: "bash", minutes: 12, queued: 3 });
    assert.ok(waiting.includes("bash") && waiting.includes("12") && waiting.includes("3"), `${locale}: ${waiting}`);
    const none = intl.formatMessage({ id: "agent.status.toolStuck" }, { tool: "bash", minutes: 12, queued: 0 });
    assert.ok(!none.includes("0"), `${locale}: no queue line when nothing waits: ${none}`);
  }
});
