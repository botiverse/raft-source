import assert from "node:assert/strict";
import {
  NOTIFICATION_COPY,
  NOTIFICATION_KEY_SET_LATEST,
  formatNotificationCopy,
  isNotificationCopyKey,
  notificationCopyKeyInSet,
  parseNotificationLocalization,
  type NotificationCopyKey,
} from "./notificationCopy";
import { notificationPreviewCopy, notificationSurfaceCopy } from "./notificationDisplay";

const KEYS = Object.keys(NOTIFICATION_COPY) as NotificationCopyKey[];

test("notification copy: keys are push.* snake_case ids, args are positional and dense", () => {
  for (const key of KEYS) {
    assert.match(key, /^push\.(preview|title|subtitle|body)\.[a-z_]+(\.[a-z_]+)?$/, key);
    const indexes = [...NOTIFICATION_COPY[key].en.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));
    const distinct = [...new Set(indexes)].sort();
    assert.deepEqual(distinct, distinct.map((_, index) => index), `${key}: {0}..{n} without gaps`);
    // An ASCII apostrophe is the ICU escape character in the web catalogs that reuse these templates.
    assert.equal(NOTIFICATION_COPY[key].en.includes("'"), false, key);
  }
});

test("notification copy: key sets 1 and 2 are the redacted-preview keys, as before set 3", () => {
  const inSet = (set: number) => KEYS.filter((key) => notificationCopyKeyInSet(key, set)).sort();
  assert.deepEqual(inSet(1), [
    "push.preview.hidden.mention",
    "push.preview.hidden.message",
    "push.preview.hidden.title",
    "push.preview.sender_only.mention",
    "push.preview.sender_only.message",
  ]);
  assert.deepEqual(inSet(2), KEYS.filter((key) => key.startsWith("push.preview.")).sort());
  assert.deepEqual(inSet(NOTIFICATION_KEY_SET_LATEST), [...KEYS].sort());
  assert.equal(notificationCopyKeyInSet("push.title.unknown", 99), false);
  assert.equal(isNotificationCopyKey("push.title.thread"), true);
  assert.equal(isNotificationCopyKey("toString"), false);
});

test("notification copy: English from the template; an arg is never read as a placeholder", () => {
  assert.equal(formatNotificationCopy("push.title.thread_in_channel", ["general"]), "Thread in #general");
  assert.equal(formatNotificationCopy("push.body.sender_attachments", ["{1}", "3"]), "{1}: Sent 3 attachments");
  assert.equal(formatNotificationCopy("push.preview.sender_only.message", ["$&"]), "$& sent a message");
  assert.equal(formatNotificationCopy("push.preview.hidden.title"), "Raft");
});

test("notification copy: surface and preview keys match the English the display helpers render", () => {
  assert.deepEqual(notificationSurfaceCopy({ kind: "dm" }), { key: "push.title.dm", args: [] });
  assert.equal(notificationSurfaceCopy({ kind: "channel", channelName: "eng" }), null);
  assert.deepEqual(notificationSurfaceCopy({ kind: "thread", parentKind: "channel", parentChannelName: "eng" }), { key: "push.title.thread_in_channel", args: ["eng"] });
  assert.deepEqual(notificationSurfaceCopy({ kind: "thread", parentKind: "dm" }), { key: "push.title.thread_in_dm", args: [] });
  assert.deepEqual(notificationSurfaceCopy({ kind: "thread", parentKind: "channel", parentChannelName: null }), { key: "push.title.thread", args: [] });

  assert.equal(notificationPreviewCopy("hello", 2), null);
  assert.deepEqual(notificationPreviewCopy(" ", 1), { key: "push.body.attachment", args: [] });
  assert.deepEqual(notificationPreviewCopy("", 4), { key: "push.body.attachments", args: ["4"] });
  assert.deepEqual(notificationPreviewCopy("", 0), { key: "push.body.no_text", args: [] });
  assert.deepEqual(notificationPreviewCopy("", 1, "Alice"), { key: "push.body.sender_attachment", args: ["Alice"] });
  assert.deepEqual(notificationPreviewCopy("", 4, "Alice"), { key: "push.body.sender_attachments", args: ["Alice", "4"] });
  assert.deepEqual(notificationPreviewCopy("", 0, "Alice"), { key: "push.body.sender_no_text", args: ["Alice"] });
});

test("notification copy: parseNotificationLocalization keeps well-formed parts only", () => {
  assert.equal(parseNotificationLocalization(undefined), null);
  assert.equal(parseNotificationLocalization({ titleArgs: ["x"] }), null);
  assert.deepEqual(
    parseNotificationLocalization({ titleKey: "push.title.thread_in_channel", titleArgs: ["eng"], subtitleKey: 3, bodyKey: "push.body.no_text", bodyArgs: [1] }),
    { titleKey: "push.title.thread_in_channel", titleArgs: ["eng"], bodyKey: "push.body.no_text", bodyArgs: [] },
  );
});
