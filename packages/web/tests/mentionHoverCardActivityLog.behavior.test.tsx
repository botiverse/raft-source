import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { ReactElement } from "react";
import type { TrajectoryLogEntry } from "../src/store/agentStore";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

const { cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { default: api } = await import("../src/api/client");
const { default: ProfilePreviewCardContent } = await import("../src/components/message/ProfilePreviewCardContent");
const { getRecentActivityPreviewRows } = await import("../src/components/message/MentionHoverActivityPreview");
const { useAgentStore } = await import("../src/store/agentStore");
const { useAuthStore } = await import("../src/store/authStore");
const { useMachineStore } = await import("../src/store/machineStore");
const { useServerStore } = await import("../src/store/serverStore");
const { TestIntlProvider } = await import("./helpers/intl");

const defaultLoadTrajectoryLog = useAgentStore.getState().loadTrajectoryLog;
const defaultApiGet = api.get;

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  useAgentStore.setState({
    agents: [],
    agentActivities: {},
    activityLogs: {},
    trajectoryLogs: {},
    loadTrajectoryLog: defaultLoadTrajectoryLog,
  } as never);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useMachineStore.setState({ machines: [] } as never);
  useServerStore.setState({ members: [] } as never);
  api.get = defaultApiGet;
});

function seedViewer(userId = "viewer-user") {
  useAuthStore.setState({
    user: {
      id: userId,
      email: `${userId}@slock.test`,
      gravatarHash: "",
      name: userId,
      displayName: null,
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "manual",
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    initialized: true,
  } as never);
}

function makeEntry(index: number): TrajectoryLogEntry {
  return {
    timestamp: Date.UTC(2026, 0, 1, 8, 0, index),
    entry: {
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: `Step ${index}`,
      detailKind: "other",
    },
  };
}

function renderPreview(ui: ReactElement) {
  return render(
    <TestIntlProvider>
      {ui}
    </TestIntlProvider>,
  );
}

test("agent profile preview card renders the latest five trajectory entries and updates from socket-ingested entries", async () => {
  const agentId = "agent-hover-activity";
  seedViewer();
  useAgentStore.setState({
    agents: [
      {
        id: agentId,
        name: "hover-agent",
        displayName: "Hover Agent",
        status: "active",
        avatarUrl: null,
        creatorType: "user",
        creatorId: "viewer-user",
      },
    ],
    agentActivities: {
      [agentId]: { activity: "working", activityDetail: "Step 6" },
    },
    trajectoryLogs: {
      [agentId]: [1, 2, 3, 4, 5, 6].map(makeEntry),
    },
  } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="agent"
      mentionId={agentId}
    />,
  );

  assert.ok(screen.getByText("Recent activity"));
  for (const label of ["Step 2", "Step 3", "Step 4", "Step 5", "Step 6"]) {
    assert.ok(screen.getAllByText(label).length > 0, `${label} should be visible`);
  }
  const activityRows = screen.getAllByTestId("mention-hover-activity-row");
  assert.equal(activityRows.length, 5);
  assert.deepEqual(
    activityRows.map((row) => row.textContent?.match(/Step \d/)?.[0]),
    ["Step 2", "Step 3", "Step 4", "Step 5", "Step 6"],
  );
  for (const row of activityRows) {
    assert.match(row.className, /\bflex\b/, "timestamp, status dot, and status text should share one flex row");
    assert.doesNotMatch(row.className, /\bgrid\b/);
  }
  assert.equal(screen.queryByText("Step 1"), null, "hover card must cap the preview at five entries");

  act(() => {
    useAgentStore.getState().appendTrajectory(
      agentId,
      [{ kind: "status", activity: "working", activityKind: "working", detail: "Live step", detailKind: "other" }],
      Date.UTC(2026, 0, 1, 8, 0, 7),
    );
  });

  await waitFor(() => assert.ok(screen.getAllByText("Live step").length > 0));
  assert.equal(screen.queryByText("Step 2"), null, "new live activity should push the oldest preview row out");
});

test("recent activity preview rows keep the latest five entries oldest-to-newest with stable keys", () => {
  const rows = getRecentActivityPreviewRows([1, 2, 3, 4, 5, 6].map(makeEntry));

  assert.deepEqual(
    rows.map((row) => row.text),
    ["Step 2", "Step 3", "Step 4", "Step 5", "Step 6"],
  );
  assert.deepEqual(
    rows.map((row) => row.key),
    [
      `${Date.UTC(2026, 0, 1, 8, 0, 2)}:status:Step 2`,
      `${Date.UTC(2026, 0, 1, 8, 0, 3)}:status:Step 3`,
      `${Date.UTC(2026, 0, 1, 8, 0, 4)}:status:Step 4`,
      `${Date.UTC(2026, 0, 1, 8, 0, 5)}:status:Step 5`,
      `${Date.UTC(2026, 0, 1, 8, 0, 6)}:status:Step 6`,
    ],
  );
});

test("agent profile preview card omits recent activity section when the log is empty", () => {
  const agentId = "agent-hover-activity-empty";
  seedViewer();
  useAgentStore.setState({
    agents: [
      {
        id: agentId,
        name: "empty-log-agent",
        displayName: "Empty Log Agent",
        status: "active",
        avatarUrl: null,
        creatorType: "user",
        creatorId: "viewer-user",
      },
    ],
    agentActivities: {
      [agentId]: { activity: "online", activityDetail: "" },
    },
    trajectoryLogs: {
      [agentId]: [],
    },
  } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="agent"
      mentionId={agentId}
    />,
  );

  assert.equal(screen.queryByText("Recent activity"), null);
});

test("agent profile preview card omits recent activity section when no log exists yet", () => {
  const agentId = "agent-hover-activity-missing";
  seedViewer();
  useAgentStore.setState({
    agents: [
      {
        id: agentId,
        name: "missing-log-agent",
        displayName: "Missing Log Agent",
        status: "active",
        avatarUrl: null,
        creatorType: "user",
        creatorId: "viewer-user",
      },
    ],
    agentActivities: {
      [agentId]: { activity: "online", activityDetail: "" },
    },
    trajectoryLogs: {},
    loadTrajectoryLog: async () => {},
  } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="agent"
      mentionId={agentId}
    />,
  );

  assert.equal(screen.queryByText("Recent activity"), null);
});

test("agent profile preview card matches agent profile runtime model reasoning and computer metadata", () => {
  const agentId = "agent-hover-runtime";
  const machineId = "machine-hover-runtime";
  seedViewer();
  useMachineStore.setState({
    machines: [
      {
        id: machineId,
        name: "Erid",
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: null,
        runtimes: ["codex"],
        hostname: "erid.local",
        os: "darwin",
        daemonVersion: "0.70.0",
        isComputer: true,
        computerAttachedByCurrentUser: true,
        computerVersion: "0.2.0",
        computerUpgradeAvailable: false,
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  } as never);
  useAgentStore.setState({
    agents: [
      {
        id: agentId,
        name: "runtime-agent",
        displayName: "Runtime Agent",
        status: "active",
        avatarUrl: null,
        creatorType: "user",
        creatorId: "viewer-user",
        runtime: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: null,
        machineId,
      },
    ],
    agentActivities: {
      [agentId]: { activity: "online", activityDetail: "" },
    },
    trajectoryLogs: {},
    loadTrajectoryLog: async () => {},
  } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="agent"
      mentionId={agentId}
    />,
  );

  assert.ok(screen.getByText("Computer"));
  assert.ok(screen.getByText("Erid"));
  assert.equal(screen.queryByText(/computer v0\.2\.0/), null);
  assert.equal(screen.queryByText("Connected"), null);
  assert.ok(screen.getByText("Runtime"));
  assert.ok(screen.getByText("Codex CLI"));
  assert.ok(screen.getByText("Model"));
  assert.ok(screen.getByText("GPT-5.6 Sol"));
  assert.ok(screen.getByText("Reasoning"));
  assert.ok(screen.getByText("Default"));
});

test("agent profile preview card does not flash a raw dynamic model ID before the configured label loads", async () => {
  const agentId = "agent-hover-dynamic-model";
  const machineId = "machine-hover-dynamic-model";
  let resolveModels!: (value: { data: unknown }) => void;
  api.get = (() => new Promise((resolve) => {
    resolveModels = resolve;
  })) as typeof api.get;
  seedViewer();
  useServerStore.setState({
    current: { id: "server-hover-dynamic-model" },
    members: [],
  } as never);
  useMachineStore.setState({
    machines: [{ id: machineId, name: "ArteaMBP" }],
  } as never);
  useAgentStore.setState({
    agents: [
      {
        id: agentId,
        name: "dynamic-model-agent",
        displayName: "Dynamic Model Agent",
        status: "active",
        avatarUrl: null,
        creatorType: "user",
        creatorId: "viewer-user",
        runtime: "kimi-sdk",
        model: "kimi-code/k3-256k",
        machineId,
        runtimeConfig: {
          version: 1,
          runtime: "kimi-sdk",
          model: { kind: "custom", name: "kimi-code/k3-256k" },
          mode: { kind: "default" },
        },
      },
    ],
    agentActivities: {
      [agentId]: { activity: "online", activityDetail: "" },
    },
    trajectoryLogs: {},
    loadTrajectoryLog: async () => {},
  } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="agent"
      mentionId={agentId}
    />,
  );

  const rawModelIdWasVisible = screen.queryByText("kimi-code/k3-256k") !== null;
  assert.ok(screen.getByText("Loading…"), "a pending dynamic catalog must render as loading, not as a raw ID");

  await act(async () => {
    resolveModels({
      data: {
        kind: "live",
        value: {
          models: [{ id: "kimi-code/k3-256k", label: "K3-256k", verified: "launchable" }],
          default: "kimi-code/k3",
        },
      },
    });
  });

  await waitFor(() => assert.ok(screen.getByText("K3-256k")));
  assert.equal(
    rawModelIdWasVisible,
    false,
    "the raw provider/model ID must not become transient user-facing copy",
  );
  assert.equal(screen.queryByText("kimi-code/k3-256k"), null);
});

test("agent profile preview card hides activity detail and trajectory preview from non-private viewers", () => {
  const agentId = "agent-hover-private";
  seedViewer("other-user");
  useAgentStore.setState({
    agents: [
      {
        id: agentId,
        name: "private-agent",
        displayName: "Private Agent",
        status: "active",
        avatarUrl: null,
        creatorType: "user",
        creatorId: "owner-user",
      },
    ],
    agentActivities: {
      [agentId]: { activity: "working", activityDetail: "secret workspace path" },
    },
    trajectoryLogs: {
      [agentId]: [makeEntry(1)],
    },
  } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="agent"
      mentionId={agentId}
    />,
  );

  assert.ok(screen.getByText("Working\u2026"));
  assert.equal(screen.queryByText("secret workspace path"), null);
  assert.equal(screen.queryByText("Recent activity"), null);
  assert.equal(screen.queryByText("Step 1"), null);
});

test("user profile preview card never renders agent activity preview", () => {
  const userId = "human-with-agent-log-id";
  useServerStore.setState({
    members: [
      {
        userId,
        email: null,
        gravatarHash: "",
        name: "human",
        displayName: "Human",
        description: null,
        avatarUrl: null,
        role: "member",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  } as never);
  useAgentStore.setState({
    trajectoryLogs: {
      [userId]: [makeEntry(1)],
    },
  } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="user"
      mentionId={userId}
    />,
  );

  assert.equal(screen.queryByText("Recent activity"), null);
});

test("user profile preview card never renders agent runtime metadata", () => {
  const userId = "human-with-agent-runtime-id";
  useServerStore.setState({
    members: [
      {
        userId,
        email: null,
        gravatarHash: "",
        name: "human-runtime",
        displayName: "Human Runtime",
        description: null,
        avatarUrl: null,
        role: "member",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="user"
      mentionId={userId}
    />,
  );

  assert.equal(screen.queryByText("Runtime"), null);
  assert.equal(screen.queryByText("Model"), null);
  assert.equal(screen.queryByText("Reasoning"), null);
  assert.equal(screen.queryByText("Computer"), null);
});

test("channel-summary Agent fallback omits operational runtime metadata", () => {
  seedViewer("guest-viewer");
  useAgentStore.setState({ agents: [] } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="agent"
      mentionId="channel-agent"
      fallbackAgent={{
        id: "channel-agent",
        serverId: "server-1",
        name: "channel-agent",
        displayName: "Channel Agent",
        description: "Helps this channel",
        avatarUrl: null,
        status: "active",
        runtime: "codex",
        model: "private-model",
        machineId: "private-machine",
        profileProjection: "channel_summary",
      } as never}
    />,
  );

  assert.ok(screen.getByText("Channel Agent"));
  assert.ok(screen.getByText("Helps this channel"));
  assert.equal(screen.queryByText("Computer"), null);
  assert.equal(screen.queryByText("Runtime"), null);
  assert.equal(screen.queryByText("Model"), null);
  assert.equal(screen.queryByText("private-model"), null);
});

test("channel participant human fallback renders a minimal profile card", () => {
  useServerStore.setState({ members: [] } as never);

  renderPreview(
    <ProfilePreviewCardContent
      mentionType="user"
      mentionId="channel-human"
      fallbackMember={{
        userId: "channel-human",
        name: "channel-human",
        displayName: "Channel Human",
        description: null,
        avatarUrl: null,
        gravatarHash: "",
        role: "member",
        joinedAt: "2026-09-03T00:00:00.000Z",
      }}
    />,
  );

  assert.ok(screen.getByText("Channel Human"));
  assert.ok(screen.getByText("@channel-human"));
  assert.equal(screen.queryByText("Profile unavailable"), null);
});

// Regression: a cross-server @mention whose entity is absent from the local
// store (and has no fallback profile) must render a minimal graceful card
// rather than `null`. Returning `null` collapsed the hover card into an empty
// black bar (joint-channel mention hover). #498 / #501.
test("agent hover card renders a graceful fallback instead of an empty black bar when the agent is missing", () => {
  useAgentStore.setState({
    agents: [],
    trajectoryLogs: {},
    loadTrajectoryLog: async () => {},
    ensureAgentProfile: async () => {},
  } as never);

  renderPreview(<ProfilePreviewCardContent mentionType="agent" mentionId="absent-agent-id" />);

  // Non-empty card: the presence of this text proves the component did not
  // return null (which would have rendered nothing = the black bar).
  assert.ok(screen.getByText("Profile unavailable"), "graceful fallback must render, not null");
});

test("hover card shows the @handle from fallbackLabel when the entity is missing", () => {
  useAgentStore.setState({
    agents: [],
    trajectoryLogs: {},
    loadTrajectoryLog: async () => {},
    ensureAgentProfile: async () => {},
  } as never);

  renderPreview(
    <ProfilePreviewCardContent mentionType="agent" mentionId="absent-agent-id" fallbackLabel="Cindy" />,
  );

  assert.ok(screen.getByText("@Cindy"), "fallback handle should surface in the graceful card");
  assert.ok(screen.getByText("Profile unavailable"));
});

test("user hover card renders a graceful fallback when the member is missing", () => {
  useServerStore.setState({ members: [] } as never);

  renderPreview(
    <ProfilePreviewCardContent mentionType="user" mentionId="absent-user-id" fallbackLabel="pi-pmo" />,
  );

  assert.ok(screen.getByText("@pi-pmo"), "graceful fallback must render for missing members too");
  assert.ok(screen.getByText("Profile unavailable"));
});
