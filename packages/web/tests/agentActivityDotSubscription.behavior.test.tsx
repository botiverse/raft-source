import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { createRenderCounter } from "./helpers/renderCount";
import AgentActivityDot from "../src/components/agent/AgentActivityDot";
import { useAgentStore } from "../src/store/agentStore";
import {
  __resetAuthTraceForTest,
  flushAuthTraces,
  setAuthTraceFetchForTest,
  setAuthTracePrincipalIdGetter,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace";
import { TestIntlProvider } from "./helpers/intl";

/**
 * Behavioral render-count replacement for `sidebarActivitySubscription.contract.test.ts`
 * (a source-proxy: it asserts Sidebar.tsx source does NOT contain a broad
 * `useAgentStore(s => s.agentActivities)` regex). That proxy can't see the actual
 * runtime behavior and survives any behavior-preserving-regex mutation.
 *
 * The behavior the proxy stands in for: a per-agent activity update must NOT
 * re-render OTHER agents' activity UI. The isolation lives in AgentActivityDot,
 * which subscribes narrowly via `useAgentDisplayState(agentId)` through the
 * store's current-activity selector. This test renders two dots and asserts that
 * updating agent B's activity leaves agent A's dot's render count unchanged.
 *
 * Mutant-kill (the #39 RED): broaden the subscription to the whole
 * `agentActivities` object → updating B re-renders A → this test goes RED, while
 * the source-regex proxy stays GREEN. That gap is exactly the false-green.
 *
 * Run: `pnpm --filter @botiverse/raft-web test:dom`.
 */

afterEach(() => {
  cleanup();
  __resetAuthTraceForTest();
  setAuthTraceServerIdGetter(() => undefined);
  setAuthTracePrincipalIdGetter(() => undefined);
  localStorage.clear();
});

function seedAgents() {
  useAgentStore.setState({
    agents: [
      { id: "a", name: "Agent A", status: "running" },
      { id: "b", name: "Agent B", status: "running" },
    ],
    agentActivities: {
      a: { activity: "online", activityDetail: "" },
      b: { activity: "online", activityDetail: "" },
    },
    agentActivityTraceJoins: {},
    agentActivityObservedAt: {},
    agentActivityVersions: {},
    agentActivitySeq: {},
    agentActivityLaunchId: {},
    loading: false,
  } as never);
}

function captureWebTraceBatches() {
  const batches: Array<{ records?: Array<{ name?: string; attrs?: Record<string, unknown> }> }> = [];
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-1");
  setAuthTracePrincipalIdGetter(() => "user-1");
  localStorage.setItem("slock_access_token", "token-1");
  setAuthTraceFetchForTest(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/scope-attestation")) {
      return new Response(JSON.stringify({ attestation: "attestation-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    batches.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("{}", { status: 200 });
  });
  return batches;
}

test("updating one agent's activity does not re-render another agent's dot (narrow per-agent subscription)", () => {
  seedAgents();
  const rc = createRenderCounter();

  render(
    <TestIntlProvider>
      <rc.Count id="a"><AgentActivityDot agentId="a" /></rc.Count>
      <rc.Count id="b"><AgentActivityDot agentId="b" /></rc.Count>
    </TestIntlProvider>,
  );

  const a0 = rc.get("a");
  const b0 = rc.get("b");
  assert.ok(a0 >= 1 && b0 >= 1, "both dots mounted");

  // Dispatch an activity update for agent B only.
  act(() => {
    useAgentStore.getState().updateActivity("b", "thinking");
  });

  assert.ok(rc.get("b") > b0, "agent B's dot re-rendered after its own activity update");
  assert.equal(
    rc.get("a"),
    a0,
    "agent A's dot must NOT re-render when only agent B's activity changed — per-agent subscription isolation",
  );
});

test("updating one agent's trace join re-renders and re-emits only that agent's dot trace", async () => {
  seedAgents();
  const batches = captureWebTraceBatches();
  const rc = createRenderCounter();

  render(
    <TestIntlProvider>
      <rc.Count id="a"><AgentActivityDot agentId="a" /></rc.Count>
      <rc.Count id="b"><AgentActivityDot agentId="b" /></rc.Count>
    </TestIntlProvider>,
  );
  await flushAuthTraces();
  batches.length = 0;
  const a0 = rc.get("a");
  const b0 = rc.get("b");

  act(() => {
    useAgentStore.setState((state) => ({
      agentActivityTraceJoins: {
        ...state.agentActivityTraceJoins,
        a: { clientEventId: "client-event-a" },
      },
    }));
  });
  await flushAuthTraces();

  assert.ok(rc.get("a") > a0, "agent A's dot must observe its trace join update");
  assert.equal(rc.get("b"), b0, "agent B's dot must not re-render for agent A's trace join update");
  const records = batches.flatMap((batch) => batch.records ?? []);
  assert.deepEqual(
    records.map((record) => [record.name, record.attrs?.join]),
    [["slock.agent_activity.status_dot_applied", { clientEventId: "client-event-a" }]],
  );
});
