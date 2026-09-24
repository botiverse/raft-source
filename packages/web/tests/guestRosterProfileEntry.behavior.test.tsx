import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import ChannelMembers from "../src/components/agent/ChannelMembers";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { LocaleProvider } from "../src/i18n/LocaleProvider";

const channelId = "channel-1";
const serverId = "server-1";

function human(overrides: Record<string, unknown> = {}) {
  return {
    id: "human-1",
    name: "developer",
    displayName: "Developer",
    description: null,
    avatarUrl: null,
    gravatarHash: "hash",
    role: "owner",
    serverRole: "owner",
    channelRole: "member",
    effectiveChannelRole: "member",
    channelAdminBasis: "none",
    canChangeChannelRole: false,
    ...overrides,
  } as never;
}

function prefetched() {
  return {
    channelAgents: [],
    channelHumans: [human()],
    channelExternalMembers: [],
    loading: false,
    addMembers: async () => undefined,
    addAgent: async () => undefined,
    removeAgent: async () => undefined,
    addHuman: async () => undefined,
    removeHuman: async () => undefined,
    changeMemberRole: async () => undefined,
    roleChangeFailed: false,
  } as never;
}

function seed(role: "guest" | "member" | "owner") {
  useServerStore.setState({ current: { id: serverId, role }, members: [] } as never);
  useChannelStore.setState({
    channels: [{ id: channelId, serverId, name: "general", type: "channel", joined: true, archivedAt: null }],
  } as never);
  useAgentStore.setState({ agents: [] } as never);
  useAuthStore.setState({ user: { id: "me" } } as never);
  resetServerFeatureFlagsForTests();
  setServerFeatureFlagForTests(serverId, TOPBAR_OVERFLOW_FEATURE_FLAG_KEY, true);
}

function renderMembers() {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <ChannelMembers channelId={channelId} presentation="page" hideTrigger prefetchedMembers={prefetched()} />
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
});

// Behaviour contract replacing the former source-grep assertion on
// ChannelMembers/LegacyChannelMembers. The roster entry must reach the same
// human profile the chat panel already reaches; the panel itself does the
// capability filtering, so gating the entry made one surface disagree with
// the other.
test("a guest can open a human profile from the members page", () => {
  seed("guest");
  renderMembers();
  const row = screen.getByRole("button", { name: /Developer/ });
  assert.ok(row, "guest must reach the human profile from the roster row");
});

test("a non-guest keeps the same members-page profile entry", () => {
  seed("owner");
  renderMembers();
  assert.ok(screen.getByRole("button", { name: /Developer/ }));
});
