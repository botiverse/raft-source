import assert from "node:assert/strict";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { useAppPermissionUpdates, notifyAppPermissionUpdatesChanged } from "../src/components/layout/useAppPermissionUpdates";
import { useSystemNotifications } from "../src/components/layout/useSystemNotifications";
import { useServerStore } from "../src/store/serverStore";
import { useAuthStore } from "../src/store/authStore";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import { useChannelStore } from "../src/store/channelStore";
import type { ReactNode } from "react";

const originalGet = api.get;
afterEach(() => {
  cleanup(); api.get = originalGet;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
});

test("permission attention drops obsolete Server/user responses and clears on successful approval", async () => {
  const pending: Array<(response: { data: { count: number } }) => void> = [];
  const servers: string[] = [];
  api.get = ((_url: string, config: { headers: { "X-Server-Id": string } }) => {
    servers.push(config.headers["X-Server-Id"]);
    return new Promise((resolve) => pending.push(resolve));
  }) as typeof api.get;
  const hook = renderHook(({ server, user, manage }) => useAppPermissionUpdates(server, user, manage), {
    initialProps: { server: "a", user: "one", manage: true },
  });
  hook.rerender({ server: "b", user: "one", manage: true });
  await act(async () => pending[0]!({ data: { count: 8 } }));
  assert.equal(hook.result.current, 0);
  await act(async () => pending[1]!({ data: { count: 2 } }));
  assert.equal(hook.result.current, 2);
  await act(async () => notifyAppPermissionUpdatesChanged("a"));
  assert.equal(pending.length, 2, "another Server's approval does not refresh this one");
  await act(async () => notifyAppPermissionUpdatesChanged("b"));
  await act(async () => pending[2]!({ data: { count: 0 } }));
  assert.equal(hook.result.current, 0);
  hook.rerender({ server: "b", user: "two", manage: true });
  hook.rerender({ server: "b", user: "two", manage: false });
  await act(async () => pending[3]!({ data: { count: 9 } }));
  assert.equal(hook.result.current, 0, "a late manager response cannot survive permission loss");
  assert.deepEqual(servers, ["a", "b", "b", "b"]);
});

test("permission attention refreshes when the page becomes visible again, not while it is hidden", async () => {
  let count = 1;
  let reads = 0;
  api.get = (async () => { reads += 1; return { data: { count } }; }) as typeof api.get;
  let state: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  try {
    const hook = renderHook(() => useAppPermissionUpdates("a", "one", true));
    await waitFor(() => assert.equal(hook.result.current, 1));
    count = 0;
    state = "hidden";
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    assert.equal(reads, 1, "a hidden page does not refetch");
    state = "visible";
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    await waitFor(() => assert.equal(hook.result.current, 0));
    assert.equal(reads, 2);
    hook.unmount();
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
    assert.equal(reads, 2, "an unmounted hook stops listening");
  } finally {
    // Drop the own property: the jsdom getter on Document.prototype answers again.
    delete (document as { visibilityState?: unknown }).visibilityState;
  }
});

test("existing notification center carries the permission review action directly to installed Apps", async () => {
  useAuthStore.setState({ user: { id: "manager" }, initialized: true } as never);
  useServerStore.setState({ current: { id: "scope", slug: "team", name: "Team", role: "owner", plan: "pro" }, loading: false } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  let count = 1;
  api.get = (async (url: string) => ({ data: url === "/integrations/permission-updates" ? { count } : { invites: [] } })) as typeof api.get;
  const wrapper = ({ children }: { children: ReactNode }) => <TestIntlProvider><MemoryRouter initialEntries={["/s/team/chat"]}>{children}</MemoryRouter></TestIntlProvider>;
  const hook = renderHook(() => ({ notifications: useSystemNotifications(), location: useLocation() }), { wrapper });
  await waitFor(() => assert.ok(hook.result.current.notifications.some((entry) => entry.id === "app-permission-updates")));
  const notice = hook.result.current.notifications.find((entry) => entry.id === "app-permission-updates")!;
  assert.equal(notice.title, "App permissions need review");
  act(() => notice.action!.onClick());
  // The installed Apps are on the Apps page now (#proj-apps task #22).
  assert.equal(hook.result.current.location.pathname, "/s/team/apps");
  assert.equal(hook.result.current.location.search, "?permission_updates=1");
  count = 0;
  await act(async () => notifyAppPermissionUpdatesChanged("scope"));
  await waitFor(() => assert.ok(!hook.result.current.notifications.some((entry) => entry.id === "app-permission-updates")));
});
