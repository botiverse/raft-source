import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import type { Machine } from "../../../store/machineStore";
import { countMachinesNeedingAttention, machineNeedsAttention } from "../../../utils/computerUpgradeIndicator";
import { attentionFirst } from "../computersRackSort";

// The Computers page's default order (no sort chosen; artin, #triage:#527):
// the computers needing attention first, by the left rail count's own rule,
// each part in the order given.

function machine(id: string, overrides: Partial<Machine> = {}): Machine {
  return {
    id,
    name: id,
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: ["claude"],
    hostname: `${id}.local`,
    os: "linux",
    daemonVersion: null,
    isComputer: true,
    computerVersion: "1.0.53",
    computerUpgradeAvailable: false,
    lastHeartbeat: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The server's summary (#68) with `count` things to act on. */
const attention = (count: number): NonNullable<Machine["attention"]> => ({ count, items: [], waitingAgents: 0 });

const ids = (machines: readonly Machine[]) => machines.map((m) => m.id);

test("the computers needing attention come first, each part in the order given", () => {
  const machines = [
    machine("mine-ok"),
    machine("mine-update", { computerUpgradeAvailable: true }),
    machine("other-ok"),
    machine("other-offline", { status: "offline" }),
    machine("other-update", { computerUpgradeAvailable: true }),
    machine("other-ok-2"),
  ];
  assert.deepEqual(ids(attentionFirst(machines)), [
    "mine-update", "other-offline", "other-update",
    "mine-ok", "other-ok", "other-ok-2",
  ]);
});

test("the server's summary decides when it sent one, as for the rail's count", () => {
  const machines = [
    machine("update-but-server-clear", { computerUpgradeAvailable: true, attention: attention(0) }),
    machine("server-flagged", { attention: attention(2) }),
    machine("plain"),
  ];
  assert.deepEqual(ids(attentionFirst(machines)), ["server-flagged", "update-but-server-clear", "plain"]);
  // One rule for the order and the count.
  assert.equal(countMachinesNeedingAttention(machines), machines.filter(machineNeedsAttention).length);
  assert.equal(countMachinesNeedingAttention(machines), 1);
});

test("a raw daemon has no upgrade signal; nothing to move keeps the list as given", () => {
  const healthy = [machine("a"), machine("daemon", { isComputer: false, computerUpgradeAvailable: true }), machine("b")];
  assert.equal(attentionFirst(healthy), healthy);
  const allNeed = [machine("x", { status: "offline" }), machine("y", { computerUpgradeAvailable: true })];
  assert.equal(attentionFirst(allNeed), allNeed);
});

test("this device keeps the top whatever it needs, the others needing attention right after it", () => {
  const machines = [
    machine("this-device"),
    machine("other-ok"),
    machine("other-update", { computerUpgradeAvailable: true }),
  ];
  assert.deepEqual(ids(attentionFirst(machines, "this-device")), ["this-device", "other-update", "other-ok"]);
  assert.deepEqual(ids(attentionFirst(machines)), ["other-update", "this-device", "other-ok"]);
});
