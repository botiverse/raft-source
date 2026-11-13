import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { installFakeRedis } from "../test/fakeRedis";
import { __setAgentApiWriteBudgetsForTests, admitAgentApiWrite, AGENT_API_WRITE_BUDGETS } from "./agentApiWriteLimits";

// The agent write budgets at their real numbers, counted where every replica
// counts (one Redis): Artifacts' file uploads (artifactUploads, 600 an agent
// and 1200 a server a minute) and its other writes (artifactWrites, 60 / 600),
// a review spending one per comment, one larger than a whole budget refused
// outright. Other replicas' spend is set in Redis as they would have left it.

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  __setAgentApiWriteBudgetsForTests(null);
});

/** The real numbers, enforced (the pglite harness skips budgets no test sets). */
function realBudgets() {
  __setAgentApiWriteBudgetsForTests({ artifactUploads: {}, artifactWrites: {} });
}

test("artifact uploads: an agent's 600 and a server's 1200 a minute hold across replicas", async () => {
  const fake = installFakeRedis();
  restore = fake.restore;
  realBudgets();
  fake.clock.now = 1_000_000;
  // Other replicas took 599 of agent a1's uploads this minute.
  fake.counters.set("slock:agent-api-write:artifactUploads:agent:a1", { count: 599, expiresAtMs: fake.clock.now + 40_000 });
  assert.deepEqual(await admitAgentApiWrite("artifactUploads", { agentId: "a1", serverId: "s1" }), { admitted: true });
  assert.deepEqual(await admitAgentApiWrite("artifactUploads", { agentId: "a1", serverId: "s1" }), { admitted: false, scope: "agent", limit: 600, retryAfterSeconds: 40 });
  // The server's other agents took 1198 more: one of a2's fits, a3's next doesn't.
  fake.counters.set("slock:agent-api-write:artifactUploads:server:s1", { count: 1199, expiresAtMs: fake.clock.now + 25_000 });
  assert.deepEqual(await admitAgentApiWrite("artifactUploads", { agentId: "a2", serverId: "s1" }), { admitted: true });
  assert.deepEqual(await admitAgentApiWrite("artifactUploads", { agentId: "a3", serverId: "s1" }), { admitted: false, scope: "server", limit: 1200, retryAfterSeconds: 25 });
  // Uploads are apart from the other writes.
  assert.deepEqual(await admitAgentApiWrite("artifactWrites", { agentId: "a1", serverId: "s1" }), { admitted: true });
  // A version of 500 new files goes up within one agent's minute.
  assert.ok(AGENT_API_WRITE_BUDGETS.artifactUploads.perAgent >= 500);
});

test("a review spends one write per comment, counted with the agent's other writes on every replica; one over the whole budget is refused outright", async () => {
  const fake = installFakeRedis();
  restore = fake.restore;
  realBudgets();
  fake.clock.now = 2_000_000;
  // A comment on another replica, then a review of 50 comments here.
  fake.counters.set("slock:agent-api-write:artifactWrites:agent:r1", { count: 1, expiresAtMs: fake.clock.now + 60_000 });
  assert.deepEqual(await admitAgentApiWrite("artifactWrites", { agentId: "r1", serverId: "s2", units: 50 }), { admitted: true });
  assert.equal(fake.counters.get("slock:agent-api-write:artifactWrites:agent:r1")?.count, 51);
  assert.equal(fake.counters.get("slock:agent-api-write:artifactWrites:server:s2")?.count, 50);
  assert.deepEqual(await admitAgentApiWrite("artifactWrites", { agentId: "r1", serverId: "s2", units: 10 }), { admitted: false, scope: "agent", limit: 60, retryAfterSeconds: 60 });
  const spent = fake.counters.get("slock:agent-api-write:artifactWrites:agent:r1")?.count;
  assert.deepEqual(await admitAgentApiWrite("artifactWrites", { agentId: "r1", serverId: "s2", units: 61 }), { admitted: false, scope: "request", limit: 60 });
  assert.equal(fake.counters.get("slock:agent-api-write:artifactWrites:agent:r1")?.count, spent, "never charged");
});
