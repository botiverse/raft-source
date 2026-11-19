import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverRunnerSpawnedPath } from "./paths";
import { clearRunnerSpawnRecord, readRunnerSpawnRecord, recordSpawnedRunner } from "./runnerSpawnRecord";

const SERVER = "11111111-1111-4111-8111-111111111111";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "raft-spawn-record-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("the service's spawn record: written at spawn, removed when that child exits", async () => {
  await withHome(async (home) => {
    const path = serverRunnerSpawnedPath(home, SERVER);
    const record = recordSpawnedRunner(path, 303, 900, (err) => { throw err; }, () => 1234);
    await record.written;
    assert.deepEqual(readRunnerSpawnRecord(path), { pid: 303, servicePid: 900, spawnedAt: 1234 });
    assert.deepEqual(readdirSync(join(path, "..")), ["runner.spawned.json"], "no temporary file left behind");
    await record.childExited();
    assert.equal(existsSync(path), false);
  });
});

test("an exit before the write settles still leaves no record; a later spawn's record survives an earlier child's exit", async () => {
  await withHome(async (home) => {
    const path = serverRunnerSpawnedPath(home, SERVER);
    // Exit observed at once: removal waits for the write.
    await recordSpawnedRunner(path, 303, 900, (err) => { throw err; }).childExited();
    assert.equal(existsSync(path), false);

    const first = recordSpawnedRunner(path, 303, 900, (err) => { throw err; });
    await first.written;
    const second = recordSpawnedRunner(path, 304, 900, (err) => { throw err; });
    await second.written;
    await first.childExited();
    assert.equal(readRunnerSpawnRecord(path)?.pid, 304);
  });
});

test("a failed write is reported, not thrown, and the exit still settles", async () => {
  await withHome(async (home) => {
    const blocker = join(home, "not-a-dir");
    await writeFile(blocker, "");
    const errors: unknown[] = [];
    const record = recordSpawnedRunner(join(blocker, "runner.spawned.json"), 303, 900, (err) => { errors.push(err); });
    await record.childExited();
    assert.equal(errors.length, 1);
  });
});

test("a malformed record reads as none; clearing without a pid removes any record", async () => {
  await withHome(async (home) => {
    const path = serverRunnerSpawnedPath(home, SERVER);
    await recordSpawnedRunner(path, 303, 900, (err) => { throw err; }).written;
    for (const junk of ["{", "{\"pid\":0,\"servicePid\":900,\"spawnedAt\":1}", "{\"pid\":303,\"spawnedAt\":1}"]) {
      const other = join(home, "junk.json");
      await writeFile(other, junk);
      assert.equal(readRunnerSpawnRecord(other), null, junk);
    }
    await clearRunnerSpawnRecord(path);
    assert.equal(existsSync(path), false);
  });
});
