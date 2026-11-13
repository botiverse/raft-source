import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AGENT_USAGE_FEATURE_FLAG_KEY, type ActivityTurnSummary, type AgentUsageResponse } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, featureFlagRules, featureFlags, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { upsertAgentTurnSummaries } from "../services/agentActivityLogService";

const test = createApiTest();

async function human(email: string) {
  const [row] = await getDb().insert(users).values({
    email, name: email.split("@")[0], displayName: email.split("@")[0],
    passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return row;
}

async function fixture(slug: string, usageOn: boolean) {
  const db = getDb();
  const owner = await human(`owner-${slug}@slock.test`);
  const member = await human(`member-${slug}@slock.test`);
  const outsider = await human(`outsider-${slug}@slock.test`);
  const server = await createServer(`Usage ${slug}`, slug, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const ownersAgent = randomUUID();
  const membersAgent = randomUUID();
  await db.insert(agents).values([
    { id: ownersAgent, serverId: server.id, name: `a-${slug}`, status: "active", model: "m", runtime: "codex", creatorType: "user", creatorId: owner.id },
    { id: membersAgent, serverId: server.id, name: `b-${slug}`, status: "active", model: "m", runtime: "claude", creatorType: "user", creatorId: member.id },
  ]);
  if (usageOn) {
    await db.insert(featureFlags).values({ key: AGENT_USAGE_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false }).onConflictDoNothing();
    await db.insert(featureFlagRules).values({ flagKey: AGENT_USAGE_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  }
  return { owner, member, outsider, server, ownersAgent, membersAgent };
}

const END = Date.parse("2026-11-12T10:00:00Z");
const turn = (tokens: ActivityTurnSummary["tokens"]): ActivityTurnSummary => ({
  v: 1, startedAt: END - 1_000, endedAt: END, outcome: "completed", actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0, tokens,
});

test("agent-usage answers only the agents the reader may inspect, and 404s when off or for non-members", async ({ app }) => {
  const f = await fixture("agent-usage-on", true);
  await upsertAgentTurnSummaries(f.ownersAgent, [{ turnKey: "daemon:1", summary: turn({ input: 10, output: 2, model: "gpt" }) }]);
  await upsertAgentTurnSummaries(f.membersAgent, [{ turnKey: "daemon:1", summary: turn({ input: 5, cacheRead: 50, output: 1, model: "opus" }) }]);
  const url = `${app.baseUrl}/api/servers/${f.server.id}/agent-usage?from=2026-11-12&to=2026-11-12`;
  const get = async (email: string, suffix = "") => fetch(url + suffix, { headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": f.server.id } });

  const asOwner = await get(f.owner.email);
  assert.equal(asOwner.status, 200);
  const ownerBody = await asOwner.json() as AgentUsageResponse;
  assert.equal(ownerBody.visible_agents, 2, "the owner inspects every agent");
  assert.deepEqual(ownerBody.rows.map((row) => row.agent_id).sort(), [f.ownersAgent, f.membersAgent].sort());
  assert.equal(ownerBody.since, "2026-11-12");
  assert.deepEqual([ownerBody.from, ownerBody.to], ["2026-11-12", "2026-11-12"]);

  const asMember = await get(f.member.email);
  const memberBody = await asMember.json() as AgentUsageResponse;
  assert.equal(memberBody.visible_agents, 1, "a member inspects only the agent they created");
  assert.deepEqual(memberBody.rows.map((row) => row.agent_id), [f.membersAgent]);
  assert.deepEqual(Object.keys(memberBody.rows[0]).sort(), ["agent_id", "cache_read", "cache_write", "day", "input_new", "model", "output", "reasoning_output", "runtime", "turns"]);

  const filtered = await (await get(f.owner.email, `&agents=${f.ownersAgent}`)).json() as AgentUsageResponse;
  assert.deepEqual(filtered.rows.map((row) => row.agent_id), [f.ownersAgent]);
  assert.equal(filtered.visible_agents, 2, "a filter narrows the rows, not the count of agents the reader can see");

  assert.ok([403, 404].includes((await get(f.outsider.email)).status), "a non-member reads nothing");
  assert.equal((await get(f.owner.email, "&from=2026-13-01")).status, 400);

  const off = await fixture("agent-usage-off", false);
  const offRead = await fetch(`${app.baseUrl}/api/servers/${off.server.id}/agent-usage`, { headers: { Authorization: `Bearer ${await tokenForHuman(off.owner.email)}`, "X-Server-Id": off.server.id } });
  assert.equal(offRead.status, 404);
});
