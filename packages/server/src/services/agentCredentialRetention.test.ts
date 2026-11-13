import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentCredentials, agentInboxPushRegistrations, agentRuntimeProvisions } from "../db/schema";
import { dbTest } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { setDefaultTraceTracer } from "../tracing/semanticTrace";
import { createAgent } from "./agentService";
import { pruneRevokedRunnerAgentCredentials } from "./agentCredentialRetention";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-05T09:00:00Z");

/** `revokedDaysAgo` / `expiresDaysAgo`: null leaves the column NULL; a negative expiry is in the future. */
async function credential(
  agentId: string,
  issuedVia: "computer" | "human",
  revokedDaysAgo: number | null,
  expiresDaysAgo: number | null = null,
) {
  const [row] = await getDb().insert(agentCredentials).values({
    agentId,
    apiKeyHash: "fixture-value-not-a-credential",
    apiKeyPrefix: `p${randomUUID().slice(0, 7)}`,
    scopes: ["send"],
    issuedVia,
    revokedAt: revokedDaysAgo === null ? null : new Date(now.getTime() - revokedDaysAgo * DAY_MS),
    expiresAt: expiresDaysAgo === null ? null : new Date(now.getTime() - expiresDaysAgo * DAY_MS),
  }).returning({ id: agentCredentials.id });
  return row!.id;
}

async function remaining(ids: string[]): Promise<string[]> {
  const rows = await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(inArray(agentCredentials.id, ids));
  return rows.map((row) => row.id).sort();
}

async function runnerAgent(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const agent = await createAgent(server.id, `runner-${randomUUID().slice(0, 8)}`, { runtime: "external", model: "external" });
  return { server, agent };
}

dbTest("retention deletes only runner keys revoked over 30 days ago, in batches", async ({ seed }) => {
  const { server, agent } = await runnerAgent(seed);

  const oldRunner = [await credential(agent.id, "computer", 45), await credential(agent.id, "computer", 31), await credential(agent.id, "computer", 90)];
  const recentRunner = await credential(agent.id, "computer", 29);
  const liveRunner = await credential(agent.id, "computer", null);
  const oldHuman = await credential(agent.id, "human", 120);
  await getDb().insert(agentInboxPushRegistrations).values({
    agentId: agent.id,
    credentialId: oldRunner[0]!,
    serverId: server.id,
    endpointUrl: "https://push.example.test/hook",
    secretCiphertext: "fixture",
    secretIv: "fixture",
    secretAuthTag: "fixture",
  });

  const result = await pruneRevokedRunnerAgentCredentials({ now, batchSize: 2, pauseMs: 0 });

  assert.equal(result.deleted, 3);
  assert.equal(result.deletedExpired, 0);
  // revoked (2, full), expired (0, done), revoked (1, done).
  assert.equal(result.batches, 3);
  assert.equal(result.yielded, false);
  assert.deepEqual(await remaining([...oldRunner, recentRunner, liveRunner, oldHuman]), [recentRunner, liveRunner, oldHuman].sort());
  const registrations = await getDb().select().from(agentInboxPushRegistrations)
    .where(inArray(agentInboxPushRegistrations.credentialId, oldRunner));
  assert.equal(registrations.length, 0);

  const again = await pruneRevokedRunnerAgentCredentials({ now, batchSize: 2, pauseMs: 0 });
  assert.deepEqual([again.deleted, again.deletedExpired, again.batches], [0, 0, 2]);
});

dbTest("retention deletes unrevoked runner keys expired over 30 days ago, and nothing that could still authenticate", async ({ seed }) => {
  const { server, agent } = await runnerAgent(seed);
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink }));
  try {
    const expiredLongAgo = [
      await credential(agent.id, "computer", null, 45),
      await credential(agent.id, "computer", null, 31),
      await credential(agent.id, "computer", null, 90),
    ];
    const expiredRecently = await credential(agent.id, "computer", null, 29);
    const neverExpires = await credential(agent.id, "computer", null, null);
    const notYetExpired = await credential(agent.id, "computer", null, -3);
    const humanExpired = await credential(agent.id, "human", null, 120);
    // Revoked rows follow the revoked rule only, whatever their expiry.
    const revokedRecentlyExpiredLongAgo = await credential(agent.id, "computer", 10, 60);
    const revokedLongAgo = await credential(agent.id, "computer", 40, 60);
    // A runtime provision still names it.
    const provisioned = await createAgent(server.id, `hosted-${randomUUID().slice(0, 8)}`, { runtime: "external", model: "external" });
    const provisionedExpired = await credential(provisioned.id, "computer", null, 60);
    await getDb().insert(agentRuntimeProvisions).values({
      agentId: provisioned.id, serverId: server.id, provider: "antiproton", state: "active",
      provisionedName: provisioned.name, provisionedInstructions: "", credentialId: provisionedExpired,
    });
    const kept = [expiredRecently, neverExpires, notYetExpired, humanExpired, revokedRecentlyExpiredLongAgo, provisionedExpired];

    const result = await pruneRevokedRunnerAgentCredentials({ now, batchSize: 2, pauseMs: 0 });

    assert.equal(result.deleted, 1);
    assert.equal(result.deletedExpired, 3);
    // revoked (1, done), expired (2, full), expired (1, done).
    assert.equal(result.batches, 3);
    assert.deepEqual(await remaining([...expiredLongAgo, revokedLongAgo, ...kept]), [...kept].sort());
    const events = sink.getAllLogEvents().filter((event) => event.name === "agent_credentials.retention");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.attrs?.deleted, 1);
    assert.equal(events[0]!.attrs?.deleted_expired, 3);
    assert.equal(events[0]!.attrs?.batches, 3);
  } finally {
    setDefaultTraceTracer(null);
  }
});

dbTest("retention takes turns between the rules and resumes on the next tick when the time budget runs out", async ({ seed }) => {
  const { agent } = await runnerAgent(seed);
  const revoked = [await credential(agent.id, "computer", 40), await credential(agent.id, "computer", 50), await credential(agent.id, "computer", 60)];
  const expired = [await credential(agent.id, "computer", null, 40), await credential(agent.id, "computer", null, 50), await credential(agent.id, "computer", null, 60)];

  // No budget: one batch, then the tick stops.
  const first = await pruneRevokedRunnerAgentCredentials({ now, batchSize: 2, pauseMs: 0, budgetMs: 0 });
  assert.deepEqual([first.deleted, first.deletedExpired, first.batches], [2, 0, 1]);
  // The oldest revoked ones went first.
  assert.deepEqual(await remaining(revoked), [revoked[0]!]);

  // A full budget: revoked (1, done), expired (2, full), expired (1, done).
  const second = await pruneRevokedRunnerAgentCredentials({ now, batchSize: 2, pauseMs: 0 });
  assert.deepEqual([second.deleted, second.deletedExpired, second.batches], [1, 3, 3]);
  assert.deepEqual(await remaining([...revoked, ...expired]), []);
});
