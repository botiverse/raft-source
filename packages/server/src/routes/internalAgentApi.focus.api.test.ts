import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Focus, part 1 (flag `agent_focus_v0`): `POST /internal/agent-api/focus`,
 * `POST /unfocus`, `GET /focus`. An agent keeps at most three threads, DMs
 * or task conversations in focus; a plain channel is refused; a conversation
 * it can't read answers as an unknown one; with the flag off for its server
 * every route refuses AGENT_FOCUS_DISABLED.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { AGENT_FOCUS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentFocusTargets, featureFlagRules, users } from "../db/schema";
import { fixturePasswordHash } from "../test/integration/credentials";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, findOrCreateDM, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";
import { focusResolvedTarget } from "./agentFocusRoutes";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }) {
  const deliverMessage = async () => ({ status: "queued" as const });
  app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<unknown>) => batch.map(() => deliverMessage()),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
}

/** Turn Focus on for one server the way Feature Flag Admin does (the migration seeds the flag default off). */
async function enableFocus(serverId: string): Promise<void> {
  await getDb().insert(featureFlagRules).values({
    flagKey: AGENT_FOCUS_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

async function setup(slug: string, opts: { focus: boolean }) {
  const [owner] = await getDb().insert(users).values({
    email: `${slug}-${randomUUID()}@slock.test`,
    name: `${slug}-${randomUUID().slice(0, 8)}`,
    displayName: `${slug} owner`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  const server = await createServer(`Focus ${slug}`, `${slug}-${randomUUID()}`, owner!.id);
  if (opts.focus) await enableFocus(server.id);
  const channel = await createChannel(server.id, slug);
  await addHuman(channel.id, owner!.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks", "channels"],
    name: `focus-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  return { owner: owner!, server, channel, agent, key: apiKey };
}

type Entry = { target: string; kind: string; source: string; focusedAt: string; lastActiveAt: string };
type Body = {
  [key: string]: unknown;
  code?: string;
  error?: string;
  suggestedNextAction?: string;
  focused?: Entry;
  alreadyFocused?: boolean;
  evicted?: Entry[];
  entries?: Entry[];
  limit?: number;
  target?: string;
  wasFocused?: boolean;
};

async function call(baseUrl: string, apiKey: string, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Body };
}

async function thread(channel: { id: string; name: string }, ownerId: string, text: string) {
  const parent = await createMessage(channel.id, "user", ownerId, text);
  const row = await getOrCreateThread(parent.id, ownerId, "user");
  await createMessage(row.id, "user", ownerId, `${text}: a reply`);
  return { id: row.id, target: `#${channel.name}:${parent.id.slice(0, 8)}` };
}

async function stored(agentId: string) {
  return getDb().select().from(agentFocusTargets).where(eq(agentFocusTargets.agentId, agentId));
}

const targets = (entries: Entry[] | undefined) => (entries ?? []).map((entry) => entry.target);

test("flag off for the agent's server: focus, unfocus and the list refuse AGENT_FOCUS_DISABLED and store nothing", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, channel, agent, key } = await setup("focus-off", { focus: false });
  const one = await thread(channel, owner.id, "root");

  for (const answer of [
    await call(app.baseUrl, key, "POST", "focus", { target: one.target }),
    await call(app.baseUrl, key, "POST", "unfocus", { target: one.target }),
    await call(app.baseUrl, key, "GET", "focus"),
  ]) {
    assert.equal(answer.status, 404, JSON.stringify(answer.body));
    assert.equal(answer.body.code, "AGENT_FOCUS_DISABLED");
    assert.equal(answer.body.errorCode, "AGENT_FOCUS_DISABLED");
    assert.match(String(answer.body.error), /^Focus is not switched on for this server yet/);
    // The sentence names no command; the next step does.
    assert.doesNotMatch(String(answer.body.error), /raft /);
    assert.equal(answer.body.suggestedNextAction, "raft inbox check");
  }
  assert.deepEqual(await stored(agent.id), []);
});

test("focus a thread, a DM and a task conversation; the list names them as the agent addresses them; a fourth unfocuses the least recently active", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, server, channel, agent, key } = await setup("focus-on", { focus: true });
  await enableTaskV2ConversationsForServer(server.id);
  const first = await thread(channel, owner.id, "first root");
  const second = await thread(channel, owner.id, "second root");
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  const dmTarget = `dm:@${owner.name}`;
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "a task" }]);
  const taskTarget = `#${channel.name}:#${task!.taskNumber}`;

  const empty = await call(app.baseUrl, key, "GET", "focus");
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body, { entries: [], limit: 3 });

  const focusedThread = await call(app.baseUrl, key, "POST", "focus", { target: first.target });
  assert.equal(focusedThread.status, 200, JSON.stringify(focusedThread.body));
  assert.equal(focusedThread.body.ok, true);
  assert.equal(focusedThread.body.alreadyFocused, false);
  assert.deepEqual(focusedThread.body.evicted, []);
  assert.equal(focusedThread.body.limit, 3);
  assert.equal(focusedThread.body.focused?.target, first.target);
  assert.equal(focusedThread.body.focused?.kind, "thread");
  assert.equal(focusedThread.body.focused?.source, "manual");
  assert.ok(Number.isFinite(Date.parse(focusedThread.body.focused!.lastActiveAt)));
  assert.deepEqual(targets(focusedThread.body.entries), [first.target]);
  assert.deepEqual((await stored(agent.id)).map((row) => [row.channelId, row.source]), [[first.id, "manual"]]);

  const focusedDm = await call(app.baseUrl, key, "POST", "focus", { target: dmTarget });
  assert.equal(focusedDm.status, 200, JSON.stringify(focusedDm.body));
  assert.equal(focusedDm.body.focused?.target, dmTarget);
  assert.equal(focusedDm.body.focused?.kind, "dm");

  // A task nobody has written in yet has no conversation to focus.
  const pending = await call(app.baseUrl, key, "POST", "focus", { target: taskTarget });
  assert.equal(pending.status, 409, JSON.stringify(pending.body));
  assert.equal(pending.body.code, "FOCUS_TASK_NO_CONVERSATION");
  assert.doesNotMatch(String(pending.body.error), /raft /);
  assert.ok(String(pending.body.suggestedNextAction).includes(`raft task reply "${taskTarget}"`), String(pending.body.suggestedNextAction));
  assert.equal((await call(app.baseUrl, key, "POST", "tasks/follow", { channel: `#${channel.name}`, task_number: task!.taskNumber })).status, 200);
  const focusedTask = await call(app.baseUrl, key, "POST", "focus", { target: taskTarget });
  assert.equal(focusedTask.status, 200, JSON.stringify(focusedTask.body));
  assert.equal(focusedTask.body.focused?.target, taskTarget);
  assert.equal(focusedTask.body.focused?.kind, "task");
  assert.equal(focusedTask.body.alreadyFocused, false);
  assert.deepEqual(targets(focusedTask.body.entries), [taskTarget, dmTarget, first.target]);

  const listed = await call(app.baseUrl, key, "GET", "focus");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(targets(listed.body.entries), [taskTarget, dmTarget, first.target]);
  assert.deepEqual(listed.body.entries?.map((entry) => entry.kind), ["task", "dm", "thread"]);
  assert.equal(listed.body.limit, 3);

  // Already focused: refreshed (it moves to the front), nothing unfocused.
  const again = await call(app.baseUrl, key, "POST", "focus", { target: first.target });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.alreadyFocused, true);
  assert.deepEqual(again.body.evicted, []);
  assert.deepEqual(targets(again.body.entries), [first.target, taskTarget, dmTarget]);

  // A fourth: the least recently active (the DM) is unfocused and named, so the agent can put it back.
  const fourth = await call(app.baseUrl, key, "POST", "focus", { target: second.target });
  assert.equal(fourth.status, 200, JSON.stringify(fourth.body));
  assert.deepEqual(targets(fourth.body.evicted), [dmTarget]);
  assert.equal(fourth.body.evicted?.[0]?.kind, "dm");
  assert.deepEqual(targets(fourth.body.entries), [second.target, first.target, taskTarget]);
  assert.equal((await stored(agent.id)).length, 3);

  const unfocused = await call(app.baseUrl, key, "POST", "unfocus", { target: first.target });
  assert.equal(unfocused.status, 200, JSON.stringify(unfocused.body));
  assert.deepEqual(
    { ok: unfocused.body.ok, target: unfocused.body.target, wasFocused: unfocused.body.wasFocused, limit: unfocused.body.limit },
    { ok: true, target: first.target, wasFocused: true, limit: 3 },
  );
  assert.deepEqual(targets(unfocused.body.entries), [second.target, taskTarget]);

  const unfocusedAgain = await call(app.baseUrl, key, "POST", "unfocus", { target: first.target });
  assert.equal(unfocusedAgain.status, 200, JSON.stringify(unfocusedAgain.body));
  assert.equal(unfocusedAgain.body.wasFocused, false);
  assert.deepEqual(targets(unfocusedAgain.body.entries), [second.target, taskTarget]);

  // The unfocus is remembered in the table, but the list (above) never shows it; focusing it again brings it back.
  assert.equal((await stored(agent.id)).filter((row) => row.unfocusedAt !== null).length, 1);
  assert.deepEqual(targets((await call(app.baseUrl, key, "GET", "focus")).body.entries), [second.target, taskTarget]);
  const back = await call(app.baseUrl, key, "POST", "focus", { target: first.target });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.alreadyFocused, false);
  assert.equal(back.body.focused?.source, "manual");
  assert.deepEqual(targets(back.body.entries), [first.target, second.target, taskTarget]);
  assert.deepEqual((await stored(agent.id)).filter((row) => row.unfocusedAt !== null), []);
});

test("a plain channel is refused: channel focus is deliberately not available yet", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { channel, agent, key } = await setup("focus-chan", { focus: true });
  for (const path of ["focus", "unfocus"]) {
    const refused = await call(app.baseUrl, key, "POST", path, { target: `#${channel.name}` });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "FOCUS_CHANNEL_UNAVAILABLE");
    assert.match(String(refused.body.error), /^Channel focus is deliberately not available yet: focus a thread, a DM or a task conversation instead/);
    assert.doesNotMatch(String(refused.body.error), /raft /);
    assert.equal(refused.body.suggestedNextAction, "raft inbox check");
  }
  assert.deepEqual(await stored(agent.id), []);
});

test("a conversation the agent can't read answers exactly as an unknown one, and one it loses leaves its list", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, server, channel, agent, key } = await setup("focus-vis", { focus: true });
  const secret = await createChannel(server.id, `secret-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(secret.id, owner.id);
  const hidden = await thread(secret, owner.id, "hidden root");
  const visible = await thread(channel, owner.id, "visible root");

  const notVisible = await call(app.baseUrl, key, "POST", "focus", { target: hidden.target });
  const unknown = await call(app.baseUrl, key, "POST", "focus", { target: `#${channel.name}:deadbeef` });
  assert.equal(notVisible.status, 404, JSON.stringify(notVisible.body));
  assert.equal(notVisible.body.code, "NOT_FOUND");
  assert.equal(notVisible.body.error, "Not found, or you don't have access.");
  assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
  assert.deepEqual(notVisible.body, unknown.body);
  assert.deepEqual(await stored(agent.id), []);

  // The valid-access witness: the same agent focuses a thread it can read.
  assert.equal((await call(app.baseUrl, key, "POST", "focus", { target: visible.target })).status, 200);

  // Focused while it could read it, then it lost access: gone from the list and from storage.
  await addAgent(secret.id, agent.id);
  const whileMember = await call(app.baseUrl, key, "POST", "focus", { target: hidden.target });
  assert.equal(whileMember.status, 200, JSON.stringify(whileMember.body));
  assert.deepEqual(targets(whileMember.body.entries), [hidden.target, visible.target]);
  await getDb().execute(`delete from channel_agents where channel_id = '${secret.id}' and agent_id = '${agent.id}'`);
  const after = await call(app.baseUrl, key, "GET", "focus");
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.deepEqual(targets(after.body.entries), [visible.target]);
  assert.deepEqual((await stored(agent.id)).map((row) => row.channelId), [visible.id]);
});

test("a conversation with no address to give back is not focused: nothing is stored and nothing is let go", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, server, channel, agent, key } = await setup("focus-noaddr", { focus: true });
  const kept = [];
  for (const text of ["one", "two", "three"]) {
    const item = await thread(channel, owner.id, `${text} root`);
    assert.equal((await call(app.baseUrl, key, "POST", "focus", { target: item.target })).status, 200);
    kept.push(item);
  }
  const before = (await stored(agent.id)).map((row) => row.channelId).sort();
  assert.equal(before.length, 3);

  // A fourth the agent can read, but whose address does not render: at the
  // limit, so a write before the render would already have let one go.
  const fourth = await thread(channel, owner.id, "four root");
  const refused = await focusResolvedTarget(
    { serverId: server.id, agentId: agent.id, channelId: fourth.id as never },
    { renderTargets: async () => new Map() },
  );
  assert.equal(refused, null);
  assert.deepEqual((await stored(agent.id)).map((row) => row.channelId).sort(), before);

  // The witness: the same conversation is focused once its address renders.
  const ok = await focusResolvedTarget({ serverId: server.id, agentId: agent.id, channelId: fourth.id as never });
  assert.equal(ok?.target, fourth.target);
  assert.equal(ok?.result.evicted.length, 1);
});
