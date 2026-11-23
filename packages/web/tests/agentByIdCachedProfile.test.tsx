import assert from "node:assert/strict";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { __testInternals } from "../src/components/layout/MainLayout";
import { setCachedAgentProfile } from "../src/components/profile/profileFallbackCache";
import { triggerServerReset } from "../src/store/serverResetRegistry";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useServerStore } from "../src/store/serverStore";
import api from "../src/api/client";
import { TestIntlProvider } from "./helpers/intl";

// Review of task #441: the agent page reads a profile cache that is filled
// after the page has rendered (a peer server's agent is in no agent list). It
// used to pick the entry up on the layout's next render; the main column's
// routes no longer render with the layout, so the page subscribes to the cache.

vi.mock("../src/features/agent/AgentDetailPanel", () => ({
  AgentDetailPanel: ({ agent }: { agent: Agent }) => <div data-testid="agent-detail">{agent.name}</div>,
}));
vi.mock("../src/components/agent/AgentUnavailablePanel", () => ({
  default: () => <div data-testid="agent-unavailable" />,
}));

const AgentById = __testInternals.AgentById;

function peerAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: "agent-peer-1", serverId: "peer-server", serverName: "Peer Server", serverSlug: "peer",
    name: "peer-agent", displayName: "Peer Agent", avatarUrl: null, description: null, status: "active",
    model: "gpt-5.2", runtime: "codex", reasoningEffort: null, executionMode: "cloud", envVars: null,
    machineId: null, creatorType: null, creatorId: null, creator: null, createdAgents: [], deletedAt: null,
    createdAt: new Date(0).toISOString(),
    ...over,
  } as Agent;
}

// A server reset reloads announcements: no request leaves this test.
const originalGet = api.get;
beforeEach(() => {
  api.get = (() => new Promise(() => {})) as typeof api.get;
});

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("an agent page opened before its cached profile exists shows the profile once it is cached, with no parent render", async () => {
  useServerStore.setState({ current: { id: "host-server", slug: "host", name: "Host", role: "member" } } as never);
  let parentRenders = 0;
  function Parent() {
    parentRenders += 1;
    return <AgentById agentId="agent-peer-1" />;
  }
  render(<TestIntlProvider><MemoryRouter><Parent /></MemoryRouter></TestIntlProvider>);
  assert.ok(await screen.findByTestId("agent-unavailable"));
  const rendersBefore = parentRenders;

  // Another server's entry for the same agent is not this page's.
  act(() => setCachedAgentProfile("other-server", peerAgent({ name: "elsewhere" })));
  assert.ok(screen.queryByTestId("agent-detail") === null, "another server's entry shows nothing here");

  act(() => setCachedAgentProfile("host-server", peerAgent()));
  assert.equal((await screen.findByTestId("agent-detail")).textContent, "peer-agent");
  assert.ok(screen.queryByTestId("agent-unavailable") === null, "the unavailable panel is gone");

  // A newer entry replaces it; a server reset clears it.
  act(() => setCachedAgentProfile("host-server", peerAgent({ name: "peer-agent-renamed" })));
  assert.equal((await screen.findByTestId("agent-detail")).textContent, "peer-agent-renamed");
  act(() => triggerServerReset());
  assert.ok(await screen.findByTestId("agent-unavailable"));
  assert.equal(parentRenders, rendersBefore, "the parent never rendered again");
});
