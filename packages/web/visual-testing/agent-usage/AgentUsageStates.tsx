import { useState } from "react";
import api from "../../src/api/client";
import { AgentUsageTab } from "../../src/features/agent/AgentUsageTab";
import { useServerStore } from "../../src/store/serverStore";
import { AGENT_USAGE_FIXTURE_AGENTS, agentUsageFixtureResponse } from "./agentUsageFixture";

// The Usage tab in a 400px side panel (lib/panelBounds detail width) over the
// fixture: api.get answers the usage read from agentUsageFixture.ts, "now"
// is 11:00 UTC today.

const SERVER_ID = "visual-usage-server";

function prime() {
  useServerStore.setState((state) => ({ current: state.current ?? ({ id: SERVER_ID, name: "Visual", slug: "visual", role: "owner" } as never) }));
  const asOf = `${new Date().toISOString().slice(0, 10)}T11:00:00.000Z`;
  api.get = (async (url: string, config?: { params?: { from: string; to: string; agents: string } }) => {
    if (url.endsWith("/agent-usage") && config?.params) return { data: agentUsageFixtureResponse(config.params, asOf) };
    throw new Error(`no fixture for ${url}`);
  }) as typeof api.get;
}

export function AgentUsageStates({ agent }: { agent: string }) {
  useState(() => {
    prime();
    return true;
  });
  const agentId = AGENT_USAGE_FIXTURE_AGENTS[agent as keyof typeof AGENT_USAGE_FIXTURE_AGENTS] ?? AGENT_USAGE_FIXTURE_AGENTS.codex;
  return (
    <main className="flex h-screen justify-end bg-layer-sidebar">
      <section data-shot="panel" className="flex h-full w-[400px] min-w-0 flex-col border-s border-line-seam bg-layer-canvas">
        <AgentUsageTab agentId={agentId} />
      </section>
    </main>
  );
}
