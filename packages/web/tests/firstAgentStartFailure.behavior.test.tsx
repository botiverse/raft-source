// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// The first agent could not start during setup (mail #214: Cindy exited a second
// after each start with runtime_unavailable, and the page promised a greeting).
// The setup's last step (the handoff) now says so plainly in a card, and puts the
// next step in its footer as the page's pink button (Cat; never a button in the
// card, Raft DS Banner): Sign in to her runtime where the error is a sign-in or the
// Computer reports it signed out, else Switch runtime; "Skip for now" outlined.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import api from "../src/api/client";
import ServerSetupHandoffStep from "../src/components/onboarding/ServerSetupHandoffStep";
import { firstAgentStartFailure } from "../src/components/onboarding/firstAgentStartFailure";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import type { AgentActivityState } from "../src/store/events/agentActivityEvents";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { RuntimeAuthClient } from "../src/utils/runtimeAuthClient";
import type { RuntimeAuthView } from "../src/utils/runtimeAuthClient";
import { TestIntlProvider } from "./helpers/intl";

type NoticeAgent = Pick<Agent, "id" | "name" | "displayName" | "runtime" | "machineId" | "status" | "lastRuntimeError">;

const CINDY: NoticeAgent = {
  id: "agent-cindy",
  name: "cindy",
  displayName: "Cindy",
  runtime: "kimi-sdk",
  machineId: "machine-1",
  status: "inactive",
  lastRuntimeError: null,
};

const FAILED_START: AgentActivityState = {
  activity: "offline",
  activityDetail: "Runtime failed to start",
  detailKind: "runtime_unavailable",
  spawnFailure: { reason: "runtime_spawn_failed" },
};

const SERVER = { id: "server-1", name: "Acme", slug: "acme", avatarUrl: null, ownerId: "user-1", role: "owner", onboardingAgentId: "agent-cindy", officialOnboardingAgentId: "agent-cindy" } as Server;
const originalGet = api.get;
const originalPost = api.post;
const agentsInitial = useAgentStore.getState();
const serversInitial = useServerStore.getState();
const machinesInitial = useMachineStore.getState();
let posts: string[] = [];

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useAgentStore.setState(agentsInitial, true);
  useServerStore.setState(serversInitial, true);
  useMachineStore.setState(machinesInitial, true);
});

function fakeClient(authView: () => RuntimeAuthView) {
  const http = { get: async <T,>() => authView() as T, post: async <T,>() => ({}) as T };
  return new RuntimeAuthClient(http, { current: () => null, onReplaced: () => () => {} });
}

function view(runtimes: NonNullable<RuntimeAuthView["status"]>["runtimes"]): RuntimeAuthView {
  return { status: { collectedAt: "2026-11-17T10:00:00.000Z", runtimes }, availability: "ok", runtimes: ["claude", "codex", "kimi"], canAct: true };
}

/** The handoff step with this onboarding agent in the stores (the gate's step, as on the main surface). */
async function renderHandoff(agent: NoticeAgent, activity: AgentActivityState | undefined, authView: RuntimeAuthView | (() => RuntimeAuthView), onOpenAgent?: () => void) {
  posts = [];
  api.get = (async () => ({ data: {} })) as typeof api.get;
  api.post = (async (path: string) => { posts.push(path); return { data: {} }; }) as typeof api.post;
  useServerStore.setState({ current: SERVER, servers: [SERVER] });
  useMachineStore.setState({ machines: [{ id: "machine-1", name: "Mei's PC", status: "online", runtimes: [agent.runtime] } as Machine] });
  useAgentStore.setState({ agents: [agent as Agent], agentActivities: activity ? { [agent.id]: activity } : {} });
  const client = fakeClient(typeof authView === "function" ? authView : () => authView);
  render(
    <TestIntlProvider>
      <ServerSetupHandoffStep serverId="server-1" onDone={() => {}} onOpenAgent={onOpenAgent} runtimeAuthClient={client} />
    </TestIntlProvider>,
  );
  await act(async () => {});
  return client;
}

/** The footer's action buttons, in DOM (left-to-right from sm) order. */
function footerActions() {
  return Array.from(screen.getByTestId("server-setup-handoff-actions").querySelectorAll("button")).map((button) => ({
    label: button.textContent ?? "",
    pink: button.className.includes("bg-attention-400"),
  }));
}

test("a failed start on a signed-out runtime: the card says so; the footer is outlined Skip for now, then pink Sign in at the far right", async () => {
  let switched = 0;
  await renderHandoff(CINDY, FAILED_START, view({ kimi: { kind: "logged_out" } }), () => { switched += 1; });

  const notice = screen.getByTestId("first-agent-start-failed");
  assert.equal(notice.textContent?.includes("Cindy couldn't start"), true);
  assert.equal(notice.textContent?.includes("Kimi Code isn't signed in on Mei's PC. Sign in, and Cindy will start."), true);
  assert.equal(notice.querySelectorAll("button").length, 0, "no button in the card");
  assert.deepEqual(footerActions(), [
    { label: "Skip for now", pink: false },
    { label: "Sign in to Kimi Code", pink: true },
  ]);
  // "Or switch to another runtime." runs on inside the same paragraph, the link a word of it (wraps with the text).
  const link = screen.getByTestId("first-agent-failed-switch-runtime");
  assert.equal(link.tagName, "SPAN");
  assert.equal(link.getAttribute("role"), "button");
  assert.equal(link.hasAttribute("href"), false, "nothing to middle-click or copy as a link");
  assert.equal(link.classList.contains("box-decoration-clone"), true, "each wrapped line gets its own focus ring");
  assert.equal(link.closest("p")?.textContent?.includes("Sign in, and Cindy will start. Or switch to another runtime."), true);
  fireEvent.click(link);
  await act(async () => {});
  assert.equal(switched, 1);
});

test("an auth_required error says sign in even where the Computer has not reported signed out", async () => {
  await renderHandoff(
    { ...CINDY, runtime: "claude", lastRuntimeError: { message: "Not logged in", code: "auth_required", at: "2026-11-17T10:00:00.000Z", actionRequired: true } },
    { activity: "error", activityDetail: "", detailKind: "none", errorCode: "auth_required" },
    view({}),
  );
  assert.equal(screen.getByTestId("first-agent-start-failed").textContent?.includes("Claude Code isn't signed in on Mei's PC."), true);
  assert.deepEqual(footerActions().map((action) => action.label), ["Skip for now", "Sign in to Claude Code"]);
});

test("a failure that is not a sign-in: what failed in the card, pink Switch runtime in the footer", async () => {
  let switched = 0;
  await renderHandoff({ ...CINDY, runtime: "claude" }, FAILED_START, view({ claude: { kind: "logged_in" } }), () => { switched += 1; });

  const notice = screen.getByTestId("first-agent-start-failed");
  assert.equal(notice.textContent?.includes("Claude Code on Mei's PC didn't start. Switch Cindy to another runtime, or restart Raft Computer there."), true, "web and desktop keep this text");
  assert.equal(notice.querySelectorAll("button, [role='button']").length, 0, "no button or link in the card");
  assert.deepEqual(footerActions(), [
    { label: "Skip for now", pink: false },
    { label: "Switch runtime", pink: true },
  ]);
  fireEvent.click(screen.getByTestId("first-agent-failed-switch-runtime-action"));
  await act(async () => {});
  assert.equal(switched, 1);
  assert.ok(posts.includes("/servers/server-1/setup-handoff"), "it finishes setup first");
});

test("where her profile can't be opened (the native page), the other failure has no pink action, only Skip for now", async () => {
  await renderHandoff({ ...CINDY, runtime: "claude" }, FAILED_START, view({ claude: { kind: "logged_in" } }));
  assert.deepEqual(footerActions(), [{ label: "Skip for now", pink: false }]);
  // With no Switch runtime here, the card says how to get there: skip, then her profile (Cat).
  assert.equal(
    screen.getByTestId("first-agent-start-failed").textContent?.includes(
      "Claude Code on Mei's PC didn't start. Restart Raft Computer there, or skip for now and switch Cindy to another runtime from Cindy's profile.",
    ),
    true,
  );
});

test("nothing while she runs: no card, and the footer is the pink Let's go alone", async () => {
  await renderHandoff({ ...CINDY, status: "active" }, { activity: "online", activityDetail: "", detailKind: "none" }, view({ kimi: { kind: "logged_out" } }), () => {});
  assert.ok(screen.queryByTestId("first-agent-start-failed") === null);
  assert.deepEqual(footerActions(), [{ label: "Let's go", pink: true }]);
});

test("the classification: failed starts and sign-in failures only, steady through a retry", () => {
  assert.deepEqual(firstAgentStartFailure(CINDY, FAILED_START), { signIn: false });
  assert.deepEqual(firstAgentStartFailure(CINDY, { activity: "offline", activityDetail: "", detailKind: "wake_crash_loop_blocked" }), { signIn: false });
  // An error of a runtime that did start is not setup's to report.
  const stored = { message: "boom", at: "2026-11-17T10:00:00.000Z", actionRequired: false };
  assert.equal(firstAgentStartFailure({ ...CINDY, lastRuntimeError: stored }, { activity: "error", activityDetail: "", detailKind: "runtime_error" }), null);
  assert.equal(firstAgentStartFailure({ ...CINDY, lastRuntimeError: stored }, undefined), null, "a stored error that is not a failed start");
  // An automatic retry in progress: the stored failed start (#490) keeps the answer.
  const storedStart = { ...stored, spawnFailureReason: "runtime_spawn_failed" as const };
  assert.deepEqual(
    firstAgentStartFailure({ ...CINDY, lastRuntimeError: storedStart }, { activity: "online", activityDetail: "", detailKind: "runtime_starting" }),
    { signIn: false },
  );
  assert.equal(firstAgentStartFailure({ ...CINDY, status: "active" }, undefined), null);
  assert.equal(firstAgentStartFailure({ ...CINDY, status: "active", lastRuntimeError: storedStart }, { activity: "working", activityDetail: "", detailKind: "none" }), null, "she runs");
  assert.equal(firstAgentStartFailure({ ...CINDY, lastRuntimeError: null }, undefined), null, "inactive with nothing that says it failed");
});

test("#490: runtime_login_required is a sign-in, on the activity frame and on the stored error", () => {
  // The agent:activity runtime_unavailable frame.
  assert.deepEqual(firstAgentStartFailure(CINDY, { ...FAILED_START, spawnFailure: { reason: "runtime_login_required" } }), { signIn: true });
  // The stored error's class (#490's `spawnFailureReason`; members get the class only, no detail).
  const stored = { message: "", at: "2026-11-17T10:00:00.000Z", actionRequired: true, spawnFailureReason: "runtime_login_required" as const };
  assert.deepEqual(firstAgentStartFailure({ ...CINDY, lastRuntimeError: stored }, undefined), { signIn: true });
  // Another stored class is a failed start, not a sign-in.
  const otherStart = { ...stored, spawnFailureReason: "runtime_spawn_failed" as const };
  assert.deepEqual(firstAgentStartFailure({ ...CINDY, lastRuntimeError: otherStart }, undefined), { signIn: false });
});

test("Sign in restarts her only when the runtime is now signed in: Cancel starts nothing", async () => {
  let authView = view({ kimi: { kind: "logged_out" } });
  const client = await renderHandoff(CINDY, FAILED_START, () => authView);
  const starts = () => posts.filter((path) => path === "/agents/agent-cindy/start").length;

  // Opened from the footer, then cancelled while still signed out.
  fireEvent.click(screen.getByTestId("first-agent-failed-sign-in"));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {});
  assert.equal(starts(), 0, "no start on Cancel");

  // Opened again; the sign-in finishes (the Computer reports signed in, the read is dropped), then closed.
  fireEvent.click(screen.getByTestId("first-agent-failed-sign-in"));
  await act(async () => {});
  authView = view({ kimi: { kind: "logged_in" } });
  client.invalidate("server-1", "machine-1");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {});
  assert.equal(starts(), 1, "one start once signed in");
});

test("the in-sentence switch link: Enter presses it, Space presses it on release, other keys do nothing", async () => {
  let switched = 0;
  await renderHandoff(CINDY, FAILED_START, view({ kimi: { kind: "logged_out" } }), () => { switched += 1; });
  let link = screen.getByTestId("first-agent-failed-switch-runtime");
  assert.equal(link.getAttribute("tabindex"), "0", "reachable with Tab");
  fireEvent.keyDown(link, { key: "a" });
  await act(async () => {});
  assert.equal(switched, 0, "any other key does nothing");
  fireEvent.keyDown(link, { key: "Enter" });
  await act(async () => {});
  assert.equal(switched, 1, "Enter");

  cleanup();
  switched = 0;
  await renderHandoff(CINDY, FAILED_START, view({ kimi: { kind: "logged_out" } }), () => { switched += 1; });
  link = screen.getByTestId("first-agent-failed-switch-runtime");
  // As a native button: Space presses it on release.
  fireEvent.keyDown(link, { key: " " });
  await act(async () => {});
  assert.equal(switched, 0, "Space waits for its keyup");
  fireEvent.keyUp(link, { key: " " });
  await act(async () => {});
  assert.equal(switched, 1, "Space");
});

test("Switch runtime runs once: a held Enter or a double click finishes setup and opens her profile once", async () => {
  let switched = 0;
  await renderHandoff(CINDY, FAILED_START, view({ kimi: { kind: "logged_out" } }), () => { switched += 1; });
  // The link repeats with a held Enter, as a native button does; the action ignores calls while one runs.
  let link = screen.getByTestId("first-agent-failed-switch-runtime");
  fireEvent.keyDown(link, { key: "Enter" });
  fireEvent.keyDown(link, { key: "Enter", repeat: true });
  fireEvent.keyDown(link, { key: "Enter", repeat: true });
  await act(async () => {});
  assert.equal(switched, 1, "held Enter");
  assert.equal(posts.length, 1, "one handoff acknowledgment");

  cleanup();
  switched = 0;
  await renderHandoff(CINDY, FAILED_START, view({ kimi: { kind: "logged_out" } }), () => { switched += 1; });
  link = screen.getByTestId("first-agent-failed-switch-runtime");
  fireEvent.click(link);
  fireEvent.click(link);
  await act(async () => {});
  assert.equal(switched, 1, "double click");
  assert.equal(posts.length, 1, "one handoff acknowledgment");
});

test("a handoff call that fails leaves Switch runtime and the footer live, and the next press tries again", async () => {
  let switched = 0;
  await renderHandoff(CINDY, FAILED_START, view({ kimi: { kind: "logged_out" } }), () => { switched += 1; });
  // The acknowledgment fails: the server still has the handoff pending, so this step stays up.
  api.post = (async (path: string) => { posts.push(path); throw new Error("offline"); }) as typeof api.post;
  const footerButtons = () => Array.from(screen.getByTestId("server-setup-handoff-actions").querySelectorAll("button"));

  fireEvent.click(screen.getByTestId("first-agent-failed-switch-runtime"));
  await act(async () => {});
  assert.equal(posts.length, 1, "the first press calls the API");
  assert.equal(switched, 1, "a failed call still lets them through");
  assert.deepEqual(footerButtons().map((button) => button.disabled), [false, false], "the footer is re-enabled");
  assert.ok(screen.queryByText("Starting…") === null, "no longer Starting…");

  fireEvent.click(screen.getByTestId("first-agent-failed-switch-runtime"));
  await act(async () => {});
  assert.equal(posts.length, 2, "the next press tries again");
  assert.equal(switched, 2);
});
