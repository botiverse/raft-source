import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../../../api/client";
import { MachineAgentList } from "../MachineAgentList";
import type { Agent } from "../../../store/agentStore";
import { useAgentStore } from "../../../store/agentStore";
import { useMachineStore } from "../../../store/machineStore";
import type { Machine } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import { renderWithIntl } from "../../../../tests/helpers/intl";

// `raft proc` jobs on the Computer page (docs/contracts/proc-jobs.md): a Jobs
// line only under an agent that has jobs (none when the answer is unknown),
// Stop only for a viewer who controls the Computer, and only after the
// confirmation, which sends the job's agent and name. Assertions compare
// strings / booleans only (never DOM nodes).
// RED proofs: render the line for every agent and "Bo" gets one; drop the
// canControl gate and the member sees Stop; post before the confirm and the
// first calls check fails.

const original = { get: api.get, post: api.post };
const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

function agent(id: string, name: string): Agent {
  return {
    id, serverId: "server-1", serverName: "Server", serverSlug: "server", name, displayName: name, avatarUrl: null,
    description: null, status: "stopped", model: "gpt-5", runtime: "codex", serverRole: null, reasoningEffort: null,
    executionMode: "cloud", envVars: null, machineId: "m1", creatorType: "user", creatorId: "user-1", creator: null,
    createdAgents: [], deletedAt: null, createdAt: "2026-08-22T00:00:00.000Z",
  };
}

const machine: Machine = {
  id: "m1", name: "mac-mini", description: null, status: "online", statusVersion: 1, apiKeyPrefix: null, runtimes: ["codex"],
  hostname: "mac-mini.local", os: "darwin", daemonVersion: null, isComputer: true, computerVersion: "1.0.0",
  computerUpgradeAvailable: false, lastHeartbeat: null, createdAt: "2026-08-08T00:00:00.000Z",
};

const startedAt = new Date(Date.now() - (3 * 60 + 5) * 60_000).toISOString();
const exitedAt = new Date(Date.now() - 5 * 60_000).toISOString();

type Call = { method: string; url: string; body?: unknown };

function mockApi(read: unknown) {
  const calls: Call[] = [];
  api.get = (async (url: string) => {
    if (!url.endsWith("/proc-jobs")) return { data: {} } as never;
    calls.push({ method: "get", url });
    return { data: read } as never;
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    calls.push({ method: "post", url, body });
    return { data: { outcome: "stopped" } } as never;
  }) as typeof api.post;
  return calls;
}

function renderList(canControl: boolean) {
  useAgentStore.setState({ agents: [agent("a1", "Ada"), agent("a2", "Bo")], activityLogs: {}, agentActivities: {}, loading: false } as never);
  useServerStore.setState({ current: { id: "server-1", name: "Acme", slug: "acme", ownerId: "user-1", role: "owner", plan: "free" } } as never);
  useMachineStore.setState({ machines: [machine], loading: false, loadStatus: "loaded", computerOperationProgress: {} } as never);
  return renderWithIntl(
    <MemoryRouter>
      <MachineAgentList machine={machine} canManageMachines canControl={canControl} canViewRuntimeAccountUsage={false} selectionDock={null} onSelectingChange={() => {}} />
    </MemoryRouter>,
  );
}

const known = {
  status: "known",
  reportedAt: new Date().toISOString(),
  jobs: [
    { agentId: "a1", name: "web", state: "running", startedAt, memoryMaxBytes: 4 * 1024 ** 3, rssBytes: 300 * 1024 ** 2 },
    { agentId: "a1", name: "bot", state: "exited", startedAt, exitedAt, exitReason: "owner_stop", stoppedBy: "tygg" },
  ],
};

afterEach(() => {
  cleanup();
  Object.assign(api, original);
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

test("the Jobs line shows under the agent that has jobs: state, uptime or how it ended, memory against the cap", async () => {
  const calls = mockApi(known);
  renderList(true);
  await waitFor(() => assert.equal(screen.queryAllByTestId("machine-agent-proc-jobs").length, 1));
  assert.deepEqual(calls[0], { method: "get", url: "/servers/server-1/machines/m1/proc-jobs" });
  const line = screen.getByTestId("machine-agent-proc-jobs");
  const text = line.textContent ?? "";
  assert.ok(text.includes("Jobs"), text);
  assert.ok(text.includes("web") && text.includes("Running 3h 5m"), text);
  assert.ok(text.includes("300.0 MB of 4.0 GB"), text);
  assert.ok(text.includes("Stopped by @tygg"), text);
  // Stop only for the running one.
  assert.deepEqual(within(line).queryAllByRole("button").map((button) => button.getAttribute("aria-label")), ["Stop web"]);
});

test("an unknown answer and an empty one show no Jobs line", async () => {
  for (const read of [{ status: "unknown" }, { status: "known", reportedAt: new Date().toISOString(), jobs: [] }]) {
    const calls = mockApi(read);
    renderList(true);
    await waitFor(() => assert.ok(calls.length > 0, "read"));
    assert.equal(screen.queryAllByTestId("machine-agent-proc-jobs").length, 0);
    cleanup();
  }
});

test("Stop is not offered to a viewer who does not control the Computer", async () => {
  mockApi(known);
  renderList(false);
  await waitFor(() => assert.equal(screen.queryAllByTestId("machine-agent-proc-jobs").length, 1));
  assert.equal(within(screen.getByTestId("machine-agent-proc-jobs")).queryAllByRole("button").length, 0);
});

test("Stop asks first; confirming posts the job's agent and name, then reads the jobs again", async () => {
  const calls = mockApi(known);
  renderList(true);
  await waitFor(() => assert.equal(screen.queryAllByTestId("machine-agent-proc-jobs").length, 1));
  fireEvent.click(screen.getByRole("button", { name: "Stop web" }));
  await waitFor(() => assert.equal(screen.queryAllByTestId("proc-job-stop-dialog").length, 1));
  assert.equal(calls.filter((call) => call.method === "post").length, 0, "nothing is sent before the confirm");
  const reads = calls.filter((call) => call.method === "get").length;
  fireEvent.click(screen.getByTestId("proc-job-stop-confirm"));
  await waitFor(() => assert.ok(calls.some((call) => call.method === "post")));
  assert.deepEqual(calls.find((call) => call.method === "post"), {
    method: "post", url: "/servers/server-1/machines/m1/proc-jobs/stop", body: { agentId: "a1", name: "web" },
  });
  await waitFor(() => assert.ok(calls.filter((call) => call.method === "get").length > reads, "read again"));
});

// The Computer's fresh report can reach the server after the stop's answer:
// the page must not keep offering Stop on a job that was just stopped.
test("a confirmed Stop shows the job ended at once, even while the next read still says running", async () => {
  const calls = mockApi(known);
  renderList(true);
  await waitFor(() => assert.equal(screen.queryAllByTestId("machine-agent-proc-jobs").length, 1));
  fireEvent.click(screen.getByRole("button", { name: "Stop web" }));
  await waitFor(() => assert.equal(screen.queryAllByTestId("proc-job-stop-dialog").length, 1));
  fireEvent.click(screen.getByTestId("proc-job-stop-confirm"));
  await waitFor(() => assert.ok(calls.some((call) => call.method === "post")));
  await waitFor(() => assert.equal(screen.queryAllByRole("button", { name: "Stop web" }).length, 0, "no Stop on a stopped job"));
});
