import assert from "node:assert/strict";
import test from "node:test";

import {
  appConfigTraceAttrs,
  appInboxItemTraceAttrs,
  appSnapshotTraceAttrs,
  appSourceTraceAttrs,
  filterAppRuntimeTraceAttrs,
} from "./appRuntimeTrace.js";

test("built-in App trace identities join exact revisions without content fields", () => {
  assert.deepEqual(
    appConfigTraceAttrs({
      appId: "test.cleaner",
      ownerAgentId: "agent-a",
      revision: 7,
    }),
    {
      app_id: "test.cleaner",
      owner_agent_id: "agent-a",
      config_revision: 7,
      app_correlation_id: "config:test.cleaner:agent-a:7",
    },
  );

  const reminder = appSourceTraceAttrs({
    appId: "system.reminder",
    ownerAgentId: "agent-a",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: "reminder-a", revision: "9" },
    itemId: "item-a",
  });
  const inbox = appInboxItemTraceAttrs("agent-a", {
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: "reminder-a", revision: "9" },
    itemId: "item-a",
  });
  assert.deepEqual(inbox, reminder);
  assert.equal(
    reminder.app_correlation_id,
    "source:agent-a:reminder:reminder-a:9",
  );
});

test("built-in App trace attributes stay content-free", () => {
  const attrs = appInboxItemTraceAttrs("agent-a", {
    appId: "test.app",
    notificationClass: "notice",
    sourceRef: { kind: "source", id: "source-a" },
    itemId: "item-a",
  });
  assert.deepEqual(Object.keys(attrs).sort(), [
    "app_correlation_id",
    "app_id",
    "item_id",
    "notification_class",
    "owner_agent_id",
    "source_id",
    "source_kind",
  ]);
  for (const forbidden of [
    "title",
    "summary",
    "action_cli",
    "argv",
    "path",
    "config_value",
  ]) {
    assert.equal(Object.hasOwn(attrs, forbidden), false);
  }
});

test("Server built-in App trace allowlist drops every unreviewed attribute", () => {
  const attrs = filterAppRuntimeTraceAttrs({
    ...appSnapshotTraceAttrs({
      appId: "system.cleaner",
      ownerAgentId: "agent-a",
      snapshotKind: "app_config",
    }),
    message_type: "app_config.snapshot",
    outcome: "snapshot_failed",
    reason: "snapshot_build_or_send_failed",
    payload: JSON.stringify({ thresholdBytes: 123 }),
    arbitrary_content: "must not cross telemetry",
    path: "/private/path",
  });

  assert.deepEqual(attrs, {
    app_id: "system.cleaner",
    owner_agent_id: "agent-a",
    snapshot_kind: "app_config",
    app_correlation_id: "snapshot:app_config:system.cleaner:agent-a",
    message_type: "app_config.snapshot",
    outcome: "snapshot_failed",
    reason: "snapshot_build_or_send_failed",
  });
});
