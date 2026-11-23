import assert from "node:assert/strict";
import {
  applyActivityMuteState,
  applyMessageDisplayPrefsState,
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

// Task #441: both answers are re-read on every channel open, and every mounted
// message row reads these arrays.
test("an activity mute answer the channel already holds returns the same state", () => {
  const state = {
    channels: [ch("c1", { activityMuted: true, muteFromSeq: "10", activityMuteSupported: true, prefsVersion: 4 }), ch("c2")],
    dmChannels: [ch("d1", { type: "dm" })],
    loungeChannels: [],
    channelActivity: {},
  };
  const next = applyActivityMuteState(state, "c1", { activityMuted: true, muteFromSeq: "10", activityMuteSupported: true, prefsVersion: 4 });
  assert.equal(next, state);
  // No stated support keeps the channel's own.
  assert.equal(applyActivityMuteState(state, "c1", { activityMuted: true, muteFromSeq: "10" }), state);
  // An older version, and a channel that is in no collection, too.
  assert.equal(applyActivityMuteState(state, "c1", { activityMuted: false, muteFromSeq: null, prefsVersion: 3 }), state);
  assert.equal(applyActivityMuteState(state, "gone", { activityMuted: true, muteFromSeq: "1", prefsVersion: 9 }), state);
});

test("an activity mute change replaces only the channel and the collection it is in", () => {
  const state = {
    channels: [ch("c1", { activityMuted: false, muteFromSeq: null, prefsVersion: 1 }), ch("c2")],
    dmChannels: [ch("d1", { type: "dm" })],
    loungeChannels: [ch("l1")],
    channelActivity: {},
  };
  const next = applyActivityMuteState(state, "c1", { activityMuted: true, muteFromSeq: "7", prefsVersion: 2 });
  assert.notEqual(next, state);
  assert.notEqual(next.channels, state.channels);
  assert.equal(next.channels[0]?.activityMuted, true);
  assert.equal(next.channels[1], state.channels[1]);
  assert.equal(next.dmChannels, state.dmChannels);
  assert.equal(next.loungeChannels, state.loungeChannels);
  // Each differing field alone is a change.
  for (const patch of [
    { activityMuted: true, muteFromSeq: null, prefsVersion: 1 },
    { activityMuted: false, muteFromSeq: "7", prefsVersion: 1 },
    { activityMuted: false, muteFromSeq: null, prefsVersion: 2 },
    { activityMuted: false, muteFromSeq: null, activityMuteSupported: true, prefsVersion: 1 },
  ]) {
    const changed = applyActivityMuteState(state, "c1", patch);
    assert.notEqual(changed.channels, state.channels);
    assert.deepEqual(
      { activityMuted: changed.channels[0]?.activityMuted, muteFromSeq: changed.channels[0]?.muteFromSeq, prefsVersion: changed.channels[0]?.prefsVersion },
      { activityMuted: patch.activityMuted, muteFromSeq: patch.muteFromSeq, prefsVersion: patch.prefsVersion },
    );
  }
  // A state without Lounges gets no Lounge list.
  const noLounges = applyActivityMuteState({ channels: state.channels, dmChannels: [], channelActivity: {} }, "c1", { activityMuted: true, muteFromSeq: "7" });
  assert.equal("loungeChannels" in noLounges, false);
});

test("message display prefs the channel already holds return the same state; a change replaces only its collection", () => {
  const state = {
    channels: [ch("c1", { collapseLongMessages: true, displayPrefsVersion: 2 })],
    dmChannels: [ch("d1", { type: "dm", collapseLongMessages: false, displayPrefsVersion: 1 })],
    loungeChannels: [],
    channelActivity: {},
  };
  assert.equal(applyMessageDisplayPrefsState(state, "c1", { collapseLongMessages: true, prefsVersion: 2 }), state);
  assert.equal(applyMessageDisplayPrefsState(state, "c1", { collapseLongMessages: true }), state);
  assert.equal(applyMessageDisplayPrefsState(state, "c1", { collapseLongMessages: false, prefsVersion: 1 }), state);

  const dm = applyMessageDisplayPrefsState(state, "d1", { collapseLongMessages: true, prefsVersion: 2 });
  assert.equal(dm.channels, state.channels);
  assert.equal(dm.loungeChannels, state.loungeChannels);
  assert.equal(dm.dmChannels[0]?.collapseLongMessages, true);
  assert.equal(dm.dmChannels[0]?.displayPrefsVersion, 2);
  // A newer version of the same value is still a change (the version is kept).
  const versionOnly = applyMessageDisplayPrefsState(state, "c1", { collapseLongMessages: true, prefsVersion: 3 });
  assert.equal(versionOnly.channels[0]?.displayPrefsVersion, 3);
});

test("a Lounge's mute or display-prefs change replaces the Lounge list alone", () => {
  const state = {
    channels: [ch("c1")],
    dmChannels: [ch("d1", { type: "dm" })],
    loungeChannels: [ch("l1", { loungeAgentId: "agent-1" }), ch("l2", { loungeAgentId: "agent-2" })],
    channelActivity: {},
  };
  const muted = applyActivityMuteState(state, "l1", { activityMuted: true, muteFromSeq: "4", prefsVersion: 1 });
  assert.equal(muted.channels, state.channels);
  assert.equal(muted.dmChannels, state.dmChannels);
  assert.notEqual(muted.loungeChannels, state.loungeChannels);
  assert.equal(muted.loungeChannels?.[0]?.activityMuted, true);
  assert.equal(muted.loungeChannels?.[1], state.loungeChannels[1]);
  assert.equal(applyActivityMuteState(muted, "l1", { activityMuted: true, muteFromSeq: "4", prefsVersion: 1 }), muted);

  const collapsed = applyMessageDisplayPrefsState(muted, "l1", { collapseLongMessages: true, prefsVersion: 1 });
  assert.equal(collapsed.channels, state.channels);
  assert.equal(collapsed.dmChannels, state.dmChannels);
  assert.equal(collapsed.loungeChannels?.[0]?.collapseLongMessages, true);
  assert.equal(collapsed.loungeChannels?.[0]?.activityMuted, true);
});

// #532: `channel:updated` floods re-send rows that did not change; a patch that
// changes nothing must keep every list, record and the activity map as they were.
test("a patch that changes nothing keeps the same lists, records and activity map", () => {
  const base = hydrateDmChannels(
    hydrateChannels({ channels: [], dmChannels: [], loungeChannels: [ch("l1", { loungeAgentId: "agent-1" })], channelActivity: {} }, [apiCh("all"), apiCh("a", { lastMessageAt: "t1" }), apiCh("b")]),
    [apiCh("d1", { type: "dm", lastMessageAt: "t2" })],
  );
  const sameChannel = patchChannel(base, apiCh("a", { lastMessageAt: "t1" }));
  assert.equal(sameChannel.channels, base.channels, "same channel list");
  assert.equal(sameChannel.channels[1], base.channels[1], "same channel record");
  assert.equal(sameChannel.channelActivity, base.channelActivity, "same activity map");

  // A partial row (fewer fields than the stored one) merges onto it: still unchanged.
  const { description: _d, ...partial } = apiCh("b");
  void _d;
  assert.equal(patchChannel(base, partial as ApiChannel).channels, base.channels);

  const sameDm = patchChannel(base, apiCh("d1", { type: "dm", lastMessageAt: "t2" }));
  assert.equal(sameDm.dmChannels, base.dmChannels);
  assert.equal(sameDm.channelActivity, base.channelActivity);

  const sameLounge = patchChannel(base, apiCh("l1", { loungeAgentId: "agent-1", type: "channel" }));
  const sameLoungeAgain = patchChannel(sameLounge, apiCh("l1", { loungeAgentId: "agent-1", type: "channel" }));
  assert.equal(sameLoungeAgain.loungeChannels, sameLounge.loungeChannels);
  assert.equal(sameLoungeAgain.channels, sameLounge.channels);
  assert.equal(sameLoungeAgain.channelActivity, sameLounge.channelActivity);

  const renamed = patchChannel(base, apiCh("a", { name: "renamed", lastMessageAt: "t1" }));
  assert.notEqual(renamed.channels, base.channels);
  assert.equal(renamed.channels.find((c) => c.id === "a")?.name, "renamed");
  assert.equal(renamed.channels.find((c) => c.id === "b"), base.channels.find((c) => c.id === "b"), "other record kept");
  assert.equal(renamed.channels[0]?.name, "all", "#all stays first");

  const bumped = patchChannel(base, apiCh("a", { lastMessageAt: "t9" }));
  assert.equal(bumped.channels, base.channels, "an activity bump alone keeps the list");
  assert.notEqual(bumped.channelActivity, base.channelActivity);
  assert.equal(bumped.channelActivity.a, "t9");
});
