import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RAFT_HINTS } from "@botiverse/raft-shared";
import { refusalBody } from "../lib/refusal";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentCredentials, appBotBindings, messages, oauthClientInstalls, oauthClients, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createOAuthClient } from "../services/oauthService";
import { createManagedAppBot, issueManagedAppBotCredential, resolveAppBotDmPeerUserId } from "../services/appBotIdentityService";
import { parseAppSubject, type AppSubject } from "../services/appSubjectService";

/**
 * `dm:sub:<sub>` (packages/cli/AGENTS.md, the one exception to the
 * agent-facing identity reference contract): an App Bot, with its App's own
 * key, names a person by the `sub` its App received at Sign in with Raft
 * (today `users.id`). Everyone else, and every miss, gets the answer staging
 * gives any target it cannot resolve, byte for byte. A resolved person goes
 * through the same DM path as `dm:@<handle>~human`.
 */

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const SEND_PATHS = ["send", "v2/send"] as const;
type SendPath = typeof SEND_PATHS[number];

/** What the send routes answer for any target they cannot resolve (none of these is a thread target). */
const notFoundBody = (target: string) => JSON.stringify(refusalBody({
  code: "target_not_found",
  error: `Nothing you can post in matches ${target}: check the target, or find the conversation in the server's directory.`,
  next: RAFT_HINTS.serverInfo(),
}));

async function seedUser(label: string, id?: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    ...(id ? { id } : {}),
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function join(serverId: string, userId: string, role: "member" | "guest" = "member") {
  if (role === "guest") await seedBoundGuest({ serverId, userId });
  else await getDb().insert(serverMembers).values({ serverId, userId, role });
}

async function seedWorld() {
  const db = getDb();
  const owner = await seedUser("dm-sub-owner");
  const server = await createServer("App Bot DM by sub", `dm-sub-${randomUUID().slice(0, 8)}`, owner.id);
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `dm-sub-bot-${randomUUID().slice(0, 8)}`,
    name: "DM Sub Bot",
    enableBot: true,
  });
  const [install] = await db.insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "granted",
  }).returning();
  const bot = await db.transaction((tx) => createManagedAppBot(tx, { installId: install!.id, serverId: server.id }));
  // The App's own key, as POST /api/oauth/installations/:id/bot-token issues it.
  const issued = await issueManagedAppBotCredential({ clientId: client.id, installationId: install!.id, rotate: false });
  assert.ok(issued.ok);

  const grace = await createAgent(server.id, `Grace${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" });
  const graceKey = await mintAgentCredential({ agentId: grace.id, scopes: ["send", "read"], name: "dm-sub-ordinary", issuedVia: "computer", createdByUserId: null });

  return {
    owner,
    server,
    client,
    install: install!,
    bot: { agentId: bot.agentId, apiKey: issued.apiKey, credentialId: issued.credentialId },
    grace: { agentId: grace.id, apiKey: graceKey.apiKey, credentialId: graceKey.credentialId },
  };
}

async function send(baseUrl: string, apiKey: string, path: SendPath, target: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target, content: `hello via ${path}`, idempotencyKey: randomUUID() }),
  });
  return { status: res.status, text: await res.text() };
}

/** The conversation a successful send landed in (checking it was sent as `senderId`). */
async function sentChannelId(sent: { status: number; text: string }, senderId: string, label: string): Promise<string> {
  assert.equal(sent.status, 200, `${label}: ${sent.text}`);
  const { messageId } = JSON.parse(sent.text) as { messageId: string };
  const [row] = await getDb().select({ channelId: messages.channelId, senderId: messages.senderId })
    .from(messages).where(eq(messages.id, messageId));
  assert.ok(row, label);
  assert.equal(row.senderId, senderId, label);
  return row.channelId;
}

function subject(raw: string): AppSubject {
  const parsed = parseAppSubject(raw);
  assert.ok(parsed, raw);
  return parsed;
}

test("an App Bot's dm:sub:<member sub> lands in the DM dm:@<handle>~human names, in either order (send and v2/send)", async ({ app }) => {
  const world = await seedWorld();
  const bot = world.bot.agentId;
  for (const path of SEND_PATHS) {
    // The DM exists first (opened by handle), then the sub finds it.
    const viaHandleFirst = await seedUser(`dm-sub-a-${path.replace("/", "")}`);
    await join(world.server.id, viaHandleFirst.id);
    const byHandle = await sentChannelId(await send(app.baseUrl, world.bot.apiKey, path, `dm:@${viaHandleFirst.name}~human`), bot, `${path} handle`);
    const bySubSent = await send(app.baseUrl, world.bot.apiKey, path, `dm:sub:${viaHandleFirst.id}`);
    assert.equal(await sentChannelId(bySubSent, bot, `${path} sub`), byHandle);
    assert.ok(!bySubSent.text.includes(viaHandleFirst.id), `${path}: the answer never echoes the sub`);

    // The sub opens the DM, then the handle finds the same one.
    const viaSubFirst = await seedUser(`dm-sub-b-${path.replace("/", "")}`);
    await join(world.server.id, viaSubFirst.id);
    const opened = await sentChannelId(await send(app.baseUrl, world.bot.apiKey, path, `dm:sub:${viaSubFirst.id}`), bot, `${path} sub first`);
    assert.equal(await sentChannelId(await send(app.baseUrl, world.bot.apiKey, path, `dm:@${viaSubFirst.name}~human`), bot, `${path} handle after`), opened);
    assert.notEqual(opened, byHandle);
  }
});

test("an App Bot's misses are byte-identical: no such sub, not a member, guest, retired, removed (send and v2/send)", async ({ app }) => {
  const world = await seedWorld();
  const db = getDb();
  for (const path of SEND_PATHS) {
    const sub = randomUUID();
    const target = `dm:sub:${sub}`;
    const miss = await send(app.baseUrl, world.bot.apiKey, path, target);
    assert.equal(miss.status, 404);
    assert.equal(miss.text, notFoundBody(target), `${path}: the answer for any unresolvable target`);
    const assertMiss = async (state: string) => {
      const res = await send(app.baseUrl, world.bot.apiKey, path, target);
      assert.deepEqual(res, miss, `${path} ${state}: same status and body as a sub nobody has`);
    };

    // The same sub through each state: only the person behind it changes.
    const person = await seedUser(`dm-sub-c-${path.replace("/", "")}`, sub);
    await assertMiss("account exists, not a member of the Bot's Server");

    await join(world.server.id, person.id);
    const dmChannelId = await sentChannelId(await send(app.baseUrl, world.bot.apiKey, path, target), world.bot.agentId, `${path} member (control)`);
    // `dm:user:` is the inert spelling of `dm:@name` and a legacy task-ref alias,
    // never this form: with the same member sub it stays the old not-found.
    const userSpelling = `dm:user:${sub}`;
    assert.deepEqual(await send(app.baseUrl, world.bot.apiKey, path, userSpelling), { status: 404, text: notFoundBody(userSpelling) }, `${path} ${userSpelling}`);

    // Guests do not use Apps, even with a DM already open.
    await seedBoundGuest({ serverId: world.server.id, userId: person.id }, db);
    await assertMiss("guest");
    assert.equal((await send(app.baseUrl, world.bot.apiKey, path, `dm:@${person.name}~human`)).status, 200, "the open DM itself still works by handle");

    await db.update(serverMembers).set({ role: "member", guestChannelId: null })
      .where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, person.id)));
    await db.update(users).set({ retiredAt: new Date() }).where(eq(users.id, person.id));
    await assertMiss("retired account");

    await db.update(users).set({ retiredAt: null }).where(eq(users.id, person.id));
    await db.delete(serverMembers)
      .where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, person.id)));
    await assertMiss("removed from the Server");

    // Not a sub at all, or a thread suffix (top-level DMs only): the same answer for that string.
    await join(world.server.id, person.id);
    const [root] = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, dmChannelId)).limit(1);
    for (const other of [`dm:sub:${sub}:${root!.id.slice(0, 8)}`, "dm:sub:not-a-sub", "dm:sub:", `dm:sub:${sub} `]) {
      const res = await send(app.baseUrl, world.bot.apiKey, path, other);
      assert.deepEqual(res, { status: 404, text: notFoundBody(other) }, `${path} ${JSON.stringify(other)}`);
    }
  }
});

test("dm:sub is refused to every other caller exactly like a sub nobody has (send and v2/send)", async ({ app }) => {
  const world = await seedWorld();
  const db = getDb();
  // A key a person minted for the Bot's agent is not the App's key.
  const personKey = await mintAgentCredential({ agentId: world.bot.agentId, scopes: ["send", "read"], name: "dm-sub-person-minted", issuedVia: "human", createdByUserId: world.owner.id });
  for (const path of SEND_PATHS) {
    const member = await seedUser(`dm-sub-d-${path.replace("/", "")}`);
    await join(world.server.id, member.id);
    const target = `dm:sub:${member.id}`;

    const ordinary = await send(app.baseUrl, world.grace.apiKey, path, target);
    assert.deepEqual(ordinary, { status: 404, text: notFoundBody(target) }, `${path}: an ordinary agent, valid member sub`);
    const personMinted = await send(app.baseUrl, personKey.apiKey, path, target);
    assert.deepEqual(personMinted, ordinary, `${path}: the Bot's agent with a person-minted key`);
    // Control: the same person is reachable to both by handle; only the form is refused.
    assert.equal((await send(app.baseUrl, world.grace.apiKey, path, `dm:@${member.name}~human`)).status, 200);

    // The App Bot's answer for the same string once nobody in its Server has
    // that sub is the same bytes: nothing tells a caller the form exists.
    await db.delete(serverMembers).where(and(eq(serverMembers.serverId, world.server.id), eq(serverMembers.userId, member.id)));
    assert.deepEqual(await send(app.baseUrl, world.bot.apiKey, path, target), ordinary, `${path}: App Bot, not a member`);
  }
});

test("an inactive Bot resolves no one: binding, installation, Bot grant, App, credential", async ({ app }) => {
  const world = await seedWorld();
  const db = getDb();
  const member = await seedUser("dm-sub-e");
  await join(world.server.id, member.id);
  const sub = subject(member.id);
  const resolve = (input: Partial<Parameters<typeof resolveAppBotDmPeerUserId>[0]> = {}) => resolveAppBotDmPeerUserId({
    serverId: world.server.id,
    agentId: world.bot.agentId,
    credentialId: world.bot.credentialId,
    sub,
    ...input,
  });
  assert.equal(await resolve(), member.id, "control: a live Bot with its App's key");

  const toggles: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
    ["binding disabled",
      () => db.update(appBotBindings).set({ state: "disabled" }).where(eq(appBotBindings.agentId, world.bot.agentId)),
      () => db.update(appBotBindings).set({ state: "active" }).where(eq(appBotBindings.agentId, world.bot.agentId))],
    ["installation suspended",
      () => db.update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, world.install.id)),
      () => db.update(oauthClientInstalls).set({ status: "active" }).where(eq(oauthClientInstalls.id, world.install.id))],
    ["Bot grant revoked",
      () => db.update(oauthClientInstalls).set({ botGrant: "revoked" }).where(eq(oauthClientInstalls.id, world.install.id)),
      () => db.update(oauthClientInstalls).set({ botGrant: "granted" }).where(eq(oauthClientInstalls.id, world.install.id))],
    ["App disabled",
      () => db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, world.client.id)),
      () => db.update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, world.client.id))],
  ];
  for (const [state, off, on] of toggles) {
    await off();
    assert.equal(await resolve(), null, state);
    await on();
    assert.equal(await resolve(), member.id, `${state} restored`);
  }
  const personKey = await mintAgentCredential({ agentId: world.bot.agentId, scopes: ["send"], name: "dm-sub-person-minted", issuedVia: "human", createdByUserId: world.owner.id });
  assert.equal(await resolve({ credentialId: personKey.credentialId }), null, "a person-minted key for the Bot");
  assert.equal(await resolve({ credentialId: undefined }), null, "no credential");
  assert.equal(await resolve({ agentId: world.grace.agentId, credentialId: world.grace.credentialId }), null, "an ordinary agent");
  assert.equal(await resolve({ credentialId: world.grace.credentialId }), null, "another agent's credential");
  const otherServer = await createServer("Other", `dm-sub-other-${randomUUID().slice(0, 8)}`, world.owner.id);
  await join(otherServer.id, member.id);
  assert.equal(await resolve({ serverId: otherServer.id }), null, "another Server");

  // Over HTTP the auth middleware refuses a Bot whose binding, installation
  // or grant is not live before the target is read: the same 401 for any sub.
  await db.update(appBotBindings).set({ state: "disabled" }).where(eq(appBotBindings.agentId, world.bot.agentId));
  const refusedMember = await send(app.baseUrl, world.bot.apiKey, "v2/send", `dm:sub:${member.id}`);
  assert.equal(refusedMember.status, 401);
  const refusedNobody = await send(app.baseUrl, world.bot.apiKey, "v2/send", `dm:sub:${randomUUID()}`);
  assert.deepEqual(refusedNobody, refusedMember);
  await db.update(appBotBindings).set({ state: "active" }).where(eq(appBotBindings.agentId, world.bot.agentId));

  // A disabled App's Bot still authenticates; its dm:sub is a plain miss.
  await db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, world.client.id));
  const disabledApp = await send(app.baseUrl, world.bot.apiKey, "v2/send", `dm:sub:${member.id}`);
  assert.deepEqual(disabledApp, { status: 404, text: notFoundBody(`dm:sub:${member.id}`) });

  // Revoking the App's key ends it (and the middleware already refuses it).
  await db.update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, world.client.id));
  await db.update(agentCredentials).set({ revokedAt: new Date() }).where(eq(agentCredentials.id, world.bot.credentialId));
  assert.equal(await resolve(), null, "revoked credential");
});
