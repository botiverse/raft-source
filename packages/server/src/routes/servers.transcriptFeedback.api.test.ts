import { tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { seedPlaywrightScenario } from "../test/seedPlaywrightScenario.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });



test("POST /api/servers/:id/machines/:machineId/agents/:agentId/feedback/:reportId/transcript accepts and fire-and-forgets collection", async ({ app }) => {
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  const orchestrator = app.app.get("agentOrchestrator") as AgentOrchestrator;

  const called: {
    agentId?: string;
    feedbackReportId?: string;
    reportGeneratedAt?: string;
    reportTimeSource?: string;
  } = {};
  orchestrator.collectFeedbackTranscript = async (agentId, feedbackReportId, reportWindow) => {
    called.agentId = agentId;
    called.feedbackReportId = feedbackReportId;
    called.reportGeneratedAt = reportWindow.reportGeneratedAt;
    called.reportTimeSource = reportWindow.reportTimeSource;
    return { reachable: true, traceBundleId: "test-trace-bundle-id" };
  };

  const reportId = randomUUID();
  const reportGeneratedAt = "2026-07-20T16:40:04.797Z";
  const res = await fetch(
    `${app.baseUrl}/api/servers/${seed.server.id}/machines/${seed.machine.id}/agents/${seed.agent.id}/feedback/${reportId}/transcript`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": seed.server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reportGeneratedAt }),
    },
  );

  assert.equal(res.status, 202);
  const body = await res.json() as { accepted: boolean; feedbackReportId: string; agentId: string };
  assert.equal(body.accepted, true);
  assert.equal(body.feedbackReportId, reportId);
  assert.equal(body.agentId, seed.agent.id);
  assert.equal(called.agentId, seed.agent.id);
  assert.equal(called.feedbackReportId, reportId);
  assert.equal(called.reportGeneratedAt, reportGeneratedAt);
  assert.equal(called.reportTimeSource, "web_report_bundle");
});

test("POST /feedback/:reportId/transcript rejects malformed report-window timestamps", async ({ app }) => {
  const seed = await seedPlaywrightScenario();
  const token = await tokenForHuman(seed.user.email);
  const reportId = randomUUID();
  const res = await fetch(
    `${app.baseUrl}/api/servers/${seed.server.id}/machines/${seed.machine.id}/agents/${seed.agent.id}/feedback/${reportId}/transcript`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": seed.server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reportGeneratedAt: "not-a-timestamp" }),
    },
  );
  assert.equal(res.status, 400);
});

test("POST /feedback/:reportId/transcript rejects non-admin/non-creator members", async ({ app }) => {
  const seed = await seedPlaywrightScenario();
  const extraToken = await tokenForHuman(seed.extraHuman.email);

  const reportId = randomUUID();
  const res = await fetch(
    `${app.baseUrl}/api/servers/${seed.server.id}/machines/${seed.machine.id}/agents/${seed.agent.id}/feedback/${reportId}/transcript`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${extraToken}`,
        "X-Server-Id": seed.server.id,
      },
    },
  );

  assert.equal(res.status, 403);
});
