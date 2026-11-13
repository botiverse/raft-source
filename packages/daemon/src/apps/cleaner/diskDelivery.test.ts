import assert from "node:assert/strict";
import { formatAgentInboxAppItems, noopTracer, type AgentInboxAppItem } from "@botiverse/raft-shared";
import { createAgentAppInboxStore, type AgentAppInboxNoticeOptions, type AgentAppInboxStore } from "../../agentAppInbox";
import { createBuiltInLocalScheduleRuntime } from "../../registry.manifest";
import { ProviderQuotaState } from "../../providerQuotaState";

const { diskStats } = vi.hoisted(() => ({
  diskStats: vi.fn(async (_absolutePath: string) => ({
    type: 0, bsize: 4096, blocks: 100, bfree: 90, bavail: 9, files: 0, ffree: 0,
  })),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  statfs: diskStats,
}));
// The fake statfs is the disk under test; on macOS the real important-usage
// capacity (osascript) would otherwise replace it.
vi.mock("../../volumeCapacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../volumeCapacity")>();
  return { ...actual, readVolumeCapacity: (target: string) => actual.readVolumeCapacity(target, { platform: "linux" }) };
});

function productionRuntime(input: {
  memoryBytes: number;
  idleTask?: { ask: () => Promise<{ send: boolean; text?: string; items: [] }>; delivered: string[] };
  providerQuota?: ProviderQuotaState;
}) {
  const inboxes = new Map<string, AgentAppInboxStore>();
  const delivered: Array<{ owner: string; item: AgentInboxAppItem; notice: AgentAppInboxNoticeOptions | undefined }> = [];
  const traces: Array<{ name: string; attrs: Readonly<Record<string, unknown>> }> = [];
  const runtime = createBuiltInLocalScheduleRuntime({
    agentsDataDir: "/computer/agents",
    cleanerReminderStateStore: { load: () => null, save: () => {}, remove: () => {} },
    ...(input.providerQuota ? { cleanerProviderQuota: (agentId: string) => input.providerQuota!.quotaFor(agentId) } : {}),
    cleanerMeasureMemoryFile: async () => ({ kind: "measured", bytes: input.memoryBytes }),
    cleanerMeasureRaftDiskFootprint: async () => ({
      raft_migration_chunks_bytes: 300,
      raft_workspace_backups_bytes: 2_000,
      raft_launch_dirs_bytes: 20,
      measure_outcome: "complete",
    }),
    getInbox(owner) {
      let inbox = inboxes.get(owner);
      if (!inbox) {
        inbox = createAgentAppInboxStore({ registry: runtime.inboxRegistry });
        inboxes.set(owner, inbox);
      }
      return inbox;
    },
    notifyInbox: async (owner, item, notice) => { delivered.push({ owner, item, notice }); return true; },
    send: () => {},
    trace: (name, attrs) => { traces.push({ name, attrs }); },
    tracer: noopTracer,
    ...(input.idleTask
      ? {
          idleNoticeFacts: () => ({ sessionId: "s-1", launchId: "l-1", resumed: true, backgroundTasks: 0, blocked: false }),
          deliverIdleNotice: async (agentId: string, text: string) => { input.idleTask!.delivered.push(`${agentId}:${text}`); return "written" as const; },
          idleTaskReminderAsk: input.idleTask.ask as never,
        }
      : {}),
  });
  for (const owner of ["owner-a", "owner-b"]) {
    runtime.handleServerMessage({
      type: "app_config.upsert",
      agentId: owner,
      config: {
        appId: "system.cleaner", ownerAgentId: owner, revision: 1,
        effective: { enabled: true, thresholdBytes: 65536, intervalMs: 3600000 },
      },
    });
  }
  return { runtime, inboxes, delivered, traces };
}

test("low disk space is traced per owner and reaches only an agent that finished work, as a workspace tip", async () => {
  vi.useFakeTimers();
  const { runtime, inboxes, delivered, traces } = productionRuntime({ memoryBytes: 1 });
  try {
    await vi.advanceTimersByTimeAsync(3600000);
    assert.ok(diskStats.mock.calls.every(([root]) => root === "/computer/agents"));
    const lowDisk = traces.filter(({ name, attrs }) =>
      name === "daemon.cleaner.decision" && attrs.decision === "disk_low");
    assert.equal(lowDisk.length, 2, "bavail, not root-reserved bfree, determines pressure");
    for (const { attrs } of lowDisk) {
      assert.equal(attrs.disk_available_bytes, 9 * 4096);
      assert.equal(attrs.disk_total_bytes, 100 * 4096);
      assert.equal(attrs.raft_workspace_backups_bytes, 2_000, "Raft's own footprint rides on the low-disk decision");
      assert.equal(attrs.measure_outcome, "complete");
    }
    assert.equal(delivered.length, 0, "a machine-wide condition must not wake every agent on it");
    for (const owner of ["owner-a", "owner-b"]) {
      assert.equal(inboxes.get(owner)?.list().length ?? 0, 0);
    }
    runtime.onAgentWorkingToIdle("owner-a");
    // The Cleaner reads the workspace root (real I/O) before it presents.
    await vi.waitFor(() => assert.equal(delivered.length, 1));
    assert.deepEqual(
      delivered.map(({ owner, item, notice }) => [owner, item.notificationClass, notice]),
      [["owner-a", "disk_space_hint", { startStoppedAgent: false, requireIdle: true }]],
    );
    assert.match(formatAgentInboxAppItems(inboxes.get("owner-a")!.list()), /summary=Disk is low \(36\.0 KiB free\)/);
    assert.equal(inboxes.get("owner-b")?.list().length ?? 0, 0, "an agent that did not work is not asked");
  } finally {
    runtime.stop();
    vi.useRealTimers();
  }
});

test("the memory hint asks the production notice path never to start a stopped agent or interrupt a turn", async () => {
  vi.useFakeTimers();
  const { runtime, inboxes, delivered } = productionRuntime({ memoryBytes: 65537 });
  try {
    await vi.advanceTimersByTimeAsync(3600000);
    assert.equal(delivered.length, 0, "due, but no agent has finished work yet");
    runtime.onAgentWorkingToIdle("owner-a");
    runtime.onAgentWorkingToIdle("owner-b");
    await vi.waitFor(() => assert.equal(delivered.length, 2));
    assert.deepEqual(
      // Each owner's idle presentation awaits its own reads, so the two finish in either order.
      delivered.map(({ owner, item, notice }) => [owner, item.notificationClass, notice])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
      [
        ["owner-a", "memory_size_hint", { startStoppedAgent: false, requireIdle: true }],
        ["owner-b", "memory_size_hint", { startStoppedAgent: false, requireIdle: true }],
      ],
    );
    assert.match(formatAgentInboxAppItems(inboxes.get("owner-a")!.list()), /class=memory_size_hint/);
  } finally {
    runtime.stop();
    vi.useRealTimers();
  }
});

test("an urgent size failure is written into a running turn; other cleaner items never are", async () => {
  const { runtime, delivered } = productionRuntime({ memoryBytes: 1 });
  try {
    runtime.noteMigrationReadiness("owner-a", {
      limits: { maxBytes: 100, maxEntries: 100 },
      lastSizeFailure: {
        migrationId: "mig-1",
        // Within the retry window, so the reminder ends with the retry hint.
        at: new Date().toISOString(),
        code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
        topPaths: [{ path: "datasets", value: 4096 }],
      },
    });
    await vi.waitFor(() => assert.equal(delivered.length, 1));
    assert.deepEqual(
      delivered.map(({ owner, item, notice }) => [owner, item.sourceRef.kind, item.summary, notice]),
      [["owner-a", "backup_ignore_hint", "The last move failed: too large. Largest: datasets. Then run raft migration retry to retry the move once.", { startStoppedAgent: false, requireIdle: false }]],
    );
  } finally {
    runtime.stop();
  }
});

test("at one Working → Idle the idle task reminder goes first and the cleaner presents after it", async () => {
  let answer!: (value: { send: boolean; text?: string; items: [] }) => void;
  const idleTask = {
    ask: () => new Promise<{ send: boolean; text?: string; items: [] }>((resolve) => { answer = resolve; }),
    delivered: [] as string[],
  };
  vi.useFakeTimers();
  const { runtime, delivered } = productionRuntime({ memoryBytes: 65537, idleTask });
  try {
    runtime.setServerIdleTaskReminderCapable(true);
    await vi.advanceTimersByTimeAsync(3600000);
    runtime.onAgentWorkingToIdle("owner-a");
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(delivered.length, 0, "the cleaner waits for the idle task reminder's ask");
    answer({ send: true, text: "tasks", items: [] });
    await vi.waitFor(() => assert.equal(delivered.length, 1));
    assert.deepEqual(idleTask.delivered, ["owner-a:tasks"]);
    assert.equal(delivered[0]!.item.notificationClass, "memory_size_hint");
  } finally {
    runtime.stop();
    vi.useRealTimers();
  }
});

test("a provider quota reading from the daemon's ProviderQuotaState reaches the cleaner", async () => {
  const providerQuota = new ProviderQuotaState({ now: () => Date.now(), recordEvent: () => {} });
  const { runtime, delivered } = productionRuntime({ memoryBytes: 1, providerQuota });
  try {
    // What Claude's rate_limit_event records for the agent (AgentProcessManager.providerQuota.observe).
    providerQuota.observe("owner-a", "claude", { status: "allowed_warning", utilization: 0.95, rateLimitType: "five_hour" });
    // A readiness update makes the cleaner evaluate urgent signals at once.
    runtime.noteMigrationReadiness("owner-a", undefined);
    await vi.waitFor(() => assert.equal(delivered.length, 1));
    assert.deepEqual(
      delivered.map(({ owner, item, notice }) => [owner, item.summary, notice]),
      [["owner-a", "Provider quota nearly used up (95%).", { startStoppedAgent: false, requireIdle: false }]],
    );
  } finally {
    runtime.stop();
  }
});
