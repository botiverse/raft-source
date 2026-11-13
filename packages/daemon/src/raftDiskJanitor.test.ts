import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RAFT_MIGRATION_GENERATION_IDLE_MS,
  createRaftDiskWalkBudget,
  measureDirectoryBytes,
  measureRaftDiskFootprint,
  removeMigrationGenerationBulk,
  runRaftDiskJanitor,
  scheduleRaftDiskJanitor,
} from "./raftDiskJanitor";
import {
  AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS,
  AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_BYTES_PER_AGENT,
  AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT,
} from "./agentMigrationWorkspaceArchive";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = new Date("2026-10-04T12:00:00Z");

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "raft-disk-janitor-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeBytes(filePath: string, bytes: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(bytes));
}

async function age(target: string, ageMs: number): Promise<void> {
  const at = new Date(NOW.getTime() - ageMs);
  await utimes(target, at, at);
}

/** A target-side generation: chunks, an extraction root and the arrival report. */
async function generation(home: string, migration: string, ageMs: number): Promise<string> {
  const root = path.join(home, "migrations", migration, "agent_migration_transport_1");
  await writeBytes(path.join(root, "chunks", "0.chunk"), 1_000);
  await writeBytes(path.join(root, "chunks", "1.chunk"), 500);
  await mkdir(path.join(root, "extracting-abc123"), { recursive: true });
  await writeBytes(path.join(root, "arrival-report-v2.json"), 10);
  for (const entry of ["chunks/0.chunk", "chunks/1.chunk", "chunks", "extracting-abc123", "arrival-report-v2.json", ""]) {
    await age(path.join(root, entry), ageMs);
  }
  return root;
}

test("measureDirectoryBytes sums regular files, never follows symlinks, and reports a truncated walk", async () => {
  await withHome(async (home) => {
    await writeBytes(path.join(home, "a", "one"), 100);
    await writeBytes(path.join(home, "a", "b", "two"), 23);
    await writeBytes(path.join(home, "outside", "big"), 10_000);
    await symlink(path.join(home, "outside"), path.join(home, "a", "link"));

    const budget = createRaftDiskWalkBudget();
    assert.equal(await measureDirectoryBytes(path.join(home, "a"), budget), 123);
    assert.equal(budget.outcome, "complete");

    const tiny = createRaftDiskWalkBudget({ maxEntries: 1 });
    await measureDirectoryBytes(path.join(home, "a"), tiny);
    assert.equal(tiny.outcome, "truncated", "a partial walk must not read as a small complete number");

    assert.equal(await measureDirectoryBytes(path.join(home, "missing"), createRaftDiskWalkBudget()), 0);
  });
});

test("an arrived generation loses its bulk transfer data but keeps the JSON report", async () => {
  await withHome(async (home) => {
    const root = await generation(home, "m1", 0);
    const freed = await removeMigrationGenerationBulk(root, createRaftDiskWalkBudget());
    assert.equal(freed, 1_500);
    assert.deepEqual(await readdir(root), ["arrival-report-v2.json"]);
  });
});

test("janitor clears only migration generations idle for over a week", async () => {
  await withHome(async (home) => {
    const idle = await generation(home, "old", RAFT_MIGRATION_GENERATION_IDLE_MS + DAY_MS);
    const active = await generation(home, "recent", RAFT_MIGRATION_GENERATION_IDLE_MS - DAY_MS);
    const sourceSide = path.join(home, "migrations", "src", "agent_migration_transport_2");
    await writeBytes(path.join(sourceSide, "source-spool", "part"), 7);
    await age(path.join(sourceSide, "source-spool", "part"), 30 * DAY_MS);
    await age(path.join(sourceSide, "source-spool"), 30 * DAY_MS);
    await age(sourceSide, 30 * DAY_MS);
    await writeBytes(path.join(home, "migrations", "grant-target", "arrival-report.json"), 5);

    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW });

    assert.deepEqual(await readdir(idle), ["arrival-report-v2.json"]);
    assert.deepEqual((await readdir(active)).sort(), ["arrival-report-v2.json", "chunks", "extracting-abc123"]);
    assert.deepEqual(await readdir(sourceSide), []);
    assert.deepEqual(await readdir(path.join(home, "migrations", "grant-target")), ["arrival-report.json"]);
    assert.equal(result.migrationGenerationsCleaned, 2);
    assert.equal(result.migrationFreedBytes, 1_507);
    assert.equal(result.sweepOutcome, "complete");
  });
});

test("janitor applies the keep-3 / 7-day backup rule to every agent and reports each removal", async () => {
  await withHome(async (home) => {
    const backups = path.join(home, "migration-workspace-backups");
    // Agent A: one backup past the 7-day limit, never migrated again.
    await writeBytes(path.join(backups, "agent-a", "mig-1", "MEMORY.md"), 400);
    await age(path.join(backups, "agent-a", "mig-1"), AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS + DAY_MS);
    // Agent B: four recent backups; the oldest is over the per-agent cap.
    for (let index = 0; index <= AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT; index += 1) {
      const name = index === 0 ? "preexisting-mig-0" : `mig-${index}`;
      await writeBytes(path.join(backups, "agent-b", name, "f"), 10);
      await age(path.join(backups, "agent-b", name), (5 - index) * DAY_MS);
    }

    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW });

    assert.deepEqual(await readdir(path.join(backups, "agent-a")), []);
    assert.deepEqual((await readdir(path.join(backups, "agent-b"))).sort(), ["mig-1", "mig-2", "mig-3"]);
    assert.deepEqual(
      result.backupsRemoved.sort((left, right) => left.ownerAgentId.localeCompare(right.ownerAgentId)),
      [
        { ownerAgentId: "agent-a", backupKind: "migration", ageDays: 8, freedBytes: 400 },
        { ownerAgentId: "agent-b", backupKind: "preexisting", ageDays: 5, freedBytes: 10 },
      ],
    );
    assert.equal(result.backupsFreedBytes, 410);
  });
});

test("janitor removes older backups once an agent's kept backups exceed the size cap, never the newest", async () => {
  await withHome(async (home) => {
    const backups = path.join(home, "migration-workspace-backups");
    // Sparse files: apparent size is what the janitor measures.
    const sparse = async (filePath: string, bytes: number): Promise<void> => {
      await writeBytes(filePath, 0);
      await truncate(filePath, bytes);
    };
    const cap = AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_BYTES_PER_AGENT;
    // Agent A: newest alone is over the cap; it stays, the two older go.
    await sparse(path.join(backups, "agent-a", "mig-new", "big"), cap + 1);
    await sparse(path.join(backups, "agent-a", "mig-mid", "f"), 1_000);
    await sparse(path.join(backups, "agent-a", "mig-old", "f"), 2_000);
    await age(path.join(backups, "agent-a", "mig-new"), 1 * DAY_MS);
    await age(path.join(backups, "agent-a", "mig-mid"), 2 * DAY_MS);
    await age(path.join(backups, "agent-a", "mig-old"), 3 * DAY_MS);
    // Agent B: newest two fit together, the third would push past the cap.
    await sparse(path.join(backups, "agent-b", "mig-1", "f"), cap / 2);
    await sparse(path.join(backups, "agent-b", "mig-2", "f"), cap / 4);
    await sparse(path.join(backups, "agent-b", "mig-3", "f"), cap / 2);
    await age(path.join(backups, "agent-b", "mig-1"), 1 * DAY_MS);
    await age(path.join(backups, "agent-b", "mig-2"), 2 * DAY_MS);
    await age(path.join(backups, "agent-b", "mig-3"), 3 * DAY_MS);

    const result = await runRaftDiskJanitor({ slockHome: home, now: NOW });

    assert.deepEqual(await readdir(path.join(backups, "agent-a")), ["mig-new"]);
    assert.deepEqual((await readdir(path.join(backups, "agent-b"))).sort(), ["mig-1", "mig-2"]);
    assert.deepEqual(
      result.backupsRemoved.sort((left, right) => left.ownerAgentId.localeCompare(right.ownerAgentId) || left.ageDays - right.ageDays),
      [
        { ownerAgentId: "agent-a", backupKind: "migration", ageDays: 2, freedBytes: 1_000 },
        { ownerAgentId: "agent-a", backupKind: "migration", ageDays: 3, freedBytes: 2_000 },
        { ownerAgentId: "agent-b", backupKind: "migration", ageDays: 3, freedBytes: cap / 2 },
      ],
    );
    assert.equal(result.sweepOutcome, "complete");
  });
});

test("once a backup goes for size, every older backup goes too, however small", async () => {
  await withHome(async (home) => {
    const backups = path.join(home, "migration-workspace-backups");
    const cap = AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_BYTES_PER_AGENT;
    const sizes = [["mig-new", cap * 0.75], ["mig-mid", cap * 0.4], ["mig-old", 1_000]] as const;
    for (const [index, [name, bytes]] of sizes.entries()) {
      const file = path.join(backups, "agent-a", name, "f");
      await writeBytes(file, 0);
      await truncate(file, bytes);
      await age(path.join(backups, "agent-a", name), (index + 1) * DAY_MS);
    }

    await runRaftDiskJanitor({ slockHome: home, now: NOW });

    assert.deepEqual(await readdir(path.join(backups, "agent-a")), ["mig-new"]);
  });
});

test("sizing large backups never starves the count / 7-day rule of other agents", async () => {
  await withHome(async (home) => {
    const backups = path.join(home, "migration-workspace-backups");
    // Many small files: sizing these alone would use up the whole budget.
    for (const name of ["mig-1", "mig-2", "mig-3"]) {
      for (let file = 0; file < 20; file += 1) {
        await writeBytes(path.join(backups, "agent-big", name, `f${file}`), 1);
      }
      await age(path.join(backups, "agent-big", name), DAY_MS);
    }
    await writeBytes(path.join(backups, "agent-old", "mig-1", "MEMORY.md"), 10);
    await age(path.join(backups, "agent-old", "mig-1"), AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_AGE_MS + DAY_MS);

    await runRaftDiskJanitor({ slockHome: home, now: NOW, budget: createRaftDiskWalkBudget({ maxEntries: 5 }) });

    assert.deepEqual(await readdir(path.join(backups, "agent-old")), []);
    assert.equal((await readdir(path.join(backups, "agent-big"))).length, 3);
  });
});

test("footprint reports Raft's own directories separately", async () => {
  await withHome(async (home) => {
    await generation(home, "m1", 0);
    await writeBytes(path.join(home, "migration-workspace-backups", "agent-a", "mig-1", "f"), 300);
    await writeBytes(path.join(home, "cli-transport", "agent-a", "launch-1", "raft"), 20);
    await writeBytes(path.join(home, "agent-proxy-tokens", "agent-a", "launch-1.token"), 5);
    await writeBytes(path.join(home, "agents", "agent-a", "huge-workspace-file"), 99_999);

    assert.deepEqual(await measureRaftDiskFootprint(home), {
      raft_migration_chunks_bytes: 1_510,
      raft_workspace_backups_bytes: 300,
      raft_launch_dirs_bytes: 25,
      measure_outcome: "complete",
    });
  });
});

test("the janitor schedule waits, never overlaps passes, and stops cleanly", async () => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { fn, ms };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer: unknown) => {
      const index = pending.indexOf(timer as { fn: () => void; ms: number });
      if (index >= 0) pending.splice(index, 1);
    },
  };
  let finishPass!: () => void;
  let passes = 0;
  const schedule = scheduleRaftDiskJanitor({
    timers,
    initialDelayMs: 600,
    intervalMs: 86_400,
    pass: () => {
      passes += 1;
      return new Promise<void>((resolve) => { finishPass = resolve; });
    },
  });
  assert.deepEqual(pending.map((timer) => timer.ms), [600]);
  pending.shift()!.fn();
  assert.equal(passes, 1);
  assert.equal(pending.length, 0, "the next pass is armed only after this one finishes");
  finishPass();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((timer) => timer.ms), [86_400]);
  schedule.stop();
  assert.equal(pending.length, 0);
});
