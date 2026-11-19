import "../../../../tests/helpers/domSetup";

import assert from "node:assert/strict";
import { cleanup, screen } from "@testing-library/react";
import { DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS } from "@botiverse/raft-shared";

import { ContentCard } from "../../../components/settings/notifications/ContentCard";
import { parseNotificationAccountSettings } from "../../../notifications/notificationApi";
import type { AccountNotificationSettingsView } from "../../../notifications/notificationApi";
import { useNotificationSettingsStore } from "../../../store/notificationSettingsStore";
import { renderWithIntl } from "../../../../tests/helpers/intl";
import { useSettingsSearchSettings } from "../search/useSettingsSearchSettings";

// "Replies in threads I follow" shows only while the server offers it: the
// server leaves `followedThreadReplies` out of the settings while its flag
// (notification_followed_thread_replies_switch) is off (contract §2.1).

const ROW_ID = "notification-followed-thread-replies";

afterEach(() => {
  cleanup();
  useNotificationSettingsStore.setState(useNotificationSettingsStore.getInitialState(), true);
});

function withField(): AccountNotificationSettingsView {
  return { ...DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS, quietHours: { ...DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS.quietHours }, followedThreadReplies: false };
}

function withoutField(): AccountNotificationSettingsView {
  const { followedThreadReplies: _absent, ...rest } = withField();
  return rest;
}

function SearchIds() {
  const ids = useSettingsSearchSettings(["notifications"], true).map((setting) => setting.id);
  return <ul data-testid="search-ids">{ids.map((id) => <li key={id}>{id}</li>)}</ul>;
}

function searchIds(): string[] {
  return Array.from(screen.getByTestId("search-ids").querySelectorAll("li"), (item) => item.textContent ?? "");
}

test("the parse keeps the field only when the server sent it", () => {
  const wire = { ...withField() } as Record<string, unknown>;
  assert.equal(parseNotificationAccountSettings(wire)?.followedThreadReplies, false);
  delete wire.followedThreadReplies;
  const parsed = parseNotificationAccountSettings(wire);
  assert.ok(parsed);
  assert.equal("followedThreadReplies" in parsed, false);
});

test("loaded without the field: the row and its search entry are gone, the other rows stay", () => {
  useNotificationSettingsStore.setState({ account: withoutField(), accountLoaded: true });
  renderWithIntl(<><ContentCard /><SearchIds /></>);
  assert.ok(document.getElementById(ROW_ID) === null, "row is hidden without the field");
  assert.ok(screen.queryByTestId("notification-followed-thread-replies-switch") === null, "switch is hidden without the field");
  assert.ok(screen.getByTestId("notification-sound-switch"));
  const ids = searchIds();
  assert.equal(ids.includes(ROW_ID), false);
  assert.ok(ids.includes("notification-sound"), JSON.stringify(ids));
});

test("loaded with the field: the row shows the stored value and is searchable", () => {
  useNotificationSettingsStore.setState({ account: withField(), accountLoaded: true });
  renderWithIntl(<><ContentCard /><SearchIds /></>);
  assert.ok(document.getElementById(ROW_ID));
  const toggle = screen.getByTestId("notification-followed-thread-replies-switch");
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(searchIds().includes(ROW_ID), true);
});

test("while the settings load: the row stands, off and disabled (#14685)", () => {
  renderWithIntl(<><ContentCard /><SearchIds /></>);
  const toggle = screen.getByTestId("notification-followed-thread-replies-switch");
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.ok(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true" || toggle.hasAttribute("data-disabled"));
});
