import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asServerId, type AnalyticsId } from "@botiverse/raft-shared";
import express from "express";
import { buildClientEventRows, clientEventBatchSchema, clientPlatform, getProductEventSink, getPublicVisitorSink } from "./productEventIngest";
import { setPrivacyModeForTest } from "../config/privacyMode";

test("ingest counts missing announcement classification separately from invalid values", () => {
  const now = new Date();
  const complete = { announcement_id: randomUUID(), delivery_version: 1, action: "primary", has_cta: true };
  const batch = clientEventBatchSchema.parse({
    source: "web",
    events: [complete, { announcement_id: complete.announcement_id, delivery_version: 1, has_cta: true }, { ...complete, has_cta: "yes" }].map((properties) => ({
      uuid: randomUUID(), event: "announcement_interacted", timestamp: now.toISOString(), properties,
    })),
  });
  const result = buildClientEventRows({
    batch, receivedAt: now, analyticsId: randomUUID() as AnalyticsId, serverId: asServerId(randomUUID()),
  });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0].properties, complete);
  assert.deepEqual(result.rejected, { missing_property: 1, invalid_property_value: 1 });
});

// The Artifact chip's source (Remy, #proj-workspace:fbc76200). Web and server
// deploy separately: a server without a newer web's value (`future_source`
// here, `message_chip` on a server older than it) drops only that event.
test("artifact_opened from the chip (message_chip) is stored; a source the server does not know drops only that event", () => {
  const now = new Date();
  const batch = clientEventBatchSchema.parse({
    source: "web",
    events: ["message_chip", "future_source", "message_card"].map((source) => ({
      uuid: randomUUID(), event: "artifact_opened", timestamp: now.toISOString(),
      properties: { source, kind: "html", is_author: false, surface: "side" },
    })),
  });
  const result = buildClientEventRows({
    batch, receivedAt: now, analyticsId: randomUUID() as AnalyticsId, serverId: asServerId(randomUUID()),
  });
  assert.deepEqual(result.rows.map((row) => row.properties.source), ["message_chip", "message_card"]);
  assert.deepEqual(result.rejected, { invalid_property_value: 1 });
});

test("a native batch is accepted, but only for events the registry opens to native apps", () => {
  const now = new Date();
  const batch = clientEventBatchSchema.parse({
    source: "ios",
    events: [
      { event: "nav_entry_selected", properties: { destination: "activity", surface: "mobile_tab_bar", was_active: false } },
      { event: "activity_open", properties: { from: "rail" } },
    ].map((event) => ({ uuid: randomUUID(), timestamp: now.toISOString(), ...event })),
  });
  const result = buildClientEventRows({
    batch, receivedAt: now, analyticsId: randomUUID() as AnalyticsId, serverId: asServerId(randomUUID()),
  });
  assert.deepEqual(result.rows.map((row) => [row.event, row.source]), [["nav_entry_selected", "ios"]]);
  assert.deepEqual(result.rejected, { source_not_allowed: 1 });
  assert.equal(clientEventBatchSchema.safeParse({ ...batch, source: "server" }).success, false, "server facts never arrive in a client batch");
});

test("clientPlatform: native apps are themselves, the desktop app is desktop_app, the web splits by install and device", () => {
  assert.equal(clientPlatform({ source: "ios" }, "tablet"), "ios");
  assert.equal(clientPlatform({ source: "android" }, "tablet"), "android");
  assert.equal(clientPlatform({ source: "harmonyos" }, undefined), "harmonyos");
  assert.equal(clientPlatform({ source: "desktop" }, "desktop"), "desktop_app");
  assert.equal(clientPlatform({ source: "web", display_mode: "standalone" }, "mobile"), "pwa");
  assert.equal(clientPlatform({ source: "web", display_mode: "browser" }, "mobile"), "mobile_web");
  assert.equal(clientPlatform({ source: "web" }, "tablet"), "mobile_web");
  assert.equal(clientPlatform({ source: "web" }, "desktop"), "web");
  assert.equal(clientPlatform({ source: "web" }, "other"), "web");
});

// meichen (2026-11-09): Desktop's migration reports stop sending once an answer counts them as a
// duplicate. A uuid is remembered only when its row is queued, so an event refused the first time
// is judged again when it comes back, never answered as already taken.
test("a refused event is not remembered: sent again, it is judged again, and only a queued one is a duplicate", () => {
  const ids = { analyticsId: randomUUID() as AnalyticsId, serverId: asServerId(randomUUID()) };
  const now = new Date();
  const uuid = randomUUID();
  const send = (event: Record<string, unknown>, receivedAt = now) => buildClientEventRows({
    batch: clientEventBatchSchema.parse({ source: "web", events: [{ uuid, ...event }] }),
    receivedAt, ...ids,
  });

  const tooOld = send({ event: "activity_open", timestamp: new Date(now.getTime() - 3 * 86_400_000).toISOString(), properties: { from: "rail" } });
  assert.deepEqual([tooOld.rows.length, tooOld.rejected], [0, { timestamp_out_of_range: 1 }]);
  const invalid = send({ event: "activity_open", timestamp: now.toISOString(), properties: { from: "nowhere" } });
  assert.deepEqual([invalid.rows.length, invalid.rejected], [0, { invalid_property_value: 1 }], "judged again, not a duplicate");

  const queued = send({ event: "activity_open", timestamp: now.toISOString(), properties: { from: "rail" } });
  assert.deepEqual([queued.rows.length, queued.rejected], [1, {}], "the first valid send is queued");
  const repeat = send({ event: "activity_open", timestamp: now.toISOString(), properties: { from: "rail" } });
  assert.deepEqual([repeat.rows.length, repeat.rejected], [0, { duplicate: 1 }], "only a queued uuid is a duplicate");
});

test("RAFT_PRIVACY_MODE: the product event and public visitor sinks are unconfigured (null), even when ScopeDB is set", () => {
  const app = express();
  // A configured sink, as createProductEventSinkFromEnv would have cached it.
  const configured = { write: () => true, flush: async () => {} };
  app.set("productEventSink", configured);
  app.set("publicVisitorSink", configured);
  setPrivacyModeForTest(true);
  try {
    assert.equal(getProductEventSink(app), null);
    assert.equal(getPublicVisitorSink(app), null);
  } finally {
    setPrivacyModeForTest(false);
  }
  assert.equal(getProductEventSink(app), configured, "off: unchanged");
  assert.equal(getPublicVisitorSink(app), configured);
});
