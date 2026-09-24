import assert from "node:assert/strict";
import test from "node:test";
import type { ApiChannel, Channel } from "../src/store/channelStore.js";

// channelStore's import chain reads `localStorage` at module load; stub it, then
// load the store via dynamic import (static imports hoist above this stub).
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { useChannelStore, toChannel, activityFrom } = await import("../src/store/channelStore.js");
const { triggerServerReset } = await import("../src/store/serverResetRegistry.js");
const api = (await import("../src/api/client.js")).default;

function ch(id: string, over: Partial<Channel> = {}): Channel {
  return { id, name: id, description: null, type: "channel", createdAt: "1970-01-01T00:00:00.000Z", joined: true, ...over };
}

// An API channel as it arrives over the wire — carries `lastMessageAt`.
function apiCh(id: string, lastMessageAt: string | null, over: Partial<ApiChannel> = {}): ApiChannel {
  return { id, name: id, description: null, type: "channel", createdAt: "1970-01-01T00:00:00.000Z", joined: true, lastMessageAt, ...over };
}

type WithActivity = Channel & { lastMessageAt?: unknown };

// First-principles guarantee: `lastMessageAt` lives in the `channelActivity`
// slice, NOT on the channel identity objects, so an activity bump (every inbound
// message) never changes the `channels`/`dmChannels` array references — no
// identity consumer (ChatPanel, MessageItem, Sidebar rows) re-renders. This is
// what makes the per-consumer `ignore-activity` defenses unnecessary
// (#proj-frontend render-perf, slice-separation root fix).

test("touchChannelActivity writes the activity slice WITHOUT churning channels/dmChannels references", () => {
  const channels = [ch("c1"), ch("c2")];
  const dmChannels = [ch("d1", { type: "dm" })];
  useChannelStore.setState({ channels, dmChannels, channelActivity: {} });

  useChannelStore.getState().touchChannelActivity("c1", "2026-06-07T00:00:00.000Z");
  const after = useChannelStore.getState();

  // The identity arrays keep their EXACT references — the whole point.
  assert.strictEqual(after.channels, channels, "touchChannelActivity must not rebuild channels");
  assert.strictEqual(after.dmChannels, dmChannels, "touchChannelActivity must not rebuild dmChannels");
  // Teeth: the activity WAS recorded, in the slice.
  assert.notStrictEqual(after.channelActivity, {});
  assert.equal(after.channelActivity["c1"], "2026-06-07T00:00:00.000Z");

  // A second bump to a DIFFERENT channel still leaves both arrays untouched.
  useChannelStore.getState().touchChannelActivity("d1", "2026-06-07T01:00:00.000Z");
  const after2 = useChannelStore.getState();
  assert.strictEqual(after2.channels, channels);
  assert.strictEqual(after2.dmChannels, dmChannels);
  assert.equal(after2.channelActivity["d1"], "2026-06-07T01:00:00.000Z");
});

test("channel identity objects do not carry lastMessageAt (it lives in the slice)", () => {
  useChannelStore.setState({ channels: [ch("c1")], dmChannels: [], channelActivity: { c1: "x" } });
  const c = useChannelStore.getState().channels[0] as WithActivity;
  assert.equal(c.lastMessageAt, undefined, "lastMessageAt must live in channelActivity, not on the Channel object");
});

// ---------------------------------------------------------------------------
// Boundary-leak regressions (@cross #2646 review). These pin the EXACT holes
// that the first round of slice-separation missed: API ingress must split the
// hot `lastMessageAt` off the cold identity object, and every removal/reset
// path must clean the hot slice. Without these, the leak class can silently
// come back without failing CI.
// ---------------------------------------------------------------------------

// (1) The shared ingress chokepoint — every load/dm/ensure/create/update/
// archive/unarchive/openDM/openUserDM path funnels its API payload through
// `toChannel` + `activityFrom`. Pinning the chokepoint covers them all.

test("toChannel drops lastMessageAt from the Channel identity object", () => {
  const c = toChannel(apiCh("a", "2026-06-07T00:00:00.000Z")) as WithActivity;
  assert.equal(c.lastMessageAt, undefined, "toChannel must strip the hot field off identity");
  assert.equal(c.type, "channel", "default type applied when API omits it");
});

test("toChannel honors the DM defaultType when the API omits type", () => {
  assert.equal(toChannel({ ...apiCh("d", null), type: undefined }, "dm").type, "dm");
});

test("activityFrom extracts lastMessageAt by id (null when the API omits it)", () => {
  const patch = activityFrom([apiCh("a", "x"), { ...apiCh("b", null), lastMessageAt: undefined }]);
  assert.deepEqual(patch, { a: "x", b: null });
});

test("openDM coalesces concurrent requests for the same agent and releases the key after success", async (t) => {
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  let requestCount = 0;
  let resolveFirst!: (value: { data: ApiChannel }) => void;
  const firstResponse = new Promise<{ data: ApiChannel }>((resolve) => {
    resolveFirst = resolve;
  });
  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    requestCount += 1;
    assert.equal(url, "/channels/dm");
    assert.deepEqual(body, { agentId: "agent-1" });
    if (requestCount === 1) return firstResponse;
    return {
      data: apiCh("dm-agent-2", "2026-06-07T02:00:00.000Z", {
        type: "dm",
        peerType: "agent",
        peerId: "agent-1",
      }),
    };
  });

  const first = useChannelStore.getState().openDM("agent-1");
  const concurrent = useChannelStore.getState().openDM("agent-1");
  assert.strictEqual(concurrent, first, "same-agent callers must share one in-flight request");
  assert.equal(requestCount, 1);

  resolveFirst({
    data: apiCh("dm-agent-1", "2026-06-07T01:00:00.000Z", {
      type: "dm",
      peerType: "agent",
      peerId: "agent-1",
    }),
  });
  const [opened, openedAgain] = await Promise.all([first, concurrent]);
  assert.strictEqual(openedAgain, opened);
  assert.equal(opened.id, "dm-agent-1");
  assert.equal((opened as WithActivity).lastMessageAt, undefined);
  assert.equal((useChannelStore.getState().dmChannels[0] as WithActivity).lastMessageAt, undefined);
  assert.equal(useChannelStore.getState().channelActivity["dm-agent-1"], "2026-06-07T01:00:00.000Z");

  const afterSettle = await useChannelStore.getState().openDM("agent-1");
  assert.equal(afterSettle.id, "dm-agent-2");
  assert.equal((afterSettle as WithActivity).lastMessageAt, undefined);
  assert.equal(useChannelStore.getState().channelActivity["dm-agent-2"], "2026-06-07T02:00:00.000Z");
  assert.equal(requestCount, 2, "the coalescing key must be released after success");
});

test("openUserDM coalesces concurrent requests and releases the key after failure", async (t) => {
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  let requestCount = 0;
  let rejectFirst!: (reason: Error) => void;
  const firstResponse = new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  });
  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    requestCount += 1;
    assert.equal(url, "/channels/dm");
    assert.deepEqual(body, { userId: "user-1" });
    if (requestCount === 1) return firstResponse;
    return {
      data: apiCh("dm-user-1", "2026-06-07T03:00:00.000Z", {
        type: "dm",
        peerType: "user",
        peerId: "user-1",
      }),
    };
  });

  const first = useChannelStore.getState().openUserDM("user-1");
  const concurrent = useChannelStore.getState().openUserDM("user-1");
  assert.strictEqual(concurrent, first, "same-user callers must share one in-flight request");
  assert.equal(requestCount, 1);

  rejectFirst(new Error("temporary DM creation failure"));
  await assert.rejects(first, /temporary DM creation failure/);

  const retry = await useChannelStore.getState().openUserDM("user-1");
  assert.equal(retry.id, "dm-user-1");
  assert.equal((retry as WithActivity).lastMessageAt, undefined);
  assert.equal((useChannelStore.getState().dmChannels[0] as WithActivity).lastMessageAt, undefined);
  assert.equal(useChannelStore.getState().channelActivity["dm-user-1"], "2026-06-07T03:00:00.000Z");
  assert.equal(requestCount, 2, "the coalescing key must be released after failure");
});

test("createChannel strips lastMessageAt off returned and stored identities while preserving activity", async (t) => {
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    assert.equal(url, "/channels");
    assert.deepEqual(body, {
      name: "created",
      description: "created description",
      visibility: "public",
      agentIds: [],
      userIds: [],
      targetServerSlug: undefined,
      invitedPeople: [],
      jointInvites: undefined,
    });
    return { data: apiCh("created", "2026-06-07T04:00:00.000Z", { name: "created" }) };
  });

  const created = await useChannelStore.getState().createChannel("created", "created description");

  assert.equal((created as WithActivity).lastMessageAt, undefined);
  assert.equal((useChannelStore.getState().channels[0] as WithActivity).lastMessageAt, undefined);
  assert.equal(useChannelStore.getState().channelActivity.created, "2026-06-07T04:00:00.000Z");
});

test("joinChannel reports whether the membership mutation succeeded", async (t) => {
  useChannelStore.setState({
    channels: [ch("join-target", { joined: false })],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
  });
  let requestCount = 0;
  t.mock.method(api, "post", async () => {
    requestCount += 1;
    if (requestCount === 1) throw new Error("temporary join failure");
    return { data: { ok: true } };
  });

  assert.equal(await useChannelStore.getState().joinChannel("join-target"), false);
  assert.equal(useChannelStore.getState().channels[0]?.joined, false);
  assert.equal(useChannelStore.getState().channelLocalMembership["join-target"], undefined);

  assert.equal(await useChannelStore.getState().joinChannel("join-target"), true);
  assert.equal(useChannelStore.getState().channels[0]?.joined, true);
  assert.equal(useChannelStore.getState().channelLocalMembership["join-target"], true);
});

// (3) Mutation paths execute the split live (no socket involved in these two).

test("updateChannel strips lastMessageAt off identity and writes it to the slice", async (t) => {
  useChannelStore.setState({ channels: [ch("c1", { name: "old" })], dmChannels: [], channelActivity: {} });
  t.mock.method(api, "patch", async () => ({ data: apiCh("c1", "2026-06-07T12:00:00.000Z", { name: "new" }) }));

  const updated = await useChannelStore.getState().updateChannel("c1", { name: "new" });

  const s = useChannelStore.getState();
  assert.equal((updated as WithActivity).lastMessageAt, undefined);
  assert.equal((s.channels.find((c) => c.id === "c1") as WithActivity).lastMessageAt, undefined);
  assert.equal(s.channelActivity["c1"], "2026-06-07T12:00:00.000Z");
});

test("updateChannel removes hidden #all from the local channel list", async (t) => {
  useChannelStore.setState({
    channels: [ch("all-1", { name: "all" }), ch("general")],
    dmChannels: [],
    channelActivity: { "all-1": "x", general: "y" },
  });
  t.mock.method(api, "patch", async () => ({
    data: apiCh("all-1", "2026-06-07T12:00:00.000Z", { name: "all", type: "private" }),
  }));

  await useChannelStore.getState().updateChannel("all-1", { visibility: "private" });

  const s = useChannelStore.getState();
  assert.equal(s.channels.some((c) => c.id === "all-1"), false, "hidden #all must disappear locally after the PATCH response");
  assert.equal("all-1" in s.channelActivity, false, "hidden #all activity should not leave a stale sidebar row");
  assert.equal(s.channels.some((c) => c.id === "general"), true);
  assert.equal(s.channelActivity.general, "y");
});

test("restoreAllChannel reinserts restored #all into the local channel list", async (t) => {
  useChannelStore.setState({
    channels: [ch("general")],
    dmChannels: [],
    channelActivity: { general: "y" },
  });
  t.mock.method(api, "post", async (url: string) => {
    assert.equal(url, "/channels/system/all/restore");
    return {
      data: apiCh("all-1", "2026-06-07T12:00:00.000Z", { name: "all", type: "channel" }),
    };
  });

  await useChannelStore.getState().restoreAllChannel();

  const s = useChannelStore.getState();
  assert.equal(s.channels[0]?.id, "all-1", "#all should return to the front of the sorted channel list");
  assert.equal(s.channels.some((c) => c.id === "general"), true);
  assert.equal(s.channelActivity["all-1"], "2026-06-07T12:00:00.000Z");
  assert.equal(s.channelActivity.general, "y");
});

test("convertChannelToJoint replaces only the converted channel and preserves activity slices", async (t) => {
  const target = ch("c1", { name: "general", type: "channel" });
  const other = ch("c2", { name: "random", type: "private" });
  useChannelStore.setState({
    channels: [target, other],
    dmChannels: [],
    channelActivity: { c1: "old-activity", c2: "other-activity" },
  });
  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    assert.equal(url, "/channels/c1/convert-to-joint");
    assert.equal(body, undefined);
    return {
      data: {
        channel: apiCh("c1", "2026-06-07T14:00:00.000Z", {
          name: "general",
          type: "joint",
          jointChannelId: "joint-c1",
          jointRole: "host",
        }),
      },
    };
  });

  const converted = await useChannelStore.getState().convertChannelToJoint("c1");

  const s = useChannelStore.getState();
  assert.equal(converted.id, "c1");
  assert.equal(converted.type, "joint");
  assert.equal(converted.jointChannelId, "joint-c1");
  assert.equal((s.channels.find((c) => c.id === "c1") as WithActivity).lastMessageAt, undefined);
  assert.equal(s.channels.find((c) => c.id === "c1")?.type, "joint");
  assert.equal(s.channels.find((c) => c.id === "c2")?.type, "private", "other channels must not be overwritten");
  assert.equal(s.channelActivity["c1"], "2026-06-07T14:00:00.000Z");
  assert.equal(s.channelActivity["c2"], "other-activity", "other channel activity must be preserved");
});

test("convertChannelToJoint sends task identity drop confirmation only when acknowledged", async (t) => {
  useChannelStore.setState({
    channels: [ch("c1", { name: "general", type: "channel" })],
    dmChannels: [],
    channelActivity: {},
  });
  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    assert.equal(url, "/channels/c1/convert-to-joint");
    assert.deepEqual(body, { confirmTaskIdentityDrop: true });
    return {
      data: {
        channel: apiCh("c1", null, {
          name: "general",
          type: "joint",
          jointChannelId: "joint-c1",
          jointRole: "host",
        }),
      },
    };
  });

  const converted = await useChannelStore.getState().convertChannelToJoint("c1", { confirmTaskIdentityDrop: true });

  assert.equal(converted.type, "joint");
  assert.equal(useChannelStore.getState().channels.find((c) => c.id === "c1")?.jointChannelId, "joint-c1");
});

test("archiveChannel strips lastMessageAt off identity and writes it to the slice", async (t) => {
  useChannelStore.setState({ channels: [ch("c1")], dmChannels: [], channelActivity: {} });
  t.mock.method(api, "post", async () => ({ data: apiCh("c1", "2026-06-07T13:00:00.000Z") }));

  const archived = await useChannelStore.getState().archiveChannel("c1");

  const s = useChannelStore.getState();
  assert.equal((archived as WithActivity).lastMessageAt, undefined);
  assert.equal((s.channels.find((c) => c.id === "c1") as WithActivity).lastMessageAt, undefined);
  assert.equal(s.channelActivity["c1"], "2026-06-07T13:00:00.000Z");
});

// (4) Removal paths clean the hot slice (no leaked stale entries).

test("deleteChannel removes the channel's channelActivity entry, leaving others intact", async (t) => {
  useChannelStore.setState({ channels: [ch("c1"), ch("c2")], dmChannels: [], channelActivity: { c1: "x", c2: "y" } });
  t.mock.method(api, "delete", async () => ({ data: {} }));

  await useChannelStore.getState().deleteChannel("c1");

  const s = useChannelStore.getState();
  assert.equal("c1" in s.channelActivity, false, "deleted channel's activity entry must be removed");
  assert.equal(s.channelActivity["c2"], "y", "other channels' activity untouched");
  assert.equal(s.channels.some((c) => c.id === "c1"), false);
});

test("disconnectJointChannel removes the channel's channelActivity entry", async (t) => {
  useChannelStore.setState({ channels: [ch("j1"), ch("j2")], dmChannels: [], channelActivity: { j1: "x", j2: "y" } });
  t.mock.method(api, "post", async () => ({ data: {} }));

  await useChannelStore.getState().disconnectJointChannel("j1");

  const s = useChannelStore.getState();
  assert.equal("j1" in s.channelActivity, false, "disconnected channel's activity entry must be removed");
  assert.equal(s.channelActivity["j2"], "y");
  assert.equal(s.channels.some((c) => c.id === "j1"), false);
});

// (5) Server reset clears the hot slice alongside the identity arrays.

test("server reset clears channelActivity along with channels/dmChannels", () => {
  useChannelStore.setState({
    channels: [ch("c1")],
    dmChannels: [ch("d1", { type: "dm" })],
    channelActivity: { c1: "x", d1: "y" },
    loading: false,
  });

  triggerServerReset();

  const s = useChannelStore.getState();
  assert.deepEqual(s.channelActivity, {}, "server reset must clear the hot slice");
  assert.deepEqual(s.channels, []);
  assert.deepEqual(s.dmChannels, []);
});
