import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import type { Machine } from "../../../store/machineStore";
import type { RackUsageResults } from "../../../components/machine/rack/rackRuntimeColumns";
import { filterRackMachines, groupRackMachines, rackNamePrefixGroups, rackSearchMatch } from "../computersRackFilter";
import { effectiveRackSort, firstSortDirection, parseRemainingSortKey, rackRemaining, sortRackMachines } from "../computersRackSort";

// The Computers toolbar's logic: the search, the Status / Runtime filters,
// Group (provider, name prefix) and the sort by what a runtime has left.

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

const owner = (id: string, name: string) => ({ ownerUserId: id, owner: { type: "human" as const, id, name, displayName: name, avatarUrl: null } });

const fleet: Machine[] = [
  machine("hetzner-ax42-1", { hostProvider: "hetzner", runtimes: ["claude", "codex"], ...owner("u-stdrc", "stdrc") }),
  machine("hetzner-ax42-2", { hostProvider: "hetzner", runtimes: ["claude", "codex"], ...owner("u-me", "atlas") }),
  machine("aws-gpu-1", { hostProvider: "aws", runtimes: ["codex"], status: "offline", ...owner("u-ricky", "ricky") }),
  machine("mac-studio", { hostProvider: null, runtimes: ["claude", "cursor"], ...owner("u-stdrc", "stdrc") }),
  machine("kimi-box-1", { hostProvider: "vultr", runtimes: ["kimi-sdk"] }),
];

const ids = (machines: readonly Machine[]) => machines.map((m) => m.id);
const none = { query: "", status: "all" as const, runtimes: [] as const };
const labels = { personal: "Personal computers", other: "Other" };

test("search matches the name, the hostname or the owner, case-insensitively", () => {
  assert.deepEqual(ids(filterRackMachines(fleet, { ...none, query: "AX42" })), ["hetzner-ax42-1", "hetzner-ax42-2"]);
  assert.deepEqual(ids(filterRackMachines(fleet, { ...none, query: "ricky" })), ["aws-gpu-1"]);
  assert.deepEqual(ids(filterRackMachines(fleet, { ...none, query: "mac-studio.local" })), ["mac-studio"]);
});

test("a search says which fields of a computer hold it: each alone, several at once, none, and nothing for an empty search", () => {
  const [ax1, , gpu, mac] = fleet;
  assert.deepEqual(rackSearchMatch(mac, "Mac-Studio.local"), { name: false, hostname: true, owner: false });
  assert.deepEqual(rackSearchMatch(mac, " studio "), { name: true, hostname: true, owner: false });
  assert.deepEqual(rackSearchMatch(gpu, "RICKY"), { name: false, hostname: false, owner: true });
  assert.deepEqual(rackSearchMatch(ax1, "r"), { name: true, hostname: true, owner: true });
  assert.deepEqual(rackSearchMatch(ax1, "zzz"), { name: false, hostname: false, owner: false });
  assert.equal(rackSearchMatch(ax1, "   "), null);
  // An owner's handle is searched as well as the display name.
  const handled = { ...mac, owner: { ...mac.owner!, name: "std-handle", displayName: "Standard" } };
  assert.deepEqual(rackSearchMatch(handled, "std-handle"), { name: false, hostname: false, owner: true });
  assert.deepEqual(rackSearchMatch(handled, "standard"), { name: false, hostname: false, owner: true });
});

test("Runtime keeps a computer with any chosen runtime; Other is a runtime with no usage provider", () => {
  assert.deepEqual(ids(filterRackMachines(fleet, { ...none, runtimes: ["kimi"] })), ["kimi-box-1"]);
  assert.deepEqual(ids(filterRackMachines(fleet, { ...none, runtimes: ["other"] })), ["mac-studio"]);
  assert.deepEqual(ids(filterRackMachines(fleet, { ...none, runtimes: ["claude", "codex"], status: "online" })), ["hetzner-ax42-1", "hetzner-ax42-2", "mac-studio"]);
});

test("a name prefix drops a trailing number; a prefix of one computer goes to Other, last", () => {
  const groups = groupRackMachines(fleet, "prefix", labels, "en", null);
  assert.deepEqual(groups.map((g) => [g.title, g.machines.length]), [["hetzner-ax42", 2], ["Other", 3]]);
});

/** Each group's title and members (Other last), as the list shows them. */
const prefixGroups = (names: string[]) =>
  groupRackMachines(names.map((name) => machine(name)), "prefix", labels, "en", null).map((g) => [g.title, ...ids(g.machines)]);

test("#triage:#291: names group by the longest word prefix they share; a lone member folds up; lone names go to Other", () => {
  const names = [
    "armbian-1", "armbian-kitchen", "armbian-lab",
    "atlas-fluence-claude", "atlas-fluence-root", "atlas-hostinger-root",
    "Alices-MacBook-Air.local", "DESKTOP-AB12CD3",
    "hetzner-ax42-1", "hetzner-ax42-4",
    "hetzner-ex63-3", "hetzner-ex63-4", "hetzner-ex63-6",
  ];
  assert.deepEqual(prefixGroups(names), [
    ["armbian", "armbian-1", "armbian-kitchen", "armbian-lab"],
    // atlas-hostinger-root is alone at "atlas": the atlas-fluence pair moves up to it.
    ["atlas", "atlas-fluence-claude", "atlas-fluence-root", "atlas-hostinger-root"],
    ["hetzner-ax42", "hetzner-ax42-1", "hetzner-ax42-4"],
    ["hetzner-ex63", "hetzner-ex63-3", "hetzner-ex63-4", "hetzner-ex63-6"],
    ["Other", "Alices-MacBook-Air.local", "DESKTOP-AB12CD3"],
  ]);
  // Without the lone one, the pair keeps its longer prefix.
  assert.deepEqual(prefixGroups(["atlas-fluence-claude", "atlas-fluence-root", "solo"]), [["atlas-fluence", "atlas-fluence-claude", "atlas-fluence-root"], ["Other", "solo"]]);
});

test("name prefixes: case-insensitive, _ and . split words, a whole name that prefixes another joins it", () => {
  // The title is the most common spelling, then the smallest by code point ("B" < "b").
  assert.deepEqual(prefixGroups(["Build-a", "build-b"]), [["Build", "Build-a", "build-b"]]);
  assert.deepEqual(prefixGroups(["build-b", "Build-a"]), [["Build", "build-b", "Build-a"]]);
  assert.deepEqual(prefixGroups(["build-c", "Build-a", "build-b"]), [["build", "build-c", "Build-a", "build-b"]]);
  assert.deepEqual(prefixGroups(["gpu_node_1", "gpu_node_2", "gpu.node.3"]), [["gpu_node", "gpu_node_1", "gpu_node_2", "gpu.node.3"]]);
  assert.deepEqual(prefixGroups(["armbian", "armbian-2", "pi"]), [["armbian", "armbian", "armbian-2"], ["Other", "pi"]]);
  assert.deepEqual(prefixGroups(["web-1", "web-2", "web-10"]), [["web", "web-1", "web-2", "web-10"]]);
});

test("name prefixes: all unique → all Other; two families under one word keep their own groups", () => {
  assert.deepEqual(prefixGroups(["alpha", "beta-1", "gamma.local"]), [["Other", "alpha", "beta-1", "gamma.local"]]);
  assert.deepEqual(prefixGroups(["gpu-a-1", "gpu-a-2", "gpu-b-1", "gpu-b-2"]), [["gpu-a", "gpu-a-1", "gpu-a-2"], ["gpu-b", "gpu-b-1", "gpu-b-2"]]);
  // A lone name under them takes the smallest family up with it (then A to Z); the larger keeps its prefix.
  assert.deepEqual(prefixGroups(["gpu-a-1", "gpu-a-2", "gpu-a-3", "gpu-b-1", "gpu-b-2", "gpu-c"]), [
    ["gpu", "gpu-b-1", "gpu-b-2", "gpu-c"],
    ["gpu-a", "gpu-a-1", "gpu-a-2", "gpu-a-3"],
  ]);
  assert.deepEqual(rackNamePrefixGroups([]), []);
});

test("name prefixes: the same name twice groups (default hostnames); a name with no words goes to Other", () => {
  assert.deepEqual(prefixGroups(["raspberrypi", "raspberrypi", "ubuntu"]), [["raspberrypi", "raspberrypi", "raspberrypi"], ["Other", "ubuntu"]]);
  assert.deepEqual(rackNamePrefixGroups(["x.local", "X-local"]), [{ key: "x-local", title: "X-local" }, { key: "x-local", title: "X-local" }]);
  assert.deepEqual(rackNamePrefixGroups(["", "  ", "-", "a"]), [null, null, null, null]);
});

test("name prefixes: the same names in any order get the same groups and titles", () => {
  const names = ["armbian-1", "Armbian-kitchen", "armbian-lab", "atlas-fluence-claude", "atlas-fluence-root", "atlas-hostinger-root", "gpu-a-1", "gpu-a-2", "gpu-b-1", "gpu-b-2", "gpu-c", "raspberrypi", "RaspberryPi", "solo"];
  const byName = (order: string[]) => {
    const groups = rackNamePrefixGroups(order);
    return Object.fromEntries(order.map((name, index) => [name, groups[index]]));
  };
  const expected = byName(names);
  assert.deepEqual(expected["atlas-hostinger-root"], { key: "atlas", title: "atlas" });
  assert.deepEqual(expected["Armbian-kitchen"], { key: "armbian", title: "armbian" });
  for (let seed = 1; seed <= 20; seed++) {
    const shuffled = [...names];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (seed * 7919 + i * 104729) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    assert.deepEqual(byName(shuffled), expected, `order ${shuffled.join(",")}`);
  }
});

test("a fallback group never merges with a real one of the same name: computers named other-1 and other-2 keep their own group", () => {
  const groups = groupRackMachines([machine("other-1"), machine("other-2"), machine("solo")], "prefix", labels, "en", null);
  assert.deepEqual(groups.map((g) => [g.key, g.title, g.machines.length]), [["prefix:other", "other", 2], ["fallback:prefix", "Other", 1]]);
  const byProvider = groupRackMachines([machine("a", { hostProvider: "none" }), machine("b", { hostProvider: null })], "provider", labels, "en", null);
  assert.deepEqual(byProvider.map((g) => [g.key, g.machines.length]), [["fallback:provider", 2]]);
});

test("provider groups go A to Z with no provider last, or by their best member under a sort", () => {
  assert.deepEqual(groupRackMachines(fleet, "provider", labels, "en", null).map((g) => g.title), ["AWS", "Hetzner Cloud", "Vultr", "Personal computers"]);
  // Under a sort, the group holding the first-ranked computer leads; unranked groups follow A to Z.
  const rank = (m: Machine) => (m.id === "hetzner-ax42-2" ? 0 : m.id === "kimi-box-1" ? 1 : null);
  assert.deepEqual(groupRackMachines(fleet, "provider", labels, "en", rank).map((g) => g.title), ["Hetzner Cloud", "Vultr", "AWS", "Personal computers"]);
});

type Win = { id: string; label: string; status: "ok" | "limit_reached" | "parse_unavailable"; usedRatio?: number };
type Health = "ok" | "rate_limited" | "reauth_required" | "unsupported" | "error";

function claude(...accounts: { health?: Health; windows: Win[] }[]): RackUsageResults {
  return {
    claude: {
      state: "fresh",
      snapshot: {
        protocolVersion: 2,
        provider: "claude",
        collectedAt: "2026-11-09T00:00:00.000Z",
        staleAfter: "2026-11-09T01:00:00.000Z",
        collectorVersion: "t",
        sourceVersion: "t",
        accounts: accounts.map((account, index) => ({ accountKey: String(index).repeat(64).slice(0, 64), health: account.health ?? "ok", windows: account.windows })),
      },
    },
  } as RackUsageResults;
}

/** Remaining to the 1e-9, as a ratio's complement isn't exact in floating point. */
function near(actual: number | null, expected: number | null, message?: string) {
  assert.ok(actual === expected || (actual !== null && expected !== null && Math.abs(actual - expected) < 1e-9), `${message ?? ""} ${actual} vs ${expected}`);
}

const win = (id: string, status: Win["status"], usedRatio?: number): Win => ({ id, label: id, status, ...(usedRatio === undefined ? {} : { usedRatio }) });

test("remaining: the tightest window of the tightest account, read by status, never by place", () => {
  // Windows in any order and with any ids: the most used counts.
  near(rackRemaining(claude({ windows: [win("w", "ok", 0.2), win("s", "ok", 0.75)] }).claude), 0.25);
  near(rackRemaining(claude({ windows: [win("s", "ok", 0.75), win("w", "ok", 0.2)] }).claude), 0.25);
  // A window that can't be read doesn't count; none left to read is no value.
  near(rackRemaining(claude({ windows: [win("x", "parse_unavailable"), win("w", "ok", 0.4)] }).claude), 0.6);
  near(rackRemaining(claude({ windows: [win("x", "parse_unavailable")] }).claude), null);
  // A reached limit is fully used, with or without its ratio.
  near(rackRemaining(claude({ windows: [win("s", "limit_reached"), win("w", "ok", 0.1)] }).claude), 0);
  near(rackRemaining(claude({ windows: [win("s", "limit_reached", 1)] }).claude), 0);
  // Several accounts: the one with the least left.
  near(rackRemaining(claude({ windows: [win("s", "ok", 0.3)] }, { windows: [win("s", "ok", 0.9)] }).claude), 0.1);
});

test("remaining: rate limited has nothing left; reauth / unsupported / error say nothing; a missing read is no value", () => {
  near(rackRemaining(claude({ health: "rate_limited", windows: [win("s", "ok", 0.2)] }).claude), 0);
  for (const health of ["reauth_required", "unsupported", "error"] as const) {
    near(rackRemaining(claude({ health, windows: [win("s", "ok", 0.2)] }).claude), null, health);
  }
  // Another account still counts beside one that needs signing in.
  near(rackRemaining(claude({ health: "reauth_required", windows: [] }, { windows: [win("s", "ok", 0.5)] }).claude), 0.5);
  near(rackRemaining({ state: "missing", snapshot: null }), null);
  near(rackRemaining(undefined), null);
});

test("a remaining sort: most remaining first by default; no value (reauth, no runtime, nothing read) last both ways", () => {
  const machines = [machine("a"), machine("b"), machine("c"), machine("d", { runtimes: ["codex"] }), machine("e"), machine("f")];
  const reads = new Map<string, RackUsageResults | null>([
    ["a", claude({ windows: [win("s", "ok", 0.2), win("w", "ok", 0.9)] })], // 0.1 left
    ["b", claude({ windows: [win("s", "limit_reached")] })], // 0 left
    ["c", claude({ windows: [win("s", "ok", 0.4)] })], // 0.6 left
    ["e", claude({ health: "reauth_required", windows: [win("s", "ok", 0.1)] })], // no value
    ["f", claude({ health: "rate_limited", windows: [win("s", "ok", 0.1)] })], // 0 left
  ]);
  assert.equal(parseRemainingSortKey("remaining:claude"), "claude");
  assert.equal(firstSortDirection("remaining:claude"), "desc");
  assert.deepEqual(ids(sortRackMachines(machines, { key: "remaining:claude", direction: "desc" }, reads, "en")), ["c", "a", "b", "f", "d", "e"]);
  assert.deepEqual(ids(sortRackMachines(machines, { key: "remaining:claude", direction: "asc" }, reads, "en")), ["b", "f", "a", "c", "d", "e"]);
});

test("no sort is the default (the list's own order); a stored runtime sort whose runtime is gone falls back to it", () => {
  const columns = { usage: [{ provider: "claude" as const, runtimeId: "claude" }], other: [] };
  assert.equal(effectiveRackSort(null, columns), null);
  assert.equal(effectiveRackSort({ key: "remaining:codex", direction: "desc" }, columns), null);
  assert.deepEqual(effectiveRackSort({ key: "name", direction: "asc" }, columns), { key: "name", direction: "asc" });
  assert.deepEqual(effectiveRackSort({ key: "remaining:claude", direction: "asc" }, columns), { key: "remaining:claude", direction: "asc" });
});
