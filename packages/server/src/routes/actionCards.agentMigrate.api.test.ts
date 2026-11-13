// agent:migrate ("move me"): prepare stores the preparing agent as the card's
// Agent and resolves the suggested computer by name; the card is never
// executed by the server (DIALOG_REQUIRED); mark-executed records the move
// only once one really started (a migration of the card's Agent to that
// computer since the card was posted), and only for whoever the migration
// route lets move it: the Agent's creator or migrateAgents.
//
// With `agent`, an agent asks for ANOTHER agent's move (an ops agent that
// prepared the workspace): prepare resolves the handle on the server (same
// server, not deleted, findable by the preparing agent) and stores only its id
// as the card's Agent; who may act, and mark-executed, bind to that Agent.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { actionCards, agentMigrations, agents, machines, messages, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { ActionCardError, prepareActionCard } from "../services/actionCardsService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function seed(app: { app: { set: (key: string, value: unknown) => void } }) {
  const deliverMessage = async () => ({ status: "queued", reason: "test" });
  app.app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<unknown>) => batch.map(() => deliverMessage()),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
  const owner = await seedUser("migrate-owner");
  const creator = await seedUser("migrate-creator");
  const other = await seedUser("migrate-other");
  const server = await createServer("Migrate Card", `migrate-card-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: creator.id, role: "member" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]);
  const channel = await channelService.createChannel(server.id, `migrate-${randomUUID().slice(0, 6)}`);
  for (const user of [owner, creator, other]) await channelService.addHuman(channel.id, user.id);
  const [source, target] = await getDb().insert(machines).values([
    { serverId: server.id, userId: creator.id, name: "macbook-pro", apiKeyHash: `migrate-src-${randomUUID()}`, runtimes: ["claude"] },
    { serverId: server.id, userId: creator.id, name: "mac-mini", apiKeyHash: `migrate-dst-${randomUUID()}`, runtimes: ["claude"] },
  ]).returning();
  const agent = await createAgent(server.id, `migrate-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await getDb().update(agents).set({ displayName: "Kimi Intern", creatorType: "user", creatorId: creator.id, machineId: source!.id }).where(eq(agents.id, agent.id));
  await channelService.addAgent(channel.id, agent.id);
  const headersFor = async (user: { email: string }) => ({
    Authorization: `Bearer ${await tokenForHuman(user.email)}`, "Content-Type": "application/json", "X-Server-Id": server.id,
  });
  return { owner, creator, other, server, channel, agent, source: source!, target: target!, headersFor };
}

/** The refusal's code, as the routes send it (`code`, or `errorCode` on some). */
async function codeOf(response: Response): Promise<string | undefined> {
  const body = await response.json() as { code?: string; errorCode?: string };
  return body.code ?? body.errorCode;
}

async function startMigration(f: Awaited<ReturnType<typeof seed>>, targetMachineId: string) {
  const deadline = new Date(Date.now() + 10 * 60_000);
  await getDb().insert(agentMigrations).values({
    contractVersion: 2,
    serverId: f.server.id,
    agentId: f.agent.id,
    sourceMachineId: f.source.id,
    targetMachineId,
    sourceMachineNameSnapshot: "macbook-pro",
    targetMachineNameSnapshot: "mac-mini",
    state: "prep",
    grantKey: `migrate-card:${randomUUID()}`,
    prepDeadlineAt: deadline,
    transferDeadlineAt: deadline,
    arrivalDeadlineAt: deadline,
  });
}

test("prepare: the card is the preparing agent's, its suggestion resolved by name; the server never executes it", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id, agentAuthored: true,
    action: { type: "agent:migrate", suggestedComputer: "mac-mini", draftHint: "My computer is offline." },
  });
  assert.deepEqual(card.metadata.action, { type: "agent:migrate", suggestedComputer: f.target.id, draftHint: "My computer is offline.", agentId: f.agent.id });
  const title = card.metadata.presentation?.card?.title;
  assert.ok(title && typeof title !== "string");
  assert.deepEqual(title.params?.agent, { kind: "agent", id: f.agent.id, fallback: "Kimi Intern" });
  const executed = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
    method: "POST", headers: await f.headersFor(f.creator), body: JSON.stringify({}),
  });
  assert.equal(executed.status, 409, await executed.clone().text());
  assert.equal(await codeOf(executed), "DIALOG_REQUIRED");
});

test("mark-executed: only once a move of the card's Agent to that computer started, and only by its creator or migrateAgents", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "agent:migrate", suggestedComputer: f.target.id },
  });
  const mark = async (user: { email: string }, result: unknown) => fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
    method: "POST", headers: await f.headersFor(user), body: JSON.stringify({ result }),
  });
  const result = { kind: "agent-migration", agentId: f.agent.id, targetMachineId: f.target.id };

  // Nothing started yet: the card stays open.
  const early = await mark(f.creator, result);
  assert.equal(early.status, 409, await early.clone().text());
  assert.equal(await codeOf(early), "MIGRATION_NOT_STARTED");

  await startMigration(f, f.target.id);
  // A member who is not its creator: the migration route's rule refuses them.
  const stranger = await mark(f.other, result);
  assert.equal(stranger.status, 403, await stranger.clone().text());
  assert.equal(await codeOf(stranger), "MISSING_MIGRATE_AGENTS_CAPABILITY");
  // Another Agent than the card's: refused.
  const mismatch = await mark(f.creator, { ...result, agentId: randomUUID() });
  assert.equal(mismatch.status, 409, await mismatch.clone().text());
  assert.equal(await codeOf(mismatch), "MIGRATION_RESULT_MISMATCH");

  const done = await mark(f.creator, result);
  assert.equal(done.status, 200, await done.clone().text());
  const metadata = (await done.json() as { metadata: ActionCardMetadata }).metadata;
  assert.equal(metadata.state, "executed");
  assert.deepEqual(metadata.result, result);
  const summary = metadata.presentation?.card?.result?.elements.summary;
  assert.ok(summary?.type === "Text" && typeof summary.props.text !== "string");
  assert.equal(summary.props.text.key, "actionCard.result.migrationStarted");
  assert.deepEqual(summary.props.text.params, {
    agent: { kind: "agent", id: f.agent.id, fallback: "Kimi Intern" },
    to: { kind: "computer", id: f.target.id, fallback: f.target.id.slice(0, 8) },
  });
});

test("mark-executed: someone with migrateAgents (the owner) may record it for an Agent they did not create", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "agent:migrate" },
  });
  await startMigration(f, f.target.id);
  const done = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
    method: "POST", headers: await f.headersFor(f.owner),
    body: JSON.stringify({ result: { kind: "agent-migration", agentId: f.agent.id, targetMachineId: f.target.id } }),
  });
  assert.equal(done.status, 200, await done.clone().text());
});

async function markAs(app: { baseUrl: string }, f: Awaited<ReturnType<typeof seed>>, messageId: string, targetMachineId: string) {
  return fetch(`${app.baseUrl}/api/actions/${messageId}/mark-executed`, {
    method: "POST", headers: await f.headersFor(f.creator),
    body: JSON.stringify({ result: { kind: "agent-migration", agentId: f.agent.id, targetMachineId } }),
  });
}

test("mark-executed: an Agent already on that computer when the card was prepared, with no move since, does not close it (Tenny, #14018)", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "agent:migrate" },
  });
  const refused = await markAs(app, f, card.messageId, f.source.id);
  assert.equal(refused.status, 409, await refused.clone().text());
  assert.equal(await codeOf(refused), "MIGRATION_NOT_STARTED");
});

test("mark-executed: an Agent on no computer when the card was prepared, then placed on one, closes it", async ({ app }) => {
  const f = await seed(app);
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, f.agent.id));
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "agent:migrate" },
  });
  const early = await markAs(app, f, card.messageId, f.target.id);
  assert.equal(early.status, 409, await early.clone().text());
  assert.equal(await codeOf(early), "MIGRATION_NOT_STARTED");
  await getDb().update(agents).set({ machineId: f.target.id }).where(eq(agents.id, f.agent.id));
  const done = await markAs(app, f, card.messageId, f.target.id);
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal((await done.json() as { metadata: ActionCardMetadata }).metadata.state, "executed");
});

test("prepare: the computer the agent was on is the server's own record (the action_cards row), never in the action clients see (Tenny, #14018)", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id,
    action: { type: "agent:migrate", suggestedComputer: f.target.id },
  });
  const [row] = await getDb().select({ payload: actionCards.payload }).from(actionCards).where(eq(actionCards.messageId, card.messageId));
  assert.equal((row?.payload as { fromMachineId?: unknown }).fromMachineId, f.source.id);
  const [message] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, card.messageId));
  const stored = message?.actionMetadata as ActionCardMetadata;
  for (const metadata of [card.metadata, stored]) {
    assert.equal(Object.hasOwn(metadata.action, "fromMachineId"), false);
    assert.equal(JSON.stringify(metadata.presentation?.displayItems ?? []).includes(f.source.id), false);
    assert.equal(JSON.stringify(metadata.presentation?.displayItems ?? []).includes("fromMachineId"), false);
    // The card shows it only as its Current computer reference, with no name the server gave it.
    assert.deepEqual(metadata.presentation?.card?.spec.elements.currentComputer?.props, {
      label: { key: "actionCard.field.currentComputer", text: { en: "Current computer", "zh-cn": "当前的计算机" } },
      value: [{ kind: "computer", id: f.source.id, fallback: f.source.id.slice(0, 8) }],
      mono: true,
    });
  }
  // As a client reads it: no key, and the computer's name nowhere (a viewer who
  // may list computers gets it from their own list).
  const read = await fetch(`${app.baseUrl}/api/messages/channel/${f.channel.id}?limit=10`, { headers: await f.headersFor(f.creator) });
  const body = await read.text();
  assert.equal(read.status, 200, body);
  assert.ok(body.includes(card.messageId), body);
  assert.equal(body.includes("fromMachineId"), false);
  assert.equal(body.includes("macbook-pro"), false, "the current computer's name is not on the card");
});

test("an Agent on no computer: no Current computer field; a done card keeps the field it had", async ({ app }) => {
  const f = await seed(app);
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, f.agent.id));
  const placed = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id, action: { type: "agent:migrate" },
  });
  assert.equal(placed.metadata.presentation?.card?.spec.elements.currentComputer, undefined);
  // On a computer: the field, and still there once done.
  await getDb().update(agents).set({ machineId: f.source.id }).where(eq(agents.id, f.agent.id));
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id, action: { type: "agent:migrate" },
  });
  await startMigration(f, f.target.id);
  const done = await markAs(app, f, card.messageId, f.target.id);
  assert.equal(done.status, 200, await done.clone().text());
  const metadata = (await done.json() as { metadata: ActionCardMetadata }).metadata;
  assert.equal(metadata.state, "executed");
  const field = metadata.presentation?.card?.spec.elements.currentComputer;
  assert.ok(field?.type === "Field", JSON.stringify(field));
  assert.deepEqual(field.props.value, [{ kind: "computer", id: f.source.id, fallback: f.source.id.slice(0, 8) }]);
});

// ---------------------------------------------------------------------------
// Another agent's move (`agent`).

/** An ops agent in the card's channel, created by `other` (so not the moved Agent's creator), on no computer. */
async function seedOps(f: Awaited<ReturnType<typeof seed>>) {
  const ops = await createAgent(f.server.id, `ops-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await getDb().update(agents).set({ displayName: "IT Ops", creatorType: "user", creatorId: f.other.id, machineId: null }).where(eq(agents.id, ops.id));
  await channelService.addAgent(f.channel.id, ops.id);
  return ops;
}

async function prepareAs(f: Awaited<ReturnType<typeof seed>>, requesterAgentId: string, action: Record<string, unknown>) {
  return prepareActionCard({
    serverId: f.server.id, requesterAgentId, targetChannelId: f.channel.id, agentAuthored: true,
    action: { type: "agent:migrate", ...action } as Parameters<typeof prepareActionCard>[0]["action"],
  });
}

async function cardsBy(requesterAgentId: string) {
  return getDb().select({ id: actionCards.id }).from(actionCards).where(eq(actionCards.requesterAgentId, requesterAgentId));
}

/** The refusal an unknown, hidden or unnamed-by-handle agent gets: one 422, a next step, and no card. */
async function assertRefused(f: Awaited<ReturnType<typeof seed>>, requesterAgentId: string, agent: string) {
  await assert.rejects(prepareAs(f, requesterAgentId, { agent }), (err: unknown) => {
    assert.ok(err instanceof ActionCardError, String(err));
    assert.equal(err.status, 422);
    assert.equal(err.code, "INVALID_HANDLE");
    assert.match(err.message, /^agent: /u);
    assert.match(err.suggestedNextAction ?? "", /raft server info --agents/u);
    return true;
  });
  assert.deepEqual(await cardsBy(requesterAgentId), [], "no card is posted");
}

test("prepare: `agent` left out, or naming the preparer, is the preparer's own move, with no Requested by line", async ({ app }) => {
  const f = await seed(app);
  for (const action of [{}, { agent: `@${f.agent.name}` }]) {
    const card = await prepareAs(f, f.agent.id, action);
    assert.deepEqual(card.metadata.action, { type: "agent:migrate", agentId: f.agent.id });
    assert.equal(card.metadata.presentation?.card?.spec.elements.requestedBy, undefined);
  }
});

test("prepare: `agent` names another agent by handle; the card is that agent's, says who asked, and keeps no handle", async ({ app }) => {
  const f = await seed(app);
  const ops = await seedOps(f);
  const card = await prepareAs(f, ops.id, { agent: `@${f.agent.name}`, suggestedComputer: "mac-mini", draftHint: "Workspace is ready on mac-mini." });
  assert.deepEqual(card.metadata.action, { type: "agent:migrate", suggestedComputer: f.target.id, draftHint: "Workspace is ready on mac-mini.", agentId: f.agent.id });
  assert.equal(card.metadata.requesterAgentId, ops.id);
  const spec = card.metadata.presentation?.card;
  assert.ok(spec && typeof spec.title !== "string");
  assert.deepEqual(spec.title.params?.agent, { kind: "agent", id: f.agent.id, fallback: "Kimi Intern" });
  const requestedBy = spec.spec.elements.requestedBy;
  assert.ok(requestedBy?.type === "Text" && typeof requestedBy.props.text !== "string", JSON.stringify(requestedBy));
  assert.equal(requestedBy.props.text.key, "actionCard.migrateAgent.requestedBy");
  assert.deepEqual(requestedBy.props.text.params, { agent: { kind: "agent", id: ops.id, fallback: "IT Ops" } });
  // The server's record: the preparer, and the computer the MOVED agent was on (not the preparer's).
  const [row] = await getDb().select({ requesterAgentId: actionCards.requesterAgentId, payload: actionCards.payload })
    .from(actionCards).where(eq(actionCards.messageId, card.messageId));
  assert.equal(row?.requesterAgentId, ops.id);
  assert.deepEqual(row?.payload, { type: "agent:migrate", suggestedComputer: f.target.id, draftHint: "Workspace is ready on mac-mini.", agentId: f.agent.id, fromMachineId: f.source.id });
  // A bare handle (no @) is the same agent.
  const bare = await prepareAs(f, ops.id, { agent: f.agent.name });
  assert.equal((bare.metadata.action as { agentId?: string }).agentId, f.agent.id);
});

test("prepare: an unknown agent, one on another server, a deleted one, or an id is refused with a next step and posts no card", async ({ app }) => {
  const f = await seed(app);
  const ops = await seedOps(f);
  await assertRefused(f, ops.id, "@nobody-here");
  // Same handle on another server: not this server's agent.
  const elsewhere = await createServer("Elsewhere", `elsewhere-${randomUUID().slice(0, 8)}`, f.owner.id);
  const foreign = await createAgent(elsewhere.id, `foreign-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await assertRefused(f, ops.id, `@${foreign.name}`);
  // Deleted (archived).
  const gone = await createAgent(f.server.id, `gone-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.id));
  await assertRefused(f, ops.id, `@${gone.name}`);
  // An id is not a handle (agent-facing identity contract), even a real agent's.
  await assertRefused(f, ops.id, f.agent.id);
});

test("prepare: a personal assistant is not found by another agent (the by-name visibility rule), and gets the unknown agent's refusal", async ({ app }) => {
  const f = await seed(app);
  const ops = await seedOps(f);
  const assistant = await createAgent(f.server.id, `assistant-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await getDb().update(agents).set({ assistantOwnerUserId: f.creator.id, machineId: null }).where(eq(agents.id, assistant.id));
  await assertRefused(f, ops.id, `@${assistant.name}`);
});

test("prepare: a person with the agent's name does not make `agent` ambiguous (it names only agents; agent names are unique on a server)", async ({ app }) => {
  const f = await seed(app);
  const ops = await seedOps(f);
  const namesake = await seedUser("namesake");
  await getDb().update(users).set({ name: f.agent.name }).where(eq(users.id, namesake.id));
  await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: namesake.id, role: "member" });
  const card = await prepareAs(f, ops.id, { agent: `@${f.agent.name}` });
  assert.equal((card.metadata.action as { agentId?: string }).agentId, f.agent.id);
});

test("another agent's card: who may act and mark-executed bind to the moved Agent, not the preparer; the preparer is told, naming it", async ({ app }) => {
  const f = await seed(app);
  const ops = await seedOps(f);
  const card = await prepareAs(f, ops.id, { agent: `@${f.agent.name}`, suggestedComputer: "mac-mini" });
  const mark = async (user: { email: string }, result: unknown) => fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
    method: "POST", headers: await f.headersFor(user), body: JSON.stringify({ result }),
  });
  const result = { kind: "agent-migration", agentId: f.agent.id, targetMachineId: f.target.id };
  await startMigration(f, f.target.id);
  // The preparer's creator is not the moved Agent's: refused, as the migration route would.
  const preparersCreator = await mark(f.other, result);
  assert.equal(preparersCreator.status, 403, await preparersCreator.clone().text());
  assert.equal(await codeOf(preparersCreator), "MISSING_MIGRATE_AGENTS_CAPABILITY");
  // A result for the preparer (or any other agent) does not close the card.
  const forPreparer = await mark(f.creator, { ...result, agentId: ops.id });
  assert.equal(forPreparer.status, 409, await forPreparer.clone().text());
  assert.equal(await codeOf(forPreparer), "MIGRATION_RESULT_MISMATCH");
  // The moved Agent's creator: done.
  const done = await mark(f.creator, result);
  assert.equal(done.status, 200, await done.clone().text());
  const metadata = (await done.json() as { metadata: ActionCardMetadata }).metadata;
  assert.deepEqual(metadata.result, result);
  // The done card still says who asked.
  const requestedBy = metadata.presentation?.card?.spec.elements.requestedBy;
  assert.ok(requestedBy?.type === "Text" && typeof requestedBy.props.text !== "string");
  assert.deepEqual(requestedBy.props.text.params, { agent: { kind: "agent", id: ops.id, fallback: "IT Ops" } });
  // The preparer's result reply names the moved agent; it is not told "you".
  const replies = await getDb().select({ content: messages.content }).from(messages)
    .where(eq(messages.systemSubtype, "action_card.result_reply"));
  const reply = replies.find((row) => row.content.startsWith(`@${ops.name} `));
  assert.ok(reply, JSON.stringify(replies));
  assert.match(reply.content, new RegExp(`Result: started moving @${f.agent.name} to another computer; it restarts there once the move completes\\.`, "u"));
  assert.doesNotMatch(reply.content, /moving you/u);
});

test("the agent's own card: its result reply still tells it \"you\"", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareAs(f, f.agent.id, {});
  await startMigration(f, f.target.id);
  const done = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
    method: "POST", headers: await f.headersFor(f.creator),
    body: JSON.stringify({ result: { kind: "agent-migration", agentId: f.agent.id, targetMachineId: f.target.id } }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  const replies = await getDb().select({ content: messages.content }).from(messages).where(eq(messages.systemSubtype, "action_card.result_reply"));
  const reply = replies.find((row) => row.content.startsWith(`@${f.agent.name} `));
  assert.ok(reply, JSON.stringify(replies));
  assert.match(reply.content, /Result: started moving you to another computer; you restart there once the move completes\./u);
});
