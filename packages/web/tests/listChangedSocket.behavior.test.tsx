// The list-changed pings (store/listChangedSocket.ts): the bridge's bindings
// for permission-updates:changed, joint-invites:changed and
// seat-join-blocks:changed make each list's hook read again, once for a
// burst, only for its server, and only where the hook would read at all; a
// reconnect's rooms:joined (not the first) reads each list once; a
// server:features-changed naming a list's gating flag reads that list.
import assert from "node:assert/strict";
import { act, cleanup, renderHook } from "@testing-library/react";
import { APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, PRO_SEAT_ADD_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { useAppPermissionUpdates } from "../src/components/layout/useAppPermissionUpdates";
import { usePendingJointInvites } from "../src/components/layout/usePendingJointInvites";
import { useSeatJoinBlocks } from "../src/components/layout/useSeatJoinBlocks";
import { __cancelListChangedReadsForTests, LIST_CHANGED_COALESCE_MS } from "../src/store/listChangedSocket";
import { buildMainLayoutSocketBindings } from "../src/store/socketBridge";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";

const SERVER = "server-1";
const originalGet = api.get;
let reads: string[] = [];

beforeEach(() => {
  reads = [];
  api.get = (async (url: string) => {
    reads.push(url);
    if (url === "/channels/joint-invites") return { data: { invites: [] } };
    if (url.endsWith("/seat-join-blocks")) return { data: { blocks: [] } };
    if (url === "/integrations/permission-updates") return { data: { count: 0, needsAdminReview: false } };
    // The reconnect's other loads (channels and the like).
    return { data: [] };
  }) as typeof api.get;
});

afterEach(() => {
  cleanup();
  api.get = originalGet;
  __cancelListChangedReadsForTests();
  resetServerFeatureFlagsForTests();
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function binding(event: string) {
  const socket = { connected: true, emit: () => undefined, on: () => undefined, off: () => undefined, onAny: () => undefined, offAny: () => undefined, disconnect: () => undefined, connect: () => undefined };
  const found = buildMainLayoutSocketBindings(socket as never, () => undefined, async () => undefined, () => undefined, () => undefined)
    .find((candidate) => candidate.event === event);
  assert.ok(found, `the bridge binds ${event}`);
  return found;
}

/** Past the bridge's coalescing window and the hook's read. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, LIST_CHANGED_COALESCE_MS + 50)); });
const count = (path: string) => reads.filter((url) => url === path).length;

function asRole(role: "owner" | "member") {
  useServerStore.setState({ current: { id: SERVER, slug: "s", name: "S", role } } as never);
}

test("permission-updates:changed: a burst for this server is one read; another server's is none", async () => {
  renderHook(() => useAppPermissionUpdates(SERVER, "u1", true));
  await settle();
  assert.equal(count("/integrations/permission-updates"), 1, "the first read");
  const changed = binding("permission-updates:changed");
  act(() => {
    changed.handler({ serverId: "another-server" });
    changed.handler({ serverId: SERVER });
    changed.handler({ serverId: SERVER });
    changed.handler({ serverId: SERVER });
  });
  await settle();
  assert.equal(count("/integrations/permission-updates"), 2, "one more read for the burst");
});

test("joint-invites:changed reads an owner's invites again; a member's hook asks nothing", async () => {
  asRole("owner");
  const owner = renderHook(() => usePendingJointInvites());
  await settle();
  assert.equal(count("/channels/joint-invites"), 1);
  act(() => binding("joint-invites:changed").handler({ serverId: SERVER }));
  await settle();
  assert.equal(count("/channels/joint-invites"), 2);
  owner.unmount();

  reads = [];
  asRole("member");
  renderHook(() => usePendingJointInvites());
  act(() => binding("joint-invites:changed").handler({ serverId: SERVER }));
  await settle();
  assert.deepEqual(reads, [], "a member can't be invited: nothing read");
});

test("seat-join-blocks:changed reads the list again where the flag is on; with it off nothing is read", async () => {
  asRole("member");
  setServerFeatureFlagForTests(SERVER, PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  const on = renderHook(() => useSeatJoinBlocks());
  await settle();
  const path = `/servers/${SERVER}/seat-join-blocks`;
  assert.equal(count(path), 1);
  act(() => binding("seat-join-blocks:changed").handler({ serverId: SERVER }));
  await settle();
  assert.equal(count(path), 2);
  on.unmount();

  reads = [];
  setServerFeatureFlagForTests(SERVER, PRO_SEAT_ADD_FEATURE_FLAG_KEY, false);
  renderHook(() => useSeatJoinBlocks());
  act(() => binding("seat-join-blocks:changed").handler({ serverId: SERVER }));
  await settle();
  assert.deepEqual(reads, [], "flag off: nothing read");
});

test("unauthorized: an App permission ping reads nothing for someone who can't manage Apps", async () => {
  renderHook(() => useAppPermissionUpdates(SERVER, "u1", false));
  act(() => binding("permission-updates:changed").handler({ serverId: SERVER }));
  await settle();
  assert.deepEqual(reads, []);
});

test("a reconnect's rooms:joined reads each list once; the first rooms:joined reads none", async () => {
  asRole("owner");
  setServerFeatureFlagForTests(SERVER, PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  renderHook(() => {
    useAppPermissionUpdates(SERVER, "u1", true);
    usePendingJointInvites();
    useSeatJoinBlocks();
  });
  await settle();
  const lists = ["/integrations/permission-updates", "/channels/joint-invites", `/servers/${SERVER}/seat-join-blocks`];
  const counts = () => lists.map(count);
  assert.deepEqual(counts(), [1, 1, 1], "the hooks' first reads");
  const roomsJoined = binding("rooms:joined");
  // rooms:joined dispatches `new Event(...)` on window: Node's global Event,
  // which jsdom's window refuses; a browser has one Event.
  const NodeEvent = globalThis.Event;
  globalThis.Event = window.Event;
  try {
    act(() => roomsJoined.handler(undefined));
    await settle();
    assert.deepEqual(counts(), [1, 1, 1], "the first rooms:joined follows the first reads");
    act(() => roomsJoined.handler(undefined));
    await settle();
    assert.deepEqual(counts(), [2, 2, 2], "a reconnect: once each");
  } finally {
    globalThis.Event = NodeEvent;
  }
});

test("server:features-changed naming pro_seat_add or app_prompt_text_consent reads the list it gates, once; other keys or servers read nothing", async () => {
  asRole("owner");
  setServerFeatureFlagForTests(SERVER, PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
  renderHook(() => {
    useAppPermissionUpdates(SERVER, "u1", true);
    usePendingJointInvites();
    useSeatJoinBlocks();
  });
  await settle();
  const lists = ["/integrations/permission-updates", "/channels/joint-invites", `/servers/${SERVER}/seat-join-blocks`];
  const counts = () => lists.map(count);
  assert.deepEqual(counts(), [1, 1, 1]);
  const featuresChanged = binding("server:features-changed");
  act(() => {
    featuresChanged.handler({ serverId: SERVER, keys: ["sidebar_mark_all_read"] });
    featuresChanged.handler({ serverId: "another-server", keys: [PRO_SEAT_ADD_FEATURE_FLAG_KEY] });
  });
  await settle();
  assert.deepEqual(counts(), [1, 1, 1], "another flag, or another server: nothing");
  act(() => {
    featuresChanged.handler({ serverId: SERVER, keys: [PRO_SEAT_ADD_FEATURE_FLAG_KEY] });
    featuresChanged.handler({ serverId: SERVER, keys: [PRO_SEAT_ADD_FEATURE_FLAG_KEY, APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY] });
  });
  await settle();
  assert.deepEqual(counts(), [2, 1, 2], "each gated list once");
});

test("hidden: reconnects and pings read no list; showing reads each list exactly once", async () => {
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new window.Event("visibilitychange"));
  };
  const NodeEvent = globalThis.Event;
  globalThis.Event = window.Event;
  try {
    asRole("owner");
    setServerFeatureFlagForTests(SERVER, PRO_SEAT_ADD_FEATURE_FLAG_KEY, true);
    renderHook(() => {
      useAppPermissionUpdates(SERVER, "u1", true);
      usePendingJointInvites();
      useSeatJoinBlocks();
    });
    await settle();
    const lists = ["/integrations/permission-updates", "/channels/joint-invites", `/servers/${SERVER}/seat-join-blocks`];
    const counts = () => lists.map(count);
    assert.deepEqual(counts(), [1, 1, 1], "the hooks' first reads");
    const roomsJoined = binding("rooms:joined");
    act(() => roomsJoined.handler(undefined));
    await settle();

    act(() => setVisibility("hidden"));
    // The OS keeps dropping the background socket: three reconnects, and pings between them.
    for (let round = 0; round < 3; round += 1) {
      act(() => roomsJoined.handler(undefined));
      await settle();
    }
    act(() => {
      binding("permission-updates:changed").handler({ serverId: SERVER });
      binding("joint-invites:changed").handler({ serverId: SERVER });
      binding("seat-join-blocks:changed").handler({ serverId: SERVER });
    });
    await settle();
    assert.deepEqual(counts(), [1, 1, 1], "nothing read while hidden");

    act(() => setVisibility("visible"));
    act(() => { window.dispatchEvent(new window.Event("focus")); });
    await settle();
    assert.deepEqual(counts(), [2, 2, 2], "one catch-up read each on show");

    act(() => roomsJoined.handler(undefined));
    await settle();
    assert.deepEqual(counts(), [3, 3, 3], "a visible reconnect reads each list once, as before");
  } finally {
    globalThis.Event = NodeEvent;
    delete (document as { visibilityState?: unknown }).visibilityState;
  }
});
