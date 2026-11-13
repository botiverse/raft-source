// RFC 081 D7 D8 D11 (#wg-ax:#17): `POST /api/oauth/agent-events` takes
// `object.ref` (the inbox item key) and `object.conversation` (resolved for the
// receiving agent, dropped with a warning when it can't open it, never
// refused), and hints "add object.ref" when it is missing. Validation errors
// are their own class: a field the app got wrong is a 400, whatever its
// message says (a too-long summary used to be a 500). First-party apps pass
// the same through the notice outbox.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { servers, thirdPartyAgentEvents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
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
  return { server, agent, general, hidden, client, send };
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
