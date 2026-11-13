import assert from "node:assert/strict";
import {
  applyActivityMuteState,
  canToggleActivityMute,
  hydrateChannels,
  hydrateDmChannels,
  nextPatchSeq,
  patchChannel,
  refreshExistingDm,
  removeChannel,
  setLocalChannelMembership,
} from "../src/store/channelDomain";
import type { ApiChannel, Channel } from "../src/store/channelStore";

function ch(id: string, over: Partial<Channel> = {}): Channel {
  return {
    id,
    name: id,
    description: null,
    type: "channel",
    createdAt: "1970-01-01T00:00:00.000Z",
    joined: true,
    ...over,
  };
}

function apiCh(id: string, over: Partial<ApiChannel> = {}): ApiChannel {
  return {
    id,
    name: id,
    description: null,
    type: "channel",
    createdAt: "1970-01-01T00:00:00.000Z",
    joined: true,
    lastMessageAt: null,
    ...over,
  };
}

test("hydrateDmChannels preserves locally-added DMs until the server returns them", () => {
  const localDm = ch("local-dm", { type: "dm" });
  const state = hydrateDmChannels(
    { channels: [], dmChannels: [localDm], channelActivity: { "local-dm": "local" } },
    [apiCh("server-dm", { type: "dm", lastMessageAt: "server" })],
  );

  assert.deepEqual(state.dmChannels.map((channel) => channel.id), ["server-dm", "local-dm"]);
  assert.equal(state.channelActivity["server-dm"], "server");
  assert.equal(state.channelActivity["local-dm"], "local");
});

test("refreshExistingDm moves an existing DM to the front without touching channel identities", () => {
  const c1 = ch("c1");
  const dm1 = ch("dm1", { type: "dm" });
  const dm2 = ch("dm2", { type: "dm" });
  const state = refreshExistingDm(
    { channels: [c1], dmChannels: [dm1, dm2], channelActivity: { dm1: "old", dm2: "older" } },
    "dm2",
    "new",
  );

  assert.strictEqual(state.channels[0], c1);
  assert.deepEqual(state.dmChannels.map((channel) => channel.id), ["dm2", "dm1"]);
  assert.strictEqual(state.dmChannels[0], dm2);
  assert.equal(state.channelActivity.dm2, "new");
});

test("activity mute applies a newer authoritative unmute", () => {
  const state = applyActivityMuteState(
    {
      channels: [ch("c1", { activityMuted: true, muteFromSeq: "10", prefsVersion: 4 })],
      dmChannels: [],
      channelActivity: {},
    },
    "c1",
    { activityMuted: false, muteFromSeq: null, prefsVersion: 5 },
  );

  assert.equal(state.channels[0]?.activityMuted, false);
  assert.equal(state.channels[0]?.muteFromSeq, null);
  assert.equal(state.channels[0]?.prefsVersion, 5);
});

test("activity mute ignores an older preference version", () => {
  const state = applyActivityMuteState(
    {
      channels: [ch("c1", { activityMuted: false, muteFromSeq: null, prefsVersion: 5 })],
      dmChannels: [],
      channelActivity: {},
    },
    "c1",
    { activityMuted: true, muteFromSeq: "10", prefsVersion: 4 },
  );

  assert.equal(state.channels[0]?.activityMuted, false);
  assert.equal(state.channels[0]?.muteFromSeq, null);
  assert.equal(state.channels[0]?.prefsVersion, 5);
});

test("activity mute applies matching versioned patches to channels and DMs", () => {
  const state = applyActivityMuteState(
    {
      channels: [ch("c1", { activityMuted: true, muteFromSeq: "10", prefsVersion: 1 })],
      dmChannels: [ch("d1", { type: "dm", activityMuted: false, muteFromSeq: null, prefsVersion: 1 })],
      channelActivity: {},
    },
    "c1",
    { activityMuted: false, muteFromSeq: null, prefsVersion: 2 },
  );
  const dmState = applyActivityMuteState(state, "d1", { activityMuted: true, muteFromSeq: "3", prefsVersion: 2 });

  assert.equal(dmState.channels[0]?.activityMuted, false);
  assert.equal(dmState.channels[0]?.muteFromSeq, null);
  assert.equal(dmState.channels[0]?.prefsVersion, 2);
  assert.equal(dmState.dmChannels[0]?.activityMuted, true);
  assert.equal(dmState.dmChannels[0]?.muteFromSeq, "3");
  assert.equal(dmState.dmChannels[0]?.prefsVersion, 2);
});

test("activity mute actions are limited to joined channel-like conversations and DMs the server marks mutable", () => {
  assert.equal(canToggleActivityMute(ch("channel")), true);
  assert.equal(canToggleActivityMute(ch("private", { type: "private" })), true);
  assert.equal(canToggleActivityMute(ch("joint", { type: "joint" })), true);
  assert.equal(canToggleActivityMute(ch("unjoined", { joined: false })), false);
  // A DM with a person or an ordinary agent: the server says it can't be muted.
  assert.equal(canToggleActivityMute(ch("dm", { type: "dm" })), false);
  assert.equal(canToggleActivityMute(ch("dm", { type: "dm", activityMuteSupported: false })), false);
  // A DM with an App bot: the server says it can.
  assert.equal(canToggleActivityMute(ch("dm", { type: "dm", activityMuteSupported: true })), true);
  // A stored mute keeps its Unmute after the DM stops qualifying (bot removed).
  assert.equal(canToggleActivityMute(ch("dm", { type: "dm", activityMuteSupported: false, activityMuted: true })), true);
  assert.equal(canToggleActivityMute(ch("thread", { type: "thread" })), false);
  assert.equal(canToggleActivityMute(undefined), false);
});

test("local membership overlays channel hydrate until backend reconciliation catches up", () => {
  const optimistic = setLocalChannelMembership(
    { channels: [ch("c1", { joined: false })], dmChannels: [], channelActivity: {} },
    "c1",
    true,
  );
  const staleHydrate = hydrateChannels(optimistic, [apiCh("c1", { joined: false })]);

  assert.equal(staleHydrate.channels[0]?.joined, true);
  assert.deepEqual(staleHydrate.channelLocalMembership, { c1: true });

  const reconciled = hydrateChannels(staleHydrate, [apiCh("c1", { joined: true })]);
  assert.equal(reconciled.channels[0]?.joined, true);
  assert.deepEqual(reconciled.channelLocalMembership, {});
});

test("an equal /channels answer keeps the same list, records and activity map (web perf)", () => {
  const first = hydrateChannels({ channels: [], dmChannels: [], channelActivity: {} }, [apiCh("a"), apiCh("b", { lastMessageAt: "t1" })]);
  const second = hydrateChannels(first, [apiCh("a"), apiCh("b", { lastMessageAt: "t1" })]);
  assert.equal(second.channels, first.channels, "same array");
  assert.equal(second.channelActivity, first.channelActivity, "same activity map");
  const changed = hydrateChannels(second, [apiCh("a"), apiCh("b", { name: "renamed", lastMessageAt: "t1" })]);
  assert.notEqual(changed.channels, second.channels);
  assert.equal(changed.channels.find((c) => c.id === "a"), second.channels.find((c) => c.id === "a"), "unchanged record kept");
  assert.notEqual(changed.channels.find((c) => c.id === "b"), second.channels.find((c) => c.id === "b"));
});

test("an equal /channels/dm answer keeps the same DM list", () => {
  const first = hydrateDmChannels({ channels: [], dmChannels: [], channelActivity: {} }, [apiCh("d1", { type: "dm" })]);
  const second = hydrateDmChannels(first, [apiCh("d1", { type: "dm" })]);
  assert.equal(second.dmChannels, first.dmChannels);
  assert.equal(second.channelActivity, first.channelActivity);
});

// #239: a GET /channels that started before a local patch must not undo it.
// `requestSeq` is the patch clock that request took when it started.
test("a list answer from before a patch keeps the patched rows and does not bring back a removed one", () => {
  const base = hydrateChannels({ channels: [], dmChannels: [], channelActivity: {} }, [apiCh("a"), apiCh("b"), apiCh("gone")]);
  const requestSeq = nextPatchSeq();
  const created = patchChannel(base, apiCh("new"));
  const renamed = patchChannel(created, apiCh("a", { name: "a-renamed" }));
  const removed = removeChannel(renamed, "b");

  // The stale answer: still has b, lacks new, has a's old name.
  const after = hydrateChannels(removed, [apiCh("a"), apiCh("b"), apiCh("gone")], requestSeq);
  assert.deepEqual(after.channels.map((c) => [c.id, c.name]), [["a", "a-renamed"], ["gone", "gone"], ["new", "new"]]);
  assert.deepEqual(Object.keys(after.channelPatchStamps ?? {}).sort(), ["a", "b", "new"], "newer stamps stay");

  // A later answer (started after the patches) is the authority again.
  const fresh = hydrateChannels(after, [apiCh("a", { name: "a-renamed" }), apiCh("new")], nextPatchSeq());
  assert.deepEqual(fresh.channels.map((c) => c.id), ["a", "new"]);
  assert.deepEqual(fresh.channelPatchStamps, {});
});

test("a channel patched before the request started follows the answer: gone server-side means gone", () => {
  const base = hydrateChannels({ channels: [], dmChannels: [], channelActivity: {} }, [apiCh("a")]);
  const patched = patchChannel(base, apiCh("b"));
  const requestSeq = nextPatchSeq();
  const after = hydrateChannels(patched, [apiCh("a")], requestSeq);
  assert.deepEqual(after.channels.map((c) => c.id), ["a"]);
  assert.deepEqual(after.channelPatchStamps, {});
});

test("a stale list answer keeps a newer row's activity and in-list position", () => {
  const base = hydrateChannels({ channels: [], dmChannels: [], channelActivity: {} }, [apiCh("a"), apiCh("b"), apiCh("c")]);
  const requestSeq = nextPatchSeq();
  const patched = patchChannel(base, apiCh("b", { name: "b2", lastMessageAt: "t2" }));
  const after = hydrateChannels(patched, [apiCh("a"), apiCh("b", { lastMessageAt: "t1" }), apiCh("c")], requestSeq);
  assert.deepEqual(after.channels.map((c) => c.name), ["a", "b2", "c"]);
  assert.equal(after.channelActivity.b, "t2");
});

test("a read answer is stamped as of its request start, so a list that started later wins over it", () => {
  const base = hydrateChannels({ channels: [], dmChannels: [], channelActivity: {} }, [apiCh("a")]);
  const readSeq = nextPatchSeq();
  const listSeq = nextPatchSeq();
  const read = patchChannel(base, apiCh("a", { name: "a-old" }), "channel", readSeq);
  const after = hydrateChannels(read, [apiCh("a", { name: "a-fresh" })], listSeq);
  assert.deepEqual(after.channels.map((c) => c.name), ["a-fresh"]);
});
