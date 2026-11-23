// dm:@Remy:#1: an App's `delivery: "inbox"` event is added to the agent's
// inbox item and wakes no one: not when it comes in, not on a repeat, not on
// any re-delivery, not when an earlier wake of its item is handed over. A
// later `wake` event on the same item wakes as usual, and the agent reads
// both there. Where inbox items are off, an event never pushed would never be
// seen, so `inbox` wakes as before and the answer warns. The same where the
// agent's `raft` CLI hasn't said, on its current Computer and daemon version,
// that it lists app inbox items (#proj-apps:#88).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, machines, servers, thirdPartyAgentEvents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createOAuthClient, listPendingThirdPartyAgentEventMessages, markThirdPartyAgentEventsDelivered, rebuildPendingThirdPartyAgentEventMessages, requestAgentAccess } from "../services/oauthService";
import { AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, createFeatureFlag } from "../services/featureFlagService";
import { INBOX_ITEMS_LAUNCH_AT_ENV, listAgentAppItemGroups } from "../services/agentInboxItems";
import { __resetInboxItemsLaunchWarningsForTests, inboxItemsLaunch } from "../services/inboxItemsLaunch";
import { wakeForEventsMergedSinceHandover } from "../services/appItemWakeCoalescing";
import { AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS, SEEN_AT_REFRESH_MS, agentCliInboxItemsState, agentCliListsAppInboxItems, recordAgentCliInboxItems, resetAgentCliInboxItemsCacheForTests } from "../services/agentCliInboxItems";
import { mintAgentCredential } from "../services/agentCredentialService";
import { INBOX_ITEMS_CAPABILITY, MANUAL_CONTEXT_CAPABILITY, RAFT_CLIENT_CAPABILITIES_HEADER } from "@botiverse/raft-shared";

const test = createApiTest();

beforeEach(() => {
  __resetInboxItemsLaunchWarningsForTests();
  resetAgentCliInboxItemsCacheForTests();
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "2026-01-01T00:00:00.000Z");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** `cli: true` (default): the agent's CLI already said it lists app inbox items. */
async function seed(app: { baseUrl: string }, options: { cli?: boolean } = {}) {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `event-delivery-${suffix}@slock.test`,
    name: `event-delivery-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Event Delivery", `evd-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `DlvBot${suffix.slice(0, 4)}`, { runtime: "external", model: "external" });
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
      body: JSON.stringify({ kind: "notification", summary: "PR 15635 merged", ...body }),
    });
    return { status: res.status, body: await res.json() as any };
  };
  if (options.cli !== false) await recordAgentCliInboxItems(agent.id, null, true);
  return { owner: owner!, server, agent, send };
}

async function stored(id: string) {
  const [row] = await getDb().select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, id));
  return row!;
}

async function itemsOn() {
  await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
}

test("delivery inbox: accepted into the item, never pushed, and no re-delivery picks it up", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const res = await s.send({ object: { ref: "pr-15635" }, delivery: "inbox" });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(res.body.status, "queued");
  assert.equal(res.body.delivery, "inbox");
  assert.equal(res.body.wake, undefined, "not a merge: it asked for no wake");
  assert.equal(res.body.warnings, undefined);

  const row = await stored(res.body.id);
  assert.equal(row.delivery, "inbox");
  assert.equal(row.status, "queued", "not claimed for a push");
  assert.ok(row.wakeCoalescedAt instanceof Date);

  const groups = await listAgentAppItemGroups({ agentId: s.agent.id, launch: inboxItemsLaunch()! });
  assert.deepEqual(groups.map((group) => group.map((entry) => entry.event.id)), [[res.body.id]], "listed in its item");

  const swept = await listPendingThirdPartyAgentEventMessages({ agentId: s.agent.id });
  assert.equal(swept.some((message) => message.third_party_event?.id === res.body.id), false);
  const rebuilt = await rebuildPendingThirdPartyAgentEventMessages({ agentId: s.agent.id });
  assert.equal(rebuilt.some((message) => message.third_party_event?.id === res.body.id), false);
  assert.equal((await stored(res.body.id)).status, "queued");
});

test("a repeat of an inbox event (same externalEventId) is deduped and still wakes no one", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const first = await s.send({ object: { ref: "pr-1" }, delivery: "inbox", externalEventId: "merged-pr-1" });
  // Even sent the second time without `delivery`: the stored event's stands.
  const repeat = await s.send({ object: { ref: "pr-1" }, externalEventId: "merged-pr-1" });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.id, first.body.id);
  assert.equal(repeat.body.deduped, true);
  assert.equal(repeat.body.status, "duplicate");
  assert.equal(repeat.body.delivery, "inbox");
  assert.equal((await stored(first.body.id)).status, "queued", "not pushed by the repeat");
});

test("a later wake event on the same item wakes as usual; the agent reads both there", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const quiet = await s.send({ object: { ref: "pr-1" }, delivery: "inbox", summary: "PR 1 merged" });
  const loud = await s.send({ object: { ref: "pr-1" }, summary: "PR 1 checks failed on staging" });
  assert.equal(loud.body.delivery, "wake");
  assert.equal(loud.body.wake, undefined, "the inbox event woke no one, so it holds no wake to merge into");
  const row = await stored(loud.body.id);
  assert.deepEqual([row.status, row.wakeCoalescedAt], ["delivering", null]);

  const groups = await listAgentAppItemGroups({ agentId: s.agent.id, launch: inboxItemsLaunch()! });
  assert.deepEqual(groups[0]!.map((entry) => entry.event.id).sort(), [quiet.body.id, loud.body.id].sort());
});

test("handing over an item's wake does not push an inbox event that came after it", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const pushes: string[] = [];
  const deliverer = { deliverMessage: async (_agentId: string, message: { third_party_event?: { id: string } | null }) => { pushes.push(message.third_party_event!.id); } };
  const wake = await s.send({ object: { ref: "pr-1" } });
  const quiet = await s.send({ object: { ref: "pr-1" }, delivery: "inbox" });
  await markThirdPartyAgentEventsDelivered([wake.body.id], { agentId: s.agent.id });
  assert.deepEqual(await wakeForEventsMergedSinceHandover(deliverer as never, s.agent.id, [wake.body.id]), []);
  assert.deepEqual(pushes, []);
  assert.equal((await stored(quiet.body.id)).status, "queued", "still unread in the item");
});

test("inbox items off: delivery inbox wakes as before, and the answer says so", async ({ app }) => {
  const s = await seed(app);
  const res = await s.send({ object: { ref: "pr-1" }, delivery: "inbox" });
  assert.equal(res.status, 202);
  assert.equal(res.body.delivery, "wake");
  assert.ok((res.body.warnings as string[]).some((warning) => warning.startsWith("delivery inbox is not available")));
  const row = await stored(res.body.id);
  assert.deepEqual([row.delivery, row.status, row.wakeCoalescedAt], ["wake", "delivering", null]);
});

test("delivery wake, or none, is today's behaviour; anything else is a 400 naming the field", async ({ app }) => {
  await itemsOn();
  const s = await seed(app);
  const explicit = await s.send({ object: { ref: "a" }, delivery: "wake" });
  const absent = await s.send({ object: { ref: "b" } });
  for (const res of [explicit, absent]) {
    assert.equal(res.status, 202);
    assert.equal(res.body.delivery, "wake");
    assert.equal((await stored(res.body.id)).status, "delivering");
  }
  for (const delivery of ["silent", "INBOX", 1, true]) {
    const bad = await s.send({ object: { ref: "c" }, delivery });
    assert.equal(bad.status, 400, String(delivery));
    assert.equal(bad.body.error, "delivery must be wake or inbox");
  }
});

const OLD_CLI_WARNING = "delivery inbox is not available for this agent yet: its raft CLI is too old to list app items in its inbox";
const UNKNOWN_CLI_WARNING = "delivery inbox is not available for this agent yet: Raft has no recent answer from its raft CLI where it runs now";

/** An authenticated agent-API request as the given client sends it (the CLI says `X-Raft-Client: cli`). */
async function agentRequest(baseUrl: string, apiKey: string, headers: Record<string, string>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/inbox/conversations?items=true`, {
    headers: { Authorization: `Bearer ${apiKey}`, ...headers },
  });
  // Recorded while the credential is checked, whatever the route answers after.
  assert.notEqual(res.status, 401, await res.clone().text());
}

async function observationOf(agentId: string) {
  const [row] = await getDb().select({ observation: agents.cliInboxItems }).from(agents).where(eq(agents.id, agentId));
  return row?.observation ?? null;
}

/** The observation without when it was seen. */
function answerOf(observation: Awaited<ReturnType<typeof observationOf>>) {
  if (!observation) return null;
  const { seenAt: _seenAt, ...answer } = observation;
  return answer;
}

/** The recording runs in the background of the request: wait for it to land (`seenAt` aside). */
async function untilObservation(agentId: string, expected: unknown) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const observation = await observationOf(agentId);
    try {
      assert.deepEqual(answerOf(observation), expected);
      assert.equal(typeof observation?.seenAt, "string");
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

test("an agent whose CLI Raft hasn't seen yet is woken, and the answer says it stops after its next command", async ({ app }) => {
  await itemsOn();
  const s = await seed(app, { cli: false });
  const res = await s.send({ object: { ref: "pr-1" }, delivery: "inbox" });
  assert.equal(res.status, 202);
  assert.equal(res.body.delivery, "wake");
  assert.deepEqual((res.body.warnings as string[]).filter((warning) => warning.startsWith("delivery inbox")).map((warning) => warning.startsWith(UNKNOWN_CLI_WARNING)), [true]);
  const row = await stored(res.body.id);
  assert.deepEqual([row.delivery, row.status, row.wakeCoalescedAt], ["wake", "delivering", null]);
});

test("only the CLI's own requests record it: inbox-items@1 holds the event, its absence wakes, other clients change nothing", async ({ app }) => {
  await itemsOn();
  const s = await seed(app, { cli: false });
  const apiKey = (await mintAgentCredential({ agentId: s.agent.id, scopes: ["send", "read"], name: "cli", issuedVia: "computer", createdByUserId: null })).apiKey;
  const declared = { declared: true, machineId: null, daemonVersion: null };
  const notDeclared = { declared: false, machineId: null, daemonVersion: null };

  // The SDK sends capabilities too, without the CLI's tokens: not the CLI, so nothing is recorded.
  await agentRequest(app.baseUrl, apiKey, { "X-Raft-Client": "sdk", [RAFT_CLIENT_CAPABILITIES_HEADER]: MANUAL_CONTEXT_CAPABILITY });
  await agentRequest(app.baseUrl, apiKey, { "X-Raft-Client": "cli", [RAFT_CLIENT_CAPABILITIES_HEADER]: `${MANUAL_CONTEXT_CAPABILITY},${INBOX_ITEMS_CAPABILITY}` });
  await untilObservation(s.agent.id, declared);
  const held = await s.send({ object: { ref: "pr-1" }, delivery: "inbox" });
  assert.equal(held.body.delivery, "inbox");
  assert.equal(held.body.warnings, undefined);

  // A request with no capabilities header (an older daemon's own call, say) changes nothing.
  await agentRequest(app.baseUrl, apiKey, { "X-Raft-Client": "cli" });
  await agentRequest(app.baseUrl, apiKey, { "X-Raft-Client": "sdk", [RAFT_CLIENT_CAPABILITIES_HEADER]: MANUAL_CONTEXT_CAPABILITY });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await untilObservation(s.agent.id, declared);

  // The CLI without the capability (an older one): woken from now on.
  await agentRequest(app.baseUrl, apiKey, { "X-Raft-Client": "cli", [RAFT_CLIENT_CAPABILITIES_HEADER]: MANUAL_CONTEXT_CAPABILITY });
  await untilObservation(s.agent.id, notDeclared);
  const woken = await s.send({ object: { ref: "pr-2" }, delivery: "inbox" });
  assert.equal(woken.body.delivery, "wake");
  assert.ok((woken.body.warnings as string[]).some((warning) => warning.startsWith(OLD_CLI_WARNING)));
});

test("what the CLI said counts only on the Computer and daemon version it said it on", async ({ app }) => {
  const s = await seed(app, { cli: false });
  const [first, second] = await getDb().insert(machines).values([
    { serverId: s.server.id, userId: s.owner.id, name: "first", apiKeyHash: randomUUID(), runtimes: [], daemonVersion: "1.25.7" },
    { serverId: s.server.id, userId: s.owner.id, name: "second", apiKeyHash: randomUUID(), runtimes: [], daemonVersion: "1.25.7" },
  ]).returning();
  await getDb().update(agents).set({ machineId: first!.id }).where(eq(agents.id, s.agent.id));
  await recordAgentCliInboxItems(s.agent.id, first!.id, true);
  assert.deepEqual(answerOf(await observationOf(s.agent.id)), { declared: true, machineId: first!.id, daemonVersion: "1.25.7" });
  assert.equal(await agentCliListsAppInboxItems(s.agent.id), true);

  // Its Computer reconnects with another daemon (and so another CLI): not known until the CLI says again.
  await getDb().update(machines).set({ daemonVersion: "1.25.8" }).where(eq(machines.id, first!.id));
  assert.equal(await agentCliListsAppInboxItems(s.agent.id), false);
  await recordAgentCliInboxItems(s.agent.id, first!.id, true);
  assert.equal(await agentCliListsAppInboxItems(s.agent.id), true);

  // Moved to another Computer: the same.
  await getDb().update(agents).set({ machineId: second!.id }).where(eq(agents.id, s.agent.id));
  assert.equal(await agentCliListsAppInboxItems(s.agent.id), false);
  await recordAgentCliInboxItems(s.agent.id, second!.id, true);
  assert.equal(await agentCliListsAppInboxItems(s.agent.id), true);

  // Taken off every Computer.
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, s.agent.id));
  assert.equal(await agentCliListsAppInboxItems(s.agent.id), false);

  // A "no" counts only where it was said too: old there, unknown after a move.
  await getDb().update(agents).set({ machineId: first!.id }).where(eq(agents.id, s.agent.id));
  await recordAgentCliInboxItems(s.agent.id, first!.id, false);
  assert.equal(await agentCliInboxItemsState(s.agent.id), "old_cli");
  await getDb().update(agents).set({ machineId: second!.id }).where(eq(agents.id, s.agent.id));
  assert.equal(await agentCliInboxItemsState(s.agent.id), "unknown");
});

const HOUR = 60 * 60_000;

test("on no Computer, a yes counts for 24 hours after the CLI last said it, then the agent is woken until it says again", async ({ app }) => {
  const s = await seed(app, { cli: false });
  const seen = new Date("2026-11-20T08:00:00.000Z");
  await recordAgentCliInboxItems(s.agent.id, null, true, seen);
  assert.deepEqual(await observationOf(s.agent.id), { declared: true, machineId: null, daemonVersion: null, seenAt: seen.toISOString() });
  const at = (ms: number) => ({ now: new Date(seen.getTime() + ms) });
  assert.equal(await agentCliInboxItemsState(s.agent.id, at(0)), "lists");
  assert.equal(await agentCliInboxItemsState(s.agent.id, at(AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS)), "lists");
  // A CLI too old to send the capabilities header never says no: the yes runs out instead.
  assert.equal(await agentCliInboxItemsState(s.agent.id, at(AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS + 1)), "unknown");
  // A no runs out the same way (it only ever costs a wake).
  await recordAgentCliInboxItems(s.agent.id, null, false, seen);
  assert.equal(await agentCliInboxItemsState(s.agent.id, at(HOUR)), "old_cli");
  assert.equal(await agentCliInboxItemsState(s.agent.id, at(AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS + 1)), "unknown");
  // Saying it again counts again.
  await recordAgentCliInboxItems(s.agent.id, null, true, new Date(seen.getTime() + 2 * AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS));
  assert.equal(await agentCliInboxItemsState(s.agent.id, at(2 * AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS + HOUR)), "lists");
  // A row from before `seenAt` existed is read as seen long ago.
  await getDb().update(agents).set({ cliInboxItems: { declared: true, machineId: null, daemonVersion: null } }).where(eq(agents.id, s.agent.id));
  assert.equal(await agentCliInboxItemsState(s.agent.id), "unknown");
});

test("on a Computer, when the CLI was seen does not matter: its Computer and daemon version do", async ({ app }) => {
  const s = await seed(app, { cli: false });
  const [machine] = await getDb().insert(machines).values(
    { serverId: s.server.id, userId: s.owner.id, name: "box", apiKeyHash: randomUUID(), runtimes: [], daemonVersion: "1.25.7" },
  ).returning();
  await getDb().update(agents).set({ machineId: machine!.id }).where(eq(agents.id, s.agent.id));
  const seen = new Date("2026-11-20T08:00:00.000Z");
  await recordAgentCliInboxItems(s.agent.id, machine!.id, true, seen);
  assert.equal(await agentCliInboxItemsState(s.agent.id, { now: new Date(seen.getTime() + 30 * AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS) }), "lists");
  // Nor does a row from before `seenAt` existed.
  await getDb().update(agents).set({ cliInboxItems: { declared: true, machineId: machine!.id, daemonVersion: "1.25.7" } }).where(eq(agents.id, s.agent.id));
  assert.equal(await agentCliInboxItemsState(s.agent.id), "lists");
});

test("an unchanged answer rewrites seenAt only once it is an hour old; a changed one writes at once", async ({ app }) => {
  const s = await seed(app, { cli: false });
  const t0 = new Date("2026-11-20T08:00:00.000Z");
  const later = (ms: number) => new Date(t0.getTime() + ms);
  const seenAt = async () => (await observationOf(s.agent.id))?.seenAt;
  await recordAgentCliInboxItems(s.agent.id, null, true, t0);
  assert.equal(await seenAt(), t0.toISOString());
  // Within the hour: no write.
  await recordAgentCliInboxItems(s.agent.id, null, true, later(SEEN_AT_REFRESH_MS - 1));
  assert.equal(await seenAt(), t0.toISOString());
  // Past it: refreshed.
  await recordAgentCliInboxItems(s.agent.id, null, true, later(SEEN_AT_REFRESH_MS + 1));
  assert.equal(await seenAt(), later(SEEN_AT_REFRESH_MS + 1).toISOString());
  // A different answer is written at once, whatever seenAt.
  await recordAgentCliInboxItems(s.agent.id, null, false, later(SEEN_AT_REFRESH_MS + 2));
  assert.deepEqual(await observationOf(s.agent.id), { declared: false, machineId: null, daemonVersion: null, seenAt: later(SEEN_AT_REFRESH_MS + 2).toISOString() });
  // A row from before seenAt existed gets one on the next request.
  await getDb().update(agents).set({ cliInboxItems: { declared: false, machineId: null, daemonVersion: null } }).where(eq(agents.id, s.agent.id));
  await recordAgentCliInboxItems(s.agent.id, null, false, later(SEEN_AT_REFRESH_MS + 3));
  assert.equal(await seenAt(), later(SEEN_AT_REFRESH_MS + 3).toISOString());
});
