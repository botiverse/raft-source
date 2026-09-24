import assert from "node:assert/strict";
import test from "node:test";
import {
  compareNotificationKind,
  topNotificationKind,
} from "../src/components/layout/notificationKind";
import type {
  NotificationKind,
} from "../src/components/layout/notificationKind";

interface NotificationEntry {
  kind: NotificationKind;
}

// Pure-function regression for the kind ordering used by the Notification
// Center trigger to color-code its indicator. The hook itself depends on
// multiple Zustand stores + async APIs so it's exercised via e2e; these
// tests pin only the deterministic helpers.

function entry(kind: NotificationKind): NotificationEntry {
  return { kind };
}

test("compareNotificationKind orders error > warning > info", () => {
  // compareNotificationKind(a, b) is negative when `a` is more severe — this
  // matches Array.prototype.sort, where "smaller" sorts earlier.
  assert.ok(compareNotificationKind("error", "warning") < 0);
  assert.ok(compareNotificationKind("warning", "info") < 0);
  assert.ok(compareNotificationKind("error", "info") < 0);
  assert.equal(compareNotificationKind("error", "error"), 0);
  assert.ok(compareNotificationKind("info", "error") > 0);
});

test("topNotificationKind returns null for an empty list", () => {
  assert.equal(topNotificationKind([]), null);
});

test("topNotificationKind picks the highest kind present", () => {
  assert.equal(topNotificationKind([entry("info")]), "info");
  assert.equal(topNotificationKind([entry("info"), entry("warning")]), "warning");
  assert.equal(topNotificationKind([entry("info"), entry("warning"), entry("error")]), "error");
  // Order in the input array does not matter — top kind wins.
  assert.equal(topNotificationKind([entry("error"), entry("info")]), "error");
  assert.equal(topNotificationKind([entry("warning"), entry("error"), entry("warning")]), "error");
});
