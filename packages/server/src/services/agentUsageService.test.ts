import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { AGENT_USAGE_FEATURE_FLAG_KEY, type ActivityTurnSummary, runtimeReportsTurnTokens } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, agentUsageContext, agentUsageDaily, featureFlagRules, featureFlags, machines, servers, users } from "../db/schema";
import { upsertAgentTurnSummaries } from "./agentActivityLogService";
import { computerReportsUsage, netUsageBuckets, pruneAgentUsage, readAgentUsage } from "./agentUsageService";

afterEach(async () => {
  await closeTestDatabase();
});

async function seed(suffix: string, usageOn: boolean) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    id: `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    email: `usage-${suffix}@example.com`,
    name: `usage-${suffix}`,
    displayName: `usage-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: `20000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    name: `Usage ${suffix}`,
    slug: `usage-${suffix}`,
    ownerId: owner.id,
  }).returning();
  const agentId = `30000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  await db.insert(agents).values({ id: agentId, serverId: server.id, name: `agent-${suffix}`, status: "active", model: "gpt-5", runtime: "codex" });
  if (usageOn) {
    await db.insert(featureFlags).values({ key: AGENT_USAGE_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false }).onConflictDoNothing();
    await db.insert(featureFlagRules).values({ flagKey: AGENT_USAGE_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  }
  return { agentId, serverId: server.id, ownerId: owner.id };
}

const DAY1 = Date.parse("2026-11-12T10:00:00Z");
const DAY2 = Date.parse("2026-11-13T01:00:00Z");

const turn = (startedAt: number, endedAt: number, tokens?: ActivityTurnSummary["tokens"]): ActivityTurnSummary => ({
  v: 1, startedAt, endedAt, outcome: "completed", actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0,
  ...(tokens ? { tokens } : {}),
});

async function daily(agentId: string) {
  return (await getDb().select().from(agentUsageDaily).where(eq(agentUsageDaily.agentId, agentId)))
    .map((row) => ({ day: String(row.day), model: row.model, input: row.inputNew, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, output: row.output, reasoning: row.reasoningOutput, turns: row.turns }))
    .sort((a, b) => `${a.day}${a.model}`.localeCompare(`${b.day}${b.model}`));
}

test("a turn's tokens are added once: the same summary sent twice counts once", async ({ db }) => {
  void db;
  const { agentId } = await seed("501", true);
  const summary = turn(DAY1 - 5_000, DAY1, { input: 100, cacheRead: 900, output: 40, reasoningOutput: 10, model: "gpt-5", contextUsed: 1_000, contextWindow: 400_000 });
  await upsertAgentTurnSummaries(agentId, [{ turnKey: `daemon:${DAY1 - 5_000}`, summary }]);
  await upsertAgentTurnSummaries(agentId, [{ turnKey: `daemon:${DAY1 - 5_000}`, summary }]);
  assert.deepEqual(await daily(agentId), [
    { day: "2026-11-12", model: "gpt-5", input: 100, cacheRead: 900, cacheWrite: null, output: 40, reasoning: 10, turns: 1 },
  ]);
  const [context] = await getDb().select().from(agentUsageContext).where(eq(agentUsageContext.agentId, agentId));
  assert.equal(context?.contextUsed, 1_000);
  assert.equal(context?.contextWindow, 400_000);
});

test("a rebuilt turn adds only what changed, and moves to its new day and model", async ({ db }) => {
  void db;
  const { agentId } = await seed("502", true);
  const key = `daemon:${DAY1 - 5_000}`;
  await upsertAgentTurnSummaries(agentId, [
    { turnKey: key, summary: turn(DAY1 - 5_000, DAY1, { input: 100, output: 40, model: "gpt-5" }) },
    { turnKey: "daemon:other", summary: turn(DAY1 - 1_000, DAY1, { input: 7, output: 3, model: "gpt-5" }) },
  ]);
  // Same turn, rebuilt: more output, and it now ends the next day on another model.
  await upsertAgentTurnSummaries(agentId, [{ turnKey: key, summary: turn(DAY1 - 5_000, DAY2, { input: 100, output: 50, model: "gpt-5.1" }) }]);
  assert.deepEqual(await daily(agentId), [
    { day: "2026-11-12", model: "gpt-5", input: 7, cacheRead: null, cacheWrite: null, output: 3, reasoning: null, turns: 1 },
    { day: "2026-11-13", model: "gpt-5.1", input: 100, cacheRead: null, cacheWrite: null, output: 50, reasoning: null, turns: 1 },
  ]);
});

test("nothing is added while agent_usage_v0 is off, and a turn without tokens adds nothing", async ({ db }) => {
  void db;
  const off = await seed("503", false);
  await upsertAgentTurnSummaries(off.agentId, [{ turnKey: "daemon:1", summary: turn(DAY1 - 1, DAY1, { input: 5, output: 1 }) }]);
  assert.deepEqual(await daily(off.agentId), []);
  const on = await seed("504", true);
  await upsertAgentTurnSummaries(on.agentId, [{ turnKey: "daemon:1", summary: turn(DAY1 - 1, DAY1) }]);
  assert.deepEqual(await daily(on.agentId), []);
});

test("an older turn rebuilt later never moves the context reading back", async ({ db }) => {
  void db;
  const { agentId } = await seed("505", true);
  await upsertAgentTurnSummaries(agentId, [{ turnKey: "daemon:2", summary: turn(DAY2 - 10, DAY2, { input: 1, contextUsed: 2_000 }) }]);
  await upsertAgentTurnSummaries(agentId, [{ turnKey: "daemon:1", summary: turn(DAY1 - 10, DAY1, { input: 1, contextUsed: 500 }) }]);
  const [context] = await getDb().select().from(agentUsageContext).where(eq(agentUsageContext.agentId, agentId));
  assert.equal(context?.contextUsed, 2_000);
});

test("readAgentUsage answers rows in range, per-agent first days and the server's first day", async ({ db }) => {
  void db;
  const { agentId, serverId } = await seed("506", true);
  await upsertAgentTurnSummaries(agentId, [
    { turnKey: "daemon:a", summary: turn(DAY1 - 10, DAY1, { input: 1, output: 2, model: "m" }) },
    { turnKey: "daemon:b", summary: turn(DAY2 - 10, DAY2, { input: 3, output: 4, model: "m" }) },
  ]);
  const answer = await readAgentUsage({ serverId, agentIds: [agentId, "30000000-0000-4000-8000-000000009999"], from: "2026-11-13", to: "2026-11-13", now: new Date(DAY2) });
  assert.equal(answer.since, "2026-11-12");
  assert.deepEqual(answer.agents, [
    { agent_id: agentId, since: "2026-11-12", usage_reported: true, computer_reports_usage: null, runtime_reports_usage: true },
    { agent_id: "30000000-0000-4000-8000-000000009999", since: null, usage_reported: false, computer_reports_usage: null, runtime_reports_usage: false },
  ]);
  assert.deepEqual(answer.rows, [{
    day: "2026-11-13", agent_id: agentId, runtime: "codex", model: "m",
    input_new: 3, cache_read: null, cache_write: null, output: 4, reasoning_output: null, turns: 1,
  }]);
});

test("computerReportsUsage: 1.25.0 and newer report, prereleases of 1.25.0 count, older or unknown do not", () => {
  assert.equal(computerReportsUsage("1.25.0"), true);
  assert.equal(computerReportsUsage("1.25.1"), true);
  assert.equal(computerReportsUsage("1.26.0"), true);
  assert.equal(computerReportsUsage("2.0.0"), true);
  assert.equal(computerReportsUsage(" 1.25.0 "), true);
  assert.equal(computerReportsUsage("1.25.0-rc.1"), true);
  assert.equal(computerReportsUsage("1.25.0-staging.20261113.sha.abc123"), true);
  assert.equal(computerReportsUsage("1.25.0+build.7"), true);
  assert.equal(computerReportsUsage("1.24.9"), false);
  assert.equal(computerReportsUsage("1.0.70"), false);
  assert.equal(computerReportsUsage("1.24.0-rc.1"), false);
  assert.equal(computerReportsUsage("0.55.5"), false);
  assert.equal(computerReportsUsage(null), false);
  assert.equal(computerReportsUsage(undefined), false);
  assert.equal(computerReportsUsage(""), false);
  assert.equal(computerReportsUsage("unknown"), false);
});

test("readAgentUsage says whether each agent's Computer can report usage, null without a Computer", async ({ db }) => {
  void db;
  const { agentId, serverId, ownerId } = await seed("507", true);
  const machine = async (name: string, computerVersion: string | null) => (await getDb().insert(machines)
    .values({ serverId, userId: ownerId, name, apiKeyHash: `hash-${name}`, computerVersion }).returning())[0]!.id;
  const agent = async (n: number, machineId: string | null) => {
    const id = `30000000-0000-4000-8000-0000005070${n}0`;
    await getDb().insert(agents).values({ id, serverId, name: `agent-507-${n}`, status: "active", model: "gpt-5", runtime: "codex", machineId });
    return id;
  };
  await getDb().update(agents).set({ machineId: await machine("new", "1.25.0") }).where(eq(agents.id, agentId));
  const older = await agent(1, await machine("old", "1.24.3"));
  const prerelease = await agent(2, await machine("rc", "1.25.0-rc.1"));
  const unknown = await agent(3, await machine("unknown", null));
  const noMachine = await agent(4, null);
  const answer = await readAgentUsage({ serverId, agentIds: [agentId, older, prerelease, unknown, noMachine], from: "2026-11-13", to: "2026-11-13", now: new Date(DAY2) });
  assert.deepEqual(answer.agents.map((entry) => [entry.agent_id, entry.computer_reports_usage]), [
    [agentId, true],
    [older, false],
    [prerelease, true],
    [unknown, false],
    [noMachine, null],
  ]);
});

test("readAgentUsage says whether each agent's runtime reports per-turn tokens, false for one that does not or an unknown agent", async ({ db }) => {
  void db;
  const { agentId, serverId } = await seed("508", true);
  const agent = async (n: number, runtime: string) => {
    const id = `30000000-0000-4000-8000-0000005080${n}0`;
    await getDb().insert(agents).values({ id, serverId, name: `agent-508-${n}`, status: "active", model: "m", runtime });
    return id;
  };
  const claude = await agent(1, "claude");
  const qwen = await agent(2, "qwen");
  const antigravity = await agent(3, "antigravity");
  const grok = await agent(4, "grok");
  const unknownRuntime = await agent(5, "not-a-runtime");
  const missing = "30000000-0000-4000-8000-000000509999";
  const answer = await readAgentUsage({ serverId, agentIds: [agentId, claude, qwen, antigravity, grok, unknownRuntime, missing], from: "2026-11-13", to: "2026-11-13", now: new Date(DAY2) });
  assert.deepEqual(answer.agents.map((entry) => [entry.agent_id, entry.runtime_reports_usage]), [
    [agentId, true], // codex
    [claude, true],
    [qwen, true],
    [antigravity, false],
    [grok, false],
    [unknownRuntime, false],
    [missing, false], // no agent row, so no runtime
  ]);
  // agents.runtime is NOT NULL; a null runtime can only reach the check as absent.
  assert.equal(runtimeReportsTurnTokens(null), false);
  assert.equal(runtimeReportsTurnTokens(undefined), false);
});

test("netUsageBuckets keeps a never-reported count null and drops a bucket whose net is zero", () => {
  const state = { tokens: { input: 5, model: "m" }, endedAt: DAY1 };
  assert.deepEqual(netUsageBuckets([{ before: state, after: state }]), []);
  assert.deepEqual(netUsageBuckets([{ after: state }]), [{
    day: "2026-11-12", model: "m", turns: 1, counts: { input: 5, cacheRead: null, cacheWrite: null, output: null, reasoningOutput: null },
  }]);
});

test("pruneAgentUsage deletes days older than 90 and keeps the rest", async ({ db }) => {
  void db;
  const { agentId, serverId } = await seed("507", true);
  await getDb().insert(agentUsageDaily).values([
    { agentId, serverId, day: "2026-08-01", model: "m", inputNew: 1, turns: 1 },
    { agentId, serverId, day: "2026-11-01", model: "m", inputNew: 2, turns: 1 },
  ]);
  const result = await pruneAgentUsage({ now: new Date(DAY1) });
  assert.equal(result.deleted, 1);
  assert.deepEqual((await daily(agentId)).map((row) => row.day), ["2026-11-01"]);
});
