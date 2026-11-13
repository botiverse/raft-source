import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  AGENT_INBOX_PREVIEW_MAX_CHARS,
  BasicTracer,
} from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_BOUNDS,
  CLEANER_CONFIG_DEFAULTS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol";
import {
  CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS,
  CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS,
  CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY,
  CLEANER_BACKUP_IGNORE_REMINDER_TITLE,
  CLEANER_BACKUP_IGNORE_URGENT_MIN_SPACING_MS,
  CLEANER_REMINDER_LARGEST_PREFIX,
  CLEANER_REMINDER_STATE_FILE,
  CLEANER_REMINDER_TOP_PATHS_PREFIX,
  CLEANER_WORKSPACE_TIDY_TITLE,
  CLEANER_SIZE_FAILURE_RETRY_HINT,
  createFileReminderStateStore,
  CLEANER_MEMORY_HINT_REWAKE_COOLDOWN_MS,
  CLEANER_MEMORY_HINT_REWAKE_GROWTH_RATIO,
  CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS,
  CLEANER_WORKSPACE_CLEANUP_TIP_SUMMARY,
  CLEANER_WORKSPACE_CLEANUP_TIP_TITLE,
  SystemCleanerRuntime,
  backupIgnoreReminderSummary,
  sizeFailureRetryHint,
  memoryHintTitle,
  workspaceTipSummary,
  type CleanerProviderQuota,
  type CleanerRuntimeOptions,
  type CleanerClock,
  type CleanerConfigEnvelope,
  type CleanerMeasurement,
  type CleanerDiskMeasurement,
} from "./runtime";
import { AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES } from "../../agentMigrationExport";

interface FakeTimer {
  id: number;
  atMs: number;
  fn: () => void;
  active: boolean;
}

class FakeClock implements CleanerClock {
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();
  nowMs = 1_000;

  now(): number {
    return this.nowMs;
  }

  schedule(fn: () => void, ms: number): unknown {
    const timer: FakeTimer = { id: this.nextId++, atMs: this.nowMs + ms, fn, active: true };
    this.timers.set(timer.id, timer);
    return timer.id;
  }

  cancel(timer: unknown): void {
    const found = this.timers.get(timer as number);
    if (found) found.active = false;
  }

  activeIds(): number[] {
    return [...this.timers.values()].filter((timer) => timer.active).map((timer) => timer.id);
  }

  activeCount(): number {
    return this.activeIds().length;
  }

  earliestActiveId(): number {
    const timer = [...this.timers.values()]
      .filter((candidate) => candidate.active)
      .sort((left, right) => left.atMs - right.atMs || left.id - right.id)[0];
    assert.ok(timer, "expected an active timer");
    return timer.id;
  }

  fire(id: number, options?: { evenIfCleared?: boolean }): void {
    const timer = this.timers.get(id);
    assert.ok(timer, `unknown timer ${id}`);
    assert.ok(timer.active || options?.evenIfCleared, `timer ${id} is cleared`);
    timer.active = false;
    this.nowMs = Math.max(this.nowMs, timer.atMs);
    timer.fn();
  }
}

const MIN_THRESHOLD_BYTES = CLEANER_CONFIG_BOUNDS.thresholdBytes.min;
const MAX_THRESHOLD_BYTES = CLEANER_CONFIG_BOUNDS.thresholdBytes.max;
const MIN_INTERVAL_MS = CLEANER_CONFIG_BOUNDS.intervalMs.min;
const MAX_INTERVAL_MS = CLEANER_CONFIG_BOUNDS.intervalMs.max;

function config(overrides?: Partial<CleanerConfigEnvelope>): CleanerConfigEnvelope {
  return {
    appId: CLEANER_APP_ID,
    ownerAgentId: "owner-a",
    enabled: true,
    thresholdBytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes,
    intervalMs: CLEANER_CONFIG_DEFAULTS.intervalMs,
    revision: 1,
    ...overrides,
  };
}

function runtimeFixture(input?: {
  measurement?: CleanerMeasurement | ((ownerAgentId: string) => CleanerMeasurement | Promise<CleanerMeasurement>);
  diskMeasurement?: () => Promise<CleanerDiskMeasurement>;
  onWake?: () => void;
  measurementTimeoutMs?: number;
  trace?: (name: string, attrs: Readonly<Record<string, unknown>>) => void;
  agentsDataDir?: string;
  scanWorkspaceRoot?: CleanerRuntimeOptions["scanWorkspaceRoot"];
  workspaceScanMaxEntries?: number;
  measureWorkspaceDirectories?: CleanerRuntimeOptions["measureWorkspaceDirectories"];
  providerQuota?: () => CleanerProviderQuota | undefined;
  deliveryPending?: () => boolean | undefined;
  /** Default: kept in memory for this fixture only (no files under the fake agents dir). */
  reminderStateStore?: CleanerRuntimeOptions["reminderStateStore"];
  clock?: FakeClock;
}) {
  const clock = input?.clock ?? new FakeClock();
  const memoryStates = new Map<string, unknown>();
  const measurements: Array<{ ownerAgentId: string; literalFileName: string; absolutePath: string }> = [];
  const wakes: Array<{ ownerAgentId: string; itemId: string; interrupt?: boolean }> = [];
  const traces: Array<{ name: string; attrs: Readonly<Record<string, unknown>> }> = [];
  const runtime = new SystemCleanerRuntime({
    agentsDataDir: input?.agentsDataDir ?? "/computer/agents",
    clock,
    measurementTimeoutMs: input?.measurementTimeoutMs,
    scanWorkspaceRoot: input?.scanWorkspaceRoot,
    workspaceScanMaxEntries: input?.workspaceScanMaxEntries,
    measureWorkspaceDirectories: input?.measureWorkspaceDirectories,
    providerQuota: input?.providerQuota,
    deliveryPending: input?.deliveryPending,
    reminderStateStore: input?.reminderStateStore ?? {
      load: (owner) => memoryStates.get(owner) ?? null,
      save: (owner, state) => { memoryStates.set(owner, JSON.parse(JSON.stringify(state))); },
      remove: (owner) => { memoryStates.delete(owner); },
    },
    measureMemoryFile: async (measurementInput) => {
      measurements.push(measurementInput);
      const result = input?.measurement ?? {
        kind: "measured",
        bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2,
      };
      return typeof result === "function" ? result(measurementInput.ownerAgentId) : result;
    },
    measureDiskSpace: input?.diskMeasurement ?? (async () => ({ kind: "measured", availableBytes: 50, totalBytes: 100 })),
    wake: async (ownerAgentId, item, options) => {
      wakes.push({ ownerAgentId, itemId: item.itemId, ...(options?.interrupt ? { interrupt: true } : {}) });
      input?.onWake?.();
    },
    trace: (name, attrs) => {
      traces.push({ name, attrs });
      input?.trace?.(name, attrs);
    },
  });
  return { runtime, clock, measurements, wakes, traces };
}

/** One period, then each owner's next Working → Idle (where due hints present). */
async function firePeriodic(
  fixture: ReturnType<typeof runtimeFixture>,
  timerId?: number,
  options?: { idleTransition?: boolean },
): Promise<void> {
  fixture.clock.fire(timerId ?? fixture.clock.earliestActiveId());
  await fixture.runtime.waitForIdle();
  if (options?.idleTransition === false) return;
  await idleTransition(fixture);
}

async function idleTransition(fixture: ReturnType<typeof runtimeFixture>, owners = ["owner-a", "owner-b"]): Promise<void> {
  for (const owner of owners) fixture.runtime.onAgentWorkingToIdle(owner);
  await fixture.runtime.waitForIdle();
}

const memoryItems = (fixture: ReturnType<typeof runtimeFixture>) =>
  fixture.runtime.inbox.list().filter((item) => item.notificationClass === "memory_size_hint");
const tipItems = (fixture: ReturnType<typeof runtimeFixture>) =>
  fixture.runtime.inbox.list().filter((item) => item.notificationClass === "disk_space_hint");

test("closed Cleaner action is executable only after applied config; payload action injection fails closed", () => {
  const { runtime } = runtimeFixture();
  const beforeConfig = runtime.inbox.mint({
    appId: CLEANER_APP_ID,
    notificationClass: "memory_size_hint",
    sourceRef: { kind: "memory_hint", agentId: "owner-a" },
  });
  assert.equal(beforeConfig.ok, false, "empty/unresolved action must not mint");
  if (!beforeConfig.ok) assert.equal(beforeConfig.code, "invalid_primary_action");

  assert.deepEqual(runtime.applyConfig(config()), { kind: "applied", activeSchedules: 1 });
  const injected = runtime.inbox.mint({
    appId: CLEANER_APP_ID,
    notificationClass: "memory_size_hint",
    sourceRef: { kind: "memory_hint", agentId: "owner-a" },
    requestedPrimaryAction: {
      kind: "run_command",
      commandId: "cleaner.configure",
      shell: "rm -rf /",
    } as never,
  });
  assert.equal(injected.ok, false);
  if (!injected.ok) assert.equal(injected.code, "raw_command_forbidden");

  const minted = runtime.inbox.mint({
    appId: CLEANER_APP_ID,
    notificationClass: "memory_size_hint",
    sourceRef: { kind: "memory_hint", agentId: "owner-a" },
  });
  assert.equal(minted.ok, true);
  if (!minted.ok) return;
  assert.deepEqual(minted.item.primaryAction, { kind: "run_command", commandId: "cleaner.configure" });
  assert.equal(
    minted.item.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2}`,
  );
});

test("periodic check measures only the literal owner's MEMORY.md and mints+wakes one transient item", async () => {
  const fixture = runtimeFixture({
    measurement: (ownerAgentId) => ({
      kind: "measured",
      bytes: ownerAgentId === "owner-a" ? CLEANER_CONFIG_DEFAULTS.thresholdBytes + 1 : 1,
    }),
  });
  fixture.runtime.applyConfig(config());
  fixture.runtime.applyConfig(config({ ownerAgentId: "owner-b" }));
  const ownerATimer = fixture.clock.activeIds()[0]!;

  await firePeriodic(fixture, ownerATimer);

  // Once for the period, once more at the Working → Idle that presents it.
  const ownerAMemory = {
    ownerAgentId: "owner-a",
    literalFileName: "MEMORY.md",
    absolutePath: path.join("/computer/agents", "owner-a", "MEMORY.md"),
  };
  assert.deepEqual(fixture.measurements, [ownerAMemory, ownerAMemory]);
  const items = memoryItems(fixture);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.retention, "transient");
  assert.deepEqual(items[0]!.sourceRef, { kind: "memory_hint", id: "owner-a" });
  assert.equal(
    items[0]!.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2}`,
  );
  assert.match(items[0]!.title ?? "", /64\.0 KiB.*64\.0 KiB/);
  assert.ok((items[0]!.title?.length ?? 0) <= AGENT_INBOX_PREVIEW_MAX_CHARS);
  assert.ok((items[0]!.summary?.length ?? 0) <= AGENT_INBOX_PREVIEW_MAX_CHARS);
  assert.deepEqual(fixture.wakes.map((wake) => wake.ownerAgentId), ["owner-a"]);
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.equal(fixture.runtime.activeScheduleCount("owner-b"), 1);
});

test("a due hint is never presented while the agent is Working; it presents at the next Working → Idle", async () => {
  const fixture = runtimeFixture();
  fixture.runtime.applyConfig(config());

  // Periods pass while the agent works: the hint is due, nothing reaches it.
  await firePeriodic(fixture, undefined, { idleTransition: false });
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.equal(fixture.runtime.inbox.list().length, 0);
  assert.equal(fixture.wakes.length, 0);
  assert.equal(fixture.traces.filter(({ name }) => name === "daemon.cleaner.present").length, 0);
  assert.deepEqual(
    fixture.traces.filter(({ name }) => name === "daemon.cleaner.hint_due").map(({ attrs }) => attrs.wake_reason),
    ["first", "first"],
  );

  await idleTransition(fixture);
  assert.equal(memoryItems(fixture).length, 1);
  assert.equal(fixture.wakes.length, 1, "one wake covers the hint and its workspace tip");
  assert.equal(fixture.wakes[0]!.itemId, memoryItems(fixture)[0]!.itemId);

  // Nothing is due any more: later idle transitions are quiet.
  await idleTransition(fixture);
  assert.equal(fixture.wakes.length, 1);
});

test("an idle transition with nothing due measures nothing", async () => {
  const fixture = runtimeFixture();
  fixture.runtime.applyConfig(config());
  await idleTransition(fixture);
  fixture.runtime.onAgentWorkingToIdle("unknown-owner");
  await fixture.runtime.waitForIdle();
  assert.equal(fixture.measurements.length, 0);
  assert.equal(fixture.runtime.inbox.list().length, 0);
});

test("MEMORY.md trimmed during the turn: the idle transition remeasures and presents nothing", async () => {
  let bytes = CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2;
  const fixture = runtimeFixture({ measurement: () => ({ kind: "measured", bytes }) });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture, undefined, { idleTransition: false });
  bytes = 1;
  await idleTransition(fixture);
  assert.equal(fixture.runtime.inbox.list().length, 0, "neither the hint nor its workspace tip");
  assert.equal(fixture.wakes.length, 0);
  assert.ok(fixture.traces.some(({ name, attrs }) =>
    name === "daemon.cleaner.decision" && attrs.decision === "under_threshold" && attrs.checked_at === "idle_transition"));
});

test("the workspace tip rides with the memory hint as its own item at most once a week per agent", async () => {
  const fixture = runtimeFixture();
  fixture.runtime.applyConfig(config());
  const memoryPresents = () => fixture.traces
    .filter(({ name, attrs }) => name === "daemon.cleaner.present" && attrs.notificationClass === "memory_size_hint");
  const tipPresents = () => fixture.traces
    .filter(({ name, attrs }) => name === "daemon.cleaner.present" && attrs.notificationClass === "disk_space_hint");
  const drops = () => fixture.traces.filter((trace) => trace.name === "daemon.cleaner.drop");

  await firePeriodic(fixture);
  const firstTipAtMs = fixture.clock.now();
  assert.deepEqual(tipItems(fixture).map((item) => [item.title, item.summary]), [
    [CLEANER_WORKSPACE_CLEANUP_TIP_TITLE, CLEANER_WORKSPACE_CLEANUP_TIP_SUMMARY],
  ]);
  assert.match(tipItems(fixture)[0]!.title!, /sure.*owner or creator/);
  assert.match(tipItems(fixture)[0]!.summary!, /new since you last asked.*\.raftbackupignore/);
  assert.doesNotMatch(tipItems(fixture)[0]!.summary!, /raftmigrateignore/);
  assert.doesNotMatch(memoryItems(fixture)[0]!.title!, /workspace/, "the memory hint itself stays about MEMORY.md");
  assert.deepEqual(tipPresents().map(({ attrs }) => attrs.workspace_tip_trigger), ["memory_hint"]);
  assert.deepEqual(memoryPresents().map(({ attrs }) => attrs.workspace_cleanup_tip), [true]);
  assert.ok(fixture.runtime.inbox.ack(tipItems(fixture)[0]!.itemId));

  // The hint itself re-presents at most daily (see the rewake cooldown test).
  fixture.clock.nowMs = firstTipAtMs + CLEANER_MEMORY_HINT_REWAKE_COOLDOWN_MS;
  await firePeriodic(fixture);
  assert.ok(fixture.clock.now() - firstTipAtMs < CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS);
  assert.equal(tipItems(fixture).length, 0, "a repeat within the week omits the tip");
  assert.deepEqual(memoryPresents().map(({ attrs }) => attrs.workspace_cleanup_tip), [true, false]);
  assert.deepEqual(memoryPresents().map(({ attrs }) => attrs.workspace_cleanup_tip_skipped), [undefined, "weekly_cap"]);
  assert.equal(drops().length, 0, "holding back the tip is not a drop; the hint still presented");
  assert.equal(fixture.wakes.length, 2, "the weekly cap holds back only the tip, not the daily hint");

  fixture.clock.nowMs = firstTipAtMs + CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS;
  await firePeriodic(fixture);
  assert.equal(tipItems(fixture).length, 1, "a week later it returns");
  assert.equal(tipPresents().length, 2);
});

test("memory hint and workspace tip previews stay under the inbox cap", () => {
  for (const intervalMs of [MIN_INTERVAL_MS, MAX_INTERVAL_MS, MIN_INTERVAL_MS + 1_001]) {
    for (const thresholdBytes of [MIN_THRESHOLD_BYTES, MAX_THRESHOLD_BYTES]) {
      const title = memoryHintTitle(MAX_THRESHOLD_BYTES * 1024 - 1, thresholdBytes, intervalMs);
      assert.ok(title.length <= AGENT_INBOX_PREVIEW_MAX_CHARS, `${title.length}: ${title}`);
    }
  }
  // Low disk is under 20 GiB free by definition; allow a far larger number anyway.
  const longNames = Array.from({ length: 9 }, (_, index) => `${"x".repeat(60)}-${index}`);
  for (const preview of [
    CLEANER_WORKSPACE_CLEANUP_TIP_TITLE,
    workspaceTipSummary(),
    workspaceTipSummary(1023 * 1024 ** 3),
    CLEANER_BACKUP_IGNORE_REMINDER_TITLE,
    CLEANER_WORKSPACE_TIDY_TITLE,
    CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY,
    backupIgnoreReminderSummary(["Close to the move file-count limit (99%)."], { prefix: CLEANER_REMINDER_LARGEST_PREFIX, items: longNames }).summary,
    backupIgnoreReminderSummary(
      ["The last move failed: too large.", "Disk is low (1023.9 GiB free).", "Provider quota nearly used up (100%)."],
      { prefix: CLEANER_REMINDER_TOP_PATHS_PREFIX, items: longNames.slice(0, 3) },
    ).summary,
    backupIgnoreReminderSummary([], { prefix: CLEANER_REMINDER_LARGEST_PREFIX, items: Array.from({ length: 2_000 }, (_, index) => `dir-${index}/`) }).summary,
    backupIgnoreReminderSummary(
      ["The last move failed: too many files.", "Disk is low (1023.9 GiB free).", "Provider quota nearly used up (100%)."],
      { prefix: CLEANER_REMINDER_TOP_PATHS_PREFIX, items: longNames.slice(0, 3) },
      CLEANER_SIZE_FAILURE_RETRY_HINT,
    ).summary,
  ]) {
    assert.ok(preview.length <= AGENT_INBOX_PREVIEW_MAX_CHARS, `${preview.length}: ${preview}`);
  }
});

test("cleaner events keep their owner agent through the local trace sink's id allowlist", async () => {
  // The sink drops id-shaped keys it does not allowlist; it allows owner_agent_id
  // and item_id, not ownerAgentId/itemId. Without this, prod could count cleaner
  // hints and drops but not say whose they were.
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "cleaner-trace-owner-"));
  try {
    const tracer = new BasicTracer({
      sink: new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 }),
    });
    const outcomes: CleanerMeasurement[] = [
      { kind: "measured", bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes + 1 },
      { kind: "measured", bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes + 1 },
      { kind: "measured", bytes: 1 },
    ];
    const fixture = runtimeFixture({
      measurement: () => outcomes.shift()!,
      trace: (name, attrs) => tracer.emitEvent(name, { surface: "daemon", attrs: attrs as never }),
    });
    fixture.runtime.applyConfig(config());
    await firePeriodic(fixture);
    await firePeriodic(fixture);

    const dir = path.join(machineDir, "traces");
    const written = readdirSync(dir).flatMap((name) => readFileSync(path.join(dir, name), "utf8")
      .split("\n").filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { name: string; attrs?: Record<string, unknown> }));
    const present = written.find((record) => record.name === "daemon.cleaner.present" && record.attrs?.notificationClass === "memory_size_hint");
    const drop = written.find((record) => record.name === "daemon.cleaner.drop" && record.attrs?.reason === "superseded");
    assert.ok(present && drop, "one hint was presented, then dropped once under threshold");
    for (const record of [present, drop]) {
      assert.equal(record.attrs?.owner_agent_id, "owner-a", record.name);
      assert.equal(record.attrs?.app_id, CLEANER_APP_ID, record.name);
      assert.equal(record.attrs?.ownerAgentId, undefined, record.name);
    }
    assert.equal(present.attrs?.item_id, fixture.wakes[0]!.itemId);
    assert.equal(present.attrs?.workspace_cleanup_tip, true, "#8833's tip flag survives the sink too");
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("under-threshold and not-established measurements produce zero current item while rearming", async () => {
  const outcomes: CleanerMeasurement[] = [
    { kind: "measured", bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes + 1 },
    { kind: "measured", bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes + 1 },
    { kind: "measured", bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes },
    { kind: "not_established", reason: "missing" },
  ];
  const fixture = runtimeFixture({ measurement: () => outcomes.shift()! });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture);
  assert.equal(memoryItems(fixture).length, 1);

  await firePeriodic(fixture);
  assert.equal(memoryItems(fixture).length, 0, "under-threshold drops the old current hint");

  await firePeriodic(fixture);
  assert.equal(memoryItems(fixture).length, 0);
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.equal(fixture.wakes.length, 1);
  assert.ok(fixture.traces.some((entry) => entry.name === "daemon.cleaner.measurement" && entry.attrs.reason === "missing"));
});

test("config reseed cancels old period, stale dequeued callback is inert, and next run uses new config", async () => {
  const fixture = runtimeFixture({ measurement: { kind: "measured", bytes: 300_000 } });
  fixture.runtime.applyConfig(config({
    revision: 1,
    thresholdBytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes,
    intervalMs: MIN_INTERVAL_MS,
  }));
  const oldTimer = fixture.clock.activeIds()[0]!;
  fixture.runtime.applyConfig(config({
    revision: 2,
    thresholdBytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2,
    intervalMs: MIN_INTERVAL_MS * 2,
  }));

  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.equal(fixture.clock.activeCount(), 1, "reseed must retire the old schedule");
  fixture.clock.fire(oldTimer, { evenIfCleared: true });
  await fixture.runtime.waitForIdle();
  assert.equal(fixture.measurements.length, 0, "a dequeued retired callback must not measure");
  assert.equal(fixture.clock.activeCount(), 1);

  await firePeriodic(fixture);
  assert.equal(fixture.measurements.length, 2, "the period and the idle transition");
  const item = memoryItems(fixture)[0]!;
  assert.match(item.title ?? "", /128\.0 KiB/);
  assert.equal(
    item.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 4}`,
  );
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
});

test("two owner config revisions leave one current item and obsolete action disappears at apply", async () => {
  const fixture = runtimeFixture({ measurement: { kind: "measured", bytes: 500_000 } });
  fixture.runtime.applyConfig(config({ revision: 1 }));
  await firePeriodic(fixture);
  const first = memoryItems(fixture);
  assert.equal(first.length, 1);
  assert.equal(
    first[0]!.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2}`,
  );

  fixture.runtime.applyConfig(config({
    revision: 2,
    thresholdBytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2,
  }));
  assert.equal(memoryItems(fixture).length, 0, "config apply removes obsolete current action");
  await firePeriodic(fixture);
  const second = memoryItems(fixture);
  assert.equal(second.length, 1);
  assert.deepEqual(second[0]!.sourceRef, { kind: "memory_hint", id: "owner-a" });
  assert.equal(
    second[0]!.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${CLEANER_CONFIG_DEFAULTS.thresholdBytes * 4}`,
  );
});

test("disabled config cancels schedule/item and a previously dequeued callback has zero effects", async () => {
  const fixture = runtimeFixture();
  fixture.runtime.applyConfig(config({ revision: 1 }));
  await firePeriodic(fixture);
  assert.equal(memoryItems(fixture).length, 1);
  const armed = fixture.clock.activeIds()[0]!;

  fixture.runtime.applyConfig(config({ revision: 2, enabled: false }));
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 0);
  assert.equal(memoryItems(fixture).length, 0);
  const measurementCount = fixture.measurements.length;
  fixture.clock.fire(armed, { evenIfCleared: true });
  await fixture.runtime.waitForIdle();
  assert.equal(fixture.measurements.length, measurementCount);
  assert.equal(fixture.wakes.length, 1);
  assert.equal(memoryItems(fixture).length, 0);
});

test("threshold below maximum clamps the action and preview does not claim it doubles", async () => {
  const fixture = runtimeFixture({ measurement: { kind: "measured", bytes: MAX_THRESHOLD_BYTES } });
  fixture.runtime.applyConfig(config({ thresholdBytes: Math.floor(MAX_THRESHOLD_BYTES * 0.75) }));
  await firePeriodic(fixture);
  const item = memoryItems(fixture)[0]!;
  assert.equal(
    item.actionCli,
    `raft app config --app system.cleaner --set threshold_bytes=${MAX_THRESHOLD_BYTES}`,
  );
  assert.match(item.summary ?? "", /raises to maximum/i);
  assert.doesNotMatch(item.summary ?? "", /doubles/i);
});

test("threshold already at maximum offers config view and copy never claims a raise", async () => {
  const fixture = runtimeFixture({ measurement: { kind: "measured", bytes: MAX_THRESHOLD_BYTES + 1 } });
  fixture.runtime.applyConfig(config({ thresholdBytes: MAX_THRESHOLD_BYTES }));
  await firePeriodic(fixture);
  const item = memoryItems(fixture)[0]!;
  assert.equal(item.actionCli, "raft app config --app system.cleaner");
  assert.match(item.summary ?? "", /already at maximum.*set it lower/i);
  assert.doesNotMatch(item.summary ?? "", /raises/i);
  assert.doesNotMatch(item.summary ?? "", /doubles/i);
});

test("restart keeps no old measurement/item, then config snapshot arms exactly one later remeasure", async () => {
  const first = runtimeFixture();
  first.runtime.applyConfig(config());
  await firePeriodic(first);
  assert.equal(memoryItems(first).length, 1);
  first.runtime.clear();
  assert.equal(memoryItems(first).length, 0);
  assert.equal(first.clock.activeCount(), 0);

  const second = runtimeFixture();
  const receipt = second.runtime.replaceSnapshot([config()]);
  assert.deepEqual(receipt, [{ kind: "applied", activeSchedules: 1 }]);
  assert.equal(memoryItems(second).length, 0);
  assert.equal(second.measurements.length, 0, "snapshot/restart does not restore or immediately replay a measurement");
  assert.equal(second.runtime.activeScheduleCount("owner-a"), 1);
  await firePeriodic(second);
  assert.equal(memoryItems(second).length, 1);
});

test("measurement timeout creates no item and the periodic schedule survives", async () => {
  const fixture = runtimeFixture({
    measurement: () => new Promise<CleanerMeasurement>(() => {}),
    measurementTimeoutMs: 50,
  });
  fixture.runtime.applyConfig(config({ intervalMs: MIN_INTERVAL_MS }));
  fixture.clock.fire(fixture.clock.earliestActiveId());
  // runPeriod rearms the canonical minimum period and arms a 50ms deadline.
  await Promise.resolve();
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await fixture.runtime.waitForIdle();
  assert.equal(memoryItems(fixture).length, 0);
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.ok(fixture.traces.some((entry) => entry.name === "daemon.cleaner.measurement" && entry.attrs.reason === "timeout"));
});

test("invalid snapshot is atomic and owner ids cannot escape the agents root", () => {
  const fixture = runtimeFixture();
  fixture.runtime.applyConfig(config());
  const before = fixture.clock.activeIds();
  const result = fixture.runtime.replaceSnapshot([
    config({ ownerAgentId: "owner-b" }),
    config({ ownerAgentId: "../escape", revision: 2 }),
  ]);
  assert.deepEqual(result, { kind: "invalid", reason: "owner_agent_id_invalid" });
  assert.deepEqual(fixture.runtime.getAppliedConfig("owner-a"), config());
  assert.deepEqual(fixture.clock.activeIds(), before);
});

test("all four canonical schema bounds fail closed before scheduling", () => {
  const fixture = runtimeFixture();
  const cases: Array<[Partial<CleanerConfigEnvelope>, string]> = [
    [{ thresholdBytes: MIN_THRESHOLD_BYTES - 1 }, "threshold_bytes_invalid"],
    [{ thresholdBytes: MAX_THRESHOLD_BYTES + 1 }, "threshold_bytes_invalid"],
    [{ intervalMs: MIN_INTERVAL_MS - 1 }, "interval_ms_invalid"],
    [{ intervalMs: MAX_INTERVAL_MS + 1 }, "interval_ms_invalid"],
  ];
  for (const [override, reason] of cases) {
    assert.deepEqual(fixture.runtime.applyConfig(config(override)), { kind: "invalid", reason });
  }
  assert.equal(fixture.clock.activeCount(), 0);
  assert.equal(memoryItems(fixture).length, 0);
});


test("low disk space adds one workspace tip per low-disk episode, never a disk warning, only at Working → Idle", async () => {
  let availableBytes = 9;
  const fixture = runtimeFixture({
    measurement: { kind: "measured", bytes: 1 },
    diskMeasurement: async () => ({ kind: "measured", availableBytes, totalBytes: 100 }),
  });
  fixture.runtime.applyConfig(config());
  const diskDecisions = () => fixture.traces
    .filter(({ name, attrs }) => name === "daemon.cleaner.decision" && attrs.notificationClass === "disk_space_hint")
    .map(({ attrs }) => attrs.workspace_tip_due);
  const tipTriggers = () => fixture.traces
    .filter(({ name, attrs }) => name === "daemon.cleaner.present" && attrs.notificationClass === "disk_space_hint")
    .map(({ attrs }) => attrs.workspace_tip_trigger);

  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.deepEqual(diskDecisions(), [true]);
  assert.equal(fixture.runtime.inbox.list().length, 0, "nothing while the agent works");
  await idleTransition(fixture);
  assert.deepEqual(tipItems(fixture).map((item) => item.summary), [workspaceTipSummary(9)]);
  assert.match(tipItems(fixture)[0]!.summary!, /^Disk is low \(9 B free\)\. /);
  assert.deepEqual(tipTriggers(), ["disk_low"]);
  assert.equal(fixture.wakes.length, 1);
  assert.ok(fixture.runtime.inbox.ack(tipItems(fixture)[0]!.itemId));

  // Lower, though not critically low (that is the urgent reminder's): same episode.
  availableBytes = 6;
  await firePeriodic(fixture);
  assert.deepEqual(diskDecisions(), [true, false], "same episode: no second tip");
  availableBytes = 10;
  await firePeriodic(fixture);
  assert.deepEqual(diskDecisions(), [true, false], "10% free is not low; the episode ends");
  availableBytes = 9;
  await firePeriodic(fixture);
  assert.deepEqual(diskDecisions(), [true, false, false], "a new episode within the week does not tip again");
  assert.equal(fixture.wakes.length, 1);

  availableBytes = 10;
  await firePeriodic(fixture);
  fixture.clock.nowMs += CLEANER_WORKSPACE_CLEANUP_TIP_MIN_INTERVAL_MS;
  availableBytes = 9;
  await firePeriodic(fixture);
  assert.deepEqual(diskDecisions(), [true, false, false, true]);
  assert.deepEqual(tipTriggers(), ["disk_low", "disk_low"]);
  assert.equal(fixture.wakes.length, 2);
  assert.equal(memoryItems(fixture).length, 0, "MEMORY.md under threshold never gets a memory hint");
});

test("a disk episode that ends before the agent goes idle tips nothing", async () => {
  let availableBytes = 9;
  const fixture = runtimeFixture({
    measurement: { kind: "measured", bytes: 1 },
    diskMeasurement: async () => ({ kind: "measured", availableBytes, totalBytes: 100 }),
  });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture, undefined, { idleTransition: false });
  availableBytes = 50;
  await firePeriodic(fixture);
  assert.equal(fixture.runtime.inbox.list().length, 0);
  assert.equal(fixture.wakes.length, 0);
});

test("missing memory produces no memory hint and an unreadable disk adds nothing", async () => {
  let disk: CleanerDiskMeasurement = { kind: "measured", availableBytes: 8, totalBytes: 100 };
  const fixture = runtimeFixture({
    measurement: { kind: "not_established", reason: "missing" },
    diskMeasurement: async () => disk,
  });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture);
  assert.ok(fixture.traces.some(({ name, attrs }) => name === "daemon.cleaner.decision" && attrs.decision === "disk_low"));
  disk = { kind: "not_established", reason: "read_failed" };
  await firePeriodic(fixture);
  assert.ok(fixture.traces.some(({ name, attrs }) =>
    name === "daemon.cleaner.measurement" && attrs.notificationClass === "disk_space_hint" && attrs.established === false));
  assert.equal(memoryItems(fixture).length, 0);
  assert.equal(tipItems(fixture).length, 1, "only the first period's low-disk workspace tip");
  assert.equal(fixture.wakes.length, 1);
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
});

test("an unchanged memory hint wakes once per day; marked growth or clearing the threshold resets that", async () => {
  const threshold = CLEANER_CONFIG_DEFAULTS.thresholdBytes;
  let bytes = threshold * 2;
  const fixture = runtimeFixture({ measurement: () => ({ kind: "measured", bytes }) });
  fixture.runtime.applyConfig(config());
  const wakeReasons = () => fixture.traces
    .filter(({ name, attrs }) => name === "daemon.cleaner.present" && attrs.notificationClass !== "disk_space_hint")
    .map(({ attrs }) => attrs.wake_reason);
  const cooldownDrops = () => fixture.traces
    .filter(({ name, attrs }) => name === "daemon.cleaner.drop" && attrs.reason === "rewake_cooldown").length;

  await firePeriodic(fixture);
  const firstAtMs = fixture.clock.now();
  assert.deepEqual(wakeReasons(), ["first"]);
  const itemId = memoryItems(fixture)[0]!.itemId;

  // The agent reads the hint (ack) but MEMORY.md stays the same size.
  assert.ok(fixture.runtime.inbox.ack(itemId));
  await firePeriodic(fixture);
  await firePeriodic(fixture);
  assert.deepEqual(wakeReasons(), ["first"], "hourly checks within a day neither re-present nor wake");
  assert.equal(cooldownDrops(), 2);
  assert.equal(memoryItems(fixture).length, 0, "an acknowledged hint is not re-minted during the cooldown");
  assert.equal(fixture.wakes.length, 1);

  bytes = Math.ceil(threshold * 2 * CLEANER_MEMORY_HINT_REWAKE_GROWTH_RATIO);
  await firePeriodic(fixture);
  assert.deepEqual(wakeReasons(), ["first", "grew"]);
  assert.equal(fixture.wakes.length, 2);

  fixture.clock.nowMs = firstAtMs + 2 * CLEANER_MEMORY_HINT_REWAKE_COOLDOWN_MS;
  await firePeriodic(fixture);
  assert.deepEqual(wakeReasons(), ["first", "grew", "cooldown_elapsed"]);

  bytes = 1;
  await firePeriodic(fixture);
  bytes = threshold * 2;
  await firePeriodic(fixture);
  assert.deepEqual(wakeReasons(), ["first", "grew", "cooldown_elapsed", "first"], "dropping under the threshold resets the cooldown");
  assert.equal(fixture.wakes.length, 4);
});

test("disk measurement finishing after owner removal cannot publish into a replacement config", async () => {
  let finish!: (measurement: CleanerDiskMeasurement) => void;
  const fixture = runtimeFixture({
    measurement: { kind: "measured", bytes: 1 },
    diskMeasurement: () => new Promise((resolve) => { finish = resolve; }),
  });
  fixture.runtime.applyConfig(config());
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await Promise.resolve();
  fixture.runtime.replaceOwnerSnapshot("owner-a", null);
  fixture.runtime.applyConfig(config());
  finish({ kind: "measured", availableBytes: 0, totalBytes: 100 });
  await fixture.runtime.waitForIdle();
  assert.equal(memoryItems(fixture).length, 0);
  assert.equal(fixture.wakes.length, 0);
});

test("disk timeout does not block a memory hint and checks retry next period", async () => {
  let observedWake!: () => void;
  const wakeObserved = new Promise<void>((resolve) => { observedWake = resolve; });
  const fixture = runtimeFixture({
    diskMeasurement: () => new Promise(() => {}),
    measurementTimeoutMs: 50,
    onWake: observedWake,
  });
  fixture.runtime.applyConfig(config());
  fixture.clock.fire(fixture.clock.earliestActiveId());
  // The memory check finishes while the disk check is still pending.
  await new Promise((resolve) => setImmediate(resolve));
  fixture.runtime.onAgentWorkingToIdle("owner-a");
  await wakeObserved;
  assert.deepEqual(memoryItems(fixture).map((item) => item.notificationClass), ["memory_size_hint"]);
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await fixture.runtime.waitForIdle();
  assert.equal(fixture.runtime.activeScheduleCount("owner-a"), 1);
  assert.ok(fixture.traces.some(({ attrs }) => attrs.notificationClass === "disk_space_hint" && attrs.reason === "timeout"));
});

test("a large disk with 20 GiB or more free is not low even under 10%", async () => {
  const GIB = 1024 ** 3;
  const fixture = runtimeFixture({
    measurement: { kind: "measured", bytes: 1 },
    diskMeasurement: async () => ({ kind: "measured", availableBytes: 100 * GIB, totalBytes: 2048 * GIB }),
  });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture);
  assert.ok(!fixture.traces.some(({ name, attrs }) => name === "daemon.cleaner.decision" && attrs.decision === "disk_low"));
});

const reminderItems = (fixture: ReturnType<typeof runtimeFixture>) =>
  fixture.runtime.inbox.list().filter((item) => item.sourceRef.kind === "backup_ignore_hint");
const reminderTraces = (fixture: ReturnType<typeof runtimeFixture>) =>
  fixture.traces.filter(({ name }) => name === "daemon.cleaner.backup_ignore.reminder").map(({ attrs }) => attrs);
const followUpTraces = (fixture: ReturnType<typeof runtimeFixture>) =>
  fixture.traces.filter(({ name }) => name === "daemon.cleaner.backup_ignore.followup").map(({ attrs }) => attrs);
const skipReasons = (fixture: ReturnType<typeof runtimeFixture>) =>
  fixture.traces.filter(({ name }) => name === "daemon.cleaner.backup_ignore.skipped").map(({ attrs }) => attrs.reason);
const tiersAndTriggers = (fixture: ReturnType<typeof runtimeFixture>) =>
  reminderTraces(fixture).map((attrs) => `${String(attrs.tier)}:${String(attrs.trigger)}`);
const lastSummary = (fixture: ReturnType<typeof runtimeFixture>) => reminderItems(fixture).at(-1)?.summary;

/** An agents root with owner-a's workspace. */
async function withWorkspace(
  run: (input: { root: string; workspace: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cleaner-backup-ignore-"));
  try {
    const workspace = path.join(root, "owner-a");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n");
    await run({ root, workspace });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** MEMORY.md under threshold, so only the reminder (and the disk tip) present. */
const smallMemory: CleanerMeasurement = { kind: "measured", bytes: 1 };
const HOUR = 60 * 60 * 1_000;

function readiness(input: { bytes?: number; files?: number; failureId?: string; failureAt?: string; topPaths?: string[] }) {
  return {
    limits: { maxBytes: 1_000, maxEntries: 1_000 },
    lastMeasured: { files: input.files ?? 0, bytes: input.bytes ?? 0, at: "2026-11-10T00:00:00Z", source: "packed" as const },
    ...(input.failureId
      ? {
          lastSizeFailure: {
            migrationId: input.failureId,
            at: input.failureAt ?? "2026-11-10T10:00:00Z",
            code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE" as const,
            topPaths: (input.topPaths ?? []).map((entry, index) => ({ path: entry, value: 1_000 - index })),
          },
        }
      : {}),
  };
}

/** Top-level folders of the workspace, each holding one file of that many bytes. */
async function makeFolders(workspace: string, sizes: Readonly<Record<string, number>>): Promise<void> {
  for (const [dir, bytes] of Object.entries(sizes)) {
    await mkdir(path.join(workspace, dir), { recursive: true });
    await writeFile(path.join(workspace, dir, "file.bin"), "x".repeat(bytes));
  }
}

async function idleA(fixture: ReturnType<typeof runtimeFixture>, advanceMs = 0): Promise<void> {
  fixture.clock.nowMs += advanceMs;
  await idleTransition(fixture, ["owner-a"]);
}

test("the old workspace tip text names .raftbackupignore, not .raftmigrateignore", () => {
  assert.doesNotMatch(CLEANER_WORKSPACE_CLEANUP_TIP_SUMMARY, /raftmigrateignore/);
  assert.match(CLEANER_WORKSPACE_CLEANUP_TIP_SUMMARY, /\.raftbackupignore/);
  assert.doesNotMatch(workspaceTipSummary(9), /raftmigrateignore/);
  assert.match(CLEANER_BACKUP_IGNORE_REMINDER_TITLE, /\.raftbackupignore/);
});

test("baseline: the first idle reminds without naming a folder; none again before 12 h; a light one after", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    for (const dir of ["node_modules", "notes", ".raft"]) await mkdir(path.join(workspace, dir));
    await makeFolders(workspace, { data: 4_096 });

    await idleA(fixture);
    assert.deepEqual(reminderItems(fixture).map((item) => [item.title, item.summary]), [
      [CLEANER_BACKUP_IGNORE_REMINDER_TITLE, CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY],
    ], "far from every limit, a name would not say whether the folder is regenerable: none is given");
    assert.match(reminderItems(fixture)[0]!.actionCli, /raft manual get agent .*migratable/);
    assert.equal(fixture.wakes.length, 1);
    assert.equal(fixture.wakes[0]!.interrupt, undefined, "idle tiers never interrupt");
    assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first"]);
    assert.equal(reminderTraces(fixture)[0]!.names_source, "none");
    assert.equal(reminderTraces(fixture)[0]!.candidate_count, undefined, "the folders are not measured");
    assert.equal(reminderTraces(fixture)[0]!.named_count, 0);

    // Hours of work with nothing new: no reminder before 12 h.
    await idleA(fixture, 60_000);
    assert.equal(followUpTraces(fixture)[0]!.outcome, "unchanged");
    assert.equal(followUpTraces(fixture)[0]!.elapsed_ms, 60_000);
    for (let step = 1; step < 3; step += 1) await idleA(fixture, 5 * HOUR);
    assert.equal(reminderTraces(fixture).length, 1);

    fixture.clock.nowMs = 1_000 + CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS;
    await idleA(fixture);
    assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first", "baseline:rhythm"]);
    assert.equal(lastSummary(fixture), CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY);
  });
});

test("early: a new top-level folder brings no reminder; a new signal does, at least 2h apart, and the same signal never repeats", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    await idleA(fixture);
    assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first"]);
    assert.equal(lastSummary(fixture), CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY);

    // A folder that appeared is no reason for a reminder, however long the agent works.
    await makeFolders(workspace, { models: 4_096 });
    for (let step = 0; step < 4; step += 1) await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.equal(reminderTraces(fixture).length, 1);
    assert.deepEqual(skipReasons(fixture), [], "and nothing is read or traced for it");

    // A new signal is held under 2h after the last reminder.
    await idleA(fixture, CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS - 4 * CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first", "baseline:rhythm"]);
    fixture.runtime.noteProviderLimitHit("owner-a");
    await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS - 1);
    assert.equal(reminderTraces(fixture).length, 2, "under 2h: held");
    await idleA(fixture, 1);
    assert.deepEqual(tiersAndTriggers(fixture).slice(2), ["early:provider_limit"]);
    assert.equal(lastSummary(fixture), "A provider usage limit was hit recently.", "size is not the reason: no folder is named");

    // A different new signal under 2h later waits; past 2h it presents.
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 550 }));
    await idleA(fixture, HOUR);
    assert.equal(reminderTraces(fixture).length, 3);
    await idleA(fixture, HOUR);
    assert.deepEqual(tiersAndTriggers(fixture).slice(3), ["early:readiness_band"]);
    assert.equal(lastSummary(fixture), "Over half the move size limit (55%). Largest folders that still move: models/.");

    // Nothing new: no repeat, however long the day.
    for (let step = 0; step < 4; step += 1) await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.equal(reminderTraces(fixture).length, 4);
  });
});

test("early: entering a readiness band names it; absent readiness changes nothing", async () => {
  await withWorkspace(async ({ root }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    fixture.runtime.noteMigrationReadiness("owner-a", undefined);
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 400 }));
    await idleA(fixture);
    assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first"]);
    assert.equal(reminderTraces(fixture)[0]!.readiness_band, 0);

    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 550 }));
    await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.deepEqual(tiersAndTriggers(fixture).slice(1), ["early:readiness_band"]);
    assert.equal(lastSummary(fixture), "Over half the move size limit (55%).");

    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 100, files: 820 }));
    await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.equal(lastSummary(fixture), "Close to the move file-count limit (82%).");
    assert.equal(reminderTraces(fixture)[2]!.readiness_band, 2);

    await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.equal(reminderTraces(fixture).length, 3, "the same band does not repeat");
    assert.equal(fixture.wakes.filter((wake) => wake.interrupt).length, 0, "bands never interrupt");
  });
});

test("urgent: a size failure reaches a working agent mid-turn once, naming the largest paths", async () => {
  await withWorkspace(async ({ root }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    await idleA(fixture);
    assert.equal(fixture.wakes.length, 1);

    // The agent is working: no Working → Idle edge, only the readiness update.
    const failed = readiness({ bytes: 1_200, failureId: "mig-1", topPaths: ["datasets", "repo/.git", "out\u0007put", "fourth"] });
    fixture.clock.nowMs += 60_000;
    fixture.runtime.noteMigrationReadiness("owner-a", failed);
    await fixture.runtime.waitForIdle();
    assert.equal(fixture.wakes.length, 2);
    assert.equal(fixture.wakes[1]!.interrupt, true, "presented into the running turn");
    assert.deepEqual(tiersAndTriggers(fixture).slice(1), ["urgent:size_failure"]);
    // The retry hint keeps its room in the preview: the readiness reason and the third name give way, with no count of what was left out.
    assert.equal(lastSummary(fixture), "The last move failed: too large. Largest: datasets, repo/.git. Then run raft migration retry to retry the move once.");
    assert.equal(reminderTraces(fixture)[1]!.names_source, "top_paths");
    assert.equal(reminderTraces(fixture)[1]!.named_count, 2);
    assert.equal(reminderTraces(fixture)[1]!.retry_hint, true);
    assert.equal(reminderTraces(fixture)[1]!.top_path_count, 3);
    assert.doesNotMatch(JSON.stringify(fixture.traces), /datasets|repo\/\.git/, "no paths in traces");

    assert.doesNotMatch(lastSummary(fixture)!, /1000|999|998/, "paths only, never their sizes or counts");

    // The same failure again (a later config push, the next tick, even a rewritten
    // `at`): keyed on its migrationId, never again.
    fixture.runtime.noteMigrationReadiness("owner-a", failed);
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 1_200, failureId: "mig-1", failureAt: "2026-11-10T11:00:00Z", topPaths: ["datasets"] }));
    await firePeriodic(fixture, undefined, { idleTransition: false });
    await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.equal(reminderTraces(fixture).length, 2);

    // A non-urgent signal arriving mid-turn does not interrupt; it waits for the idle.
    fixture.runtime.noteMigrationReadiness("owner-a", { ...readiness({ bytes: 1_200 }), lastSizeFailure: failed.lastSizeFailure });
    fixture.runtime.noteProviderLimitHit("owner-a");
    await fixture.runtime.waitForIdle();
    assert.equal(fixture.wakes.filter((wake) => wake.interrupt).length, 1);
  });
});

test("urgent: critically low disk interrupts once at the periodic tick; merely low waits for the idle", async () => {
  let disk = { availableBytes: 9, totalBytes: 100 };
  const fixture = runtimeFixture({
    measurement: smallMemory,
    diskMeasurement: async () => ({ kind: "measured", ...disk }),
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: [] }),
  });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.equal(reminderTraces(fixture).length, 0, "low, not critical: nothing mid-turn");

  disk = { availableBytes: 4, totalBytes: 100 };
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.deepEqual(tiersAndTriggers(fixture), ["urgent:disk_low"]);
  assert.equal(fixture.wakes.at(-1)!.interrupt, true);
  assert.equal(lastSummary(fixture), "Disk is low (4 B free).");
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.equal(reminderTraces(fixture).length, 1, "once per critical episode");
});

test("the workspace tip and the reminder due at one transition are one item", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({
      agentsDataDir: root,
      measurement: smallMemory,
      diskMeasurement: async () => ({ kind: "measured", availableBytes: 9, totalBytes: 100 }),
    });
    fixture.runtime.applyConfig(config());
    await makeFolders(workspace, { data: 4_096 });
    await firePeriodic(fixture);
    const items = fixture.runtime.inbox.list();
    assert.deepEqual(items.map((item) => [item.sourceRef.kind, item.title, item.summary]), [
      ["backup_ignore_hint", CLEANER_WORKSPACE_TIDY_TITLE, "Disk is low (9 B free). Largest folders that still move: data/."],
    ]);
    assert.equal(fixture.wakes.length, 1);
    assert.equal(reminderTraces(fixture)[0]!.merged_with_tip, true);
    assert.ok(fixture.traces.some(({ name, attrs }) =>
      name === "daemon.cleaner.present" && attrs.workspace_tip_trigger === "disk_low" && attrs.merged_with_backup_ignore_reminder === true));
  });
});

test("low disk that only the merged workspace tip says still names the largest folders", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const states = new Map<string, unknown>();
    const make = (clock?: FakeClock) => runtimeFixture({
      agentsDataDir: root,
      measurement: smallMemory,
      diskMeasurement: async () => ({ kind: "measured", availableBytes: 9, totalBytes: 100 }),
      reminderStateStore: {
        load: (owner) => states.get(owner) ?? null,
        save: (owner, state) => { states.set(owner, JSON.parse(JSON.stringify(state))); },
        remove: (owner) => { states.delete(owner); },
      },
      clock,
    });
    await makeFolders(workspace, { data: 4_096 });
    const first = make();
    first.runtime.applyConfig(config());
    await firePeriodic(first);
    assert.deepEqual(tiersAndTriggers(first), ["baseline:first"]);
    first.runtime.clear();

    // After a restart the low disk is remembered (no new signal), while the
    // workspace tip, kept per process, is due again with the plain baseline.
    const clock = new FakeClock();
    clock.nowMs = first.clock.nowMs + CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS;
    const second = make(clock);
    second.runtime.applyConfig(config());
    await firePeriodic(second);
    assert.deepEqual(tiersAndTriggers(second), ["baseline:rhythm"]);
    assert.equal(reminderTraces(second)[0]!.signal_count, 0);
    assert.deepEqual(reminderItems(second).map((item) => [item.title, item.summary]), [
      [CLEANER_WORKSPACE_TIDY_TITLE, "Disk is low (9 B free). Largest folders that still move: data/."],
    ]);
  });
});

test("a plain baseline is skipped when the agent updated .raftbackupignore since; an early signal is not", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    await idleA(fixture);
    await writeFile(path.join(workspace, ".raftbackupignore"), "cache/\n");

    // The baseline after 12h finds the file updated and nothing new: skipped, counted as a reminder.
    await idleA(fixture, CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS);
    assert.equal(reminderTraces(fixture).length, 1);
    assert.deepEqual(skipReasons(fixture), ["ignore_file_updated"]);
    await idleA(fixture, HOUR);
    assert.equal(reminderTraces(fixture).length, 1, "the next baseline counts from the update");

    // The agent edits the file again, then crosses 0.8: the early reminder still goes out.
    await writeFile(path.join(workspace, ".raftbackupignore"), "cache/\nmodels/\n");
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 850 }));
    await idleA(fixture, HOUR);
    assert.deepEqual(tiersAndTriggers(fixture).slice(1), ["early:readiness_band"]);
    assert.equal(lastSummary(fixture), "Close to the move size limit (85%).");
  });
});

test("provider quota: warning and exhausted wait for the idle; near exhaustion interrupts once", async () => {
  let quota: CleanerProviderQuota | undefined;
  const fixture = runtimeFixture({
    measurement: smallMemory,
    providerQuota: () => quota,
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: [] }),
  });
  fixture.runtime.applyConfig(config());
  await idleA(fixture);
  assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first"]);

  quota = { state: "warning", utilization: 0.7 };
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.equal(reminderTraces(fixture).length, 1, "a warning never interrupts");
  await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
  assert.equal(lastSummary(fixture), "Provider quota is running low (70%).");

  quota = { state: "near_exhausted", utilization: 0.96 };
  fixture.clock.nowMs += CLEANER_BACKUP_IGNORE_URGENT_MIN_SPACING_MS;
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.deepEqual(tiersAndTriggers(fixture).slice(2), ["urgent:provider_quota"]);
  assert.equal(fixture.wakes.at(-1)!.interrupt, true);
  assert.equal(lastSummary(fixture), "Provider quota nearly used up (96%).");
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.equal(reminderTraces(fixture).length, 3);

  quota = { state: "exhausted" };
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.equal(reminderTraces(fixture).length, 3, "exhausted waits for the idle");
  await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
  assert.deepEqual(tiersAndTriggers(fixture).slice(3), ["early:provider_quota"]);
  assert.equal(lastSummary(fixture), "Provider quota is used up.");
});

test("a reminder waits while another delivery is queued for the agent", async () => {
  let pending: boolean | undefined = true;
  const fixture = runtimeFixture({
    measurement: smallMemory,
    deliveryPending: () => pending,
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: ["data"] }),
  });
  fixture.runtime.applyConfig(config());
  await idleA(fixture);
  assert.equal(reminderTraces(fixture).length, 0);
  assert.deepEqual(skipReasons(fixture), ["delivery_pending"]);
  pending = undefined;
  await idleA(fixture);
  assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first"]);
});

test("size is the reason: the three largest folders that still move are named, largest first, never a skipped or kept one", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
    await writeFile(path.join(workspace, ".raftbackupignore"), "data/\n**/models\n# keep\n# keep: ./drafts/\n");
    await writeFile(path.join(workspace, ".raftmigrateignore"), "legacy\n");
    await makeFolders(workspace, {
      // Left out of a move, or kept: the largest of all, and never named.
      data: 9_000, models: 8_000, legacy: 7_000, node_modules: 6_000, drafts: 5_000,
      checkouts: 4_000, archive: 2_000, scratch: 300, pics: 10, tmpx: 1,
      // What a move leaves out below the top level does not count either.
      "pics/node_modules": 50_000,
    });
    await mkdir(path.join(workspace, "hollow"));

    await idleA(fixture);
    assert.deepEqual(reminderItems(fixture).map((item) => item.summary), [
      "Over half the move size limit (60%). Largest folders that still move: checkouts/, archive/, scratch/.",
    ], "three at most, and no count of the rest");
    const trace = reminderTraces(fixture)[0]!;
    assert.equal(trace.names_source, "largest");
    assert.equal(trace.scan_outcome, "established");
    assert.equal(trace.candidate_count, 6);
    assert.equal(trace.measure_outcome, "complete");
    assert.equal(trace.ranked_by, "bytes");
    assert.equal(trace.named_count, 3);
    assert.equal(trace.ignore_file_present, true);
    assert.doesNotMatch(JSON.stringify(fixture.traces), /checkouts|archive|scratch/, "traces carry counts, never names");
    assert.doesNotMatch(lastSummary(fixture)!, /4000|2000|300/, "names only, never sizes");
  });
});

test("folders rank by what was counted: an unfinished walk does not outrank a finished larger folder, and nothing counted is never named", async () => {
  const GIB = 1024 ** 3;
  const measuredFolders: string[][] = [];
  const fixture = runtimeFixture({
    measurement: smallMemory,
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: ["models", "repo-a", "repo-b", "repo-c", "unread"] }),
    measureWorkspaceDirectories: async ({ directoryNames }) => {
      measuredFolders.push([...directoryNames]);
      return [
        // 40 GiB in 20 files, finished; three repositories cut off half-counted.
        { name: "models", bytes: 40 * GIB, entries: 20, complete: true },
        { name: "repo-a", bytes: 300_000, entries: 60_000, complete: false },
        { name: "repo-b", bytes: 200_000, entries: 70_000, complete: false },
        { name: "repo-c", bytes: 100_000, entries: 65_000, complete: false },
        { name: "unread", bytes: 0, entries: 0, complete: false },
      ];
    },
  });
  fixture.runtime.applyConfig(config());
  fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
  await idleA(fixture);
  assert.deepEqual(measuredFolders, [["models", "repo-a", "repo-b", "repo-c", "unread"]]);
  assert.equal(lastSummary(fixture), "Over half the move size limit (60%). Largest folders that still move: models/, repo-a/, repo-b/.");
  assert.equal(reminderTraces(fixture)[0]!.measure_outcome, "partial");
  assert.equal(reminderTraces(fixture)[0]!.ranked_by, "bytes");
});

test("when the file count is the reason the folders rank by their entries, not their bytes", async () => {
  const fixture = runtimeFixture({
    measurement: smallMemory,
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: ["models", "repo", "notes-site"] }),
    measureWorkspaceDirectories: async () => [
      { name: "models", bytes: 9_000_000, entries: 20, complete: true },
      { name: "repo", bytes: 5_000, entries: 70_000, complete: true },
      { name: "notes-site", bytes: 100, entries: 900, complete: true },
    ],
  });
  fixture.runtime.applyConfig(config());
  // Nearer the file-count limit (60%) than the size limit (10%).
  fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 100, files: 600 }));
  await idleA(fixture);
  assert.equal(lastSummary(fixture), "Over half the move file-count limit (60%). Largest folders that still move: repo/, notes-site/, models/.");
  assert.equal(reminderTraces(fixture)[0]!.ranked_by, "entries");

  // A new failure for too many files that reported no paths: by entries too, though the last
  // measurement is nearer the size limit. (Past its retry window, so the summary has room for the names.)
  const failed = readiness({ bytes: 100, files: 100, failureId: "mig-1", failureAt: "1969-12-30T00:00:00Z" });
  fixture.clock.nowMs += 60_000;
  fixture.runtime.noteMigrationReadiness("owner-a", {
    ...failed,
    lastSizeFailure: { ...failed.lastSizeFailure!, code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED" },
  });
  await fixture.runtime.waitForIdle();
  assert.deepEqual(tiersAndTriggers(fixture).slice(1), ["urgent:size_failure"]);
  assert.equal(lastSummary(fixture), "The last move failed: too many files. Largest folders that still move: repo/, notes-site/, models/.");
  assert.equal(reminderTraces(fixture)[1]!.ranked_by, "entries");
});

test("the measurement is told to stop at its time budget, and what it counted by then is used", async () => {
  let stopRequested: (() => boolean) | null = null;
  let finish: ((sizes: Array<{ name: string; bytes: number; entries: number; complete: boolean }>) => void) | null = null;
  const fixture = runtimeFixture({
    measurement: smallMemory,
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: ["a", "b"] }),
    measureWorkspaceDirectories: ({ shouldStop }) => {
      stopRequested = shouldStop;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  fixture.runtime.applyConfig(config());
  fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
  await fixture.runtime.waitForIdle();

  fixture.runtime.onAgentWorkingToIdle("owner-a");
  await vi.waitFor(() => assert.ok(stopRequested));
  assert.equal(stopRequested!(), false);
  fixture.clock.fire(fixture.clock.earliestActiveId());
  assert.equal(stopRequested!(), true, "told to stop at the budget");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reminderTraces(fixture).length, 0, "the reminder waits for what was counted");
  finish!([{ name: "a", bytes: 5, entries: 1, complete: false }, { name: "b", bytes: 0, entries: 0, complete: false }]);
  await fixture.runtime.waitForIdle();
  assert.equal(lastSummary(fixture), "Over half the move size limit (60%). Largest folders that still move: a/.", "b was not reached: nothing is known about it");
  assert.equal(reminderTraces(fixture)[0]!.measure_outcome, "partial");
});

test("a measurement that never returns is cut off shortly after its budget: the reminder goes out without names", async () => {
  let started = false;
  const fixture = runtimeFixture({
    measurement: smallMemory,
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: ["a", "b"] }),
    measureWorkspaceDirectories: () => {
      started = true;
      return new Promise(() => {});
    },
  });
  fixture.runtime.applyConfig(config());
  fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
  await fixture.runtime.waitForIdle();

  fixture.runtime.onAgentWorkingToIdle("owner-a");
  await vi.waitFor(() => assert.ok(started));
  // The budget, then the cut-off.
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reminderTraces(fixture).length, 0);
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await fixture.runtime.waitForIdle();
  assert.equal(lastSummary(fixture), "Over half the move size limit (60%).");
  assert.equal(reminderTraces(fixture)[0]!.measure_outcome, "timeout");
  assert.equal(reminderTraces(fixture)[0]!.candidate_count, 2);
  assert.equal(reminderTraces(fixture)[0]!.named_count, 0);
});

test("the Server's largest paths of a new size failure are named without measuring; later the folders measured here are", async () => {
  let measurements = 0;
  const fixture = runtimeFixture({
    measurement: smallMemory,
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: ["work"] }),
    measureWorkspaceDirectories: async () => {
      measurements += 1;
      return [{ name: "work", bytes: 5, entries: 1, complete: true }];
    },
  });
  fixture.runtime.applyConfig(config());
  fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 1_200, failureId: "mig-1", topPaths: ["datasets"] }));
  await fixture.runtime.waitForIdle();
  assert.equal(lastSummary(fixture), "The last move failed: too large. Largest: datasets. Then run raft migration retry to retry the move once.");
  assert.equal(reminderTraces(fixture)[0]!.names_source, "top_paths");
  assert.equal(reminderTraces(fixture)[0]!.scan_outcome, "not_scanned");
  assert.equal(measurements, 0);

  // The same failure is not new 12h later, and the workspace is still over the limit.
  await idleA(fixture, CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS);
  assert.deepEqual(tiersAndTriggers(fixture), ["urgent:size_failure", "baseline:rhythm"]);
  assert.equal(lastSummary(fixture), "Largest folders that still move: work/.");
  assert.equal(measurements, 1);
});

test("past the entry cap the scan is not established and names nothing", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory, workspaceScanMaxEntries: 3 });
    fixture.runtime.applyConfig(config());
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
    await makeFolders(workspace, { a: 10, b: 10, c: 10, d: 10 });
    await idleA(fixture);
    assert.deepEqual(reminderItems(fixture).map((item) => item.summary), ["Over half the move size limit (60%)."]);
    assert.equal(reminderTraces(fixture)[0]!.names_source, "largest");
    assert.equal(reminderTraces(fixture)[0]!.scan_outcome, "entry_limit");
    assert.equal(reminderTraces(fixture)[0]!.named_count, 0);
    assert.equal(reminderTraces(fixture)[0]!.candidate_count, undefined, "nothing to measure");
  });
});

test("a scan past its time budget stops and names nothing", async () => {
  let stopRequested: (() => boolean) | null = null;
  const fixture = runtimeFixture({
    measurement: smallMemory,
    scanWorkspaceRoot: ({ shouldStop }) => {
      stopRequested = shouldStop;
      return new Promise(() => {});
    },
  });
  fixture.runtime.applyConfig(config());
  fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
  await fixture.runtime.waitForIdle();
  fixture.runtime.onAgentWorkingToIdle("owner-a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopRequested!(), false);
  fixture.clock.fire(fixture.clock.earliestActiveId());
  await fixture.runtime.waitForIdle();
  assert.equal(stopRequested!(), true, "the scan is told to stop at the budget");
  assert.deepEqual(reminderItems(fixture).map((item) => item.summary), ["Over half the move size limit (60%)."]);
  assert.equal(reminderTraces(fixture)[0]!.scan_outcome, "timeout");
});

test("an unreadable workspace root or a disabled config presents nothing", async () => {
  const fixture = runtimeFixture({ measurement: smallMemory });
  fixture.runtime.applyConfig(config({ ownerAgentId: "owner-a" }));
  fixture.runtime.applyConfig(config({ ownerAgentId: "owner-b", enabled: false }));
  await idleTransition(fixture);
  assert.equal(reminderItems(fixture).length, 0);
  assert.equal(fixture.wakes.length, 0);
  assert.deepEqual(
    fixture.traces.filter(({ name }) => name === "daemon.cleaner.backup_ignore.skipped").map(({ attrs }) => [attrs.owner_agent_id, attrs.scan_outcome]),
    [["owner-a", "read_failed"]],
  );
});

test("urgent: a size failure of another migration is new; an entry-count failure says too many files", async () => {
  const fixture = runtimeFixture({
    measurement: smallMemory,
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: [] }),
  });
  fixture.runtime.applyConfig(config());
  fixture.runtime.noteMigrationReadiness("owner-a", readiness({ failureId: "mig-1", topPaths: ["a"] }));
  await fixture.runtime.waitForIdle();
  assert.equal(lastSummary(fixture), "The last move failed: too large. Largest: a. Then run raft migration retry to retry the move once.");
  const second = readiness({ files: 1_500, failureId: "mig-2", topPaths: ["node_cache"] });
  fixture.runtime.noteMigrationReadiness("owner-a", {
    ...second,
    lastSizeFailure: { ...second.lastSizeFailure!, code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED" },
  });
  await fixture.runtime.waitForIdle();
  assert.deepEqual(tiersAndTriggers(fixture), ["urgent:size_failure", "urgent:size_failure"]);
  assert.equal(lastSummary(fixture), "The last move failed: too many files. Largest: node_cache. Then run raft migration retry to retry the move once.");
  // An unknown code or a failure without its migration id is not one.
  fixture.runtime.noteMigrationReadiness("owner-a", {
    ...second,
    lastSizeFailure: { ...second.lastSizeFailure!, migrationId: "mig-3", code: "SOMETHING_ELSE" },
  });
  await fixture.runtime.waitForIdle();
  assert.equal(reminderTraces(fixture).length, 2);
});

test("the size-failure retry hint: only for a new size failure, within the retry window, on a daemon that offers the retry", async () => {
  // Always kept whole after the first reason, whatever else competes for the preview.
  assert.equal(
    backupIgnoreReminderSummary(
      ["The last move failed: too many files.", "Close to the move file-count limit (150%)."],
      { prefix: "Largest: ", items: ["x".repeat(200)] },
      CLEANER_SIZE_FAILURE_RETRY_HINT,
    ).summary,
    "The last move failed: too many files. Then run raft migration retry to retry the move once.",
  );
  const failedAt = Date.parse("2026-11-10T10:00:00Z");
  const snapshot = { readiness: readiness({ failureId: "mig-1", failureAt: "2026-11-10T10:00:00Z" }) } as unknown as Parameters<typeof sizeFailureRetryHint>[1];
  const sizeFailure = [{ trigger: "size_failure", urgent: true, reason: "The last move failed: too large." }] as const;
  assert.equal(sizeFailureRetryHint(sizeFailure, snapshot, failedAt + HOUR), CLEANER_SIZE_FAILURE_RETRY_HINT, "this daemon offers the retry");
  assert.equal(sizeFailureRetryHint(sizeFailure, snapshot, failedAt + 24 * HOUR), null, "the retry window has passed");
  assert.equal(sizeFailureRetryHint(sizeFailure, snapshot, failedAt + HOUR, false), null, "a daemon without the retry");
  assert.equal(sizeFailureRetryHint([{ trigger: "disk_low", urgent: true, reason: "Disk is low (1 GiB free)." }], snapshot, failedAt + HOUR), null);

  // An expired failure still reminds, without the hint.
  const fixture = runtimeFixture({ measurement: smallMemory, scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: [] }) });
  fixture.clock.nowMs = failedAt + 25 * HOUR;
  fixture.runtime.applyConfig(config());
  fixture.runtime.noteMigrationReadiness("owner-a", readiness({ failureId: "mig-old", failureAt: "2026-11-10T10:00:00Z", topPaths: ["a"] }));
  await fixture.runtime.waitForIdle();
  assert.equal(lastSummary(fixture), "The last move failed: too large. Largest: a.");
  assert.equal(reminderTraces(fixture).at(-1)!.retry_hint, false);
});

test("a restart keeps the reminder state: the same size failure never interrupts again, and no baseline within 12h", async () => {
  await withWorkspace(async ({ root }) => {
    const failed = readiness({ bytes: 1_200, failureId: "mig-1", topPaths: ["datasets"] });
    const first = runtimeFixture({ agentsDataDir: root, measurement: smallMemory, reminderStateStore: createFileReminderStateStore(root) });
    first.runtime.applyConfig(config());
    await idleA(first);
    first.runtime.noteMigrationReadiness("owner-a", failed);
    await first.runtime.waitForIdle();
    assert.deepEqual(tiersAndTriggers(first), ["baseline:first", "urgent:size_failure"]);
    first.runtime.clear();

    const statePath = path.join(root, ".agent-state", "owner-a", CLEANER_REMINDER_STATE_FILE);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.version, 1);
    assert.deepEqual((persisted.signals as Record<string, unknown>).sizeFailureMigrationIds, ["mig-1"]);

    // A new daemon over the same agents dir, an hour later: agent:start resends the same failure.
    const clock = new FakeClock();
    clock.nowMs = first.clock.nowMs + HOUR;
    const second = runtimeFixture({ agentsDataDir: root, measurement: smallMemory, reminderStateStore: createFileReminderStateStore(root), clock });
    second.runtime.applyConfig(config());
    second.runtime.noteMigrationReadiness("owner-a", failed);
    await second.runtime.waitForIdle();
    await idleA(second, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.equal(reminderTraces(second).length, 0, "no interrupt and no first or baseline reminder");
    assert.equal(second.wakes.length, 0);

    // A new failure gets through at once.
    second.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 1_200, failureId: "mig-2", topPaths: ["datasets"] }));
    await second.runtime.waitForIdle();
    assert.deepEqual(tiersAndTriggers(second), ["urgent:size_failure"]);
  });
});

test("a corrupt persisted state is treated as none", async () => {
  await withWorkspace(async ({ root }) => {
    const store = createFileReminderStateStore(root);
    store.save("owner-a", { version: 1, signals: {} as never, names: null });
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory, reminderStateStore: store });
    fixture.runtime.applyConfig(config());
    await idleA(fixture);
    assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first"]);
  });
});

test("a disk reading around the critical line interrupts once; critical is over only once the disk is not low", async () => {
  let disk = { availableBytes: 4, totalBytes: 100 };
  let quota: CleanerProviderQuota | undefined;
  const fixture = runtimeFixture({
    measurement: smallMemory,
    providerQuota: () => quota,
    diskMeasurement: async () => ({ kind: "measured", ...disk }),
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: [] }),
  });
  fixture.runtime.applyConfig(config());
  for (const available of [4, 6, 4, 6, 4]) {
    disk = { availableBytes: available, totalBytes: 100 };
    fixture.clock.nowMs += CLEANER_BACKUP_IGNORE_URGENT_MIN_SPACING_MS;
    await firePeriodic(fixture, undefined, { idleTransition: false });
  }
  assert.deepEqual(tiersAndTriggers(fixture), ["urgent:disk_low"]);

  // Back above the low-disk line, then critical again: a new episode.
  disk = { availableBytes: 50, totalBytes: 100 };
  await firePeriodic(fixture, undefined, { idleTransition: false });
  disk = { availableBytes: 4, totalBytes: 100 };
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.deepEqual(tiersAndTriggers(fixture), ["urgent:disk_low", "urgent:disk_low"]);

  // Another urgent signal right after (quota, evaluated on a readiness update): held by the spacing.
  quota = { state: "near_exhausted" };
  fixture.runtime.noteMigrationReadiness("owner-a", undefined);
  await fixture.runtime.waitForIdle();
  assert.equal(reminderTraces(fixture).length, 2, "held by the urgent spacing");
  assert.ok(skipReasons(fixture).includes("urgent_spacing"));
  fixture.clock.nowMs += CLEANER_BACKUP_IGNORE_URGENT_MIN_SPACING_MS;
  fixture.runtime.noteMigrationReadiness("owner-a", undefined);
  await fixture.runtime.waitForIdle();
  assert.deepEqual(tiersAndTriggers(fixture).slice(2), ["urgent:provider_quota"]);
});

test("a capped scan names no folder; a new signal still sends", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory, workspaceScanMaxEntries: 3 });
    fixture.runtime.applyConfig(config());
    await idleA(fixture);
    await makeFolders(workspace, { a: 10, b: 10, c: 10, d: 10 });
    await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.equal(reminderTraces(fixture).length, 1);
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
    await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
    assert.deepEqual(tiersAndTriggers(fixture).slice(1), ["early:readiness_band"]);
    assert.equal(lastSummary(fixture), "Over half the move size limit (60%).");
    assert.equal(reminderTraces(fixture)[1]!.scan_outcome, "entry_limit");
    assert.equal(reminderTraces(fixture)[1]!.named_count, 0);
  });
});

test("the cleaner reads at most 64 KiB of an ignore file and uses the whole lines read", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const padding = `${"# padding\n".repeat(Math.ceil(AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES / 10))}`;
    await writeFile(path.join(workspace, ".raftbackupignore"), `early/\n${padding}late/\n`);
    await makeFolders(workspace, { early: 10, late: 10 });
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
    await idleA(fixture);
    assert.equal(
      lastSummary(fixture),
      "Over half the move size limit (60%). Largest folders that still move: late/.",
      "past the cap, the late line is not read",
    );
  });
});

test("a reminder while the disk is low (not critical) keeps the critical episode: the next dip is not new", async () => {
  let disk = { availableBytes: 4, totalBytes: 100 };
  const fixture = runtimeFixture({
    measurement: smallMemory,
    diskMeasurement: async () => ({ kind: "measured", ...disk }),
    scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: [] }),
  });
  fixture.runtime.applyConfig(config());
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.deepEqual(tiersAndTriggers(fixture), ["urgent:disk_low"]);

  disk = { availableBytes: 9, totalBytes: 100 };
  await firePeriodic(fixture, undefined, { idleTransition: false });
  fixture.runtime.noteProviderLimitHit("owner-a");
  await idleA(fixture, CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS);
  assert.deepEqual(tiersAndTriggers(fixture).slice(1), ["early:provider_limit"], "a reminder while low, not critical");

  disk = { availableBytes: 4, totalBytes: 100 };
  fixture.clock.nowMs += CLEANER_BACKUP_IGNORE_URGENT_MIN_SPACING_MS;
  await firePeriodic(fixture, undefined, { idleTransition: false });
  assert.equal(reminderTraces(fixture).length, 2, "still the same critical episode");
});

test("a state file an earlier version wrote, with its directory names, still loads; the next one is written with names: null, which that version reads", async () => {
  await withWorkspace(async ({ root }) => {
    const statePath = path.join(root, ".agent-state", "owner-a", CLEANER_REMINDER_STATE_FILE);
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({
      version: 1,
      lastReminderAtMs: 1_000,
      stamp: null,
      signals: {
        diskLowFreeBytes: null,
        diskCritical: false,
        readinessBand: 0,
        sizeFailureMigrationIds: ["mig-1"],
        quotaState: "ok",
        providerLimitAtMs: null,
      },
      names: ["data", "models"],
    })}\n`);
    const clock = new FakeClock();
    clock.nowMs = 1_000 + HOUR;
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory, reminderStateStore: createFileReminderStateStore(root), clock });
    fixture.runtime.applyConfig(config());
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ failureId: "mig-1", topPaths: ["datasets"] }));
    await fixture.runtime.waitForIdle();
    await idleA(fixture, HOUR);
    assert.equal(reminderTraces(fixture).length, 0, "the failure and the time it remembers hold: no interrupt, no first reminder");

    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ failureId: "mig-2", topPaths: ["datasets"] }));
    await fixture.runtime.waitForIdle();
    assert.deepEqual(tiersAndTriggers(fixture), ["urgent:size_failure"]);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    // The version before parses a state only when `names` is null or an array of strings.
    assert.equal("names" in persisted, true);
    assert.equal(persisted.names, null);
    assert.deepEqual((persisted.signals as Record<string, unknown>).sizeFailureMigrationIds, ["mig-1", "mig-2"]);
  });
});

test("a workspace deleted while an idle reminder is being prepared is not written back", async () => {
  await withWorkspace(async ({ root }) => {
    let deleteDuringMeasurement: (() => void) | null = null;
    const fixture = runtimeFixture({
      agentsDataDir: root,
      reminderStateStore: createFileReminderStateStore(root),
      measurement: () => {
        deleteDuringMeasurement?.();
        deleteDuringMeasurement = null;
        return { kind: "measured", bytes: CLEANER_CONFIG_DEFAULTS.thresholdBytes * 2 };
      },
    });
    fixture.runtime.applyConfig(config());
    // The period finds MEMORY.md large, so a memory hint is due at the next idle;
    // presenting it measures again, and that is when the workspace goes.
    await firePeriodic(fixture, undefined, { idleTransition: false });
    deleteDuringMeasurement = () => fixture.runtime.onAgentWorkspaceDeleted("owner-a");
    await idleA(fixture);
    assert.equal(deleteDuringMeasurement, null, "the delete ran while the hint was being presented");
    const statePath = path.join(root, ".agent-state", "owner-a", CLEANER_REMINDER_STATE_FILE);
    assert.equal(existsSync(statePath), false, "the deleted agent's state stays deleted");
  });
});

test("deleting the agent's workspace removes its reminder state", async () => {
  await withWorkspace(async ({ root }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory, reminderStateStore: createFileReminderStateStore(root) });
    fixture.runtime.applyConfig(config());
    await idleA(fixture);
    const statePath = path.join(root, ".agent-state", "owner-a", CLEANER_REMINDER_STATE_FILE);
    assert.ok(existsSync(statePath));
    fixture.runtime.onAgentWorkspaceDeleted("owner-a");
    assert.equal(existsSync(statePath), false);
    await idleA(fixture, HOUR);
    assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first", "baseline:first"], "nothing remembered for that agent");
  });
});

// ── Withdrawal: the reminder's item is taken back once what it was about is measurably over ──

const withdrawals = (fixture: ReturnType<typeof runtimeFixture>) =>
  fixture.traces.filter(({ name }) => name === "daemon.cleaner.backup_ignore.withdrawn").map(({ attrs }) => attrs);
const diskTipItems = (fixture: ReturnType<typeof runtimeFixture>) =>
  fixture.runtime.inbox.list().filter((item) => item.sourceRef.kind === "disk_hint");

test("withdrawal: once every folder the reminder named is ignored, marked kept or gone, its item is withdrawn; the workspace tip's own item stays", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    let disk = { availableBytes: 50, totalBytes: 100 };
    const fixture = runtimeFixture({
      agentsDataDir: root,
      measurement: smallMemory,
      diskMeasurement: async () => ({ kind: "measured", ...disk }),
    });
    fixture.runtime.applyConfig(config());
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
    await makeFolders(workspace, { checkouts: 4_000, archive: 2_000, scratch: 300 });
    await idleA(fixture);
    assert.equal(lastSummary(fixture), "Over half the move size limit (60%). Largest folders that still move: checkouts/, archive/, scratch/.");

    // Low disk within 2 h of the reminder: the workspace tip is its own item (kind disk_hint) in the same class.
    disk = { availableBytes: 9, totalBytes: 100 };
    await firePeriodic(fixture);
    assert.equal(diskTipItems(fixture).length, 1);
    assert.equal(reminderItems(fixture).length, 1, "nothing was done yet: the reminder stays");

    // Two of the three handled: the third still moves, so the reminder still holds.
    await writeFile(path.join(workspace, ".raftbackupignore"), "checkouts/\n# keep: archive\n");
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 1);
    assert.deepEqual(withdrawals(fixture), []);

    // The third is deleted: everything it named is handled.
    await rm(path.join(workspace, "scratch"), { recursive: true });
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 0, "withdrawn");
    assert.equal(diskTipItems(fixture).length, 1, "the tip that shares the class is untouched");
    assert.deepEqual(withdrawals(fixture).map((attrs) => [attrs.rule, attrs.names_source, attrs.named_count, attrs.merged_with_tip]), [
      ["named_folders_handled", "largest", 3, false],
    ]);
    assert.ok(fixture.traces.some(({ name, attrs }) => name === "daemon.cleaner.drop" && attrs.reason === "condition_cleared" && attrs.count === 1));
    assert.doesNotMatch(JSON.stringify(withdrawals(fixture)), /checkouts|archive|scratch/, "no names in traces");

    // Nothing is sent because of the withdrawal: with the disk no longer low
    // there is no new signal (the band is not new), and the baseline is hours away.
    disk = { availableBytes: 50, totalBytes: 100 };
    await firePeriodic(fixture, undefined, { idleTransition: false });
    const reminders = reminderTraces(fixture).length;
    for (let step = 0; step < 3; step += 1) await idleA(fixture, HOUR);
    assert.equal(reminderTraces(fixture).length, reminders);
    assert.equal(reminderItems(fixture).length, 0);
  });
});

test("withdrawal: a reminder that named nothing is withdrawn once .raftbackupignore changed since, and not before", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    await makeFolders(workspace, { data: 4_096 });
    await idleA(fixture);
    assert.equal(lastSummary(fixture), CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY);

    for (let step = 0; step < 3; step += 1) await idleA(fixture, HOUR);
    assert.equal(reminderItems(fixture).length, 1, "the file is as it was: the reminder stays");
    assert.deepEqual(withdrawals(fixture), []);

    await writeFile(path.join(workspace, ".raftbackupignore"), "data/\n");
    await idleA(fixture, HOUR);
    assert.equal(reminderItems(fixture).length, 0);
    assert.deepEqual(withdrawals(fixture).map((attrs) => [attrs.rule, attrs.names_source, attrs.named_count]), [
      ["ignore_file_changed", "none", 0],
    ]);
    assert.equal(reminderTraces(fixture).length, 1, "and no reminder follows from it");
  });
});

test("withdrawal: a reminder sent for signals is withdrawn once every one of them is measurably gone", async () => {
  await withWorkspace(async ({ root }) => {
    let disk = { availableBytes: 4, totalBytes: 100 };
    const fixture = runtimeFixture({
      agentsDataDir: root,
      measurement: smallMemory,
      diskMeasurement: async () => ({ kind: "measured", ...disk }),
      // No folder to name, and the ignore file never changes: only its signals can end this reminder.
      scanWorkspaceRoot: async () => ({ kind: "established", directoryNames: [] }),
    });
    fixture.runtime.applyConfig(config());
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
    // Critically low disk interrupts at the tick, with the band as its second reason.
    await firePeriodic(fixture, undefined, { idleTransition: false });
    assert.deepEqual(tiersAndTriggers(fixture), ["urgent:disk_low"]);
    assert.equal(reminderTraces(fixture)[0]!.signal_count, 2);
    assert.equal(reminderTraces(fixture)[0]!.merged_with_tip, false);

    // The low-disk workspace tip presents at the idle as its own item.
    await idleA(fixture, 60_000);
    assert.equal(diskTipItems(fixture).length, 1);
    assert.equal(reminderItems(fixture).length, 1, "both reasons hold");

    // Back under half the limit, the disk still low: one of its two reasons holds.
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 100 }));
    await fixture.runtime.waitForIdle();
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 1);

    // The disk recovers while the Server sends no readiness: nothing measured says the band is over.
    disk = { availableBytes: 50, totalBytes: 100 };
    fixture.runtime.noteMigrationReadiness("owner-a", undefined);
    await firePeriodic(fixture, undefined, { idleTransition: false });
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 1, "an unknown signal is not a cleared one");
    assert.deepEqual(withdrawals(fixture), []);

    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 100 }));
    await fixture.runtime.waitForIdle();
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 0);
    assert.equal(diskTipItems(fixture).length, 1, "the tip's own item stays");
    assert.deepEqual(withdrawals(fixture).map((attrs) => [attrs.rule, attrs.signal_count, attrs.merged_with_tip]), [["signals_cleared", 2, false]]);
  });
});

test("withdrawal: a size-failure reminder goes once the Server reports no failure and the workspace is under half the limit; its named paths never withdraw it", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    await makeFolders(workspace, { datasets: 4_096 });
    await idleA(fixture);
    fixture.clock.nowMs += 60_000;
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 1_200, failureId: "mig-1", topPaths: ["datasets"] }));
    await fixture.runtime.waitForIdle();
    assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first", "urgent:size_failure"]);

    // The path it named is ignored and the file changed, but the failure stands: the reminder says why the move failed.
    await writeFile(path.join(workspace, ".raftbackupignore"), "datasets/\n");
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 1);
    assert.deepEqual(withdrawals(fixture), []);

    // A later move packed: no failure, and what it measured is under half the limit.
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 100 }));
    await fixture.runtime.waitForIdle();
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 0);
    assert.deepEqual(withdrawals(fixture).map((attrs) => [attrs.rule, attrs.names_source]), [["signals_cleared", "top_paths"]]);
  });
});

test("withdrawal: the item merged with the low-disk workspace tip stays while the disk is low, and goes once it is not", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    let disk = { availableBytes: 9, totalBytes: 100 };
    const fixture = runtimeFixture({
      agentsDataDir: root,
      measurement: smallMemory,
      diskMeasurement: async () => ({ kind: "measured", ...disk }),
    });
    fixture.runtime.applyConfig(config());
    await makeFolders(workspace, { data: 4_096 });
    await firePeriodic(fixture);
    assert.deepEqual(reminderItems(fixture).map((item) => [item.title, item.summary]), [
      [CLEANER_WORKSPACE_TIDY_TITLE, "Disk is low (9 B free). Largest folders that still move: data/."],
    ]);

    // The folder it named is ignored now, but the tip in the same item is still due.
    await writeFile(path.join(workspace, ".raftbackupignore"), "data/\n");
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 1, "left: the disk is still low");
    assert.deepEqual(withdrawals(fixture), []);

    disk = { availableBytes: 50, totalBytes: 100 };
    await firePeriodic(fixture);
    assert.equal(reminderItems(fixture).length, 0);
    assert.deepEqual(withdrawals(fixture).map((attrs) => attrs.merged_with_tip), [true]);
  });
});

test("withdrawal: the item merged with the weekly workspace tip is left, as that tip has no condition to measure", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root });
    fixture.runtime.applyConfig(config());
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n");
    await firePeriodic(fixture);
    assert.deepEqual(reminderItems(fixture).map((item) => item.title), [CLEANER_WORKSPACE_TIDY_TITLE]);

    await writeFile(path.join(workspace, ".raftbackupignore"), "data/\n");
    await idleA(fixture, HOUR);
    assert.equal(reminderItems(fixture).length, 1);
    assert.deepEqual(withdrawals(fixture), []);
  });
});

test("withdrawal: names that did not fit the summary are not \"named nothing\": editing the ignore file does not withdraw a size-failure reminder", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    await idleA(fixture);
    fixture.clock.nowMs += 60_000;
    // With the retry hint keeping its room, the Server's one path does not fit the 120-character summary.
    const longPath = "checkouts/slock/node_modules/.pnpm/some-package@1.0.0/node_modules/some-package";
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 1_200, failureId: "mig-1", topPaths: [longPath] }));
    await fixture.runtime.waitForIdle();
    assert.deepEqual(tiersAndTriggers(fixture), ["baseline:first", "urgent:size_failure"]);
    assert.equal(reminderTraces(fixture)[1]!.names_source, "top_paths");
    assert.equal(reminderTraces(fixture)[1]!.named_count, 0, "the path did not fit");
    assert.doesNotMatch(lastSummary(fixture)!, /checkouts/);

    await writeFile(path.join(workspace, ".raftbackupignore"), "# a note to self\n");
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 1, "the move still failed for its size: the reminder stands");
    assert.deepEqual(withdrawals(fixture), []);
  });
});

test("withdrawal: a deleted .raftbackupignore is not an update: the reminder that named nothing stays", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory });
    fixture.runtime.applyConfig(config());
    await writeFile(path.join(workspace, ".raftbackupignore"), "cache/\n");
    await idleA(fixture);
    assert.equal(lastSummary(fixture), CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY);
    assert.equal(reminderTraces(fixture)[0]!.names_source, "none");

    await rm(path.join(workspace, ".raftbackupignore"));
    await idleA(fixture, 60_000);
    assert.equal(reminderItems(fixture).length, 1);
    assert.deepEqual(withdrawals(fixture), []);
  });
});

test("withdrawal: an item the agent dismissed is not withdrawn and sends no reminder; the state file is as it was before withdrawals", async () => {
  await withWorkspace(async ({ root, workspace }) => {
    const store = createFileReminderStateStore(root);
    const fixture = runtimeFixture({ agentsDataDir: root, measurement: smallMemory, reminderStateStore: store });
    fixture.runtime.applyConfig(config());
    fixture.runtime.noteMigrationReadiness("owner-a", readiness({ bytes: 600 }));
    await makeFolders(workspace, { checkouts: 4_000, archive: 2_000 });
    await idleA(fixture);

    // What the reminder was about is kept in memory only: the file has the fields it always had.
    const statePath = path.join(root, ".agent-state", "owner-a", CLEANER_REMINDER_STATE_FILE);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(persisted).sort(), ["lastReminderAtMs", "names", "signals", "stamp", "version"]);
    assert.equal(persisted.names, null);

    // `raft inbox dismiss`: the item leaves the Inbox without the Cleaner.
    assert.equal(fixture.runtime.inbox.dismiss(reminderItems(fixture)[0]!.itemId), true);
    // Everything it named is handled afterwards: there is no item left to withdraw.
    await writeFile(path.join(workspace, ".raftbackupignore"), "checkouts/\narchive/\n");
    await idleA(fixture, 60_000);
    assert.deepEqual(withdrawals(fixture), []);
    assert.equal(reminderTraces(fixture).length, 1, "and a dismissal sends no reminder either");
    assert.equal(readFileSync(statePath, "utf8"), `${JSON.stringify(persisted)}\n`, "nothing was written for it");
  });
});
