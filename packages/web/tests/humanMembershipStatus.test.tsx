import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { getHumanDepartureLabel } from "../src/components/member/humanMembershipStatus";
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

function seedViewer() {
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

test("human departure labels distinguish voluntary leave from removal", () => {
  assert.equal(getHumanDepartureLabel("active"), null);
  assert.equal(getHumanDepartureLabel(null), null);
  assert.equal(getHumanDepartureLabel(undefined), null);
  assert.equal(getHumanDepartureLabel("left"), "Left");
  assert.equal(getHumanDepartureLabel("removed"), "Removed");
});

test("human profile surfaces the shared departure label as a badge", () => {
  seedViewer();
  renderPanel(human({ membershipStatus: "left" }));
  assert.ok(screen.getAllByText("Left").length >= 1);
  assert.equal(screen.queryByText("Removed"), null);
  cleanup();

  seedViewer();
  renderPanel(human({ membershipStatus: "removed" }));
  assert.ok(screen.getAllByText("Removed").length >= 1);
  assert.equal(screen.queryByText("Left"), null);
});
