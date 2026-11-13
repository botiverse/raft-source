import assert from "node:assert/strict";
import { createIntl, createIntlCache } from "react-intl";
import type { ExternalAgentDiagnosticsView } from "@botiverse/raft-shared";

import { buildAgentDiagnosticInfo } from "../src/utils/agentDiagnosticInfo";
import { getActivityText } from "../src/utils/activity";
import { en } from "../src/i18n/messages/en";

const formatMessage = createIntl(
  { locale: "en", defaultLocale: "en", messages: en },
  createIntlCache(),
).formatMessage;

test("diagnostic activity kind uses structured detail kind instead of display text", () => {
  const info = buildAgentDiagnosticInfo({
    agent: {
      id: "agent-1",
      machineId: "machine-1",
      sessionId: "session-1",
      runtime: "codex",
      model: "gpt-5",
      status: "active",
    },
    serverId: "server-1",
    machine: {
      id: "machine-1",
      daemonVersion: "1.2.3",
      computerVersion: "4.5.6",
    },
    activityState: {
      activity: "working",
      activityDetail: "Localized or edited running-copy",
      detailKind: "running_command",
    },
    activityLog: [{ timestamp: 12345, activity: "working", detail: "old copy", detailKind: "other" }],
    reportedAt: new Date(67890),
    formatMessage,
  });

  assert.match(info, /^Raft diagnostic info$/m);
  assert.match(info, /^activityKind: running_command$/m);
  assert.doesNotMatch(info, /^activityKind: Localized or edited running-copy$/m);
});

test("managed agent diagnostic text keeps its exact managed shape", () => {
  const info = buildAgentDiagnosticInfo({
    agent: { id: "agent-1", machineId: "machine-1", sessionId: null, runtime: "codex", model: "gpt-5", status: "active" },
    serverId: "server-1",
    machine: { id: "machine-1", daemonVersion: "1.2.3", computerVersion: "4.5.6" },
    activityState: { activity: "online", activityDetail: "", detailKind: "none" },
    activityLog: [{ timestamp: 12345, activity: "online", detail: "", detailKind: "none" }],
    reportedAt: new Date(67890),
    formatMessage,
  });
  assert.equal(info, [
    "Raft diagnostic info",
    "reportedAtUtc: 1970-01-01T00:01:07.890Z",
    "serverId: server-1",
    "agentId: agent-1",
    "machineId: machine-1",
    "sessionId: null",
    "runtime: codex",
    "model: gpt-5",
    "computerVersion: 4.5.6",
    "daemonVersion: 1.2.3",
    "agentStatus: active",
    "activity: online",
    "activityKind: online",
    "lastActivityAtUtc: 1970-01-01T00:00:12.345Z",
  ].join("\n"));
});

const EXTERNAL_DIAGNOSTICS: ExternalAgentDiagnosticsView = {
  agentId: "ext-1",
  runtime: "external",
  generatedAt: "2026-09-29T12:00:00.000Z",
  provider: {
    kind: "antiproton",
    state: "active",
    providerAgentId: "ap_1",
    syncPending: false,
    lastErrorCode: null,
    lastErrorAt: null,
    activatedAt: "2026-09-01T00:00:00.000Z",
  },
  presence: { lastSeenAt: "2026-09-29T11:59:30.000Z", onlineWindowMs: 120_000, online: true },
  status: {
    activity: "working",
    detail: "Reviewing PR",
    detailKind: null,
    observedAt: "2026-09-29T11:59:00.000Z",
    lastActivityLogAt: "2026-09-29T11:59:00.000Z",
    statusProtocolAdoptedAt: "2026-09-10T00:00:00.000Z",
  },
  push: {
    registered: true,
    enabled: false,
    endpointHost: "hooks.antiproton.ai",
    disabledReason: "endpoint_rejected",
    disabledAt: "2026-09-29T10:00:00.000Z",
    consecutiveFailures: 3,
    lastAttemptAt: "2026-09-29T10:00:00.000Z",
    lastDeliveryAt: "2026-09-28T10:00:00.000Z",
    lastError: "http_404",
    nextAttemptAt: null,
  },
  events: { lastCursorPullAt: "2026-09-29T11:58:00.000Z", pendingCursorAckCount: 2 },
  connections: [{ provider: "github", state: "connected", account: "octo-bot", reason: null }],
};

test("external agent diagnostic text carries external facts, not managed-only fields", () => {
  const info = buildAgentDiagnosticInfo({
    agent: { id: "ext-1", machineId: null, sessionId: null, runtime: "external", model: "external", status: "inactive", lastSeenAt: null },
    serverId: "server-1",
    machine: null,
    activityState: { activity: "online", activityDetail: "", detailKind: "none" },
    activityLog: [],
    externalDiagnostics: EXTERNAL_DIAGNOSTICS,
    reportedAt: new Date("2026-09-29T12:00:10.000Z"),
    formatMessage,
  });
  for (const managedOnly of [/^machineId:/m, /^daemonVersion:/m, /^computerVersion:/m, /^agentStatus:/m, /^sessionId:/m, /^model:/m]) {
    assert.doesNotMatch(info, managedOnly);
  }
  for (const line of [
    "runtime: external",
    "providerKind: antiproton",
    "provisioningState: active",
    "lastSeenAtUtc: 2026-09-29T11:59:30.000Z",
    "online: yes (window 120s)",
    "activity: working",
    "activityDetail: Reviewing PR",
    "statusObservedAtUtc: 2026-09-29T11:59:00.000Z",
    "statusProtocolAdoptedAtUtc: 2026-09-10T00:00:00.000Z",
    "pushWebhook: disabled (endpoint_rejected)",
    "pushEndpointHost: hooks.antiproton.ai",
    "pushConsecutiveFailures: 3",
    "pushLastDeliveryAtUtc: 2026-09-28T10:00:00.000Z",
    "eventsLastCursorPullAtUtc: 2026-09-29T11:58:00.000Z",
    "eventsPendingCursorAcks: 2",
    "githubConnection: connected (octo-bot)",
  ]) {
    assert.ok(info.split("\n").includes(line), `missing line: ${line}\n${info}`);
  }
});

test("external agent diagnostic text says when the external diagnostics are unavailable", () => {
  const info = buildAgentDiagnosticInfo({
    agent: { id: "ext-1", machineId: null, sessionId: null, runtime: "external", model: "external", status: "inactive", lastSeenAt: "2026-09-29T11:00:00.000Z" },
    serverId: "server-1",
    machine: null,
    activityState: null,
    activityLog: [],
    externalDiagnostics: null,
    reportedAt: new Date("2026-09-29T12:00:00.000Z"),
    formatMessage,
  });
  assert.match(info, /^externalDiagnostics: unavailable$/m);
  assert.match(info, /^online: no \(window 120s\)$/m);
  assert.doesNotMatch(info, /^daemonVersion:/m);
});

test("offline display uses structured detail kind instead of display text", () => {
  assert.equal(
    getActivityText("offline", "Localized stopped copy", "stopped"),
    "Stopped — won't receive messages until restarted",
  );
  assert.equal(getActivityText("offline", "Stopped", "other"), "Offline");
  assert.equal(getActivityText("offline", "Stopped"), "Offline");
});
