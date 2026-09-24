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

function seedViewer(role: "owner" | "member" = "member", userId = "user-self") {
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
      role,
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

test("human profile Message action allows self-DM while still blocking remote joint humans", () => {
  seedViewer("member", "user-self");
  renderPanel(human({ userId: "user-self" }));
  assert.ok(screen.getByRole("button", { name: "Message" }), "self profile keeps the Message entry");
  cleanup();

  seedViewer("member", "user-self");
  renderPanel(human({ userId: "user-1" }));
  assert.ok(screen.getByRole("button", { name: "Message" }), "local active human keeps the Message entry");
  cleanup();

  seedViewer("member", "user-self");
  renderPanel(human({ userId: "user-remote", serverId: "server-other", serverName: "Other" }));
  assert.equal(
    screen.queryByRole("button", { name: "Message" }),
    null,
    "remote joint humans must not get the Message action",
  );
});

test("human profile owner/admin actions keep self-protection separate from self-DM", () => {
  seedViewer("owner", "user-self");
  renderPanel(human({ userId: "user-self", role: "owner" }));
  assert.ok(screen.getByRole("button", { name: "Message" }), "self-DM stays available to the owner");
  assert.equal(screen.queryByRole("button", { name: "Edit role" }), null);
  assert.equal(screen.queryByRole("button", { name: "Remove Member" }), null);
  cleanup();

  seedViewer("owner", "user-self");
  renderPanel(human({ userId: "user-1", role: "member" }));
  assert.ok(screen.getByRole("button", { name: "Message" }));
  assert.ok(screen.getByRole("button", { name: "Edit role" }), "owner can edit another member");
  assert.ok(screen.getByRole("button", { name: "Remove Member" }), "owner can remove another member");
});
