// #wg-ax:#24, RFC 081 D7 "one item, one read state": an app event that comes
// in while its inbox item (`app:<app>/<object.ref>`, or `app:<app>`) already
// has unread events is added to it without waking the agent again. Only the
// wake is skipped: the event stays readable in the item, and no re-delivery
// (the daemon's rebuild, the inbox push sweep) pushes it as a wake later.
// After the item is read, the next event wakes as usual. Inbox items off:
// every event is its own notice, as before.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { servers, thirdPartyAgentEvents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createOAuthClient, listPendingThirdPartyAgentEventMessages, markThirdPartyAgentEventsDelivered, rebuildPendingThirdPartyAgentEventMessages, requestAgentAccess } from "../services/oauthService";
import { AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, createFeatureFlag } from "../services/featureFlagService";
import { INBOX_ITEMS_LAUNCH_AT_ENV, listAgentAppItemGroups } from "../services/agentInboxItems";
import { __resetInboxItemsLaunchWarningsForTests, inboxItemsLaunch } from "../services/inboxItemsLaunch";
import { createSystemAppAgentEvent, deliverSystemAppAgentEvent } from "../services/systemAppAgentEvents";
import { wakeForEventsMergedSinceHandover } from "../services/appItemWakeCoalescing";

const test = createApiTest();

beforeEach(() => {
  __resetInboxItemsLaunchWarningsForTests();
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "2026-01-01T00:00:00.000Z");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seed(app: { baseUrl: string }) {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `wake-coalesce-${suffix}@slock.test`,
    name: `wake-coalesce-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Wake Coalesce", `wkc-${suffix}`, owner!.id);
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

async function itemsOn() {
  await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
}

test("a second event on an unread item joins it without a wake; another object, or the fallback item, is its own item", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const first = await s.send({ object: { ref: "slip_BTC" }, summary: "slippage 9bp" });
  const second = await s.send({ object: { ref: "slip_BTC" }, summary: "slippage 12bp" });
  const other = await s.send({ object: { ref: "feed_down" } });
  const fallbackFirst = await s.send({});
  const fallbackSecond = await s.send({});
  for (const res of [first, second, other, fallbackFirst, fallbackSecond]) assert.equal(res.status, 202, JSON.stringify(res.body));

  assert.equal(first.body.wake, undefined, "the first event of an item wakes");
  assert.equal(other.body.wake, undefined, "another object is another item");
  assert.equal(fallbackFirst.body.wake, undefined);
  assert.equal(second.body.wake, "merged");
  assert.equal(fallbackSecond.body.wake, "merged");
  assert.equal(second.body.status, "queued", "accepted like any other");

  const [a, b] = [await stored(first.body.id), await stored(second.body.id)];
  assert.equal(a.status, "delivering", "pushed: it woke the agent");
  assert.equal(a.wakeCoalescedAt, null);
  assert.equal(b.status, "queued", "not pushed, and not consumed either");
  assert.ok(b.wakeCoalescedAt instanceof Date);

  // Only the wake is skipped: the item lists both, newest first.
  const groups = await listAgentAppItemGroups({ agentId: s.agent.id, launch: inboxItemsLaunch()! });
  const slip = groups.find((group) => group[0]!.event.objectRef === "slip_BTC");
  assert.deepEqual(slip?.map((row) => row.event.summary), ["slippage 12bp", "slippage 9bp"]);
});

test("no re-delivery wakes for a merged event: the daemon's rebuild and the push sweep leave it out, the item's first event stays", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const first = await s.send({ object: { ref: "pr-1" } });
  const merged = await s.send({ object: { ref: "pr-1" } });
  assert.equal(merged.body.wake, "merged");

  const swept = await listPendingThirdPartyAgentEventMessages({ agentId: s.agent.id });
  const sweptIds = swept.map((message) => message.third_party_event?.id);
  assert.ok(sweptIds.includes(first.body.id));
  assert.equal(sweptIds.includes(merged.body.id), false, "the sweep never announces it");

  const rebuilt = await rebuildPendingThirdPartyAgentEventMessages({ agentId: s.agent.id });
  const rebuiltIds = rebuilt.map((message) => message.third_party_event?.id);
  assert.ok(rebuiltIds.includes(first.body.id));
  assert.equal(rebuiltIds.includes(merged.body.id), false, "a restart never pushes it");
  assert.equal((await stored(merged.body.id)).status, "queued", "and the rebuild did not claim it");
});

test("once the item is read, the next event on it wakes again", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const first = await s.send({ object: { ref: "pr-1" } });
  const merged = await s.send({ object: { ref: "pr-1" } });
  await markThirdPartyAgentEventsDelivered([first.body.id, merged.body.id]);
  const after = await s.send({ object: { ref: "pr-1" } });
  assert.equal(after.body.wake, undefined);
  assert.equal((await stored(after.body.id)).status, "delivering");
  assert.equal((await stored(after.body.id)).wakeCoalescedAt, null);
});

test("an expired unread event does not hold the item's wake", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const first = await s.send({ object: { ref: "pr-1" } });
  await getDb().update(thirdPartyAgentEvents).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(thirdPartyAgentEvents.id, first.body.id));
  const next = await s.send({ object: { ref: "pr-1" } });
  assert.equal(next.body.wake, undefined);
});

test("inbox items off: every event wakes, as before", async ({ app }) => {
  const s = await seed(app);
  const first = await s.send({ object: { ref: "pr-1" } });
  const second = await s.send({ object: { ref: "pr-1" } });
  assert.equal(second.body.wake, undefined);
  const rows = await getDb().select().from(thirdPartyAgentEvents).where(inArray(thirdPartyAgentEvents.id, [first.body.id, second.body.id]));
  assert.deepEqual(rows.map((row) => [row.status, row.wakeCoalescedAt]).sort(), [["delivering", null], ["delivering", null]]);
});

test("a first-party app's notices merge the same way", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const delivered: string[] = [];
  const deliverer = { deliverMessage: async (_agentId: string, message: { third_party_event?: { id: string } | null }) => { delivered.push(message.third_party_event!.id); } };
  const notice = () => createSystemAppAgentEvent({
    serverId: s.server.id,
    agentId: s.agent.id,
    systemApp: "system.artifacts",
    summary: "A comment on your Artifact",
    payload: {},
    ttlMs: 60_000,
    objectRef: "pt_3f4b1fd4-1111-4222-8333-444444444444",
  });
  // Its first notice was pushed and is unread (its delivery guard needs an Artifact this test has none of).
  const first = await notice();
  await getDb().update(thirdPartyAgentEvents).set({ status: "delivering" }).where(eq(thirdPartyAgentEvents.id, first.id));
  const second = await notice();
  assert.equal(await deliverSystemAppAgentEvent({ event: second, deliverer: deliverer as never }), false);
  assert.deepEqual(delivered, [], "no second push");
  const row = await stored(second.id);
  assert.ok(row.wakeCoalescedAt instanceof Date);
  assert.equal(row.status, "queued", "readable in the item, not consumed");
});

test("handed over after later events merged into its item: the newest merged one gets the item's one push, then the chain ends (Tenny, #13995)", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const pushes: string[] = [];
  const deliverer = { deliverMessage: async (_agentId: string, message: { third_party_event?: { id: string } | null }) => { pushes.push(message.third_party_event!.id); } };
  // Event 1 is pushed and held in the Computer (the agent is mid-turn); 2 and 3 merge into its item.
  const first = await s.send({ object: { ref: "slip_BTC" }, summary: "slippage 9bp" });
  const second = await s.send({ object: { ref: "slip_BTC" }, summary: "slippage 12bp" });
  const third = await s.send({ object: { ref: "slip_BTC" }, summary: "slippage 15bp" });
  assert.deepEqual([second.body.wake, third.body.wake], ["merged", "merged"]);

  // The turn ends: event 1 is handed over. The newest merged event, 3, goes out once.
  await markThirdPartyAgentEventsDelivered([first.body.id], { agentId: s.agent.id });
  assert.deepEqual(await wakeForEventsMergedSinceHandover(deliverer as never, s.agent.id, [first.body.id]), [third.body.id]);
  assert.deepEqual(pushes, [third.body.id]);
  const [two, three] = [await stored(second.body.id), await stored(third.body.id)];
  assert.ok(two.wakeCoalescedAt instanceof Date, "2 stays merged: still readable in the item, no push of its own");
  assert.equal(two.status, "queued");
  assert.deepEqual([three.status, three.wakeCoalescedAt], ["delivering", null]);

  // Handing that one over again, or event 1 a second time, pushes nothing more.
  await markThirdPartyAgentEventsDelivered([third.body.id], { agentId: s.agent.id });
  assert.deepEqual(await wakeForEventsMergedSinceHandover(deliverer as never, s.agent.id, [third.body.id]), []);
  assert.deepEqual(await wakeForEventsMergedSinceHandover(deliverer as never, s.agent.id, [first.body.id]), []);
  assert.deepEqual(pushes, [third.body.id], "exactly one push for the item");
});

test("with no orchestrator to push through, a handover releases nothing", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const first = await s.send({ object: { ref: "pr-1" } });
  const merged = await s.send({ object: { ref: "pr-1" } });
  await markThirdPartyAgentEventsDelivered([first.body.id], { agentId: s.agent.id });
  // No deliverer (no orchestrator): nothing is released, so the sweep can't double it later.
  assert.deepEqual(await wakeForEventsMergedSinceHandover(undefined, s.agent.id, [first.body.id]), []);
  assert.ok((await stored(merged.body.id)).wakeCoalescedAt instanceof Date);
});
