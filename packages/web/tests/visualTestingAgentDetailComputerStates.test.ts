import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// task #535 / #537: the agent-detail Computer row has five reachable web states
// (AgentDetailPanel.tsx blob c549c316acf5, :771-772 and :2053-2084). The default
// fixture only ever reached "known + online", and its 21-char machine name never
// wrapped, so three states and the whole wrap/truncate branch had no capture at
// all. These checks pin the fixture so that each new case still exercises the
// state its id claims — a case whose input drifted back to "online / short name"
// would capture green and prove nothing.

const sharedDir = new URL("../../visual-testing/shared/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("fixtureData.json", sharedDir), "utf8")) as {
  machines: Record<string, { id: string; name: string; status: string }>;
  agents: Record<string, { id: string; machineKey: string | null; serverRole?: string }>;
};
const specSource = readFileSync(new URL("../../visual-testing/tests/react-provider.spec.ts", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("sharedCases.json", sharedDir), "utf8")) as {
  cases: Array<{ id: string; androidCaseHint?: string; capture?: { selector?: string } }>;
};
const casesSource = readFileSync(new URL("../visual-testing/VisualTestingCases.tsx", import.meta.url), "utf8");

/** The state each fixture agent must encode, by construction. */
const STATE_AGENTS = {
  computerOffline: { caseSuffix: "computer-offline", machineKey: "studio", machineStatus: "offline" },
  computerMissing: { caseSuffix: "computer-missing", machineKey: "missing", machineStatus: null },
  noComputer: { caseSuffix: "no-computer", machineKey: null, machineStatus: null },
  longMachine: { caseSuffix: "long-machine-name", machineKey: "longName", machineStatus: "online" },
  daemonOnly: { caseSuffix: "daemon-only", machineKey: "daemonOnly", machineStatus: "online" },
  noMembership: { caseSuffix: "no-membership", machineKey: "primary", machineStatus: "online" },
} as const;

/** The one fixture agent that must NOT carry a server role: the wire omits
    serverRole for an agent without a membership row (task #261, artin
    2026-09-03 16:54 → hide the chip). Every other agent is a server member. */
const NO_MEMBERSHIP_AGENT = "noMembership";

/** Longest run without a natural break opportunity (hyphen, dot, space). */
export function longestUnbreakableRun(name: string): number {
  return Math.max(...name.split(/[-.\s]/).map((part) => part.length));
}

test("each Computer-row state agent still encodes its state", () => {
  for (const [agentKey, expect] of Object.entries(STATE_AGENTS)) {
    const agent = fixture.agents[agentKey];
    assert.ok(agent, `fixture agent "${agentKey}" is missing`);
    assert.equal(agent.machineKey, expect.machineKey, `${agentKey}.machineKey`);
    if (expect.machineKey === null) continue;
    const machine = fixture.machines[expect.machineKey];
    if (expect.machineStatus === null) {
      // The dangling-id state only works while nothing resolves the key.
      assert.equal(machine, undefined, `${agentKey}: machineKey "${expect.machineKey}" must NOT resolve to a machine`);
    } else {
      assert.ok(machine, `${agentKey}: machineKey "${expect.machineKey}" must resolve to a machine`);
      assert.equal(machine.status, expect.machineStatus, `${agentKey}: machine status`);
    }
  }
  // Positive control: the default agent is the "known + online" state.
  assert.equal(fixture.agents.productUx.machineKey, "primary");
  assert.equal(fixture.machines.primary.status, "online");
});

test("the long-name machine cannot fit one 390dp line, unlike the default machine", () => {
  // 390dp minus the page padding leaves ~342dp; the 14sp mono name glyph is
  // ~8.4dp, so anything past ~40 chars with no break opportunity must wrap,
  // truncate, or overflow — the three outcomes task #537 exists to observe.
  const longName = fixture.machines.longName.name;
  assert.ok(longName.length >= 60, `long name is only ${longName.length} chars`);
  assert.ok(longestUnbreakableRun(longName) >= 40, `longest unbreakable run is ${longestUnbreakableRun(longName)}`);
  // Control: the default machine name does NOT trigger the branch (that is the
  // gap this fixture closes), so a test that passed for it would be meaningless.
  const defaultName = fixture.machines.primary.name;
  assert.ok(defaultName.length < 40, `default name ${defaultName.length} chars — did the default fixture change?`);
  assert.ok(longestUnbreakableRun(defaultName) < 40);
});

test("each state case is registered in the manifest and bound to its agent on both arms", () => {
  for (const [agentKey, expect] of Object.entries(STATE_AGENTS)) {
    const caseId = `screens.members.agent-detail.profile.${expect.caseSuffix}`;
    const entry = manifest.cases.find((c) => c.id === caseId);
    assert.ok(entry, `${caseId} missing from sharedCases.json`);
    const agentId = fixture.agents[agentKey].id;
    assert.match(entry.androidCaseHint ?? "", new RegExp(`memberId=${agentId}(,|$)`), `${caseId}: androidCaseHint must open ${agentId}`);
    assert.equal(entry.capture?.selector, `[data-visual-case='${caseId}']`);
    // Web side: the case must exist AND name the same fixture agent.
    const block = casesSource.match(new RegExp(`"${caseId.replace(/\./g, "\\.")}": \\{[^}]*\\}`));
    assert.ok(block, `${caseId} not declared in VisualTestingCases.tsx`);
    assert.match(block[0], new RegExp(`agentKey: "${agentKey}"`), `${caseId}: web case must bind agentKey ${agentKey}`);
    assert.match(block[0], /tab: "profile"/, `${caseId}: dotted suffix would be parsed as the tab; tab must be explicit`);
  }
});

test("mutation control: a short or breakable name is rejected by the predicate", () => {
  assert.equal(longestUnbreakableRun("Jiachengs-MacBook-Pro"), 9);
  assert.equal(longestUnbreakableRun("a".repeat(45)), 45);
  assert.equal(longestUnbreakableRun("a".repeat(45) + "-" + "b".repeat(10)), 45);
});

// task #261: the server omits `serverRole` only when an agent has NO membership
// row (server_agent_members.role is NOT NULL, default member). Every fixture
// agent is a server member, so each must carry a role — otherwise web draws its
// "omitted" branch ("No role") and the role chip cell compares two renderings of
// an absence instead of one value. The mock must forward it, because the app's
// post-mount refetch replaces whatever the case file seeded.
test("every fixture agent carries a server role and the /api/agents mock forwards it", () => {
  const agents = Object.entries(fixture.agents);
  assert.ok(agents.length >= 10, `only ${agents.length} fixture agents — did the fixture shape change?`);
  for (const [key, agent] of agents) {
    if (key === NO_MEMBERSHIP_AGENT) {
      assert.equal("serverRole" in agent, false, `${key} must carry NO serverRole (it is the no-membership-row state)`);
      continue;
    }
    assert.ok(agent.serverRole === "member" || agent.serverRole === "admin", `${key}.serverRole is ${JSON.stringify(agent.serverRole)}`);
  }
  // Anchor on the fulfilling branch; the home-loading branch mentions the same path earlier.
  // Ten identical values would let a hardcoded "Member" chip pass: the fixture
  // must reach BOTH chips (text and colour differ) so the cell can fail (LiBai).
  const roles = new Set(agents.map(([, agent]) => agent.serverRole));
  assert.ok(roles.has("admin") && roles.has("member"), `fixture roles ${JSON.stringify([...roles])} must include both admin and member`);
  const mock = specSource.match(/if \(pathname === "\/api\/agents"\) \{[\s\S]*?return;/);
  assert.ok(mock, "/api/agents mock not found in react-provider.spec.ts");
  // Accepts the plain read and the cast form `(agent as {...}).serverRole` used once noMembership has no role.
  assert.match(mock[0], /serverRole: \(?agent(?: as \{[^}]*\})?\)?\.serverRole/, "the /api/agents mock must forward serverRole from the fixture agent");
});

// Batch 2: the bare-daemon branch of web's per-type version rule
// (machineRunLabel.ts: isComputer ? computerVersion : daemonVersion) had no
// input — all three original machines were managed computers.
test("the daemon-only machine is a bare daemon, unlike every other fixture machine", () => {
  const machines = fixture.machines as Record<string, { isComputer?: boolean; computerVersion?: string | null; daemonVersion?: string | null; status: string }>;
  const daemon = machines.daemonOnly;
  assert.ok(daemon, "machines.daemonOnly missing");
  assert.equal(daemon.isComputer, false);
  assert.equal(daemon.computerVersion, null);
  assert.ok(daemon.daemonVersion, "daemonOnly needs a daemonVersion, that is what web shows for it");
  assert.equal(daemon.status, "online", "the branch only renders a version when online");
  // Control: without this machine the branch is untriggerable.
  const others = Object.entries(machines).filter(([k]) => k !== "daemonOnly");
  assert.ok(others.every(([, m]) => m.isComputer === true), "some other fixture machine is already a bare daemon — then this cell is not the only input and the control is stale");
});

test("the loading-state case keeps the machines list in flight on both surfaces", () => {
  const caseId = "screens.members.agent-detail.profile.loading-state";
  const block = casesSource.match(new RegExp(`"${caseId.replace(/\./g, "\\.")}": \\{[^}]*\\}`));
  assert.ok(block, `${caseId} not declared in VisualTestingCases.tsx`);
  assert.match(block[0], /machinesLoading: true/, "the web case must seed the machine store as loading");
  assert.ok(manifest.cases.some((c) => c.id === caseId), `${caseId} missing from sharedCases.json`);
  assert.match(specSource, /screens\.members\.agent-detail\.profile\.loading-state[\s\S]{0,400}servers\/visual-server\/machines/, "the spec must hold the machines route in flight for this case");
});
