import { expect, vi } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { agents, channels, channelAgents, channelHumans, featureFlags, messages, raftbenchConfigs, serverAgentMembers, serverMembers, servers } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";

// Staging timed out this count at 15 s and the whole settings page failed.
const fault = vi.hoisted(() => ({ mode: undefined as undefined | "reject" | "hang" }));
vi.mock("../raftbench/sourceCoverage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../raftbench/sourceCoverage")>();
  return { ...actual, sourceCoverage: (...args: Parameters<typeof actual.sourceCoverage>) =>
    fault.mode === "reject" ? Promise.reject(new Error("Database query failed"))
      : fault.mode === "hang" ? new Promise<never>(() => {})
      : actual.sourceCoverage(...args) };
});

const test = createApiTest();
const serverId = "90623df1-20ed-4321-88a1-e4e2b411a252";

test("a failed or slow source count leaves the settings page loadable with unknown coverage", async ({ app, db, seed, onTestFinished }) => {
  const old = process.env.DEPLOYMENT_ENV; process.env.DEPLOYMENT_ENV = "staging";
  onTestFinished(() => { fault.mode = undefined; if (old === undefined) delete process.env.DEPLOYMENT_ENV; else process.env.DEPLOYMENT_ENV = old; });
  const owner = await seed.human();
  await db.insert(featureFlags).values({ key: "raftbench_overview_v0", randomizationUnit: "server", salt: "synthetic", defaultEnabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, killSwitch: false, defaultEnabled: true } });
  await db.insert(servers).values({ id: serverId, ownerId: owner.id, name: "Synthetic", slug: "synthetic-coverage" });
  await db.insert(serverMembers).values({ serverId, userId: owner.id, role: "owner", setupStatus: "complete" });
  const [service] = await db.insert(agents).values({ serverId, name: "Analysis", runtime: "external" }).returning();
  await db.insert(serverAgentMembers).values({ serverId, agentId: service.id });
  const [source] = await db.insert(channels).values({ serverId, name: "synthetic-coverage", type: "private" }).returning();
  await db.insert(channelHumans).values({ channelId: source.id, userId: owner.id });
  await db.insert(channelAgents).values({ channelId: source.id, agentId: service.id });
  await db.insert(messages).values({ channelId: source.id, senderId: owner.id, senderType: "user", content: "Synthetic coverage" });
  await db.insert(raftbenchConfigs).values({ serverId, configuredByUserId: owner.id, enabled: true, agentId: service.id, channelIds: [source.id], revision: 1 });
  await mintAgentCredential({ agentId: service.id, scopes: ["read", "raftbench"], name: "Service", issuedVia: "human", createdByUserId: owner.id });
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": serverId };
  const load = async () => {
    const response = await fetch(`${app.baseUrl}/api/raftbench`, { headers });
    expect(response.status).toBe(200);
    return response.json();
  };

  expect((await load()).coverage).toMatchObject({ totalMessages: 1, windowMessages: 1 });
  fault.mode = "reject";
  const failed = await load();
  expect(failed.coverage).toBeNull();
  expect(failed).toMatchObject({ enabled: true, revision: 1, channelIds: [source.id] });
  fault.mode = "hang";
  const started = performance.now();
  expect((await load()).coverage).toBeNull();
  expect(performance.now() - started).toBeLessThan(10_000);
}, 30_000);
