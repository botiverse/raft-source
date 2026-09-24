import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createApiTest } from "../test/integration/apiTest.js";
import { fixturePasswordHash } from "../test/integration/credentials.js";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { thirdPartyAgentEvents, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createOAuthClient } from "../services/oauthService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

/**
 * `agent-event:<id8>` — the idempotent re-read for a third-party event (task #257).
 *
 * The address is printed in every rendered third-party line, and nothing implemented
 * a read for it: `message check` handed the body over once and consumed the cursor, so
 * an agent woken by an event could see it exactly once and never return to it.
 *
 * Two error states, not three (@Tao's ruling, @Tenny's #145 neutrality policy confirmed
 * as covering id-addressed routes):
 *
 *   EXPIRED    only ever for an event that IS yours -> tells you nothing new
 *   NOT_FOUND  "no such event" AND "not yours", byte-identical
 *
 * ⚠️ The other agent's event is a REAL fixture on purpose. If it were merely an id that
 * did not exist, the equality below would hold by construction and no change to the
 * lookup could ever redden it — the same trap `internalAgentApi.threadRead.test.ts`
 * documents for its B/D pair.
 */
function agentHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

const shortIdOf = (id: string): string => id.slice(0, 8);

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `agent-event-${suffix}@slock.test`,
    name: `agent-event-${suffix}`,
    displayName: "Agent Event Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("Agent Event Read", `agent-event-${suffix.slice(0, 8)}`, owner.id);
  const mine = await createAgent(server.id, "EventReaderBot", { runtime: "claude", model: "sonnet" });
  const other = await createAgent(server.id, "OtherOwnerBot", { runtime: "claude", model: "sonnet" });

  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `agent-event-${suffix.slice(0, 8)}`,
    name: "Agent Event Client",
    allowedScopes: ["openid", "agent:event:write", "agent:notification:write"],
  });

  const insertEvent = async (agentId: string, summary: string, expiresAt: Date, payload: Record<string, unknown>) => {
    const [row] = await db.insert(thirdPartyAgentEvents).values({
      serverId: server.id,
      agentId,
      clientId: client.id,
      externalEventId: `ext-${randomUUID()}`,
      kind: "notification",
      summary,
      payload,
      payloadHash: "0".repeat(64),
      resource: `urn:raft:server:${server.id}:agent-inbound`,
      status: "queued",
      expiresAt,
    }).returning();
    return row;
  };

  const insertEventWithId = async (id: string, agentId: string, summary: string, expiresAt: Date, payload: Record<string, unknown>) => {
    const [row] = await db.insert(thirdPartyAgentEvents).values({
      id,
      serverId: server.id,
      agentId,
      clientId: client.id,
      externalEventId: `ext-${randomUUID()}`,
      kind: "notification",
      summary,
      payload,
      payloadHash: "0".repeat(64),
      resource: `urn:raft:server:${server.id}:agent-inbound`,
      status: "queued",
      expiresAt,
    }).returning();
    return row;
  };

  const hour = 60 * 60 * 1000;
  const live = await insertEvent(mine.id, "your move: g6", new Date(Date.now() + hour), { move: "g6" });
  const expired = await insertEvent(mine.id, "stale turn", new Date(Date.now() - hour), { move: "e4" });
  // REAL and owned by someone else — see the header note.
  const foreign = await insertEvent(other.id, "not for you", new Date(Date.now() + hour), { secret: "x" });

  // Two events the caller OWNS behind ONE 8-hex address. The formatter prints the
  // same short target for both, so if a collision resolved to "absent" the caller
  // could never re-read either -- the guarantee this route exists for.
  const collideA = await insertEventWithId(
    "abcd1234-1111-4111-8111-111111111111", mine.id, "collide A", new Date(Date.now() + hour), { which: "A" },
  );
  const collideB = await insertEventWithId(
    "abcd1234-2222-4222-8222-222222222222", mine.id, "collide B", new Date(Date.now() + hour), { which: "B" },
  );

  const credential = await mintAgentCredential({
    agentId: mine.id,
    scopes: ["send", "read"],
    name: "agent-event-read",
    createdByUserId: null,
  });

  return { apiKey: credential.apiKey, live, expired, foreign, collideA, collideB };
}

async function readRaw(baseUrl: string, apiKey: string, target: string) {
  const res = await fetch(
    `${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}`,
    { headers: agentHeaders(apiKey) },
  );
  // Raw text, not parsed JSON: the neutrality claim is about the bytes on the wire.
  // Comparing parsed objects would pass an implementation that echoed the requested
  // id in a differently-ordered but semantically equal body.
  return { status: res.status, text: await res.text() };
}

test("agent-event:<id> re-reads your own event, and hides everyone else's identically", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, {
    humanActivityMuteFlagDefaultEnabled: true,
    onboardingOpenerFlagDefaultEnabled: false,
  });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  const read = (target: string) => readRaw(app.baseUrl, fx.apiKey, target);

  // Control first. If this does not genuinely succeed, every "absent" assertion
  // below is measured against a command that never works at all.
  const live = await read(`agent-event:${shortIdOf(fx.live.id)}`);
  assert.equal(live.status, 200, `re-reading your own live event must succeed: ${live.text}`);
  const body = JSON.parse(live.text) as { messages?: Array<Record<string, unknown>> };
  assert.equal(body.messages?.length, 1, "expected exactly the one event");
  assert.match(live.text, /your move: g6/, "the summary must come back");
  assert.match(live.text, /"g6"/, "the payload must come back -- re-reading the body is the point");

  // Yours + expired: distinguishable, because you already had visibility of it.
  const expired = await read(`agent-event:${shortIdOf(fx.expired.id)}`);
  assert.equal(expired.status, 410, `expired must be its own state: ${expired.text}`);
  assert.match(expired.text, /"errorCode":"EXPIRED"/);

  // The neutrality tooth: someone else's REAL event vs an id that exists nowhere.
  const foreign = await read(`agent-event:${shortIdOf(fx.foreign.id)}`);
  const unknown = await read("agent-event:0123abcd");
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(
    foreign.text,
    unknown.text,
    "another agent's event id and an unknown id must be byte-identical, or this route is an enumeration oracle",
  );
  assert.ok(
    !foreign.text.includes(shortIdOf(fx.foreign.id)),
    "the neutral body must not echo the requested id",
  );
  assert.ok(!foreign.text.includes("not for you"), "no part of another agent's event may leak");
});

test("a short address shared by two of your own events is recoverable, not lost", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, {
    humanActivityMuteFlagDefaultEnabled: true,
    onboardingOpenerFlagDefaultEnabled: false,
  });
  onTestFinished(() => app.close());
  const fx = await seedFixture();
  const read = (target: string) => readRaw(app.baseUrl, fx.apiKey, target);

  // The short form both events print resolves to neither -- but it must SAY so,
  // not return the neutral 404. Returning "absent" would be safe and would still
  // leave both of the caller's own live events permanently unreadable.
  const short = await read(`agent-event:${shortIdOf(fx.collideA.id)}`);
  assert.equal(short.status, 409, `an owned collision must be named, not hidden: ${short.text}`);
  assert.match(short.text, /"errorCode":"AMBIGUOUS_ID"/);

  // ...and the advice must be executable: each full id reads its own event.
  const a = await read(`agent-event:${fx.collideA.id}`);
  const b = await read(`agent-event:${fx.collideB.id}`);
  assert.equal(a.status, 200, `the full id must resolve: ${a.text}`);
  assert.equal(b.status, 200, `the full id must resolve: ${b.text}`);
  assert.match(a.text, /"which":"A"/);
  assert.match(b.text, /"which":"B"/);
  assert.ok(!a.text.includes("collide B"), "the full id must select ONE event, not both");

  // The remedy is only executable if the full id is obtainable from ordinary
  // output. It is: the rendered body carries `event_id: <uuid>`.
  assert.match(a.text, new RegExp(`event_id: ${fx.collideA.id}`),
    "the full event id must be recoverable from the standard rendered body");

  // A full id belonging to someone else stays byte-identical to an unknown one.
  const foreignFull = await read(`agent-event:${fx.foreign.id}`);
  const unknownFull = await read("agent-event:99999999-9999-4999-8999-999999999999");
  assert.equal(foreignFull.status, 404);
  assert.equal(foreignFull.text, unknownFull.text,
    "the full-id path must be as neutral as the short-id path");
});
