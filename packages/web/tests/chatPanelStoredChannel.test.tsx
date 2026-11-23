import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useChannelPrefs } from "../src/features/channel/useChannelPrefs";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";

// Review of task #441: a mute or display-prefs change replaces only the list
// the conversation is in. ChatPanel derived its mute and collapse state from a
// memo keyed on `channels`, which a DM's or a Lounge's change no longer
// touches, so its switches would have kept the old state. The derivation is
// useChannelPrefs, tested here with the row the panel was given held still.

function ch(id: string, over: Partial<Channel> = {}): Channel {
  return { id, name: id, description: null, type: "channel", createdAt: "1970-01-01T00:00:00.000Z", joined: true, ...over };
}

afterEach(() => {
  cleanup();
  useChannelStore.setState(useChannelStore.getInitialState(), true);
});

for (const [kind, id, list] of [["a DM", "d1", "dmChannels"], ["a Lounge", "l1", "loungeChannels"]] as const) {
  test(`${kind}'s mute and collapse state follow the store while \`channels\` and the given row stay the same`, () => {
    const row = ch(id, kind === "a DM" ? { type: "dm" } : { loungeAgentId: "agent-1" });
    useChannelStore.setState({ channels: [ch("c1")], dmChannels: [], loungeChannels: [], [list]: [row] });
    const channels = useChannelStore.getState().channels;
    // The caller's row never changes: the values must come from the store.
    const prefs = renderHook(() => useChannelPrefs(id, row));
    assert.deepEqual(prefs.result.current, { activityMuted: false, muteFromSeq: null, prefsVersion: undefined, collapseLongMessages: false, displayPrefsVersion: undefined });

    act(() => useChannelStore.getState().setActivityMuteState(id, { activityMuted: true, muteFromSeq: "3", prefsVersion: 1 }));
    assert.deepEqual(
      { muted: prefs.result.current.activityMuted, from: prefs.result.current.muteFromSeq, version: prefs.result.current.prefsVersion },
      { muted: true, from: "3", version: 1 },
    );
    act(() => useChannelStore.getState().setMessageDisplayPrefsState(id, { collapseLongMessages: true, prefsVersion: 2 }));
    assert.equal(prefs.result.current.collapseLongMessages, true);
    assert.equal(prefs.result.current.displayPrefsVersion, 2);
    assert.equal(prefs.result.current.activityMuted, true);

    act(() => useChannelStore.getState().setActivityMuteState(id, { activityMuted: false, muteFromSeq: null, prefsVersion: 3 }));
    assert.equal(prefs.result.current.activityMuted, false);
    assert.equal(useChannelStore.getState().channels, channels);
  });
}

test("a conversation the store does not hold reads the given row", () => {
  const prefs = renderHook(() => useChannelPrefs("gone", ch("gone", { activityMuted: true, muteFromSeq: 7, prefsVersion: 2, collapseLongMessages: true, displayPrefsVersion: 4 })));
  assert.deepEqual(prefs.result.current, { activityMuted: true, muteFromSeq: 7, prefsVersion: 2, collapseLongMessages: true, displayPrefsVersion: 4 });
  assert.deepEqual(renderHook(() => useChannelPrefs(null, null)).result.current, { activityMuted: false, muteFromSeq: null, prefsVersion: undefined, collapseLongMessages: false, displayPrefsVersion: undefined });
});

test("ChatPanel passes no store state read while rendering as a prop", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/features/channel/ChatPanel.tsx"), "utf8");
  assert.doesNotMatch(source, /=\{use[A-Za-z]+Store\.getState\(\)\.[A-Za-z]+\}/, "no JSX prop is a getState() read");
  assert.match(source, /<ForwardComposerDialog[\s\S]{0,200}orderByChannelActivity/);
});
