import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sidebar from "../src/components/layout/Sidebar";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";
import { useUIStore } from "../src/store/uiStore";

/**
 * Behavior: the mounted Sidebar's "Saved" nav badge shows the store's true
 * `savedStore.total` — NOT the loaded-page length (`saved.length`).
 *
 * Why this exists (mutant-kill, PR #3388): tests/savedNavCount.behavior.test.tsx
 * pins <SavedNavCount total={n}/> in isolation, and tests/savedStoreTotal.test.ts
 * pins the store's `total` bookkeeping — but NEITHER proves the real Sidebar
 * subscribes to `savedStore.total` and feeds it into the badge. Stryker's
 * mutation-diff-gate replaced the Sidebar selector
 *   `useSavedStore((s) => s.total)` -> `useSavedStore(() => undefined)`
 * and every test still passed (SURVIVING mutant). This test renders the real
 * Sidebar with `saved: []` (length 0) and `total: 42`, and asserts the Saved row
 * renders `42`. It FAILS if the selector is mutated to `() => undefined` (badge
 * shows nothing → no "42") or to `(s) => s.saved.length` (badge would show
 * nothing, since 0 is hidden — and never "42").
 *
 * Run: `pnpm --filter @botiverse/raft-web test:dom`.
 */

function makeSidebarOrder() {
  return {
    channelOrder: [],
    agentOrder: [],
    dmOrder: [],
    channelSortMode: "manual" as const,
    jointChannelSortMode: "manual" as const,
    dmSortMode: "manual" as const,
    pinnedSortMode: "manual" as const,
    pinned: [],
    pinnedChannelIds: [],
    pinnedAgentIds: [],
    pinnedOrder: [],
    hiddenDmIds: [],
    channelPanelTabOrder: [],
    agentPanelTabOrder: [],
    pinnedVersion: 0,
  };
}

function seedStores() {
  useAuthStore.setState({
    user: {
      id: "user-saved",
      email: "saved@example.com",
      gravatarHash: "",
      name: "saved-user",
      displayName: null,
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  });
  useServerStore.setState({
    current: {
      id: "server-saved",
      name: "Saved Server",
      avatarUrl: null,
      slug: "saved-server",
      ownerId: "user-saved",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-06-28T00:00:00.000Z",
    },
    servers: [],
    members: [],
    sidebarOrder: makeSidebarOrder(),
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });
  useMessageStore.setState({
    unreadCounts: {},
    mentionFlags: {},
    drafts: {},
    clearUnread: () => {},
    markRead: async () => {},
  });
  useAgentStore.setState({ agents: [], loading: false });
  useMachineStore.setState({ machines: [], loading: false });
  useInboxStore.setState({
    totalCount: 0,
    totalUnreadCount: 0,
    loadInbox: async () => {},
  });
  useUIStore.setState({ sidebarOpen: true });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("Sidebar 'Saved' badge renders savedStore.total, not the loaded page length", () => {
  seedStores();
  // A loaded page of length 0, but a true server total of 42. The badge must
  // reflect `total` (42), proving the Sidebar subscribes to `s.total` and not
  // `s.saved.length` (which is 0 → hidden badge).
  useSavedStore.setState({ saved: [], savedIds: new Set(), total: 42 });

  render(
    <MemoryRouter initialEntries={["/s/saved-server/channel/none"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  // Locate the real "Saved" nav row and assert its badge shows the store total.
  const savedButton = screen.getByRole("button", { name: /^Saved/ });
  const badge = within(savedButton).getByText("42");
  assert.ok(badge, "Saved nav badge renders the store total (42)");
  // And it must NOT be showing the loaded-page length (0).
  assert.equal(within(savedButton).queryByText("0"), null, "badge is not saved.length (0)");
});
