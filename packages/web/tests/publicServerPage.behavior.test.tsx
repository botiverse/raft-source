import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import { AppShell } from "../src/App";
import PublicServerPage from "../src/pages/PublicServerPage";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";
import { render } from "@testing-library/react";

const originalGet = api.get;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

test("logged-out public page shows only the read surface and its sign-in banner", async () => {
  const reads: string[] = [];
  api.get = (async (url: string) => {
    reads.push(url);
    if (url === "/public/servers/open-team") {
      return {
        data: {
          server: { id: "server-1", name: "Open Team", slug: "open-team", avatarUrl: null },
          channels: [
            { id: "channel-1", name: "announcements", description: "What is happening" },
            { id: "channel-2", name: "questions", description: null },
          ],
        },
      };
    }
    if (url.endsWith("/channel-1/messages")) {
      return { data: { messages: [{
        id: "message-1",
        senderType: "user",
        senderName: "Cindy",
        messageType: "chat",
        content: "Welcome, everyone",
        createdAt: "2026-09-08T08:00:00.000Z",
      }] } };
    }
    if (url.endsWith("/channel-2/messages")) return { data: { messages: [] } };
    throw new Error(`unexpected read ${url}`);
  }) as typeof api.get;
  let signIns = 0;
  let registrations = 0;

  renderWithIntl(
    <PublicServerPage
      slug="open-team"
      onSignIn={() => { signIns += 1; }}
      onRegister={() => { registrations += 1; }}
      onUnavailable={() => assert.fail("public server must be available")}
    />,
  );

  assert.ok(await screen.findByTestId("public-server-page"));
  await screen.findByText("Welcome, everyone");
  const page = screen.getByTestId("public-server-page");
  const topBanner = screen.getByTestId("public-server-top-banner");
  assert.equal(page.firstElementChild, topBanner, "the read-only notice must span the very top of the app shell");
  assert.ok(topBanner.classList.contains("w-full"));
  assert.ok(screen.getByTestId("public-server-existing-shell"));
  assert.ok(screen.getByTestId("public-server-app-rail"));
  assert.ok(screen.getByTestId("public-server-channel-sidebar"));
  assert.ok(screen.getByTestId("public-server-channel-header"));
  assert.ok(screen.getByTestId("public-server-message-timeline"));
  assert.match(screen.getByTestId("public-server-page").textContent ?? "", /viewing public channels without signing in/);
  assert.equal(screen.queryByRole("textbox"), null, "read-only page must not render a composer");

  fireEvent.click(screen.getByRole("button", { name: /questions/ }));
  await waitFor(() => assert.ok(reads.includes("/public/servers/open-team/channels/channel-2/messages")));
  assert.ok(await screen.findByText("No messages have been posted here yet."));

  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  assert.equal(signIns, 1);
  assert.equal(registrations, 1);
});

test("a non-public slug falls back to the existing sign-in surface without exposing existence", async () => {
  api.get = (async () => {
    throw { response: { status: 404 } };
  }) as typeof api.get;
  let unavailable = 0;

  renderWithIntl(
    <PublicServerPage
      slug="not-public"
      onSignIn={() => {}}
      onRegister={() => {}}
      onUnavailable={() => { unavailable += 1; }}
    />,
  );

  await waitFor(() => assert.equal(unavailable, 1));
  assert.equal(screen.queryByText(/not public/i), null);
});

test("AppShell routes a signed-out /s/:slug visit to the public page before login", async () => {
  useAuthStore.setState({
    user: null,
    accessToken: null,
    refreshToken: null,
    initialized: true,
    restoreState: "signed_out",
    loadUser: async () => {},
  } as never);
  useServerStore.setState({ loading: false, loadServers: async () => {} } as never);
  api.get = (async (url: string) => {
    if (url === "/public/servers/open-team") {
      return {
        data: {
          server: { id: "server-1", name: "Open Team", slug: "open-team", avatarUrl: null },
          channels: [],
        },
      };
    }
    throw new Error(`unexpected read ${url}`);
  }) as typeof api.get;

  render(
    <TestIntlProvider locale="en">
      <MemoryRouter initialEntries={["/s/open-team"]}>
        <AppShell />
      </MemoryRouter>
    </TestIntlProvider>,
  );

  assert.ok(await screen.findByTestId("public-server-page"));
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => assert.equal(screen.queryByTestId("public-server-page"), null));
  assert.ok(screen.getByRole("heading", { name: "Sign In" }));
});

test("an older-page response cannot bleed into a channel selected while it was in flight", async () => {
  const page = Array.from({ length: 50 }, (_, index) => ({
    id: `message-${index + 51}`,
    senderType: "user" as const,
    senderName: "First sender",
    messageType: "chat" as const,
    content: `first-${index + 51}`,
    createdAt: "2026-09-08T08:00:00.000Z",
  }));
  let resolveOlder!: (value: { data: { messages: typeof page } }) => void;
  api.get = ((url: string) => {
    if (url === "/public/servers/race") return Promise.resolve({ data: {
      server: { id: "server-1", name: "Race", slug: "race", avatarUrl: null },
      channels: [
        { id: "channel-1", name: "first", description: null },
        { id: "channel-2", name: "second", description: null },
      ],
    } });
    if (url.endsWith("/channel-1/messages")) return Promise.resolve({ data: { messages: page } });
    if (url.includes("/channel-1/messages?beforeMessageId=")) {
      return new Promise((resolve) => { resolveOlder = resolve; });
    }
    if (url.endsWith("/channel-2/messages")) return Promise.resolve({ data: { messages: [{
      ...page[0]!, id: "second-message", senderName: "Second sender", content: "second-channel-only",
    }] } });
    throw new Error(`unexpected read ${url}`);
  }) as typeof api.get;

  renderWithIntl(
    <PublicServerPage slug="race" onSignIn={() => {}} onRegister={() => {}} onUnavailable={() => {}} />,
  );
  const loadOlder = await screen.findByRole("button", { name: "Load older messages" });
  fireEvent.click(loadOlder);
  fireEvent.click(screen.getByRole("button", { name: "second" }));
  assert.ok(await screen.findByText("second-channel-only"));

  await act(async () => {
    resolveOlder({ data: { messages: [{ ...page[0]!, id: "stale", content: "stale-first-channel" }] } });
  });
  assert.equal(screen.queryByText("stale-first-channel"), null);
  assert.ok(screen.getByText("second-channel-only"));
});
