import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentProcessManager } from "./agentProcessManager";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

test("task #166 (S6): a runner writes activeTurns 0 when it starts, so a server with no agents is quiet, not unknown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "turn-activity-boot-"));
  const file = path.join(dir, "servers", "s1", "activity.json");
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir: dir, slockHome: dir, runtimeSessionHomeDir: dir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test",
    activitySnapshotPath: file,
  } as ConstructorParameters<typeof AgentProcessManager>[2]);
  try {
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    assert.equal(snapshot.activeTurns, 0);
    assert.equal(snapshot.pid, process.pid);
  } finally {
    await drainAgentManagerForTests(manager);
    await manager.stopAll();
    await rm(dir, { recursive: true, force: true });
  }
});
