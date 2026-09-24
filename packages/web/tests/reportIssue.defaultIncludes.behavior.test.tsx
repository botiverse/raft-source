import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReportIssueDialog from "../src/components/agent/ReportIssueDialog";
import api from "../src/api/client";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const originalApiPost = api.post;
const originalFetch = globalThis.fetch;
const consentLabel = enMessages["agent.reportIssue.consent"] as string;

const agentBase: Agent = {
  id: "agent-1",
  serverId: "server-1",
  name: "helper",
  displayName: "Helper",
  avatarUrl: null,
  description: "A test agent",
  status: "idle",
  model: "test-model",
  runtime: "codex",
  serverRole: "member",
  reasoningEffort: null,
  executionMode: "byoc",
  envVars: null,
  machineId: null,
  creatorType: "user",
  creatorId: "user-1",
  creator: null,
  createdAgents: [],
  deletedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
};

const machine: Machine = {
  id: "machine-1",
  name: "Test computer",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: ["codex"],
  hostname: "test.local",
  os: "darwin",
  daemonVersion: "1.0.16",
  lastHeartbeat: "2026-08-12T00:00:00.000Z",
  createdAt: "2026-08-12T00:00:00.000Z",
};

type ReportPayload = {
  title: string;
  metadata: {
    includes: Record<string, boolean>;
    transcript?: {
      requested: boolean;
      requestable: boolean;
    };
  };
};

afterEach(() => {
  cleanup();
  api.post = originalApiPost;
  globalThis.fetch = originalFetch;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function seedStores(hasMachine: boolean) {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "reporter@example.test",
      name: "reporter",
      displayName: "Reporter",
    },
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Test server",
      slug: "test-server",
    },
  } as never);
  useMachineStore.setState({ machines: hasMachine ? [machine] : [] } as never);
  useAgentStore.setState({
    getActivityLog: () => [{ id: "activity-1" }],
    getTrajectoryLog: () => [{ id: "trajectory-1" }],
  } as never);
}

function renderDialog(hasMachine: boolean, locale = "en") {
  seedStores(hasMachine);
  const agent = { ...agentBase, machineId: hasMachine ? machine.id : null };
  render(
    <TestIntlProvider locale={locale}>
      <ReportIssueDialog
        agent={agent}
        onClose={() => undefined}
        feedbackExportUrl="https://feedback.example.test"
      />
    </TestIntlProvider>,
  );
}

test("the mounted dialog sends its formatted agent title under zh-cn", async () => {
  const mocks = installSubmitMocks();
  renderDialog(false, "zh-cn");

  fireEvent.click(screen.getByRole("checkbox", {
    name: (zhMessages as Record<string, string>)["agent.reportIssue.consent"],
  }));
  fireEvent.click(screen.getByRole("button", {
    name: (zhMessages as Record<string, string>)["agent.reportIssue.title"],
  }));

  await screen.findByText((zhMessages as Record<string, string>)["agent.reportIssue.submittedTitle"]);
  assert.equal(mocks.getCreatePayload()?.title, "针对 Helper 的问题报告");
});

function checkbox(label: string) {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function consentCheckbox() {
  return screen.getByRole("checkbox", { name: consentLabel }) as HTMLInputElement;
}

function installSubmitMocks() {
  let createPayload: ReportPayload | null = null;
  const apiCalls: string[] = [];

  api.post = (async (url: string) => {
    apiCalls.push(url);
    if (url === "/servers/server-1/scope-attestation") {
      return {
        data: {
          attestation: "attestation-1",
          scope: "feedback-report:create",
          expiresAt: "2026-08-12T01:00:00.000Z",
        },
      };
    }
    if (url === "/servers/server-1/feedback/report-1/receipt") return { data: {} };
    throw new Error(`Unexpected API call: ${url}`);
  }) as typeof api.post;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://feedback.example.test/api/reports") {
      createPayload = JSON.parse(String(init?.body)) as ReportPayload;
      return new Response(JSON.stringify({
        id: "report-1",
        artifactId: "artifact-1",
        upload: { method: "PUT", url: "https://upload.example.test/report-1", headers: {} },
        completeToken: "complete-1",
        expiresAt: "2026-08-12T01:00:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://upload.example.test/report-1") return new Response(null, { status: 200 });
    if (url === "https://feedback.example.test/api/reports/report-1/complete") {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  return {
    apiCalls,
    getCreatePayload: () => createPayload,
  };
}

test("assigned-machine defaults are individually on while consent starts off", () => {
  renderDialog(true);

  assert.ok(screen.getByText("These are included by default — untick anything you don't want to send."));
  assert.equal(checkbox("Recent DM messages with this agent").checked, true);
  assert.equal(checkbox("Recent live agent activity").checked, true);
  assert.equal(checkbox("Activity tab history").checked, true);
  assert.equal(checkbox("Runtime session transcript").checked, true);
  assert.equal(consentCheckbox().checked, false);
});

test("without an assigned machine transcript is unavailable, off, and omitted from the request", async () => {
  const mocks = installSubmitMocks();
  renderDialog(false);

  assert.equal(checkbox("Recent DM messages with this agent").checked, true);
  assert.equal(checkbox("Recent live agent activity").checked, true);
  assert.equal(checkbox("Activity tab history").checked, true);
  const transcript = checkbox("Runtime session transcript");
  assert.equal(transcript.checked, false);
  assert.equal(transcript.disabled, true);
  assert.ok(screen.getByText("Runtime transcript upload is unavailable until the agent is assigned to a machine."));
  const consent = consentCheckbox();
  assert.equal(consent.checked, false);

  fireEvent.click(consent);
  fireEvent.click(screen.getByRole("button", { name: "Report Issue" }));

  await screen.findByText("Report Submitted");
  const payload = mocks.getCreatePayload();
  assert.ok(payload);
  assert.equal(Object.hasOwn(payload.metadata.includes, "runtimeSessionTranscript"), false);
  assert.equal(Object.hasOwn(payload.metadata, "transcript"), false);
  assert.equal(mocks.apiCalls.some((url) => url.includes("/transcript")), false);
});

test("each user untick stays equal between the final DOM and the request payload", async () => {
  const mocks = installSubmitMocks();
  renderDialog(true);

  const rows = [
    ["Recent DM messages with this agent", "recentMessages"],
    ["Recent live agent activity", "activityLog"],
    ["Activity tab history", "trajectoryLog"],
    ["Runtime session transcript", "runtimeSessionTranscript"],
  ] as const;

  for (const [label] of rows) {
    const input = checkbox(label);
    assert.equal(input.checked, true, `${label} must start on`);
    fireEvent.click(input);
    assert.equal(input.checked, false, `${label} must end off after its own untick`);
  }
  const finalDomState = Object.fromEntries(
    rows.map(([label, payloadKey]) => [payloadKey, checkbox(label).checked]),
  ) as Record<(typeof rows)[number][1], boolean>;

  const consent = consentCheckbox();
  assert.equal(consent.checked, false);
  fireEvent.click(consent);
  fireEvent.click(screen.getByRole("button", { name: "Report Issue" }));

  await screen.findByText("Report Submitted");
  const payload = mocks.getCreatePayload();
  assert.ok(payload);
  for (const [, payloadKey] of rows) {
    assert.equal(payload.metadata.includes[payloadKey], finalDomState[payloadKey], payloadKey);
  }
  assert.equal(payload.metadata.transcript?.requested, finalDomState.runtimeSessionTranscript);
  assert.equal(payload.metadata.transcript?.requestable, true);
});
