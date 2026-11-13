import assert from "node:assert/strict";
import { DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS, type NotificationAccountSettings } from "@botiverse/raft-shared";
import { accountSettingChanges, pauseLength } from "./accountSettingsEvents";

const NOW = new Date("2026-11-09T12:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000).toISOString();
const base: NotificationAccountSettings = { ...DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS };
const withSettings = (patch: Partial<NotificationAccountSettings>): NotificationAccountSettings => ({ ...base, ...patch });

test("each pause preset stays in its own bucket, even a little late", () => {
  for (const [preset, bucket] of [[30, "up_to_45m"], [60, "45m_to_90m"], [120, "90m_to_3h"], [9 * 60, "3h_to_36h"], [33 * 60, "3h_to_36h"]] as const) {
    assert.equal(pauseLength(preset * 60_000), bucket, `${preset}m`);
    assert.equal(pauseLength(preset * 60_000 - 5_000), bucket, `${preset}m, 5s after the client computed it`);
  }
  assert.equal(pauseLength(3 * 24 * 60 * 60_000), "over_36h");
});

test("a pause is on, a moved one edited, a resume off; clearing a pause that already ran out records nothing", () => {
  assert.deepEqual(accountSettingChanges(base, withSettings({ pausedUntil: minutes(60) }), NOW), [
    { setting: "pause", change: "on", pause_length: "45m_to_90m" },
  ]);
  assert.deepEqual(accountSettingChanges(withSettings({ pausedUntil: minutes(20) }), withSettings({ pausedUntil: minutes(120) }), NOW), [
    { setting: "pause", change: "edited", pause_length: "90m_to_3h" },
  ]);
  assert.deepEqual(accountSettingChanges(withSettings({ pausedUntil: minutes(-5) }), withSettings({ pausedUntil: minutes(30) }), NOW), [
    { setting: "pause", change: "on", pause_length: "up_to_45m" },
  ], "a new pause after one ran out");
  assert.deepEqual(accountSettingChanges(withSettings({ pausedUntil: minutes(20) }), base, NOW), [{ setting: "pause", change: "off" }]);
  assert.deepEqual(accountSettingChanges(withSettings({ pausedUntil: minutes(-5) }), base, NOW), [], "ran out already");
});

test("quiet hours: on and off once each, a window moved while on is edited, a window edited while off is nothing", () => {
  const on = { ...base.quietHours, enabled: true, startMinute: 22 * 60, endMinute: 7 * 60, timeZone: "Asia/Shanghai" };
  assert.deepEqual(accountSettingChanges(base, withSettings({ quietHours: on }), NOW), [{ setting: "quiet_hours", change: "on" }]);
  assert.deepEqual(
    accountSettingChanges(withSettings({ quietHours: on }), withSettings({ quietHours: { ...on, endMinute: 8 * 60 } }), NOW),
    [{ setting: "quiet_hours", change: "edited" }],
  );
  assert.deepEqual(accountSettingChanges(withSettings({ quietHours: on }), withSettings({ quietHours: { ...on, enabled: false } }), NOW), [
    { setting: "quiet_hours", change: "off" },
  ]);
  const off = { ...on, enabled: false };
  assert.deepEqual(accountSettingChanges(withSettings({ quietHours: off }), withSettings({ quietHours: { ...off, startMinute: 0 } }), NOW), []);
});

test("one write that changes several settings gives one entry each; nothing changed gives none", () => {
  assert.deepEqual(accountSettingChanges(base, withSettings({ previewMode: "sender_only", sound: !base.sound, mobileDelay: "always" }), NOW), [
    { setting: "preview", preview: "sender_only" },
    { setting: "sound", change: base.sound ? "off" : "on" },
    { setting: "mobile_delay", mobile_delay: "always" },
  ]);
  assert.deepEqual(accountSettingChanges(base, { ...base }, NOW), []);
});
