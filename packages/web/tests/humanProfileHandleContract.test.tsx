import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HumanDetailPanel from "../src/components/member/HumanDetailPanel";
import type { HumanProfile } from "../src/components/member/HumanDetailPanel";
import { TestIntlProvider } from "./helpers/intl";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null } as never);
  useServerStore.setState({ current: null, members: [] } as never);
});

function human(overrides: Partial<HumanProfile> = {}): HumanProfile {
  return {
    userId: "user-1",
    serverId: "server-1",
    serverName: "Design",
    serverSlug: "design",
    email: "ada@example.com",
    gravatarHash: "hash",
    name: "ada",
    displayName: "Ada Lovelace",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-14T00:00:00.000Z",
    membershipStatus: "active",
    createdAgents: [],
    ...overrides,
  };
}

test("human profile surfaces the handle alongside the display name", () => {
  useAuthStore.setState({
    user: { id: "user-self", name: "self" },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Design",
      slug: "design",
      role: "owner",
    },
    members: [],
    loading: false,
  } as never);

  render(
    <TestIntlProvider>
      <MemoryRouter>
        <HumanDetailPanel human={human()} />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  assert.ok(screen.getAllByText("Ada Lovelace").length > 0);
  assert.ok(screen.getAllByText("@ada").length >= 2);
  assert.ok(screen.getByTitle("@ada"));
});
