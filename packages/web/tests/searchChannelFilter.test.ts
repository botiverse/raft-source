import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import api from "../src/api/client";
import MessageSearchPage from "../src/components/search/MessageSearchPage";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get;

function LocationProbe() {
  const location = useLocation();
  return createElement("output", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

function seedStores() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      gravatarHash: "ownerhash",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    members: [],
  } as never);
  useChannelStore.setState({
    channels: [
      { id: "channel-design", serverId: "server-1", name: "design", description: null, type: "channel", createdAt: "2026-07-01T00:00:00.000Z", archivedAt: null, joined: true },
      { id: "channel-roadmap", serverId: "server-1", name: "roadmap", description: null, type: "channel", createdAt: "2026-07-01T00:00:00.000Z", archivedAt: null, joined: true },
    ],
    dmChannels: [],
  } as never);
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useSearchContentStore.setState({ slot: null });
  useThreadStore.setState({ openParentMessageId: null, openThreadChannelId: null, openParentChannelId: null } as never);
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useSearchContentStore.setState(useSearchContentStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useThreadStore.setState(useThreadStore.getInitialState(), true);
});

test("mounted Search channel combobox filters live options and commits the first match", async () => {
  seedStores();
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;

  render(createElement(
    TestIntlProvider,
    null,
    createElement(
      MemoryRouter,
      { initialEntries: ["/s/server/search"] },
      createElement(MessageSearchPage),
      createElement(LocationProbe),
    ),
  ));

  fireEvent.click(screen.getByRole("button", { name: "Open channel filter" }));
  assert.ok(screen.getByRole("button", { name: "#design" }));
  assert.ok(screen.getByRole("button", { name: "#roadmap" }));

  const filterInput = screen.getAllByRole("textbox").at(-1);
  assert.ok(filterInput instanceof HTMLInputElement);
  fireEvent.change(filterInput, { target: { value: "road" } });
  const filteredLabels = screen
    .getAllByRole("button")
    .map((button) => button.textContent)
    .filter((label) => label?.startsWith("#"));
  fireEvent.keyDown(filterInput, { key: "Escape" });
  assert.deepEqual(filteredLabels, ["#roadmap"]);

  fireEvent.click(screen.getByRole("button", { name: "Open channel filter" }));
  fireEvent.click(screen.getByRole("button", { name: "#roadmap" }));
  await waitFor(() => {
    assert.equal(screen.getByTestId("location").textContent, "/s/server/search?channelId=channel-roadmap");
  });
});
