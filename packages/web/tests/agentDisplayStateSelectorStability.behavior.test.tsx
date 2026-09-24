/**
 * React #185 regression pins (2026-07-07 prod incident, hotfix for #3991).
 *
 * The lesion: MachineDetailPanel/HumanDetailPanel built a map of per-agent
 * display states INSIDE a store selector. `resolveAgentDisplayState` returns
 * a fresh object per call, so even `useShallow` saw a changed snapshot on
 * every read -> useSyncExternalStore re-rendered forever -> React #185.
 *
 * The fix: subscribe to raw slices (stable references) and compute display
 * states in render via `computeAgentDisplayState`. These tests pin:
 *  1. the trap itself (selector-returned display objects are reference-
 *     unstable — executable documentation of WHY the map-in-selector shape
 *     is banned),
 *  2. the fixed subscription shape renders once, stays quiet on identical
 *     store writes, and re-renders exactly once per real activity change,
 *  3. `computeAgentDisplayState` semantic parity (managed / external /
 *     fallback-only).
 *
 * Run: `pnpm --filter @botiverse/raft-web test:dom`.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import {
  computeAgentDisplayState,
  selectAgentDisplayState,
  useAgentStore,
} from "../src/store/agentStore";

afterEach(cleanup);

function seedStore() {
  useAgentStore.setState({
    agents: [
      { id: "a", name: "Agent A", status: "active", machineId: "m1" },
      { id: "b", name: "Agent B", status: "stopped", machineId: "m1" },
    ],
    agentActivities: {
      a: { activity: "working", activityDetail: "Running command" },
    },
    agentActivityObservedAt: {},
    agentActivityVersions: {},
    agentActivitySeq: {},
    loading: false,
  } as never);
}

test("the trap, as executable documentation: selector-built display states are reference-unstable", () => {
  seedStore();
  const state = useAgentStore.getState();
  const first = selectAgentDisplayState(state, "a");
  const second = selectAgentDisplayState(state, "a");
  assert.deepEqual(first, second, "semantically equal…");
  assert.notEqual(first, second, "…but referentially fresh per call — building a map of these inside a store selector loops the render (React #185)");
});

/** The FIXED subscription shape used by MachineDetailPanel/HumanDetailPanel. */
function FixedShapeProbe({ onRender }: { onRender: () => void }) {
  onRender();
  const agents = useAgentStore((s) => s.agents);
  const agentActivities = useAgentStore((s) => s.agentActivities);
  return (
    <ul>
      {agents.map((agent) => {
        const displayState = computeAgentDisplayState(agents, agentActivities, agent.id, agent);
        return (
          <li key={agent.id} data-testid={`probe-${agent.id}`}>
            {agent.name}: {displayState.activityText}
          </li>
        );
      })}
    </ul>
  );
}

test("fixed shape: renders once, silent on no-op writes, exactly one re-render per real change (no #185)", () => {
  seedStore();
  let renders = 0;
  render(<FixedShapeProbe onRender={() => { renders += 1; }} />);
  const afterMount = renders;
  assert.ok(afterMount >= 1);
  assert.ok(screen.getByTestId("probe-a").textContent?.includes("Running command"));

  // Identical write (same references) — must NOT re-render, and above all
  // must not loop.
  act(() => {
    const s = useAgentStore.getState();
    useAgentStore.setState({ agents: s.agents, agentActivities: s.agentActivities } as never);
  });
  assert.equal(renders, afterMount, "no-op store write must not re-render the probe");

  // One real activity change — exactly one re-render, content updates.
  act(() => {
    useAgentStore.setState((s) => ({
      agentActivities: { ...s.agentActivities, a: { activity: "online", activityDetail: "" } },
    }) as never);
  });
  assert.equal(renders, afterMount + 1, "one real change = exactly one re-render");
  assert.ok(!screen.getByTestId("probe-a").textContent?.includes("Running command"));
});

test("computeAgentDisplayState parity: managed, stopped-fallback, and external agents", () => {
  seedStore();
  const { agents, agentActivities } = useAgentStore.getState();

  const managed = computeAgentDisplayState(agents, agentActivities, "a");
  assert.equal(managed.isOnline, true);
  assert.equal(managed.activity, "working");

  const stopped = computeAgentDisplayState(agents, agentActivities, "b");
  assert.equal(stopped.isOnline, false);

  // Agent absent from the store: fallback drives the result (HumanDetailPanel
  // createdAgents path).
  const viaFallback = computeAgentDisplayState(agents, agentActivities, "ghost", { status: "active" });
  assert.equal(viaFallback.isOnline, true);

  const external = computeAgentDisplayState(agents, agentActivities, "ghost", { status: "active", external: true });
  assert.equal(external.isExternal, true);
  assert.equal(external.isOnline, false);
  assert.equal(external.activityText, "External");
});
