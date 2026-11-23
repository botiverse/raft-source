// RFC 081 D7 D8 D11 (#wg-ax:#17): `POST /api/oauth/agent-events` takes
// `object.ref` (the inbox item key) and `object.conversation` (resolved for the
// receiving agent, dropped with a warning when it can't open it, never
// refused), and hints "add object.ref" when it is missing. Validation errors
// are their own class: a field the app got wrong is a 400, whatever its
// message says (a too-long summary used to be a 500). First-party apps pass
// the same through the notice outbox.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { channels, servers, thirdPartyAgentEvents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, findOrCreateDM, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { renderRelatedTargets } from "../services/agentInboxItems";
import { createOAuthClient, requestAgentAccess } from "../services/oauthService";
import { appNoticeOutbox } from "../services/firstPartyAppHost";
import { firstPartyAppOfSystemApp } from "../apps/firstPartyApps";

const test = createApiTest();
/** The Artifacts app's object kind (apps/artifacts/kinds.ts; core tests do not import an app). */
const ARTIFACT_OBJECT_KIND = "artifact";

async function seed(app: { baseUrl: string }) {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `agent-events-object-${suffix}@slock.test`,
    name: `agent-events-object-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Agent Events Object", `aeo-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `ObjBot${suffix.slice(0, 4)}`, { runtime: "external", model: "external" });
  const general = await createChannel(server.id, `general-${suffix}`);
  await addHuman(general.id, owner!.id);
  await addAgent(general.id, agent.id);
  const hidden = await createChannel(server.id, `hidden-${suffix}`, undefined, "private");
  await addHuman(hidden.id, owner!.id);
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner!.id,
    clientId: `stamp-${suffix}`,
    name: "Stamp",
    returnUrl: "https://stamp.example.test/callback",
    allowedScopes: ["openid", "profile", "agent:notification:write"],
  });
  const [row] = await db.select({ slug: servers.slug }).from(servers).where(eq(servers.id, server.id));
  const { request } = await requestAgentAccess({
    clientId: client.id,
    serverSlug: row!.slug,
    agentId: agent.id,
    scopes: ["openid", "profile", "agent:notification:write"],
    initiatedByAgent: true,
  });
  const token = await fetch(`${app.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret,
      grantType: "urn:slock:grant-type:agent_request",
      requestId: request.id,
      resource: `urn:raft:server:${server.id}:agent-inbound`,
    }),
  });
  assert.equal(token.status, 200, await token.clone().text());
  const accessToken = (await token.json() as { access_token: string }).access_token;
  const send = async (body: Record<string, unknown>) => {
    const res = await fetch(`${app.baseUrl}/api/oauth/agent-events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "notification", summary: "checks failed on 3f4b1fd4", ...body }),
    });
    return { status: res.status, body: await res.json() as any };
  };
  return { owner: owner!, server, agent, general, hidden, client, send };
}

async function stored(id: string) {
  const [row] = await getDb().select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, id));
  return row!;
}

test("D7 D11: object.ref is kept as sent and returned; without it the answer hints to add it", async ({ app }) => {
  const s = await seed(app);
  const withRef = await s.send({ object: { ref: "  botiverse/slock#13754  " } });
  assert.equal(withRef.status, 202, JSON.stringify(withRef.body));
  assert.equal(withRef.body.objectRef, "botiverse/slock#13754", "trimmed, case and punctuation kept");
  assert.equal((await stored(withRef.body.id)).objectRef, "botiverse/slock#13754");
  assert.equal(withRef.body.warnings, undefined, "nothing to change");

  const withoutRef = await s.send({});
  assert.equal(withoutRef.status, 202);
  assert.equal((await stored(withoutRef.body.id)).objectRef, null);
  assert.deepEqual(withoutRef.body.warnings, [
    `object.ref is missing: this notice goes into the app's catch-all item app:${s.client.clientId}. Send object.ref (the thing it is about, e.g. a PR) so notices about one object are read together.`,
  ]);

  // A deduped repeat keeps the first event's ref.
  const first = await s.send({ externalEventId: "ev-1", object: { ref: "pr-1" } });
  const repeat = await s.send({ externalEventId: "ev-1", object: { ref: "pr-2" } });
  assert.deepEqual([repeat.status, repeat.body.deduped, repeat.body.id, repeat.body.objectRef], [200, true, first.body.id, "pr-1"]);
});

test("D7: a malformed object or object.ref is a 400 naming the field; a too-long summary is a 400 too, not a 500", async ({ app }) => {
  const s = await seed(app);
  for (const object of [{ ref: "" }, { ref: "has space" }, { ref: "-lead" }, { ref: "x".repeat(129) }, { ref: 7 }, { ref: "ünï" }]) {
    const res = await s.send({ object });
    assert.equal(res.status, 400, JSON.stringify({ object, body: res.body }));
    assert.match(res.body.error, /^object\.ref must be 1-128 characters/);
  }
  assert.equal((await s.send({ object: "pr-1" })).status, 400);
  assert.match((await s.send({ object: { conversation: 12 } })).body.error, /^object\.conversation/);
  assert.equal((await s.send({ object: { ref: "x".repeat(128) } })).status, 202, "128 is the limit");

  const long = await s.send({ summary: "s".repeat(2001) });
  assert.equal(long.status, 400, JSON.stringify(long.body));
  assert.match(long.body.error, /^summary is too long/);
  // The other field errors still answer 400 by class.
  assert.equal((await s.send({ kind: "nope" })).status, 400);
  assert.equal((await s.send({ ttlSeconds: -1 })).status, 400);
  assert.equal((await s.send({ externalEventId: "e".repeat(201) })).status, 400);
});

test("D8: object.conversation is kept when the receiving agent can open it, and dropped with one warning otherwise, never refused", async ({ app }) => {
  const s = await seed(app);
  const kept = await s.send({ object: { ref: "pr-1", conversation: `#${s.general.name}` } });
  assert.equal(kept.status, 202, JSON.stringify(kept.body));
  assert.equal((await stored(kept.body.id)).relatedChannelId, s.general.id);
  assert.equal(kept.body.warnings, undefined);

  const hidden = await s.send({ object: { ref: "pr-1", conversation: `#${s.hidden.name}` } });
  const unknown = await s.send({ object: { ref: "pr-1", conversation: "#no-such-channel" } });
  for (const res of [hidden, unknown]) {
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal((await stored(res.body.id)).relatedChannelId, null);
  }
  assert.deepEqual(hidden.body.warnings, unknown.body.warnings, "the same answer for a conversation that exists and one that does not");
  assert.deepEqual(hidden.body.warnings, ["object.conversation was not kept: the receiving agent can't open that conversation. The notice was accepted without it."]);
});

test("D8: a thread form naming a message no one has replied to is kept as that message's thread, created as message send creates it, and listed as <parent>:<msg8>", async ({ app }) => {
  const s = await seed(app);
  const conversationOf = async (res: { status: number; body: any }) => {
    assert.equal(res.status, 202, JSON.stringify(res.body));
    return (await stored(res.body.id)).relatedChannelId;
  };
  const threadOf = async (channelId: string | null) => {
    assert.ok(channelId, "kept");
    const [row] = await getDb().select({ type: channels.type, parentMessageId: channels.parentMessageId }).from(channels).where(eq(channels.id, channelId));
    return row!;
  };
  const listed = async (channelId: string) => (await renderRelatedTargets(s.server.id, s.agent.id, [channelId])).get(channelId);

  // A channel the agent is in, a message with no replies (no thread yet).
  const root = await createMessage(s.general.id, "user", s.owner.id, "ship it?");
  const inChannel = await s.send({ object: { ref: "pr-1", conversation: `#${s.general.name}:${root.id.slice(0, 8)}` } });
  const channelThread = await conversationOf(inChannel);
  assert.deepEqual(await threadOf(channelThread), { type: "thread", parentMessageId: root.id });
  assert.equal(inChannel.body.warnings, undefined);
  assert.equal(await listed(channelThread!), `#${s.general.name}:${root.id.slice(0, 8)}`, "the inbox names it as the agent wrote it");
  // The same notice again finds the same thread.
  assert.equal(await conversationOf(await s.send({ object: { ref: "pr-1", conversation: `#${s.general.name}:${root.id.slice(0, 8)}` } })), channelThread);

  // The same in a DM.
  const dm = await findOrCreateDM(s.server.id, s.owner.id, s.agent.id);
  assert.ok(dm);
  const dmRoot = await createMessage(dm.id, "user", s.owner.id, "can you look?");
  const inDm = await s.send({ object: { ref: "pr-1", conversation: `dm:@${s.owner.name}:${dmRoot.id.slice(0, 8)}` } });
  const dmThread = await conversationOf(inDm);
  assert.deepEqual(await threadOf(dmThread), { type: "thread", parentMessageId: dmRoot.id });
  assert.equal(await listed(dmThread!), `dm:@${s.owner.name}:${dmRoot.id.slice(0, 8)}`);

  // An existing thread still resolves (to itself).
  const replied = await createMessage(s.general.id, "user", s.owner.id, "already discussed");
  const existing = await getOrCreateThread(replied.id, s.owner.id, "user");
  assert.equal(await conversationOf(await s.send({ object: { ref: "pr-1", conversation: `#${s.general.name}:${replied.id.slice(0, 8)}` } })), existing.id);
});

test("D8: a thread form the agent may not post in, or naming no message, is dropped with the same warning and starts no thread", async ({ app }) => {
  const s = await seed(app);
  // A public channel the agent is not in (it could read it, not post in it), and the private one it can't see.
  const elsewhere = await createChannel(s.server.id, `elsewhere-${randomUUID().slice(0, 8)}`);
  await addHuman(elsewhere.id, s.owner.id);
  const publicRoot = await createMessage(elsewhere.id, "user", s.owner.id, "not for the agent");
  const hiddenRoot = await createMessage(s.hidden.id, "user", s.owner.id, "secret");
  const generalRoot = await createMessage(s.general.id, "user", s.owner.id, "in general");
  const dropped = [
    await s.send({ object: { ref: "pr-1", conversation: `#${elsewhere.name}:${publicRoot.id.slice(0, 8)}` } }),
    await s.send({ object: { ref: "pr-1", conversation: `#${s.hidden.name}:${hiddenRoot.id.slice(0, 8)}` } }),
    // A message of another channel, named under one the agent is in.
    await s.send({ object: { ref: "pr-1", conversation: `#${s.general.name}:${hiddenRoot.id.slice(0, 8)}` } }),
    // No such message.
    await s.send({ object: { ref: "pr-1", conversation: `#${s.general.name}:00000000` } }),
    await s.send({ object: { ref: "pr-1", conversation: `dm:@${s.owner.name}:00000000` } }),
  ];
  for (const res of dropped) {
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal((await stored(res.body.id)).relatedChannelId, null);
    assert.deepEqual(res.body.warnings, ["object.conversation was not kept: the receiving agent can't open that conversation. The notice was accepted without it."]);
  }
  const started = await getDb().select({ id: channels.id }).from(channels)
    .where(inArray(channels.parentMessageId, [publicRoot.id, hiddenRoot.id, generalRoot.id]));
  assert.deepEqual(started, [], "no thread started");
});

test("D11: a first-party app's notice carries its object ref and related conversation through the outbox; a malformed ref is refused", async ({ app }) => {
  const s = await seed(app);
  const artifacts = firstPartyAppOfSystemApp("system.artifacts");
  assert.ok(artifacts, "the Artifacts app is registered");
  const outbox = appNoticeOutbox(artifacts, undefined);
  const { eventId } = await outbox.queue(getDb(), {
    serverId: asServerId(s.server.id),
    agentId: s.agent.id,
    summary: "A comment on your Artifact",
    kind: ARTIFACT_OBJECT_KIND,
    event: { action: "commented" },
    ttlMs: 60_000,
    now: new Date(),
    objectRef: "pt_3f4b1fd4-1111-4222-8333-444444444444",
    relatedChannelId: s.general.id,
  });
  const row = await stored(eventId);
  assert.deepEqual([row.systemApp, row.objectRef, row.relatedChannelId], ["system.artifacts", "pt_3f4b1fd4-1111-4222-8333-444444444444", s.general.id]);
  await assert.rejects(outbox.queue(getDb(), {
    serverId: asServerId(s.server.id),
    agentId: s.agent.id,
    summary: "x",
    kind: ARTIFACT_OBJECT_KIND,
    event: {},
    ttlMs: 60_000,
    now: new Date(),
    objectRef: "has space",
  }), /is not an inbox object ref/);
});
