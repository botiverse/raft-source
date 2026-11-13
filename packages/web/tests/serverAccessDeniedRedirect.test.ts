import "./helpers/domSetup";

import assert from "node:assert/strict";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";

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
const otherServer: Server = { ...homeServer, id: "server-other", name: "Other", slug: "other", role: "member" };
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

/** The no-access page at /s/missing, with the real root resolver at "/" so a
 *  navigation to the picker renders it. */
function renderNotFoundRoutes() {
  return renderAt("/s/missing", createElement(
    Routes,
    null,
    createElement(Route, { path: "/s/:serverSlug", element: createElement(ServerAccessDeniedPage) }),
    createElement(Route, { path: "/", element: createElement(ServerRedirect) }),
  ));
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState({
    ...useServerStore.getInitialState(),
    setCurrent: originalSetCurrent,
  }, true);
});

test("mounted no-access page gives neutral feedback and never redirects on its own", async () => {
  seedServers();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  renderAt("/s/missing", createElement(ServerAccessDeniedPage));

  assert.ok(screen.getByRole("heading", { level: 1, name: "Server not found" }));
  assert.ok(screen.getByText("The link may be out of date, or you haven\u2019t joined this server."));
  // The client cannot tell "not a member" from "does not exist", so no copy may
  // claim one of them.
  for (const [id, value] of Object.entries(enMessages)) {
    if (!id.startsWith("pages.serverNotFound.")) continue;
    assert.doesNotMatch(value, /invite link|do not have access|redirect|seconds/i);
  }
  assert.doesNotMatch(document.body.textContent ?? "", /Redirecting|seconds/);

  // The old page left after 3 s; well past that, it is still here.
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  assert.equal(screen.getByTestId("location").textContent, "/s/missing");
  assert.ok(screen.getByRole("heading", { name: "Server not found" }));
  assert.equal(vi.getTimerCount(), 0, "the page schedules no timer");
});

test("the one button goes back to the current server, named on the button", async () => {
  seedServers();
  renderAt("/s/missing", createElement(ServerAccessDeniedPage));

  assert.equal(screen.getAllByRole("button").length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/home"));
});

test("with no current server the button goes back to the last server", async () => {
  useServerStore.setState({
    current: null,
    servers: [homeServer, otherServer],
    members: [],
    loading: false,
    setCurrent: originalSetCurrent,
  } as never);
  localStorage.setItem("slock_last_server_slug", otherServer.slug);
  renderAt("/s/missing", createElement(ServerAccessDeniedPage));

  fireEvent.click(screen.getByRole("button", { name: "Back to Other" }));
  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/s/other"));
});

test("with no current or last server the button opens the server picker", async () => {
  // Servers exist, but none is current or remembered: the page must not guess
  // one (it used to pick the first), it hands the choice to the picker.
  useServerStore.setState({
    current: null,
    servers: [homeServer, otherServer],
    members: [],
    loading: false,
    setCurrent: originalSetCurrent,
  } as never);
  renderNotFoundRoutes();

  assert.ok(screen.queryByRole("button", { name: /^Back to/ }) === null, "no server to go back to");
  fireEvent.click(screen.getByRole("button", { name: "Choose a server" }));

  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/"));
  assert.ok(screen.getByRole("heading", { name: "Choose server" }));
  assert.ok(screen.queryByRole("heading", { name: "Server not found" }) === null);
});

test("requestServerSelection is consumed by the mounted resolver before no-access or community join", async () => {
  seedServers();
  requestServerSelection();

  renderAt("/s/missing", createElement(ServerResolver));

  await waitFor(() => assert.equal(screen.getByTestId("location").textContent, "/"));
  assert.ok(screen.queryByRole("heading", { name: "Server not found" }) === null);
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
