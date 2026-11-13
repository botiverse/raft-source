import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { serverActivityPath } from "./paths";
import { readMachineTurnActivity } from "./turnActivity";

const [A, B, C, D] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];

test("task #166: the quiet point sums live runners' turns; a dead runner counts as idle and a missing snapshot as unknown", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "raft-turn-activity-"));
  try {
    const write = async (serverId: string, body: unknown) => {
      const file = serverActivityPath(home, serverId);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(body));
    };
    await write(A, { formatVersion: 1, activeTurns: 2, pid: 10, updatedAt: "t1" });
    await write(B, { formatVersion: 1, activeTurns: 5, pid: 11, updatedAt: "t2" });
    await write(C, { formatVersion: 9, activeTurns: 1, pid: 10 });
    const activity = await readMachineTurnActivity(home, {
      listServerIds: async () => [A, B, C, D],
      isAlive: (pid) => pid === 10,
    });
    assert.equal(activity.activeTurns, 2, "b's runner is gone: its turns ended with it");
    assert.deepEqual(activity.unknownServerIds, [C, D]);
    assert.deepEqual(activity.servers[1], { serverId: B, activeTurns: 0, updatedAt: "t2" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
