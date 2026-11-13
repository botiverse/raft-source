import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, type SQL } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, appBotBindings, channels, oauthClientInstalls, users } from "../db/schema";
import {
  activeAppBotOrOrdinaryAgent,
  AGENT_KIND_RULES,
  agentFindableBy,
  agentKindOf,
  headcountAgent,
  isAgentFindableBy,
  listedServerAgent,
  seatAgent,
  type AgentKind,
} from "../services/agentMemberListPolicy";
import { createAgent } from "../services/agentService";
import { createOAuthClient } from "../services/oauthService";
import { getServerBillingUsage } from "../services/planService";
import { createServer } from "../services/serverService";

// AGENT_KIND_RULES is the one statement of what each kind of agent may do. Each
// condition is held to it against real rows, so the table can't say one thing
// while a query does another.

const test = createApiTest();

async function seedUser(suffix: string) {
  const [user] = await getDb().insert(users).values({
    email: `kinds-${suffix}@slock.test`,
    name: `kinds-${suffix}`,
    displayName: `kinds-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user!;
}

/** One live agent of each kind in one server, with a removed Bot beside the bound one. */
async function seedKinds() {
  const short = randomUUID().slice(0, 8);
  const owner = await seedUser(short);
  const other = await seedUser(`other-${short}`);
  const server = await createServer("Agent Kinds", `agent-kinds-${short}`, owner.id);
  const db = getDb();
  const ordinary = await createAgent(server.id, `plain-${short}`, { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const assistant = await createAgent(server.id, `helper-${short}`, { runtime: "external", creatorType: "user", creatorId: owner.id, kind: "personal_assistant" });
  await db.update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const bot = async (name: string, state: "active" | "disabled") => {
    const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `${name}-${short}`, name, enableBot: true });
    const [install] = await db.insert(oauthClientInstalls).values({ serverId: server.id, clientId: client.id, installedByUserId: owner.id, status: "active", botGrant: "pending" }).returning();
    const row = await createAgent(server.id, `${name}-${short}`, { runtime: "external", creatorType: "user", creatorId: owner.id });
    await db.update(agents).set({ managedByAppInstallId: install!.id }).where(eq(agents.id, row.id));
    await db.insert(appBotBindings).values({ agentId: row.id, installId: install!.id, serverId: server.id, handle: row.name, state });
    return row;
  };
  const boundBot = await bot("bound-bot", "active");
  const removedBot = await bot("removed-bot", "disabled");
  return { server, owner, other, ids: { ordinary: ordinary.id, assistant: assistant.id, boundBot: boundBot.id, removedBot: removedBot.id } };
}

type Seeded = Awaited<ReturnType<typeof seedKinds>>;
type Name = keyof Seeded["ids"];

const KIND_OF: Record<Name, AgentKind> = { ordinary: "ordinary", assistant: "personal_assistant", boundBot: "app_bot", removedBot: "app_bot" };

async function kept(seeded: Seeded, condition: SQL): Promise<Name[]> {
  const rows = await getDb().select({ id: agents.id }).from(agents)
    .where(and(inArray(agents.id, Object.values(seeded.ids)), condition));
  const found = new Set(rows.map((row) => row.id));
  return (Object.keys(seeded.ids) as Name[]).filter((name) => found.has(seeded.ids[name]));
}

/** What a rule's value keeps: a Bot `while_bound` only while bound. */
function expected(rule: (kind: AgentKind) => boolean | string): Name[] {
  return (Object.keys(KIND_OF) as Name[]).filter((name) => {
    const value = rule(KIND_OF[name]);
    if (value === "while_bound") return name !== "removedBot";
    return value === true || value === "always";
  });
}

test("every condition keeps exactly what AGENT_KIND_RULES says, kind by kind", async ({ app: _app }) => {
  const seeded = await seedKinds();
  assert.deepEqual(await kept(seeded, seatAgent()), expected((kind) => AGENT_KIND_RULES[kind].seat), "seat");
  assert.deepEqual(await kept(seeded, seatAgent()), ["ordinary"]);
  assert.deepEqual(await kept(seeded, headcountAgent()), expected((kind) => AGENT_KIND_RULES[kind].headcount), "headcount");
  assert.deepEqual(await kept(seeded, headcountAgent()), ["ordinary", "boundBot", "removedBot"]);
  assert.deepEqual(await kept(seeded, listedServerAgent()), expected((kind) => AGENT_KIND_RULES[kind].listed), "listed");
  assert.deepEqual(await kept(seeded, listedServerAgent()), ["ordinary", "boundBot"]);
  assert.deepEqual(await kept(seeded, activeAppBotOrOrdinaryAgent()), expected((kind) => AGENT_KIND_RULES[kind].member), "member");
  assert.deepEqual(await kept(seeded, activeAppBotOrOrdinaryAgent()), ["ordinary", "assistant", "boundBot"]);
});

test("findable: a kind that says `owner` is found by its owner and itself, in SQL and on a row alike", async ({ app: _app }) => {
  const seeded = await seedKinds();
  const anyone = (Object.keys(KIND_OF) as Name[]).filter((name) => AGENT_KIND_RULES[KIND_OF[name]].findable === "anyone");
  const all = Object.keys(seeded.ids) as Name[];
  assert.deepEqual(await kept(seeded, agentFindableBy({ userId: seeded.other.id })), anyone, "another person");
  assert.deepEqual(await kept(seeded, agentFindableBy({ userId: seeded.owner.id })), all, "its owner");
  assert.deepEqual(await kept(seeded, agentFindableBy({ agentId: seeded.ids.assistant })), all, "itself");
  assert.deepEqual(await kept(seeded, agentFindableBy({ agentId: seeded.ids.ordinary })), anyone, "another agent");

  const rows = await getDb().select().from(agents).where(inArray(agents.id, Object.values(seeded.ids)));
  for (const row of rows) {
    const expectedForOther = AGENT_KIND_RULES[agentKindOf(row)].findable === "anyone";
    assert.equal(isAgentFindableBy({ userId: seeded.other.id }, row), expectedForOther, row.name);
    assert.equal(isAgentFindableBy({ userId: seeded.owner.id }, row), true, row.name);
  }
});

test("agentKindOf reads a row's kind", async ({ app: _app }) => {
  const seeded = await seedKinds();
  const rows = await getDb().select().from(agents).where(inArray(agents.id, Object.values(seeded.ids)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const name of Object.keys(seeded.ids) as Name[]) {
    assert.equal(agentKindOf(byId.get(seeded.ids[name])!), KIND_OF[name], name);
  }
});

test("billing usage counts only what takes a seat", async ({ app: _app }) => {
  const seeded = await seedKinds();
  const usage = await getServerBillingUsage(getDb(), seeded.server.id);
  assert.equal(usage.agents, 1, "the ordinary agent; not the assistant and not the Bots");
});

test("createAgent reveals #all by the kind's headcount: an assistant grows no team", async ({ app: _app }) => {
  const short = randomUUID().slice(0, 8);
  const owner = await seedUser(`all-${short}`);
  const server = await createServer("Agent Kinds All", `agent-kinds-all-${short}`, owner.id);
  const allType = async () => {
    const [all] = await getDb().select({ type: channels.type }).from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
    return all!.type;
  };
  await createAgent(server.id, `first-${short}`, { runtime: "claude" });
  await createAgent(server.id, `helper-${short}`, { runtime: "external", kind: "personal_assistant" });
  assert.equal(await allType(), "private", "one person, one agent and an assistant are not yet a team");
  await createAgent(server.id, `second-${short}`, { runtime: "claude" });
  assert.equal(await allType(), "channel", "the third member reveals it");
});
