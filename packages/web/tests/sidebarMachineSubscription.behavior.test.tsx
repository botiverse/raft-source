import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { createRenderCounter } from "./helpers/renderCount";
import { ComputerRow } from "../src/components/layout/Sidebar";
import { TestIntlProvider } from "./helpers/intl";
import { useMachineStore } from "../src/store/machineStore";

/**
 * Behavioral render-count replacement for `sidebarMachineSubscription.contract.test.ts`
 * (a source-proxy asserting Sidebar.tsx source has no broad
 * `useMachineStore(s => s.machines)` regex). The proxy can't see runtime
 * behavior and survives any behavior-preserving-regex mutation.
 *
 * Behavior: a `machine:status` update for one machine must NOT re-render OTHER
 * machine rows. ComputerRow subscribes narrowly via
 * `useMachineStore(s => s.machines.find(m => m.id === machineId))`; isolation
 * holds when updateMachineStatus structurally shares unchanged machine objects.
 *
 * Mutant-kill (#39 RED): broaden the subscription → updating m2 re-renders m1's
 * row → RED, while the source-regex proxy stays GREEN.
 *
 * Run: `pnpm --filter @botiverse/raft-web test:dom`.
 */

afterEach(cleanup);

function seedMachines() {
  useMachineStore.setState({
    machines: [
      { id: "m1", name: "Machine 1", description: "Lab bench runner", status: "online" },
      { id: "m2", name: "Machine 2", status: "online" },
    ],
    loading: false,
  } as never);
}

const noop = () => {};

test("a machine:status update does not re-render other machine rows (narrow per-machine subscription)", () => {
  seedMachines();
  const rc = createRenderCounter();

  render(
    <TestIntlProvider>
      <>
        <rc.Count id="m1"><ComputerRow machineId="m1" selected={false} onSelect={noop} /></rc.Count>
        <rc.Count id="m2"><ComputerRow machineId="m2" selected={false} onSelect={noop} /></rc.Count>
      </>
    </TestIntlProvider>,
  );

  const m1_0 = rc.get("m1");
  const m2_0 = rc.get("m2");
  assert.ok(m1_0 >= 1 && m2_0 >= 1, "both machine rows mounted");

  // Flip machine m2's status only.
  act(() => {
    useMachineStore.getState().updateMachineStatus("m2", "offline");
  });

  assert.ok(rc.get("m2") > m2_0, "machine m2's row re-rendered after its own status change");
  assert.equal(
    rc.get("m1"),
    m1_0,
    "machine m1's row must NOT re-render when only m2's status changed — per-machine subscription isolation",
  );
});

test("computer rows show a machine description when present", () => {
  seedMachines();

  render(
    <TestIntlProvider>
      <ComputerRow machineId="m1" selected={false} onSelect={noop} />
    </TestIntlProvider>,
  );

  const description = screen.getByText("Lab bench runner");
  assert.ok(
    description.className.includes("text-black/60"),
    "machine description must render as muted secondary row text",
  );
});
