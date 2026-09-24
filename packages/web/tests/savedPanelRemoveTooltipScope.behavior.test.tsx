import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import SavedPanel from "../src/components/saved/SavedPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useSavedStore } from "../src/store/savedStore";
import type { SavedEntry } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";

const savedEntry: SavedEntry = {
  messageId: "saved-message-1",
  channelId: "channel-general",
  channelName: "general",
  channelType: "channel",
  content: "Saved tooltip scope check",
  senderType: "agent",
  senderId: "agent-cindy",
  senderName: "Cindy",
  createdAt: "2026-07-12T00:00:00.000Z",
  savedAt: "2026-07-12T00:00:00.000Z",
  parentChannelId: null,
  parentChannelName: null,
  parentChannelType: null,
  parentMessageId: null,
};

function seedStores() {
  useAuthStore.setState({
    user: {
      id: "user-saved-tooltip",
      email: "saved-tooltip@example.com",
      gravatarHash: "",
      name: "saved-tooltip-user",
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
      id: "server-saved-tooltip",
      name: "Saved Tooltip Server",
      avatarUrl: null,
      slug: "saved-tooltip",
      ownerId: "user-saved-tooltip",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-12T00:00:00.000Z",
    },
    servers: [],
    members: [],
  });
  useAgentStore.setState({
    agents: [{
      id: "agent-cindy",
      name: "cindy",
      displayName: "Cindy",
      description: null,
      avatarUrl: null,
      status: "online",
      runtime: "codex",
      channelIds: [],
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    }],
    loading: false,
  });
  useSavedStore.setState({
    saved: [savedEntry],
    savedIds: new Set([savedEntry.messageId]),
    loading: false,
    hasMore: false,
    total: 1,
    loadSaved: async () => {},
    loadMore: async () => {},
    unsaveMessage: async () => {},
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("Saved remove tooltip is scoped to the remove badge hover, not the whole row", () => {
  seedStores();

  render(
    <MemoryRouter initialEntries={["/s/saved-tooltip/saved"]}>
      <SavedPanel />
    </MemoryRouter>,
  );

  const row = screen.getByRole("button", { name: /Saved tooltip scope check/ });
  const tooltip = screen.getByText("Remove from Saved");
  const hoverScope = tooltip.closest(".group");

  assert.equal(row.classList.contains("group"), false, "hovering the saved row must not reveal the remove tooltip");
  assert.ok(hoverScope, "tooltip keeps a hover group");
  assert.notEqual(hoverScope, row, "tooltip hover group is not the saved row");
  assert.ok(
    hoverScope?.querySelector("[aria-label='Remove from Saved']"),
    "tooltip hover group is the small remove badge wrapper",
  );
});
