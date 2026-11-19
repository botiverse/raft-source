// AppShell reads the server list and the cross-server unread summary once per
// signed-in person, not once per user object: the boot's own profile writes
// (the timezone observation after the first screen, a rail reorder) replace
// the object, and each replacement used to read the list again, and with it
// the members and sidebar order (docs/frontend/boot-requests.md).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TestIntlProvider } from "./helpers/intl";
import { signInReaderForTests, signOutReaderForTests } from "./helpers/artifactReader";
import api from "../src/api/client";
import { AppShell } from "../src/App";
import { setArtifactSourceForTests } from "../src/apps/artifacts/artifactSource";
import { resetArtifactOpenEarlyForTests } from "../src/apps/artifacts/artifactOpenEarly";
import { fakeArtifactSource, resetFakeArtifactSourceForTests } from "../src/apps/artifacts/fakeArtifactSource";
import { __resetAuthProvidersForTest } from "../src/hooks/useAuthProviders";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

const HOME = { id: "server-home", slug: "home", name: "Home" };
const user = {
  id: "boot-user", email: "boot@example.com", name: "booter",
  displayName: "Boot User", description: null, avatarUrl: null, emailVerified: true,
  profileSetupCompletedAt: "2026-08-21T00:00:00.000Z",
};

let loads = { servers: 0, summary: 0 };
const originalGet = api.get;
const originalResizeObserver = globalThis.ResizeObserver;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
  localStorage.clear();
  signInReaderForTests();
  resetFakeArtifactSourceForTests();
  __resetAuthProvidersForTest();
  setArtifactSourceForTests({ ...fakeArtifactSource });
  loads = { servers: 0, summary: 0 };
  useServerStore.setState({
    current: null, loading: true, servers: [],
    loadServers: async () => {
      loads.servers += 1;
      useServerStore.setState({ servers: [HOME], loading: false } as never);
    },
    loadServerUnreadSummary: async () => { loads.summary += 1; },
  } as never);
  api.get = (async (url: string) => {
    if (url === "/auth/providers") return { data: { providers: [] } };
    return new Promise(() => {});
  }) as typeof api.get;
  useAuthStore.setState({ user, initialized: true, restoreState: "authenticated", accessToken: "test-access", refreshToken: "test-refresh", loadUser: async () => {} } as never);
});

afterEach(() => {
  cleanup();
  setArtifactSourceForTests(null);
  resetArtifactOpenEarlyForTests();
  signOutReaderForTests();
  api.get = originalGet;
  globalThis.ResizeObserver = originalResizeObserver;
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function mountApp(path: string) {
  window.history.replaceState({}, "", path);
  return render(<TestIntlProvider><MemoryRouter initialEntries={[path]}><AppShell /></MemoryRouter></TestIntlProvider>);
}

test("a new user object for the same person (a profile write) reads neither the server list nor the unread summary again", async () => {
  mountApp("/artifacts/not-an-id");
  await waitFor(() => assert.equal(loads.summary, 1));
  await act(async () => {});
  assert.deepEqual(loads, { servers: 1, summary: 1 }, "one of each at boot");

  // What the timezone observation does after the first screen.
  await act(async () => {
    useAuthStore.setState({ user: { ...user, lastObservedTimezone: "Europe/Paris" } } as never);
  });
  await act(async () => {});
  assert.deepEqual(loads, { servers: 1, summary: 1 }, "the same person: nothing read again");

  // Another person signed in on this page: theirs are read.
  await act(async () => {
    useAuthStore.setState({ user: { ...user, id: "other-user" } } as never);
  });
  await act(async () => {});
  assert.deepEqual(loads, { servers: 2, summary: 2 }, "another person: read again");
});

test("an account that becomes verified reads the server list again (its gate opened)", async () => {
  useAuthStore.setState({ user: { ...user, emailVerified: false } } as never);
  mountApp("/artifacts/not-an-id");
  await act(async () => {});
  const before = loads.servers;
  await act(async () => {
    useAuthStore.setState({ user: { ...user, emailVerified: true } } as never);
  });
  await act(async () => {});
  assert.equal(loads.servers, before + 1);
});
