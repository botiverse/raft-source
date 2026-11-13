import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TurnActivitySnapshotWriter } from "./turnActivitySnapshot";

test("task #166: the turn activity snapshot is written on change only, atomically, with the runner pid", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "turn-activity-"));
  try {
    const file = path.join(dir, "servers", "s1", "activity.json");
    let tick = 0;
    const writer = new TurnActivitySnapshotWriter(file, () => new Date(Date.UTC(2026, 9, 29, 0, 0, tick++)), 4242);
    writer.update(0);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      formatVersion: 1, activeTurns: 0, pid: 4242, updatedAt: "2026-10-29T00:00:00.000Z",
    });
    writer.update(0); // unchanged: no rewrite
    writer.update(2);
    assert.equal(JSON.parse(await readFile(file, "utf8")).activeTurns, 2);
    assert.equal(JSON.parse(await readFile(file, "utf8")).updatedAt, "2026-10-29T00:00:01.000Z");
    assert.deepEqual(await readdir(path.dirname(file)), ["activity.json"], "no temp file is left behind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task #166: no path means no file, and a failed write never throws", async () => {
  new TurnActivitySnapshotWriter(null).update(3);
  new TurnActivitySnapshotWriter(undefined).update(3);
  const dir = await mkdtemp(path.join(os.tmpdir(), "turn-activity-"));
  try {
    // A directory where the file should be: the rename fails, the agents don't notice.
    const blocked = path.join(dir, "activity.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(blocked, "x"), { recursive: true }));
    assert.doesNotThrow(() => new TurnActivitySnapshotWriter(blocked).update(1));
    assert.deepEqual((await readdir(dir)).sort(), ["activity.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
