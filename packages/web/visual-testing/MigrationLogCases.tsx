import { useMemo } from "react";
import { Route, Routes } from "react-router-dom";
import type { AgentMigrationLogEntry, AgentMigrationLogResponse } from "@botiverse/raft-shared";
import api from "../src/api/client";
import MainLayout from "../src/components/layout/MainLayout";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import type { Machine } from "../src/store/machineStore";
import { useMachineStore } from "../src/store/machineStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";

// The agent migration log (迁移记录) on the whole app shell: the real MainLayout at /s/visual/migrations, as an
// owner, over a log of its own that api.get answers (GET /agent-migrations/log). The table case opens with
// `?view=table` (the page keeps its view in the URL); the chart case is the same log as the chord chart, for
// comparison. Eight moves, oldest first as the server sends them: successes, a failure, a cancel, one still
// running, a move to the cloud, a computer renamed since (studio-mac, now mac-studio-2) and one no longer on the
// server (old-runner). In sharedCases.json (React only, no parity gate), so a PR's visual-shots block can ask for them.

export const MIGRATION_LOG_CASE_IDS = [
  "screens.agent-migration-log.table",
  "screens.agent-migration-log.chart",
] as const;
export type MigrationLogCaseId = (typeof MIGRATION_LOG_CASE_IDS)[number];

export const MIGRATION_LOG_CASE_PATH = `/s/${fixtureData.server.slug}/migrations`;

export function isMigrationLogCase(caseId: string): caseId is MigrationLogCaseId {
  return (MIGRATION_LOG_CASE_IDS as readonly string[]).includes(caseId);
}

/** The URL params a case opens with (the view; no filters). */
export function migrationLogCaseParams(caseId: MigrationLogCaseId): Record<string, string> {
  return caseId === "screens.agent-migration-log.table" ? { view: "table" } : {};
}

const AGENTS = [
  { id: "visual-mig-kirby", name: "Kirby", avatarUrl: "pixel:robot", machineId: "mig-hx1" },
  { id: "visual-mig-atlas", name: "Atlas", avatarUrl: "pixel:fox", machineId: "mig-studio" },
  { id: "visual-mig-mira", name: "Mira", avatarUrl: "pixel:catbot", machineId: "mig-oak" },
] as const;

/** The server's computers now: studio-mac was renamed mac-studio-2; old-runner has left the server. */
const MACHINES = [
  { id: "mig-hx1", name: "hetzner-ax42-1", hostProvider: "hetzner" },
  { id: "mig-hx2", name: "hetzner-ax42-2", hostProvider: "hetzner" },
  { id: "mig-studio", name: "mac-studio-2", deviceClass: "desktop" },
  { id: "mig-oak", name: "oak-linux", deviceClass: "server" },
] as const;

const owner = { id: fixtureData.humans.owner.id, name: fixtureData.humans.owner.name, displayName: fixtureData.humans.owner.displayName };

function move(ref: string, agentId: string, from: [string, string], to: [string, string] | "cloud", startedAt: string, minutes: number | null, over: Partial<AgentMigrationLogEntry> = {}): AgentMigrationLogEntry {
  const start = Date.parse(startedAt);
  return {
    migrationRef: ref,
    agentId,
    sourceMachineId: from[0],
    sourceMachineName: from[1],
    targetKind: to === "cloud" ? "hosted" : "computer",
    targetMachineId: to === "cloud" ? null : to[0],
    targetMachineName: to === "cloud" ? null : to[1],
    initiatedBy: owner,
    outcome: "completed",
    startedAt,
    endedAt: minutes == null ? null : new Date(start + minutes * 60_000).toISOString(),
    bytes: null,
    files: null,
    failureKind: null,
    failureCode: null,
    ...over,
  };
}

const HX1: [string, string] = ["mig-hx1", "hetzner-ax42-1"];
const HX2: [string, string] = ["mig-hx2", "hetzner-ax42-2"];
const STUDIO_THEN: [string, string] = ["mig-studio", "studio-mac"];
const STUDIO: [string, string] = ["mig-studio", "mac-studio-2"];
const OAK: [string, string] = ["mig-oak", "oak-linux"];
const OLD: [string, string] = ["mig-old", "old-runner"];

const LOG: AgentMigrationLogResponse = {
  truncated: false,
  migrations: [
    move("visual-mig-1", "visual-mig-kirby", OLD, STUDIO_THEN, "2026-10-02T09:12:00.000Z", 3.5),
    move("visual-mig-2", "visual-mig-atlas", OLD, HX2, "2026-10-05T14:40:00.000Z", 6),
    move("visual-mig-3", "visual-mig-kirby", STUDIO_THEN, HX1, "2026-10-11T08:03:00.000Z", 2, { outcome: "failed", failureKind: "network", failureCode: "transfer_reset" }),
    move("visual-mig-4", "visual-mig-kirby", STUDIO_THEN, HX1, "2026-10-11T08:20:00.000Z", 4.25),
    move("visual-mig-5", "visual-mig-mira", HX2, "cloud", "2026-10-19T16:30:00.000Z", 1.5, { outcome: "canceled" }),
    move("visual-mig-6", "visual-mig-atlas", HX2, STUDIO, "2026-10-27T11:45:00.000Z", 5),
    move("visual-mig-7", "visual-mig-mira", HX2, OAK, "2026-11-03T10:05:00.000Z", 3),
    move("visual-mig-8", "visual-mig-kirby", HX1, OAK, "2026-11-18T07:55:00.000Z", null, { outcome: "in_progress" }),
  ],
};

function primeMigrationLog(primeShell: () => void) {
  primeShell();
  const template = useAgentStore.getState().agents[0];
  const serverId = fixtureData.server.id;
  useAgentStore.setState({
    agents: AGENTS.map((agent) => ({
      ...(template ?? {}),
      id: agent.id,
      serverId,
      name: agent.name.toLowerCase(),
      displayName: agent.name,
      avatarUrl: agent.avatarUrl,
      description: null,
      status: "active",
      machineId: agent.machineId,
      deletedAt: null,
    }) as Agent),
    agentActivities: {},
    loading: false,
  });
  const machineTemplate = useMachineStore.getState().machines[0];
  useMachineStore.setState({
    machines: MACHINES.map((machine) => ({ ...(machineTemplate ?? {}), ...machine, serverId }) as unknown as Machine),
    loading: false,
    loadStatus: "loaded",
    loadError: false,
    // The fixture host has no server to answer a reload.
    loadMachines: async () => {},
  } as never);
  const get = api.get.bind(api);
  api.get = (async (url: string, config?: unknown) => {
    if (url === "/agent-migrations/log") return { data: LOG };
    return get(url, config as never);
  }) as typeof api.get;
}

export function MigrationLogCase({ caseId, primeShell }: { caseId: MigrationLogCaseId; primeShell: () => void }) {
  useMemo(() => primeMigrationLog(primeShell), [primeShell]);
  if (window.location.pathname !== MIGRATION_LOG_CASE_PATH) return null;
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
