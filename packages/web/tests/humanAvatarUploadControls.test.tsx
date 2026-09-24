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

function seedViewer(userId = "user-self") {
  useAuthStore.setState({
    user: { id: userId, name: "self" },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Design",
      slug: "design",
      role: "member",
    },
    members: [],
    loading: false,
  } as never);
}

function renderPanel(profile: HumanProfile) {
  return render(
    <TestIntlProvider>
      <MemoryRouter>
        <HumanDetailPanel human={profile} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("human profile uses the avatar itself as the upload entry without a remove action", () => {
  seedViewer("user-self");
  renderPanel(human({ userId: "user-self" }));

  assert.ok(screen.getByRole("button", { name: "Upload image" }));
  assert.equal(screen.queryByRole("button", { name: /remove/i }), null);
  assert.equal(screen.queryByText(/remove custom image/i), null);
  cleanup();

  seedViewer("user-self");
  renderPanel(human({ userId: "user-other" }));
  assert.equal(
    screen.queryByRole("button", { name: "Upload image" }),
    null,
    "another human's avatar is not an upload entry",
  );
});
