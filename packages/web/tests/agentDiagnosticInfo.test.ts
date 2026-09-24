import assert from "node:assert/strict";
import test from "node:test";
import { createIntl, createIntlCache } from "react-intl";

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

  assert.match(info, /^Raft Diagnostic Info$/m);
  assert.match(info, /^activityKind: running_command$/m);
  assert.doesNotMatch(info, /^activityKind: Localized or edited running-copy$/m);
});

test("offline display uses structured detail kind instead of display text", () => {
  assert.equal(
    getActivityText("offline", "Localized stopped copy", "stopped"),
    "Stopped — won't receive messages until restarted",
  );
  assert.equal(getActivityText("offline", "Stopped", "other"), "Offline");
  assert.equal(getActivityText("offline", "Stopped"), "Offline");
});
