import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AppOutboundPermissionError,
  appOutboundEventRequiredGroups,
  computeEffectiveAppOutboundAuthority,
  normalizeAppOutboundPermissionRequest,
} from "./appOutboundPermissionService.js";

test("outbound permission requests are strict, deduplicated, and sorted", () => {
  assert.deepEqual(normalizeAppOutboundPermissionRequest({
    groups: ["server", "agent", "server"],
    events: ["agent.status_changed", "server.config_updated", "agent.status_changed"],
  }), {
    groups: ["agent", "server"],
    events: ["agent.status_changed", "server.config_updated"],
  });

  assert.throws(
    () => normalizeAppOutboundPermissionRequest({ groups: ["server", "unknown"], events: [] }),
    AppOutboundPermissionError,
  );
  assert.throws(
    () => normalizeAppOutboundPermissionRequest({ groups: ["server"], events: ["agent.status_changed"] }),
    /requires group agent/,
  );
  assert.throws(
    () => normalizeAppOutboundPermissionRequest({ groups: ["server"], events: ["server.unknown"] }),
    AppOutboundPermissionError,
  );
});

test("effective authority intersects reviewed events and Developer subscriptions within approved groups", () => {
  assert.deepEqual(computeEffectiveAppOutboundAuthority({
    currentGroups: ["server", "agent", "computer"],
    currentEvents: ["server.config_updated", "agent.status_changed", "computer.agent_started"],
    approvedGroups: ["server", "computer"],
    subscribedEvents: ["server.config_updated", "computer.agent_started"],
  }), {
    groups: ["computer", "server"],
    events: ["server.config_updated"],
  });

  assert.deepEqual(computeEffectiveAppOutboundAuthority({
    currentGroups: ["server"],
    currentEvents: ["server.config_updated"],
    approvedGroups: ["server"],
    subscribedEvents: [],
  }), { groups: ["server"], events: [] });
});

test("computer agent lifecycle events require both read groups", () => {
  assert.deepEqual(appOutboundEventRequiredGroups("computer.agent_started"), ["computer", "agent"]);
  assert.deepEqual(appOutboundEventRequiredGroups("server.member_added"), ["server"]);
});
