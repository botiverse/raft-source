import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { AppShell } from "../src/App";
import InviteAcceptPage from "../src/components/auth/InviteAcceptPage";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { PENDING_INVITE_STORAGE_KEY } from "../src/utils/socialAuth";

const originalApiGet = api.get;
const originalApiPost = api.post;

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  api.post = originalApiPost;
  localStorage.clear();
  window.localStorage.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function renderInvite(insideCountsHidden: boolean) {
  api.get = (async (url: string) => {
    assert.equal(url, "/auth/invite-info?token=invite-token");
    return {
      data: {
        kind: "join_link",
        serverName: "Raft Test",
        inviterName: null,
        memberCount: 12,
        agentCount: 4,
        insideCountsHidden,
        humanSeatLimitReached: false,
        humanSeatLimitMessage: null,
        agreement: null,
      },
    };
  }) as typeof api.get;

  // Wrapped in an EN provider because the page now uses react-intl. Its
  // assertions below are deliberately unchanged: the English output must be
  // byte-identical after the migration, which is the strongest available check
  // that moving these sentences into ICU messages did not alter the copy.
  return render(
    <TestIntlProvider locale="en">
      <MemoryRouter>
        <InviteAcceptPage
          token="invite-token"
          onInviteConsumed={() => {}}
          onSwitchToLogin={() => {}}
          onSwitchToRegister={() => {}}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

test("invite preview hides inside counts when the server marks them private", async () => {
  const view = renderInvite(true);

  assert.ok(await screen.findByText("everyone"));
  assert.match(view.container.textContent ?? "", /Meet everyone inside\./);
  assert.doesNotMatch(view.container.textContent ?? "", /12 humans|4 agents/);
});

test("invite preview shows nonzero inside counts when they are public", async () => {
  const view = renderInvite(false);

  assert.ok(await screen.findByText("12 humans"));
  assert.ok(screen.getByText("4 agents"));
  assert.match(
    view.container.textContent ?? "",
    /Meet 12 humans and 4 agents inside\./,
  );
  assert.equal(screen.queryByText("everyone"), null);
});

test("signed-in no-agreement invite waits for an explicit join click", async () => {
  useAuthStore.setState({
    user: { id: "u1", name: "u", displayName: "U", emailVerified: true },
    initialized: true,
  } as never);
  useServerStore.setState({
    servers: [],
    current: null,
    members: [],
    loadServers: async () => {},
  } as never);

  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: { serverName: "Raft Test", serverId: "server-1" } };
  }) as typeof api.post;

  renderInvite(false);

  const joinButton = await screen.findByRole("button", { name: "Join Server" });
  assert.deepEqual(posts, [], "loading a signed-in invite must not mutate membership");

  fireEvent.click(joinButton);

  await waitFor(() => assert.equal(posts.length, 1));
  assert.deepEqual(posts[0], {
    url: "/auth/accept-invite",
    body: { token: "invite-token", agreementId: undefined },
  });
});

test("app resume returns a pending no-agreement invite to confirmation before accepting", async () => {
  window.localStorage.setItem(PENDING_INVITE_STORAGE_KEY, "invite-token");
  useAuthStore.setState({
    user: {
      id: "u1",
      email: "u@example.com",
      gravatarHash: "",
      name: "u",
      displayName: "U",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      profileSetupCompletedAt: "2026-08-21T00:00:00.000Z",
      preferredLanguage: null,
      displayLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "off",
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    initialized: true,
    restoreState: "authenticated",
    loadUser: async () => {},
  } as never);
  useServerStore.setState({
    servers: [],
    current: null,
    members: [],
    loading: false,
    loadServers: async () => {},
  } as never);

  api.get = (async (url: string) => {
    assert.equal(url, "/auth/invite-info?token=invite-token");
    return {
      data: {
        kind: "join_link",
        serverName: "Raft Test",
        inviterName: null,
        memberCount: 12,
        agentCount: 4,
        insideCountsHidden: false,
        humanSeatLimitReached: false,
        humanSeatLimitMessage: null,
        agreement: null,
      },
    };
  }) as typeof api.get;

  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: { serverName: "Raft Test", serverId: "server-1" } };
  }) as typeof api.post;

  render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={["/"]}>
        <AppShell />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  const joinButton = await screen.findByRole("button", { name: "Join Server" });
  assert.equal(window.localStorage.getItem(PENDING_INVITE_STORAGE_KEY), null);
  assert.deepEqual(posts, [], "resuming a pending invite must not auto-accept after login");

  fireEvent.click(joinButton);

  await waitFor(() => assert.equal(posts.length, 1));
  assert.deepEqual(posts[0], {
    url: "/auth/accept-invite",
    body: { token: "invite-token", agreementId: undefined },
  });
});
