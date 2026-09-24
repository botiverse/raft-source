import assert from "node:assert/strict";
import test from "node:test";
import {
  applyActivityMuteState,
  canToggleActivityMute,
  hydrateChannels,
  hydrateDmChannels,
  refreshExistingDm,
  setLocalChannelMembership,
} from "../src/store/channelDomain.js";
import type { ApiChannel, Channel } from "../src/store/channelStore.js";

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

test("activity mute actions are limited to joined channel-like conversations", () => {
  assert.equal(canToggleActivityMute(ch("channel")), true);
  assert.equal(canToggleActivityMute(ch("private", { type: "private" })), true);
  assert.equal(canToggleActivityMute(ch("joint", { type: "joint" })), true);
  assert.equal(canToggleActivityMute(ch("unjoined", { joined: false })), false);
  assert.equal(canToggleActivityMute(ch("dm", { type: "dm" })), false);
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
