import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { requestServerSelection, ServerAccessDeniedPage, ServerRedirect, ServerResolver } from "../src/App";
import { en as enMessages } from "../src/i18n/messages/en";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const homeServer: Server = {
  id: "server-home",
  name: "Home",
  avatarUrl: null,
  slug: "home",
  ownerId: "owner-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-07-07T00:00:00.000Z",
};
const originalSetCurrent = useServerStore.getState().setCurrent;

function LocationProbe() {
  const location = useLocation();
  return createElement("output", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

function seedServers() {
  useMachineStore.setState({ machines: [] } as never);
  useServerStore.setState({
    current: homeServer,
    servers: [homeServer],
    members: [],
    loading: false,
    setCurrent: originalSetCurrent,
  } as never);
}

function renderAt(path: string, node: ReturnType<typeof createElement>) {
  return render(createElement(
    TestIntlProvider,
    null,
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      node,
      createElement(LocationProbe),
    ),
  ));
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState({
    ...useServerStore.getInitialState(),
    setCurrent: originalSetCurrent,
  }, true);
});

test("mounted no-access page gives neutral feedback and navigates to the real fallback server", async () => {
  seedServers();
  renderAt("/s/missing", createElement(ServerAccessDeniedPage));

  assert.ok(screen.getByRole("heading", { name: "Server not found" }));
  assert.match(document.body.textContent ?? "", /Redirecting to Home in 3 seconds\./);
  for (const [id, value] of Object.entries(enMessages)) {
    if (!id.startsWith("pages.serverNotFound.")) continue;
    assert.doesNotMatch(value, /invite link|do not have access/i);
  }

  fireEvent.click(screen.getByRole("button", { name: "Go to my server" }));
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/home"));
});

test("requestServerSelection is consumed by the mounted resolver before no-access or community join", async () => {
  seedServers();
  requestServerSelection();

  renderAt("/s/missing", createElement(ServerResolver));

  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/"));
  assert.equal(screen.queryByRole("heading", { name: "Server not found" }), null);
  assert.ok(screen.getByRole("heading", { name: "Choose server" }));
  assert.equal(sessionStorage.getItem("slock_server_selection_requested"), null);
});

test("root redirect honors an explicit picker request over a persisted last server", async () => {
  seedServers();
  localStorage.setItem("slock_last_server_slug", homeServer.slug);
  requestServerSelection();

  renderAt("/", createElement(ServerRedirect));

  assert.ok(screen.getByRole("heading", { name: "Choose server" }));
  assert.equal(screen.queryByTestId("location")?.textContent, "/");
  await waitFor(() => assert.equal(sessionStorage.getItem("slock_server_selection_requested"), null));
});
