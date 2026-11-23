// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// The dedicated native onboarding page renders only the setup gate: no app shell
// loads the agent list there. The handoff step reads the onboarding agent itself
// (GET /agents/:id, then the agent list while it shows), so "Cindy couldn't
// start" shows there too, with the agent store empty when the step mounts.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import ServerSetupHandoffStep from "../src/components/onboarding/ServerSetupHandoffStep";
import { useAgentStore } from "../src/store/agentStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const SERVER = {
  id: "server-1",
  name: "Acme",
  slug: "acme",
  avatarUrl: null,
  ownerId: "user-1",
  role: "owner",
  onboardingAgentId: "agent-cindy",
  officialOnboardingAgentId: "agent-cindy",
} as Server;

const CINDY_FAILED = {
  id: "agent-cindy",
  serverId: "server-1",
  name: "cindy",
  displayName: "Cindy",
  avatarUrl: "pixel:mug",
  description: null,
  status: "inactive",
  model: "",
  runtime: "claude",
  serverRole: "member",
  executionMode: "byoc",
  envVars: null,
  machineId: "machine-1",
  reasoningEffort: null,
  lastRuntimeError: null,
  activity: "offline",
  activityDetail: "Runtime failed to start",
  activityDetailKind: "runtime_unavailable",
  spawnFailure: { reason: "runtime_spawn_failed" },
};

const originalGet = api.get;
const agentsInitial = useAgentStore.getState();
const serversInitial = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useAgentStore.setState(agentsInitial, true);
  useServerStore.setState(serversInitial, true);
});

test("on the native page the handoff step loads the onboarding agent itself and shows that she couldn't start", async () => {
  const reads: string[] = [];
  api.get = (async (path: string) => {
    reads.push(path);
    if (path === "/agents/agent-cindy") return { data: CINDY_FAILED };
    if (path === "/agents") return { data: [CINDY_FAILED] };
    if (path.endsWith("/runtime-auth")) {
      return { data: { status: { collectedAt: "2026-11-17T10:00:00.000Z", runtimes: { claude: { kind: "logged_in" } } }, availability: "ok", canAct: true } };
    }
    return { data: {} };
  }) as typeof api.get;
  useServerStore.setState({ current: SERVER, servers: [SERVER] });
  useAgentStore.setState({ agents: [], agentActivities: {} });

  render(
    <TestIntlProvider>
      {/* No Router, as on any surface: the step takes navigation as a callback, which the gate leaves out on the dedicated page. */}
      <ServerSetupHandoffStep serverId="server-1" onDone={() => {}} pollAgent />
    </TestIntlProvider>,
  );
  await act(async () => {});

  await waitFor(() => assert.ok(screen.queryByTestId("first-agent-start-failed") !== null, "the banner shows once she is read"));
  assert.ok(reads.includes("/agents/agent-cindy"), "read on its own, with no app shell");
  const notice = screen.getByTestId("first-agent-start-failed");
  assert.equal(notice.textContent?.includes("Cindy couldn't start"), true);
  // The native page offers no Switch runtime: the card points to skip, then her profile (Cat).
  assert.equal(notice.textContent?.includes("didn't start. Restart Raft Computer there, or skip for now and switch Cindy to another runtime from Cindy's profile."), true);
  // The native page never opens the app: no Switch runtime there.
  assert.ok(screen.queryByTestId("first-agent-failed-switch-runtime") === null);
  // Not "takes it from here" / "waiting in your channel" for an agent that could not start.
  assert.ok(screen.getByText("One more step"));
  assert.ok(screen.queryByText(/takes it from here|is waiting in your channel/) === null);
  // The card's Sign in is the main action: the bottom button only skips past it, and is secondary (Cat).
  const done = screen.getByTestId("server-setup-handoff-done");
  assert.equal(done.textContent, "Skip for now");
  assert.equal(done.className.includes("bg-attention-400"), false, "not the pink primary");
});

test("while she runs, the handoff keeps its title and the pink Let's go", async () => {
  api.get = (async (path: string) => {
    if (path === "/agents/agent-cindy") return { data: { ...CINDY_FAILED, status: "active", activity: "online", activityDetail: "", activityDetailKind: "idle", spawnFailure: undefined } };
    return { data: {} };
  }) as typeof api.get;
  useServerStore.setState({ current: SERVER, servers: [SERVER] });
  useAgentStore.setState({ agents: [], agentActivities: {} });

  render(
    <TestIntlProvider>
      <ServerSetupHandoffStep serverId="server-1" onDone={() => {}} />
    </TestIntlProvider>,
  );
  await waitFor(() => assert.ok(screen.queryByText("Cindy takes it from here") !== null));
  assert.ok(screen.queryByTestId("first-agent-start-failed") === null);
  const done = screen.getByTestId("server-setup-handoff-done");
  assert.equal(done.textContent, "Let's go");
  assert.equal(done.className.includes("bg-attention-400"), true, "the pink primary");
});

test("the agent list is polled only on the dedicated native page, never on the main app surface", async () => {
  vi.useFakeTimers();
  try {
    const listReads = { count: 0 };
    api.get = (async (path: string) => {
      if (path === "/agents") { listReads.count += 1; return { data: [CINDY_FAILED] }; }
      if (path === "/agents/agent-cindy") return { data: CINDY_FAILED };
      return { data: {} };
    }) as typeof api.get;
    useServerStore.setState({ current: SERVER, servers: [SERVER] });
    useAgentStore.setState({ agents: [], agentActivities: {} });

    // The main app surface (the gate passes no pollAgent there): live pushes, no poll.
    const main = render(
      <TestIntlProvider>
        <ServerSetupHandoffStep serverId="server-1" onDone={() => {}} onOpenAgent={() => {}} />
      </TestIntlProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    assert.equal(listReads.count, 0, "no agent-list poll on the main surface");
    main.unmount();

    // The dedicated native page: re-read while the step shows.
    render(
      <TestIntlProvider>
        <ServerSetupHandoffStep serverId="server-1" onDone={() => {}} pollAgent />
      </TestIntlProvider>,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    assert.ok(listReads.count >= 3, `polled on the native page (${listReads.count} reads)`);
  } finally {
    vi.useRealTimers();
  }
});
