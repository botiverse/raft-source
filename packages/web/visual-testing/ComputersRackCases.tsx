import { useMemo } from "react";
import { Route, Routes } from "react-router-dom";
import { composeReadiness, composeReadinessAttention, agentReadinessChain, runtimeReadinessChain, trimReadinessAttentionForViewer, trimReadinessForViewer } from "@botiverse/raft-shared";
import type { ComputerReadiness, Readiness, ReadinessAttention, ReadinessFact, RuntimeAccountUsageProvider, RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";
import MainLayout from "../src/components/layout/MainLayout";
import type { Agent, CreatorSummary } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { resetComputersRackFiltersForTests } from "../src/store/computersRackFilterPreference";
import type { ComputersRackFilters } from "../src/store/computersRackFilterPreference";
import { COMPUTERS_RACK_SORT_STORAGE_KEY, writeComputersRackSort } from "../src/store/computersRackSortPreference";
import type { ComputersRackSort } from "../src/store/computersRackSortPreference";
import { writeComputersRackView } from "../src/store/computersRackViewPreference";
import type { ComputersRackView } from "../src/store/computersRackViewPreference";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { runtimeAccountUsageClient } from "../src/utils/runtimeAccountUsageClient";
import fixtureData from "../../visual-testing/shared/fixtureData.json";

// #proj-raft-computer (Artea): the Computers overview's toolbar (search,
// Filter, Group, Sort menus) on the whole app shell,
// the real MainLayout at /s/visual/computers, over 15 fixture computers whose runtime usage is put straight into the
// usage client's cache (no request). Web-only local shots, not part of the
// Android parity matrix (sharedCases.json): the kit that drives the menus
// lives with the screenshots. Every case primes the same fleet and sets the
// toolbar's choices itself, so cases don't leak into each other through
// localStorage.
//
// The `needs-attention` cases (#proj-raft-computer:#68) ARE in
// sharedCases.json (React only, no parity gate), so a PR's visual-shots block
// can ask for them: a small fleet of its own (ATTENTION_FLEET) whose
// `attention` and `readiness` are composed here from readiness facts by the
// shared functions the server uses (composeReadinessAttention,
// composeReadiness), named and trimmed for the viewer as the server does.

export const COMPUTERS_RACK_CASE_IDS = [
  "screens.computers.rack.list-provider",
  "screens.computers.rack.cards-prefix",
  "screens.computers.rack.filtered",
  "screens.computers.rack.no-results",
  "screens.computers.rack.phone",
  "screens.computers.rack.phone-filtered",
  "screens.computers.rack.needs-attention",
  "screens.computers.rack.needs-attention.dark",
  "screens.computers.rack.needs-attention.single",
  "screens.computers.rack.needs-attention.member",
] as const;
export type ComputersRackCaseId = (typeof COMPUTERS_RACK_CASE_IDS)[number];

export const COMPUTERS_RACK_CASE_PATH = `/s/${fixtureData.server.slug}/computers`;

export function isComputersRackCase(caseId: string): caseId is ComputersRackCaseId {
  return (COMPUTERS_RACK_CASE_IDS as readonly string[]).includes(caseId);
}

const GB = 1024 ** 3;
const HOUR = 3_600_000;
// Above the app's version floor (COMPUTER_VERSION_FLOOR, 1.0.47), so only do-runner-1 asks for anything: Upgrade.
const LATEST = "1.0.53";
const OLDER = "1.0.49";

const me: CreatorSummary = { type: "human", id: fixtureData.humans.owner.id, name: fixtureData.humans.owner.name, displayName: fixtureData.humans.owner.displayName, avatarUrl: null };
const stdrc: CreatorSummary = { type: "human", id: "visual-human-stdrc", name: "stdrc", displayName: "stdrc", avatarUrl: null };
const ricky: CreatorSummary = { type: "human", id: "visual-human-ricky", name: "ricky", displayName: "ricky", avatarUrl: null };
const olive: CreatorSummary = { type: "human", id: "visual-human-olive", name: "olive", displayName: "Olive", avatarUrl: null };

/** used: 0–1 per window, or "up" for a reached limit. */
type WindowUse = number | "up";
interface FleetEntry {
  id: string;
  name: string;
  provider: string | null;
  os: "linux" | "darwin";
  osRelease: string | null;
  deviceClass: "server" | "desktop" | "laptop";
  online: boolean;
  /** Hours since it was last seen, when offline. */
  offlineHours?: number;
  runtimes: string[];
  owner: CreatorSummary | null;
  agents: number;
  disk: number;
  memory: number;
  version?: string;
  usage?: Partial<Record<RuntimeAccountUsageProvider, [WindowUse, WindowUse]>>;
  /** An account that isn't plainly ok: rate limited (nothing left) or needing a sign-in again (no value). */
  health?: Partial<Record<RuntimeAccountUsageProvider, "rate_limited" | "reauth_required">>;
  /** Days until the week window resets (default 4). */
  weekResetDays?: number;
  /** Each agent's runtime, by index (default: the first runtime). */
  agentRuntimes?: string[];
  /** Offline with an upgrade to LATEST in flight (the server's pending request): "Updating…". */
  upgrading?: boolean;
  /** #68: readiness facts about this Computer (the server's and its daemon's); `attention` and `readiness` are composed from them. */
  facts?: (now: number) => ReadinessFact[];
}

const FLEET: FleetEntry[] = [
  { id: "vm-ax42-1", name: "hetzner-ax42-1", provider: "hetzner", os: "linux", osRelease: "Ubuntu 24.04", deviceClass: "server", online: true, runtimes: ["claude", "codex"], owner: stdrc, agents: 8, disk: 0.58, memory: 0.71, usage: { claude: ["up", 0.71], codex: [0.4, 0.22] } },
  { id: "vm-ax42-2", name: "hetzner-ax42-2", provider: "hetzner", os: "linux", osRelease: "Ubuntu 24.04", deviceClass: "server", online: true, runtimes: ["claude", "codex"], owner: stdrc, agents: 6, disk: 0.44, memory: 0.63, usage: { claude: [0.92, 0.64], codex: [0.18, 0.12] } },
  { id: "vm-ax42-3", name: "hetzner-ax42-3", provider: "hetzner", os: "linux", osRelease: "Ubuntu 24.04", deviceClass: "server", online: true, runtimes: ["claude", "codex"], owner: me, agents: 5, disk: 0.37, memory: 0.48, usage: { claude: [0.47, 0.38], codex: [0.33, 0.41] } },
  { id: "vm-ax42-4", name: "hetzner-ax42-4", provider: "hetzner", os: "linux", osRelease: "Ubuntu 24.04", deviceClass: "server", online: true, runtimes: ["claude", "codex"], owner: me, agents: 3, disk: 0.21, memory: 0.3, usage: { claude: [0.12, 0.09], codex: [0.06, 0.04] } },
  { id: "vm-cx22-1", name: "hetzner-cx22-1", provider: "hetzner", os: "linux", osRelease: "Ubuntu 24.04", deviceClass: "server", online: true, runtimes: ["claude"], owner: me, agents: 2, disk: 0.93, memory: 0.52, usage: { claude: [0.64, 0.83] } },
  { id: "vm-cx22-2", name: "hetzner-cx22-2", provider: "hetzner", os: "linux", osRelease: "Ubuntu 24.04", deviceClass: "server", online: false, offlineHours: 5, runtimes: ["claude"], owner: me, agents: 1, disk: 0, memory: 0 },
  { id: "vm-aws-1", name: "aws-gpu-1", provider: "aws", os: "linux", osRelease: "Ubuntu 22.04", deviceClass: "server", online: true, runtimes: ["claude", "codex"], owner: ricky, agents: 4, disk: 0.66, memory: 0.82, usage: { claude: [0.71, 0.55], codex: [0.27, 0.19] }, health: { claude: "rate_limited" } },
  { id: "vm-aws-2", name: "aws-gpu-2", provider: "aws", os: "linux", osRelease: "Ubuntu 22.04", deviceClass: "server", online: false, offlineHours: 26, runtimes: ["codex"], owner: ricky, agents: 1, disk: 0, memory: 0 },
  { id: "vm-gcp", name: "gcp-build", provider: "gcp", os: "linux", osRelease: "Debian 12", deviceClass: "server", online: true, runtimes: ["claude", "codex"], owner: null, agents: 2, disk: 0.49, memory: 0.35, usage: { claude: [0.25, 0.44], codex: [0.52, 0.31] }, health: { claude: "reauth_required" } },
  { id: "vm-do", name: "do-runner-1", provider: "digitalocean", os: "linux", osRelease: "Ubuntu 22.04", deviceClass: "server", online: true, runtimes: ["opencode"], owner: me, agents: 1, disk: 0.31, memory: 0.27, version: OLDER },
  { id: "mac-studio", name: "mac-studio", provider: null, os: "darwin", osRelease: null, deviceClass: "desktop", online: true, runtimes: ["claude", "codex", "cursor"], owner: stdrc, agents: 7, disk: 0.72, memory: 0.6, usage: { claude: [0.58, 0.49], codex: [0.21, 0.15] } },
  { id: "stdrc-mini", name: "stdrc-mini", provider: null, os: "darwin", osRelease: null, deviceClass: "desktop", online: false, offlineHours: 3, runtimes: ["claude"], owner: stdrc, agents: 3, disk: 0, memory: 0 },
  { id: "ricky-mbp", name: "ricky-mbp", provider: null, os: "darwin", osRelease: null, deviceClass: "laptop", online: false, offlineHours: 50, runtimes: ["claude", "codex"], owner: ricky, agents: 0, disk: 0, memory: 0 },
  { id: "vm-kimi", name: "kimi-box-1", provider: "vultr", os: "linux", osRelease: "Ubuntu 24.04", deviceClass: "server", online: true, runtimes: ["kimi-sdk"], owner: me, agents: 2, disk: 0.4, memory: 0.44, usage: { kimi: [0.52, 0.3] } },
  { id: "vm-grok", name: "grok-lab", provider: null, os: "linux", osRelease: "Ubuntu 24.04", deviceClass: "server", online: true, runtimes: ["grok"], owner: null, agents: 0, disk: 0.18, memory: 0.22, usage: { grok: [0.15, 0.1] } },
  // Long-gone personal computers, as on a real server: no provider, nothing to read, last seen 100+ days ago.
  ...([
    ["Maria", "darwin", "laptop", null, 0],
    ["Cindy MacAir", "darwin", "laptop", me, 1],
    ["tyz mini", "darwin", "desktop", stdrc, 0],
    ["xxair", "darwin", "laptop", null, 0],
    ["kabi-mbp", "darwin", "laptop", ricky, 1],
    ["wenyideMacBook-Pro.local", "darwin", "laptop", null, 0],
    ["Shared-EC2", "linux", "server", null, 0],
    ["jiacheng-desktop", "linux", "desktop", null, 0],
    ["old-runner", "linux", "server", stdrc, 0],
    ["Kirby's MacBook Air", "darwin", "laptop", null, 0],
  ] as const).map(([name, os, deviceClass, owner, agents], index): FleetEntry => ({
    id: `stale-${index}`,
    name,
    provider: null,
    os,
    osRelease: os === "linux" ? "Ubuntu 22.04" : null,
    deviceClass,
    online: false,
    offlineHours: (104 + index * 9) * 24,
    runtimes: index % 3 === 0 ? ["claude"] : ["claude", "codex"],
    owner,
    agents,
    disk: 0,
    memory: 0,
  })),
];

const MINUTE = 60_000;
const DAY = 24 * HOUR;
const COMPUTER = { kind: "computer" } as const;

// #68: one Computer of each kind for the needs-attention line. oak-linux is
// fine (Claude 60% used). elm-studio, Olive's: its Claude account needs
// verification, holding its 2 Claude agents, and its Codex week is used up, so
// its 2 Codex agents wait until the week resets in 6 days. pine-mini is
// restarting into an update (offline, its upgrade request pending:
// "Updating…"); the update it is installing still counts until it is on the
// new version. birch-mbp has been offline for two days with an agent on it.
const ATTENTION_FLEET: FleetEntry[] = [
  { id: "oak-linux", name: "oak-linux", provider: "hetzner", os: "linux", osRelease: "Ubuntu 24.04", deviceClass: "server", online: true, runtimes: ["claude", "codex"], owner: me, agents: 3, disk: 0.41, memory: 0.52, usage: { claude: [0.6, 0.35], codex: [0.22, 0.14] } },
  {
    id: "elm-studio", name: "elm-studio", provider: null, os: "darwin", osRelease: null, deviceClass: "desktop", online: true, runtimes: ["claude", "codex"], owner: olive,
    agents: 4, agentRuntimes: ["claude", "claude", "codex", "codex"], disk: 0.55, memory: 0.6, usage: { codex: [0.3, "up"] }, weekResetDays: 6,
    facts: (now) => [
      { resource: { kind: "login", key: "shared:claude" }, code: "verification_required", behaviour: "blocked", since: now - 3 * HOUR },
      { resource: { kind: "login", key: "shared:codex" }, code: "usage_limit_reached", behaviour: "waiting", since: now - DAY, until: now + 6 * DAY },
    ],
  },
  {
    id: "pine-mini", name: "pine-mini", provider: null, os: "darwin", osRelease: null, deviceClass: "desktop", online: false, offlineHours: 1 / 60, runtimes: ["claude"], owner: me, agents: 0, disk: 0, memory: 0,
    version: OLDER, upgrading: true,
    facts: (now) => [{ resource: COMPUTER, code: "computer_updating", behaviour: "waiting", since: now - 90_000, until: now + 28 * MINUTE }],
  },
  {
    id: "birch-mbp", name: "birch-mbp", provider: null, os: "darwin", osRelease: null, deviceClass: "laptop", online: false, offlineHours: 50, runtimes: ["claude", "codex"], owner: me, agents: 1, disk: 0, memory: 0,
    facts: (now) => [{ resource: COMPUTER, code: "computer_offline", behaviour: "blocked", since: now - 50 * HOUR }],
  },
];

// One Computer needing attention (elm-studio), so the line names it, its agents and the way to act.
const SINGLE_ATTENTION_FLEET: FleetEntry[] = [
  ATTENTION_FLEET[0]!,
  ATTENTION_FLEET[1]!,
  { id: "maple-cloud", name: "maple-cloud", provider: "aws", os: "linux", osRelease: "Ubuntu 22.04", deviceClass: "server", online: true, runtimes: ["codex"], owner: olive, agents: 2, disk: 0.33, memory: 0.4, usage: { codex: [0.44, 0.3] } },
];

function agentIdOf(entry: FleetEntry, index: number): string {
  return `visual-rack-agent-${entry.id}-${index}`;
}

function agentRuntimeOf(entry: FleetEntry, index: number): string {
  return entry.agentRuntimes?.[index] ?? entry.runtimes[0] ?? "claude";
}

/** Who the viewer is: a server admin (sees every reason), or a member (only their own Computers'). Null: the
 *  original rack cases, whose machine list predates the summary (an older server). */
type Viewer = "admin" | "member";

/** The machine list's #68 fields for this Computer, as the server composes, names and trims them. */
function readinessFieldsOf(entry: FleetEntry, now: number, viewer: Viewer): { attention: ReadinessAttention; readiness: ComputerReadiness } {
  const facts = entry.facts?.(now) ?? [];
  const ownerName = entry.owner?.displayName ?? null;
  const canSeeReason = viewer === "admin" || entry.owner?.id === me.id;
  const name = <T extends { actor?: string | null; actorName?: string }>(each: T): T => (each.actor === "computer_owner" && ownerName ? { ...each, actorName: ownerName } : each);
  const composed = composeReadinessAttention({
    facts,
    agents: Array.from({ length: entry.agents }, (_, index) => {
      const runtime = agentRuntimeOf(entry, index);
      return { id: agentIdOf(entry, index), chain: agentReadinessChain({ agentId: agentIdOf(entry, index), runtime, loginKey: `shared:${runtime}` }) };
    }),
    update: (entry.version ?? LATEST) !== LATEST ? "available" : null,
    nowMs: now,
  });
  const attention = trimReadinessAttentionForViewer({ ...composed, items: composed.items.map(name) }, canSeeReason);
  const readinessFor = (chain: Parameters<typeof composeReadiness>[1]): Readiness => {
    const each = composeReadiness(facts, chain, now);
    return trimReadinessForViewer(each.state === "blocked" || each.state === "waiting" ? name(each) : each, canSeeReason);
  };
  const readiness: ComputerReadiness = {
    ...readinessFor([{ kind: "server" }, COMPUTER]),
    runtimes: Object.fromEntries(entry.runtimes.map((runtime) => [runtime, readinessFor(runtimeReadinessChain(runtime, `shared:${runtime}`))])),
  };
  return { attention, readiness };
}

const AGENT_AVATARS = ["pixel:robot", "pixel:fox", "pixel:catbot", "pixel:frog", "pixel:ottie", "pixel:targetbot"];
const AGENT_NAMES = ["Cindy", "Wug", "Kirby", "Remy", "Juno", "Otto", "Pixel", "Mira", "Ferry", "Noel", "Jasper", "Tenny", "Iris", "Bram", "Sol", "Vega", "Lumi", "Ada", "Hex", "Nova"];

function machineOf(entry: FleetEntry, now: number, viewer: Viewer | null): Machine {
  const version = entry.version ?? LATEST;
  const upgrade = version !== LATEST;
  return {
    id: entry.id,
    name: entry.name,
    description: null,
    status: entry.online ? "online" : "offline",
    statusVersion: 1,
    apiKeyPrefix: "slk_vis",
    runtimes: entry.runtimes,
    hostname: `${entry.name}.internal`,
    os: entry.os,
    osRelease: entry.osRelease,
    hostProvider: entry.provider,
    deviceClass: entry.deviceClass,
    daemonVersion: fixtureData.latestVersions.daemon,
    isComputer: true,
    computerAttachedByCurrentUser: entry.owner?.id === me.id,
    userId: entry.owner?.id ?? me.id,
    creator: entry.owner ?? me,
    ownerUserId: entry.owner?.id ?? null,
    owner: entry.owner,
    computerVersion: version,
    computerUpgradeAvailable: upgrade,
    remoteUpgradeSupported: true,
    computerBroadcastPolicy: upgrade
      ? { eligibility: "eligible", targetVersion: LATEST, targetRole: "independent_bugfix", migrationClass: "seamless", policyRevision: "visual", reasonCode: "eligible" }
      : null,
    upgradeRequest: entry.upgrading
      ? { id: `visual-upgrade-${entry.id}`, targetVersion: LATEST, requestedAt: new Date(now - 90_000).toISOString(), state: "pending", observedVersion: null, reason: null, resolvedAt: null, deadlineAt: new Date(now + 28 * MINUTE).toISOString() }
      : null,
    diskStatus: entry.online ? { availableBytes: (1 - entry.disk) * 512 * GB, totalBytes: 512 * GB } : null,
    memoryStatus: entry.online ? { availableBytes: (1 - entry.memory) * 64 * GB, totalBytes: 64 * GB } : null,
    lastHeartbeat: new Date(now - (entry.online ? 20_000 : (entry.offlineHours ?? 1) * HOUR)).toISOString(),
    createdAt: fixtureData.times.entityCreatedAtIso,
    ...(viewer ? readinessFieldsOf(entry, now, viewer) : {}),
  };
}

const WINDOW_LABELS: Record<RuntimeAccountUsageProvider, [string, string]> = {
  claude: ["Current session", "Current week (all models)"],
  codex: ["Codex · 5 hours", "Codex · 1 week"],
  kimi: ["5 hours", "1 week"],
  grok: ["5 hours", "1 week"],
  antigravity: ["Gemini Models · 5-hour limit", "Gemini Models · Weekly limit"],
};

const PLAN_LABELS: Record<RuntimeAccountUsageProvider, string> = { claude: "Claude Max", codex: "ChatGPT Pro", kimi: "Kimi Pro", grok: "SuperGrok", antigravity: "Google AI Pro" };

/** The next 14:20 in the fixture's zone (Asia/Shanghai, UTC+8): when the used-up 5-hour window resets. */
function nextResetIso(now: number): string {
  const at = new Date(now);
  at.setUTCHours(6, 20, 0, 0);
  if (at.getTime() <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString();
}

function snapshotOf(machineIndex: number, provider: RuntimeAccountUsageProvider, use: [WindowUse, WindowUse], now: number, health: "ok" | "rate_limited" | "reauth_required" = "ok", weekResetDays = 4): RuntimeAccountUsageSnapshot {
  const [fiveHourLabel, weekLabel] = WINDOW_LABELS[provider];
  // A used-up 5-hour window resets at the next 14:20; a used-up week when the week does.
  const window = (id: string, label: string, value: WindowUse, resetsAt: string) => (value === "up"
    ? { id, label, status: "limit_reached" as const, usedRatio: 1, resetsAt: id === "week" ? resetsAt : nextResetIso(now) }
    : { id, label, status: "ok" as const, usedRatio: value, resetsAt });
  return {
    protocolVersion: 2,
    provider,
    collectedAt: new Date(now - 60_000).toISOString(),
    staleAfter: new Date(now + 30 * 60_000).toISOString(),
    collectorVersion: "visual",
    sourceVersion: "visual",
    accounts: [{
      accountKey: (machineIndex.toString(16) + provider).padEnd(64, "0").replace(/[^a-f0-9]/g, "a").slice(0, 64),
      planLabel: PLAN_LABELS[provider],
      health,
      windows: [
        window("five-hour", fiveHourLabel, use[0], new Date(now + 3 * HOUR).toISOString()),
        window("week", weekLabel, use[1], new Date(now + weekResetDays * 24 * HOUR).toISOString()),
        // A model window (OAR 0.102 `scope`): the cell's second line.
        ...(provider === "claude"
          ? [{ ...window("fable", "Current week (Fable)", machineIndex === 1 ? "up" : 0.4, new Date(now + 6 * 24 * HOUR).toISOString()), scope: { kind: "model" as const, name: "Fable" } }]
          : []),
      ],
    }],
  } as RuntimeAccountUsageSnapshot;
}

interface CaseState {
  view: ComputersRackView;
  sort: ComputersRackSort | null;
  filters: Partial<ComputersRackFilters>;
  /** #68 cases: their own fleet, with the server's summary as this viewer reads it. */
  attention?: { fleet: FleetEntry[]; viewer: Viewer };
}

const BY_CLAUDE: ComputersRackSort = { key: "remaining:claude", direction: "desc" };

const CASE_STATES: Record<ComputersRackCaseId, CaseState> = {
  // (The id predates the default of no grouping; it is the list the links open.)
  "screens.computers.rack.list-provider": { view: "list", sort: BY_CLAUDE, filters: {} },
  "screens.computers.rack.cards-prefix": { view: "cards", sort: { key: "remaining:codex", direction: "desc" }, filters: { groupBy: "prefix" } },
  "screens.computers.rack.filtered": { view: "list", sort: BY_CLAUDE, filters: { status: "online", runtimes: ["claude", "codex"] } },
  "screens.computers.rack.no-results": { view: "list", sort: BY_CLAUDE, filters: { query: "mainframe", status: "online" } },
  "screens.computers.rack.phone": { view: "list", sort: BY_CLAUDE, filters: {} },
  "screens.computers.rack.phone-filtered": { view: "list", sort: BY_CLAUDE, filters: { status: "online", runtimes: ["claude", "codex"] } },
  "screens.computers.rack.needs-attention": { view: "list", sort: null, filters: {}, attention: { fleet: ATTENTION_FLEET, viewer: "admin" } },
  "screens.computers.rack.needs-attention.dark": { view: "list", sort: null, filters: {}, attention: { fleet: ATTENTION_FLEET, viewer: "admin" } },
  "screens.computers.rack.needs-attention.single": { view: "list", sort: null, filters: {}, attention: { fleet: SINGLE_ATTENTION_FLEET, viewer: "admin" } },
  "screens.computers.rack.needs-attention.member": { view: "list", sort: null, filters: {}, attention: { fleet: SINGLE_ATTENTION_FLEET, viewer: "member" } },
};

function primeComputersRack(caseId: ComputersRackCaseId, primeShell: () => void) {
  primeShell();
  const state = CASE_STATES[caseId];
  const fleet = state.attention?.fleet ?? FLEET;
  const now = Date.now();
  const serverId = fixtureData.server.id;
  const machines = fleet.map((entry) => machineOf(entry, now, state.attention?.viewer ?? null));
  let nameIndex = 0;
  const template = useAgentStore.getState().agents[0];
  const agents: Agent[] = fleet.flatMap((entry) => Array.from({ length: entry.agents }, (_, index) => {
    const avatarUrl = AGENT_AVATARS[nameIndex % AGENT_AVATARS.length]!;
    const name = AGENT_NAMES[nameIndex++ % AGENT_NAMES.length]!;
    return {
      ...(template ?? {}),
      id: agentIdOf(entry, index),
      serverId,
      name: name.toLowerCase(),
      displayName: name,
      avatarUrl,
      description: null,
      status: "active",
      runtime: agentRuntimeOf(entry, index),
      machineId: entry.id,
      sessionId: `session-${entry.id}-${index}`,
      deletedAt: null,
    } as Agent;
  }));
  useAgentStore.setState({ agents, agentActivities: {}, loading: false });
  useMachineStore.setState({
    machines,
    loading: false,
    loadStatus: "loaded",
    loadError: false,
    latestComputerVersion: LATEST,
    selectedMachineId: null,
    showAddMachine: false,
    computerOperationProgress: {},
    // The page reloads the list on mount; the fixture host has no server to
    // answer (the CI capture's API mock would put its own three machines in).
    loadMachines: async () => {},
  } as never);
  // A member (#68 member case): who acts on Olive's Computers, never why.
  const role = state.attention?.viewer === "member" ? "member" : null;
  useServerStore.setState((server) => ({
    current: server.current ? { ...server.current, plan: "pro", ...(role ? { role } : {}) } : server.current,
    servers: role ? server.servers.map((each) => (each.id === serverId ? { ...each, role } : each)) : server.servers,
    billing: null,
  }) as never);
  runtimeAccountUsageClient.clear();
  fleet.forEach((entry, index) => {
    for (const [provider, use] of Object.entries(entry.usage ?? {}) as [RuntimeAccountUsageProvider, [WindowUse, WindowUse]][]) {
      runtimeAccountUsageClient.storeSnapshot(serverId, entry.id, provider, snapshotOf(index, provider, use, now, entry.health?.[provider], entry.weekResetDays));
    }
  });
  writeComputersRackView(state.view);
  if (state.sort) writeComputersRackSort(state.sort);
  else window.localStorage.removeItem(COMPUTERS_RACK_SORT_STORAGE_KEY);
  resetComputersRackFiltersForTests(state.filters);
}

export function ComputersRackCase({ caseId, primeShell }: { caseId: ComputersRackCaseId; primeShell: () => void }) {
  useMemo(() => primeComputersRack(caseId, primeShell), [caseId, primeShell]);
  if (window.location.pathname !== COMPUTERS_RACK_CASE_PATH) return null;
  // The whole window, as the app shell fills it: rail, the page, room for the side panel.
  return (
    <main className="h-dvh bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseId} className="flex h-full w-full flex-col overflow-hidden">
        <Routes>
          <Route path="/s/:serverSlug/*" element={<MainLayout />} />
        </Routes>
      </div>
    </main>
  );
}
