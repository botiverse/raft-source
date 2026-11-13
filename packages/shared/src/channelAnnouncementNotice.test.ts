// Channel announcements (#proj-chat:#29): the one event line a set, a
// replacement or a removal posts in the channel. Its text is the record agents
// read; the web reads its `actionMetadata` back to say it in the reader's language.
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CHANNEL_ANNOUNCEMENT_NOTICE_KIND,
  channelAnnouncementChangeKind,
  channelAnnouncementChangeText,
  readChannelAnnouncementNotice,
} from "./channelAnnouncement";

const A = "pt_0b3b0f4e-2f0c-4a53-9d8e-2a5b7c1d9e01";
const B = "pt_7d1f0c2e-9a3b-4c5d-8e6f-0a1b2c3d4e5f";

test("which change: set, replaced, removed, and none when it is the same", () => {
  assert.equal(channelAnnouncementChangeKind(null, A), "set");
  assert.equal(channelAnnouncementChangeKind(A, B), "replaced");
  assert.equal(channelAnnouncementChangeKind(A, null), "removed");
  assert.equal(channelAnnouncementChangeKind(A, A), null);
  assert.equal(channelAnnouncementChangeKind(null, null), null);
});

test("the record: who, what, and the title when it was read", () => {
  assert.equal(channelAnnouncementChangeText("set", "@martin", "Release rules for 1.9"), "@martin set the channel announcement: Release rules for 1.9");
  assert.equal(channelAnnouncementChangeText("replaced", "@martin", "Q4"), "@martin replaced the channel announcement: Q4");
  assert.equal(channelAnnouncementChangeText("removed", "@martin", null), "@martin removed the channel announcement.");
});

test("the notice reads back from actionMetadata; anything else is null", () => {
  const stored = { kind: CHANNEL_ANNOUNCEMENT_NOTICE_KIND, change: "replaced", actor: { type: "agent", id: "agent-1", name: "Kimi" }, artifactId: A, title: "Rules" };
  assert.deepEqual(readChannelAnnouncementNotice(stored), stored);
  assert.deepEqual(readChannelAnnouncementNotice({ ...stored, actor: { type: "user", id: "u1", name: "" }, title: "" }), {
    ...stored, actor: { type: "user", id: "u1", name: null }, title: null,
  });
  assert.equal(readChannelAnnouncementNotice(null), null);
  assert.equal(readChannelAnnouncementNotice({ ...stored, kind: "task-assignment" }), null);
  assert.equal(readChannelAnnouncementNotice({ ...stored, change: "updated" }), null);
  assert.equal(readChannelAnnouncementNotice({ ...stored, artifactId: "" }), null);
  assert.equal(readChannelAnnouncementNotice({ ...stored, actor: { type: "bot", id: "x" } }), null);
});
