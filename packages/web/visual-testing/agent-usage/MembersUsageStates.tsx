import { useState } from "react";
import { AGENT_USAGE_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import api from "../../src/api/client";
import { MembersPage } from "../../src/features/members/MembersPage";
import { useAgentStore } from "../../src/store/agentStore";
import type { Agent } from "../../src/store/agentStore";
import { useAuthStore } from "../../src/store/authStore";
import { useMachineStore } from "../../src/store/machineStore";
import { useServerStore } from "../../src/store/serverStore";
import { AGENT_USAGE_FIXTURE_AGENTS, agentUsageFixtureResponse } from "./agentUsageFixture";

// Members › Agents › Usage (agent_usage_v0) drawn with the real page on the
// fixture: the fixture's three agents, one whose Computer sends no usage yet,
// and one the server leaves out (not the viewer's to inspect). api.get answers
// the usage read from agentUsageFixture.ts; "now" is 11:00 UTC today.

const SERVER_ID = "visual-usage-members";
const OLD = "usage-agent-old";
const NAMES: [string, string, string, string][] = [
  [AGENT_USAGE_FIXTURE_AGENTS.mixed, "Remy", "claude", "opus"],
  [AGENT_USAGE_FIXTURE_AGENTS.codex, "Lagoon", "codex", "gpt-6.1-sol"],
  [AGENT_USAGE_FIXTURE_AGENTS.claude, "Tenny", "claude", "opus"],
  [OLD, "Archer", "claude", "opus"],
];

function agent([id, name, runtime, model]: [string, string, string, string]): Agent {
  return {
    id, name: name.toLowerCase(), displayName: name, avatarUrl: null, description: null, status: "active",
    model, runtime, serverRole: "member", reasoningEffort: null, executionMode: "byoc",
    envVars: null, machineId: null, creatorType: "user", creatorId: "visual-owner",
    creator: { type: "human", id: "visual-owner", name: "owner", displayName: "Owner", avatarUrl: null },
    createdAgents: [], deletedAt: null, createdAt: "2026-01-01T00:00:00.000Z",
  } as Agent;
}

function prime() {
  useServerStore.setState({
    current: { id: SERVER_ID, name: "Visual", slug: "visual", role: "owner" } as never,
    members: [{ userId: "visual-owner", email: null, name: "owner", displayName: "Owner", description: null, avatarUrl: null, role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" }] as never,
    membersLoadError: false,
  } as never);
  useAgentStore.setState({ agents: NAMES.map(agent), agentActivities: {}, loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAuthStore.setState({ user: { id: "visual-owner" } } as never);
  const asOf = `${new Date().toISOString().slice(0, 10)}T11:00:00.000Z`;
  const ids = Object.values(AGENT_USAGE_FIXTURE_AGENTS).join(",");
  api.get = (async (url: string, config?: { params?: { from: string; to: string } }) => {
    if (url.endsWith("/agent-usage") && config?.params) {
      const base = agentUsageFixtureResponse({ ...config.params, agents: ids }, asOf);
      return { data: { ...base, visible_agents: 4, agents: [...base.agents, { agent_id: OLD, since: null, usage_reported: false }] } };
    }
    throw new Error(`no fixture for ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [{ key: AGENT_USAGE_FEATURE_FLAG_KEY, enabled: true }] } };
    throw new Error(`no fixture for ${url}`);
  }) as typeof api.post;
}

export function MembersUsageStates({ width }: { width: number }) {
  useState(() => {
    prime();
    return true;
  });
  return (
    <main className="flex h-screen bg-layer-sidebar">
      <section data-shot="members" className="flex h-full min-w-0 flex-col border-e border-line-seam bg-layer-canvas" style={{ width }}>
        <MembersPage />
      </section>
    </main>
  );
}
