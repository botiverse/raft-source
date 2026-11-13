import assert from "node:assert/strict";
import {
  APP_INSTALLATION_NOTIFICATION_EVENTS,
  APP_NOTIFICATION_EVENT_GROUPS,
  APP_NOTIFICATION_EVENT_REGISTRY,
  APP_NOTIFICATION_GROUPS,
  APP_NOTIFICATION_SUBJECT_TYPES,
  appNotificationEventSpec,
  isAppInstallationNotificationEvent,
  type AppNotificationEventSpec,
} from "./appNotifications";

// Tenny's condition for installation.bot_changed (#proj-apps #35): the
// `installation` subject is the App's own installation, and no other event
// type may use it to skip permission groups. Adding an event with that
// subject, or a group-free event of any other subject, fails here.
test("only installation.bot_changed is about the installation, and it is the only event without a group", () => {
  const entries = Object.entries(APP_NOTIFICATION_EVENT_REGISTRY) as Array<[string, AppNotificationEventSpec]>;
  const installationEvents = entries.filter(([, spec]) => spec.subject === "installation").map(([event]) => event);
  const groupFree = entries.filter(([, spec]) => spec.groups.length === 0).map(([event]) => event);
  assert.deepEqual(installationEvents, ["installation.bot_changed"]);
  assert.deepEqual(groupFree, ["installation.bot_changed"]);
  assert.deepEqual([...APP_INSTALLATION_NOTIFICATION_EVENTS], ["installation.bot_changed"]);

  for (const [event, spec] of entries) {
    assert.ok((APP_NOTIFICATION_SUBJECT_TYPES as readonly string[]).includes(spec.subject), `${event} subject`);
    for (const group of spec.groups) {
      assert.ok((APP_NOTIFICATION_GROUPS as readonly string[]).includes(group), `${event} group ${group}`);
    }
    assert.equal(isAppInstallationNotificationEvent(event), spec.subject === "installation", event);
  }
});

test("the group-gated event map an App declares from leaves the installation's own event out", () => {
  const gated = Object.keys(APP_NOTIFICATION_EVENT_GROUPS);
  assert.equal(gated.includes("installation.bot_changed"), false);
  assert.deepEqual(gated, Object.keys(APP_NOTIFICATION_EVENT_REGISTRY).filter((event) => event !== "installation.bot_changed"));
  for (const [event, groups] of Object.entries(APP_NOTIFICATION_EVENT_GROUPS)) {
    assert.ok(groups.length > 0, `${event} needs a group`);
    assert.deepEqual(groups, appNotificationEventSpec(event)?.groups);
  }
});

test("an unknown or inherited name is no event", () => {
  assert.equal(appNotificationEventSpec("installation.unknown"), undefined);
  assert.equal(appNotificationEventSpec("toString"), undefined);
  assert.equal(isAppInstallationNotificationEvent("constructor"), false);
});
