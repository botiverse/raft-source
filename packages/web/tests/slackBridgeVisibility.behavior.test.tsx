import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { useServerFeatureFlag, resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";

const originalPost = api.post;

afterEach(() => {
  cleanup();
  api.post = originalPost;
  resetServerFeatureFlagsForTests();
  useServerStore.setState({ current: null, servers: [] } as never);
});

function GateProbe() {
  const gate = useServerFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master);
  return <output data-testid="slack-bridge-gate">{gate.resolved && gate.enabled ? "visible" : "hidden"}</output>;
}

function currentServer(id: string) {
  return {
    id,
    name: id,
    avatarUrl: null,
    slug: id,
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

test("Slack Bridge gate is isolated to the current server when switching", async () => {
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/feature-flags/evaluate");
    const serverId = (body as { serverId?: string }).serverId;
    return { data: { evaluations: [{ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, enabled: serverId === "server-a" }] } };
  }) as typeof api.post;

  useServerStore.setState({ current: currentServer("server-a"), servers: [] } as never);
  render(<GateProbe />);
  await waitFor(() => assert.equal(screen.getByTestId("slack-bridge-gate").textContent, "visible"));

  await act(async () => {
    useServerStore.setState((state) => ({ current: { ...state.current!, ...currentServer("server-b") } }));
  });
  await waitFor(() => assert.equal(screen.getByTestId("slack-bridge-gate").textContent, "hidden"));
});
