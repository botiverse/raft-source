// RFC 085 request:prepare, the review's must-fixes (Tenny, slock #14735; services/preparedRequestCommit.ts,
// preparedRequestCards.ts, delegableRouteBackstop.ts). Pins: a run is recorded under its claim alone (the route may
// archive the card's own channel); the flag stops open cards at commit and at Confirm again, while decline, withdraw
// and expiry go on; the stored request is re-checked against the entry's schemas as they are now; path params are
// ids, never `.`, `..` or `/`; a press releases only its own claim; a step-up is the person's alone, never on the
// card; a conversion's Confirm again takes the conversion's path; asking is capped per 24 hours and after a decline;
// the runtime backstop refuses a listed sign-in or billing route; an entry gone, a guest, a joint channel, a
// non-session credential, a true double claim; a build that fails is refused, never unknown; a route's 401 or 429
// is not /execute's status; the audit event per run and decline, joined to the route's own audit row by request id;
// the test-only hooks; and the agent's reply names only what the card shows everyone.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { preparedRequestFormId, type PreparedRequestAction } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { actionCards, channels, integrationAuditEvents, jointChannels, jointChannelServers } from "../db/schema";
import * as channelService from "../services/channelService";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { prepareActionCard } from "../services/actionCardsService";
import { setOwnerRouteDispatcherForTest } from "../services/assistantOwnerActionCards";
import { setDelegableCardRegistryForTest } from "../services/delegableCardRegistry";
import {
  PREPARED_REQUEST_PER_DAY,
  releasePreparedRequestClaim,
  setPreparedRequestHooksForTest,
  setPreparedRequestPerDayForTest,
  sweepPreparedRequestCards,
  type PreparedRequestClaim,
} from "../services/preparedRequestCards";
import { seedBoundGuest } from "../test/guestFixture";
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { cardRow, post, seedUser } from "../test/actionCardFormFixture";
import {
  TEST_ROUTES, agentApi, decide, disableFlag, enableFlag, installList, prepare, prepareArchive, prepareStop, replies, reset, stored,
  stubRunner, tamper, waitFor, world,
} from "../test/preparedRequestFixture";

const test = createApiTest();

/** A refusal or answer read loosely: a test asserts on whichever fields its case expects. */
type Body = Record<string, any>;

const ok = async () => ({ status: 200, body: {} });

// ── Must fix ─────────────────────────────────────────────────────────────────

test("a run is recorded under its claim alone: archiving the card's own channel succeeds and is recorded as success", async ({ app }) => {
  const w = await world(app);
  try {
    // The route archives the very channel the card is in (the person may no longer operate cards there after it).
    const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:archive", args: { channel: `#${w.channel.name}` } });
    assert.equal(res.status, 201, res.text);
    const confirmed = await decide(app.baseUrl, w, "owner", res.body.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.ok((await channelService.getChannel(w.channel.id))?.archivedAt, "the route ran");
    const row = await cardRow(res.body.messageId);
    assert.equal(row.state, "executed");
    assert.equal((row.result as Body).outcome, "success", "not an error, not 'may have run'");
    const [event] = await getDb().select().from(integrationAuditEvents).where(and(eq(integrationAuditEvents.eventType, "action_card.request_run"), eq(integrationAuditEvents.correlationId, res.body.messageId)));
    assert.equal((event?.metadata as Body | undefined)?.outcome, "success");
  } finally {
    reset();
  }
});

test("the flag stops open cards at commit and at Confirm again; decline, withdraw and expiry go on with it off", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const confirmLater = await prepareStop(app.baseUrl, w);
    const declineLater = await prepareStop(app.baseUrl, w, "owner", "decline me");
    const withdrawLater = await prepareStop(app.baseUrl, w, "owner", "withdraw me");
    const expireLater = await prepareStop(app.baseUrl, w, "owner", "expire me");
    const changed = await prepareArchive(app.baseUrl, w);
    // The last one changes (its channel turns private) and waits to be confirmed again.
    await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, w.target.id));
    assert.equal((await decide(app.baseUrl, w, "owner", changed.messageId, "confirm")).body.errorCode, "action_card_reconfirmation_required");

    await disableFlag();
    const refused = await decide(app.baseUrl, w, "owner", confirmLater.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_not_available");
    const again = await post(app.baseUrl, w, "owner", `${changed.messageId}/reconfirm`, {});
    assert.equal(again.status, 409, again.text);
    assert.equal(again.body.errorCode, "request_not_available");
    assert.equal(calls.length, 0, "nothing ran");
    assert.equal((await cardRow(confirmLater.messageId)).state, "prepared", "still open: the flag may come back");

    assert.equal((await decide(app.baseUrl, w, "owner", declineLater.messageId, "decline")).status, 200);
    assert.equal((await agentApi(app.baseUrl, w.agentKey, `/actions/${withdrawLater.messageId}/withdraw`)).status, 200);
    await getDb().update(actionCards).set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) }).where(eq(actionCards.messageId, expireLater.messageId));
    await sweepPreparedRequestCards(app.app.get("io") as never, app.app.get("agentOrchestrator") as never);
    assert.deepEqual(
      [(await cardRow(declineLater.messageId)).state, (await cardRow(withdrawLater.messageId)).state, (await cardRow(expireLater.messageId)).state],
      ["declined", "withdrawn", "expired"],
    );
    // On again: the open card runs.
    await enableFlag(w.server.id);
    assert.equal((await decide(app.baseUrl, w, "owner", confirmLater.messageId, "confirm")).status, 200);
    assert.equal(calls.length, 1);
  } finally {
    reset();
  }
});

test("commit re-checks the stored request against the entry's schemas as they are now: a narrowed schema ends the card changed_since_prepared", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const card = await prepareStop(app.baseUrl, w, "owner", "a reason that is long");
    // The entry's body schema narrows (its reason at most 5 characters) after the card was prepared.
    const stop = TEST_ROUTES["POST /api/agents/:id/stop"]!;
    installList({ ...TEST_ROUTES, "POST /api/agents/:id/stop": { ...stop, bodySchema: z.strictObject({ reason: z.string().max(5) }) } });
    const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_changed_unavailable");
    const row = await cardRow(card.messageId);
    assert.equal(row.state, "expired");
    assert.equal((row.result as Body).outcome, "changed_since_prepared");
    assert.equal(calls.length, 0);
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
    assert.match(told[0]!, /ended changed_since_prepared/);

    // A schema that parses to something else (a default it adds) is not the same request either.
    installList();
    const second = await prepareStop(app.baseUrl, w, "owner", "fine");
    installList({ ...TEST_ROUTES, "POST /api/agents/:id/stop": { ...stop, bodySchema: z.strictObject({ reason: z.string(), priority: z.string().default("high") }) } });
    assert.equal((await decide(app.baseUrl, w, "owner", second.messageId, "confirm")).body.errorCode, "request_changed_unavailable");
    assert.equal(calls.length, 0);
  } finally {
    reset();
  }
});

test("path params are ids: `.`, `..` and `/` are refused at prepare and, stored anyway, refused when building the request (never unknown)", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    // An entry whose params schema takes any string (the structure test refuses it; the runtime refuses it again).
    const loose = { ...TEST_ROUTES["POST /api/agents/:id/stop"]!, paramsSchema: z.strictObject({ id: z.string() }) };
    for (const id of ["..", ".", "a/b", "%2e%2e"]) {
      installList({ "POST /api/agents/:id/stop": { ...loose, operation: { ...loose.operation, resolve: async () => ({ ok: true, params: { id }, body: { reason: "x" } }) } } });
      const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
      assert.equal(res.status, 400, `${id}: ${res.text}`);
      assert.equal(res.body.code, "invalid_args");
    }
    // Stored anyway (a hand in the database): the build refuses it; nothing runs; the card stays open, refused.
    installList({ ...TEST_ROUTES, "POST /api/agents/:id/stop": loose });
    for (const id of ["..", ".", "a/b"]) {
      const card = await prepareStop(app.baseUrl, w);
      // Its summary as the template builds it from these params, so only the path is wrong.
      await tamper(card.messageId, (action) => ({ ...action, params: { id }, summaryModel: { agent: { kind: "agent", id } } as unknown as PreparedRequestAction["summaryModel"] }));
      const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
      assert.equal(refused.status, 409, `${id}: ${refused.text}`);
      assert.equal(refused.body.errorCode, "request_not_runnable");
      const row = await cardRow(card.messageId);
      assert.equal(row.state, "prepared", "not unknown: nothing ran");
      assert.equal(row.result, null);
      assert.deepEqual([(row.payload as PreparedRequestAction).attempt, (row.payload as PreparedRequestAction).refusal?.code], [2, "request_not_runnable"]);
      await decide(app.baseUrl, w, "owner", card.messageId, "decline");
    }
    assert.equal(calls.length, 0);
  } finally {
    reset();
  }
});

test("a press releases only its own claim: a foreign release or a Confirm again mid-run leaves the running claim, and nothing runs twice", async ({ app }) => {
  const w = await world(app);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const calls = stubRunner(async () => { await gate; return { status: 200, body: {} }; });
  try {
    const card = await prepareStop(app.baseUrl, w);
    const first = decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    await waitFor(async () => calls.length, (n) => n === 1);
    const held = (await cardRow(card.messageId)).result as PreparedRequestClaim;
    // Another press's release (another token, another time) never clears this one.
    assert.equal(await releasePreparedRequestClaim(card.messageId, { ...held, token: randomUUID() }), false);
    assert.equal(await releasePreparedRequestClaim(card.messageId, { ...held, claimedAt: new Date(0).toISOString() }), false);
    assert.equal(await releasePreparedRequestClaim(card.messageId, { ...held, userId: w.alice.id }), false);
    // A Confirm again mid-run refuses, and releases nothing.
    assert.equal((await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {})).status, 409);
    // The sweep leaves a fresh claim alone.
    await sweepPreparedRequestCards(null, null);
    assert.deepEqual((await cardRow(card.messageId)).result, held);
    const second = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(second.body.errorCode, "REQUEST_ALREADY_CONFIRMING", second.text);
    open();
    assert.equal((await first).status, 200);
    assert.equal(calls.length, 1);
  } finally {
    open();
    reset();
  }
});

test("a step-up the route asks for is the person's alone: their /execute answer says so; the card the agent and everyone read is byte for byte the same, with no redraw", async ({ app }) => {
  const w = await world(app);
  let stepUp = true;
  const calls = stubRunner(async () => stepUp
    ? { status: 403, body: { error: "Confirm it's you first.", code: "second_factor_step_up_required", methods: ["totp"] }, stepUpRequired: true }
    : { status: 200, body: {} });
  const agentRead = async (messageId: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${w.channel.name}`)}&limit=50&consume=false`, { headers: { Authorization: `Bearer ${w.agentKey}` } });
    assert.equal(res.status, 200);
    const read = (await res.json() as { messages: Array<{ id: string; actionMetadata?: unknown }> }).messages.find((message) => message.id === messageId);
    assert.ok(read, "the agent reads the card");
    return JSON.stringify(read.actionMetadata);
  };
  try {
    const card = await prepareStop(app.baseUrl, w);
    const before = { stored: JSON.stringify(await stored(card.messageId)), agent: await agentRead(card.messageId), payload: JSON.stringify((await cardRow(card.messageId)).payload) };
    const redraws = () => w.emitted.filter((emit) => emit.event === "message:updated" && (emit.payload as Body)?.id === card.messageId).length;
    const redrawsBefore = redraws();
    const asked = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(asked.status, 403, asked.text);
    assert.equal((asked.body as Body).code, "second_factor_step_up_required");
    assert.deepEqual((asked.body as Body).methods, ["totp"]);
    const row = await cardRow(card.messageId);
    assert.deepEqual([row.state, row.result], ["prepared", null], "open, no claim left");
    assert.equal(JSON.stringify(row.payload), before.payload, "the stored action is unchanged (no attempt)");
    assert.equal(JSON.stringify(await stored(card.messageId)), before.stored, "the card every viewer reads, byte for byte");
    assert.equal(await agentRead(card.messageId), before.agent, "the agent's read of it, byte for byte");
    assert.equal(redraws(), redrawsBefore, "no redraw to infer it from");
    assert.deepEqual(await replies(w, card.messageId), [], "the agent isn't told");
    // Verified, the person presses again: the same attempt runs (the route refused before it ran).
    stepUp = false;
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).status, 200);
    assert.deepEqual(calls.map((call) => call.idempotencyKey), [`${card.messageId}:1`, `${card.messageId}:1`]);
  } finally {
    reset();
  }
});

test("a 403 whose body only says second_factor_step_up_required, without the gate's mark, is the route's refusal: the attempt moves on, so a second press never reruns it", async ({ app }) => {
  const w = await world(app);
  // As a route that relays another answer, or refuses after it wrote, could answer: the code, no gate.
  const calls = stubRunner(async () => ({ status: 403, body: { error: "Confirm it's you first.", code: "second_factor_step_up_required", methods: ["totp"] } }));
  try {
    const card = await prepareStop(app.baseUrl, w);
    const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal((refused.body as Body).errorCode, "request_refused");
    const row = await cardRow(card.messageId);
    assert.equal(row.state, "prepared");
    assert.equal((row.payload as { attempt: number }).attempt, 2, "a new attempt: the next press is a new request, never this one again");
    assert.deepEqual(calls.map((call) => call.idempotencyKey), [`${card.messageId}:1`]);
  } finally {
    reset();
  }
});

test("a Confirm again a channel conversion asks for takes the conversion's path and its checks, never the request card's", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const card = await prepareStop(app.baseUrl, w);
    // As a finished conversion leaves it: reconfirm_required, bound to its source (here not a Joint channel).
    await getDb().update(actionCards).set({ freezeState: "reconfirm_required", conversionSourceChannelId: w.channel.id }).where(eq(actionCards.messageId, card.messageId));
    const again = await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {});
    assert.equal(again.status, 409, again.text);
    assert.equal(again.body.errorCode, "action_card_conversion_frozen", "the conversion's own check (its source is not Joint)");
    assert.equal((await cardRow(card.messageId)).freezeState, "reconfirm_required", "not opened by the request card's path");
    const pressed = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(pressed.status, 409, pressed.text);
    assert.equal(pressed.body.errorCode, "action_card_reconfirmation_required");
    assert.equal(calls.length, 0);
  } finally {
    reset();
  }
});

// ── Before the first entry ───────────────────────────────────────────────────

test("asking is capped per agent and person: N prepared in 24 hours whatever became of them, and 24 hours after a decline of the same request", async ({ app }) => {
  const w = await world(app);
  try {
    assert.equal(PREPARED_REQUEST_PER_DAY, 20);
    setPreparedRequestPerDayForTest(3);
    for (let i = 0; i < 3; i += 1) {
      const card = await prepareStop(app.baseUrl, w, "alice", `reason ${i}`);
      // Withdrawn at once: withdrawing doesn't give the asking back.
      assert.equal((await agentApi(app.baseUrl, w.agentKey, `/actions/${card.messageId}/withdraw`)).status, 200);
    }
    const fourth = await prepare(app.baseUrl, w, { to: `@${w.alice.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}`, why: "again" } });
    assert.equal(fourth.status, 429, fourth.text);
    assert.equal(fourth.body.code, "request_card_budget_spent");
    assert.match(fourth.body.error, /You can ask again after \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./);
    assert.ok(Number(fourth.body.retryAfterSeconds) > 0);
    // Another person is counted apart.
    await prepareStop(app.baseUrl, w, "owner");
    setPreparedRequestPerDayForTest(null);

    // Declined: the same request (operation, params, body) waits 24 hours; another request doesn't.
    const card = await prepareStop(app.baseUrl, w, "alice", "same one");
    assert.equal((await decide(app.baseUrl, w, "alice", card.messageId, "decline")).status, 200);
    const same = await prepare(app.baseUrl, w, { to: `@${w.alice.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}`, why: "same one" } });
    assert.equal(same.status, 409, same.text);
    assert.equal(same.body.code, "request_declined_recently");
    assert.match(same.body.error, /You can ask again after \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    assert.ok(Number(same.body.retryAfterSeconds) > 23 * 3600);
    assert.equal((await prepare(app.baseUrl, w, { to: `@${w.alice.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}`, why: "another" } })).status, 201);
    // A day later it may be asked again.
    await getDb().update(actionCards).set({ result: { ...((await cardRow(card.messageId)).result as Body), decidedAt: new Date(Date.now() - 25 * 3600_000).toISOString() } }).where(eq(actionCards.messageId, card.messageId));
    assert.equal((await prepare(app.baseUrl, w, { to: `@${w.alice.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}`, why: "same one" } })).status, 201);
  } finally {
    reset();
  }
});

test("the runtime backstop: a listed billing or sign-in route is refused at prepare and at commit, whatever the list says", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const stop = TEST_ROUTES["POST /api/agents/:id/stop"]!;
    for (const route of ["POST /api/billing/checkout", "POST /api/agents/:id/credentials", "POST /api/auth/second-factor/disable", "DELETE /api/me/account/deletion"]) {
      installList({ [route]: { ...stop, paramsSchema: route.includes(":id") ? stop.paramsSchema : z.strictObject({}) } });
      const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
      assert.equal(res.status, 400, `${route}: ${res.text}`);
      assert.equal(res.body.code, "unknown_operation");
    }
    // A card stored with such a route (the structure test bypassed, a hand in the database): refused at commit.
    installList();
    const card = await prepareStop(app.baseUrl, w);
    await tamper(card.messageId, (action) => ({ ...action, route: "POST /api/billing/checkout", params: {} }));
    installList({ ...TEST_ROUTES, "POST /api/billing/checkout": { ...stop, paramsSchema: z.strictObject({}) } });
    const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_not_available");
    assert.equal(calls.length, 0);
  } finally {
    reset();
  }
});

test("the runtime backstop refuses the escalating classes too: a listed server-role change is refused at commit, and scopes, grants, public, outside and delete routes at prepare", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const stop = TEST_ROUTES["POST /api/agents/:id/stop"]!;
    const idParams = (route: string) => z.strictObject(Object.fromEntries([...route.matchAll(/:([A-Za-z]\w*)/g)].map((match) => [match[1]!, z.uuid()])));
    for (const route of [
      "PUT /api/agents/:id/scopes",
      "POST /api/servers/:id/agent-context-view-grants",
      "PUT /api/raftbench/readers/:agentId",
      "PUT /api/mcp/agents/:agentId/assignments",
      "POST /api/integrations/agents/:agentId/grants",
      "PATCH /api/servers/:id/public-visibility",
      "POST /api/artifacts/:id/home",
      "POST /api/channels/:id/joint-invites",
      "POST /api/channels/:id/convert-to-joint",
      "POST /api/slack-bridge/provisioning/enable",
      "DELETE /api/channels/:id",
      "DELETE /api/servers/:id",
    ]) {
      installList({ [route]: { ...stop, paramsSchema: idParams(route) } });
      const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
      assert.equal(res.status, 400, `${route}: ${res.text}`);
      assert.equal(res.body.code, "unknown_operation", route);
    }
    // A card stored with the server member role route (the structure test bypassed): refused at commit, nothing runs.
    installList();
    const card = await prepareStop(app.baseUrl, w);
    const route = "PATCH /api/servers/:id/members/:memberId";
    await tamper(card.messageId, (action) => ({ ...action, route, params: { id: w.server.id, memberId: w.bob.id } }));
    installList({ ...TEST_ROUTES, [route]: { ...stop, paramsSchema: idParams(route) } });
    const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_not_available");
    assert.equal(calls.length, 0);
    assert.equal((await cardRow(card.messageId)).state, "prepared");
  } finally {
    reset();
  }
});

// ── Missing tests ────────────────────────────────────────────────────────────

test("an entry removed between prepare and commit: refused, nothing runs; the person may still decline", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const card = await prepareStop(app.baseUrl, w);
    const { "POST /api/agents/:id/stop": _gone, ...rest } = TEST_ROUTES;
    installList(rest);
    const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_not_available");
    assert.equal(calls.length, 0);
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "decline")).status, 200);
  } finally {
    reset();
  }
});

test("a guest can't be the person a request is for", async ({ app }) => {
  const w = await world(app);
  try {
    const guest = await seedUser("request-guest");
    await seedBoundGuest({ serverId: w.server.id, userId: guest.id, channelId: w.channel.id });
    const res = await prepare(app.baseUrl, w, { to: `@${guest.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.code, "addressee_cannot_act_here");
  } finally {
    reset();
  }
});

test("a non-session credential never confirms: the agent's own key on /execute is refused and nothing runs", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const card = await prepareStop(app.baseUrl, w);
    const id = preparedRequestFormId((await stored(card.messageId)).action.digest);
    const res = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${w.agentKey}`, "Content-Type": "application/json", "X-Server-Id": w.server.id },
      body: JSON.stringify({ form: { id, values: { decision: "confirm" } } }),
    });
    assert.ok(res.status === 401 || res.status === 403, `${res.status}: ${await res.text()}`);
    assert.equal(calls.length, 0);
    assert.equal((await cardRow(card.messageId)).state, "prepared");
  } finally {
    reset();
  }
});

test("a true concurrent double claim: two presses at once run it once", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return { status: 200, body: {} }; });
  try {
    const card = await prepareStop(app.baseUrl, w);
    const presses = await Promise.all([1, 2, 3].map(() => decide(app.baseUrl, w, "owner", card.messageId, "confirm")));
    assert.equal(calls.length, 1, presses.map((press) => press.text).join("\n"));
    for (const press of presses) assert.ok(press.status === 200 || press.body.errorCode === "REQUEST_ALREADY_CONFIRMING", press.text);
    assert.equal((await cardRow(card.messageId)).state, "executed");
  } finally {
    reset();
  }
});

test("a route's 401 or 429 is the card's refusal, never /execute's own status", async ({ app }) => {
  const w = await world(app);
  for (const status of [401, 429]) {
    stubRunner(async () => ({ status, body: { error: `Refused with ${status}.`, code: `inner_${status}` } }));
    try {
      const card = await prepareStop(app.baseUrl, w, "owner", `status ${status}`);
      const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.errorCode, "request_refused");
      assert.deepEqual([(refused.body as Body).routeStatus, (refused.body as Body).routeCode], [status, `inner_${status}`]);
      assert.equal((await stored(card.messageId)).action.refusal?.status, status, "the route's status, on the card's result");
    } finally {
      setOwnerRouteDispatcherForTest(null);
    }
  }
  reset();
});

test("in a Joint channel: the card acts on its own server, for one of its members; another server's person is no one to ask, and can't confirm", async ({ app }) => {
  const db = getDb();
  const calls = stubRunner(ok);
  try {
    installList();
    const hostOwner = await seedUser("jr-host");
    const peerOwner = await seedUser("jr-peer");
    const hostServer = await createServer("JR Host", `jr-host-${randomUUID().slice(0, 8)}`, hostOwner.id);
    const peerServer = await createServer("JR Peer", `jr-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
    await enableFlag(hostServer.id);
    const canonical = await channelService.createChannel(hostServer.id, `jr-storage-${randomUUID().slice(0, 4)}`, undefined, "channel");
    const hostProjection = await channelService.createChannel(hostServer.id, `jr-joint-${randomUUID().slice(0, 4)}`, undefined, "joint");
    const peerProjection = await channelService.createChannel(peerServer.id, `jr-joint-${randomUUID().slice(0, 4)}`, undefined, "joint");
    await channelService.addHuman(hostProjection.id, hostOwner.id);
    await channelService.addHuman(peerProjection.id, peerOwner.id);
    const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: hostServer.id, createdByUserId: hostOwner.id }).returning();
    await db.insert(jointChannelServers).values([
      { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
      { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
    ]);
    await fillJointMembersFromChannelHumans([joint!.id]);
    const hostAgent = await createAgent(hostServer.id, `jr-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
    await channelService.addAgent(hostProjection.id, hostAgent.id);
    const worker = await createAgent(hostServer.id, `jr-worker-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
    const prepareFor = (to: string) => prepareActionCard({
      serverId: hostServer.id, requesterAgentId: hostAgent.id, targetChannelId: hostProjection.id, agentAuthored: true,
      action: { type: "request:prepare", to, operation: "agent:stop", args: { agent: `@${worker.name}` } } as never,
    });
    // The peer server's owner is not a member of the card's server: no one this agent can ask.
    await assert.rejects(prepareFor(`@${peerOwner.name}`), (err: Error & { refusal?: { code?: string } }) => err.refusal?.code === "user_not_found");
    const card = await prepareFor(`@${hostOwner.name}`);
    const action = (await stored(card.messageId)).action;
    const form = { id: preparedRequestFormId(action.digest), values: { decision: "confirm" } };
    const as = async (user: { email: string }, serverId: string) => fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await tokenForHuman(user.email)}`, "Content-Type": "application/json", "X-Server-Id": serverId },
      body: JSON.stringify({ form }),
    });
    const fromPeer = await as(peerOwner, peerServer.id);
    assert.ok(fromPeer.status === 403 || fromPeer.status === 404, `${fromPeer.status}: ${await fromPeer.text()}`);
    assert.equal(calls.length, 0);
    const fromHost = await as(hostOwner, hostServer.id);
    assert.equal(fromHost.status, 200, await fromHost.text());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.serverId, hostServer.id, "the card's own server");
    assert.equal(calls[0]!.request.path, `/api/agents/${worker.id}/stop`);
  } finally {
    reset();
  }
});

// ── Small ────────────────────────────────────────────────────────────────────

test("audit: one event per run and per decline, with the dispatched request's id, which the route's own audit row carries too", async ({ app }) => {
  const w = await world(app);
  try {
    // Remove Bob from the server, through the real route (it writes its own membership.removed row).
    const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "member:remove", args: { member: `@${w.bob.name}` } });
    assert.equal(res.status, 201, res.text);
    const confirmed = await decide(app.baseUrl, w, "owner", res.body.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    const [cardEvent] = await getDb().select().from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "action_card.request_run"), eq(integrationAuditEvents.correlationId, res.body.messageId)));
    assert.ok(cardEvent, "the card's run event");
    const row = await cardRow(res.body.messageId);
    assert.deepEqual(
      { actorId: cardEvent.actorId, requesterType: cardEvent.requesterType, requesterId: cardEvent.requesterId, targetType: cardEvent.targetType, targetId: cardEvent.targetId },
      { actorId: w.owner.id, requesterType: "agent", requesterId: w.agent.id, targetType: "action_card", targetId: row.id },
    );
    const metadata = cardEvent.metadata as Body;
    assert.deepEqual(
      { operation: metadata.operation, route: metadata.route, attempt: metadata.attempt, preparerAgentId: metadata.preparerAgentId, outcome: metadata.outcome, routeStatus: metadata.routeStatus },
      { operation: "member:remove", route: "DELETE /api/servers/:id/members/:memberId", attempt: 1, preparerAgentId: w.agent.id, outcome: "success", routeStatus: 200 },
    );
    assert.match(String(cardEvent.requestId), /^[0-9a-f-]{36}$/);
    assert.equal(metadata.dispatchRequestId, cardEvent.requestId);
    const [routeRow] = await getDb().select().from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "membership.removed"), eq(integrationAuditEvents.targetId, w.bob.id)))
      .orderBy(desc(integrationAuditEvents.createdAt)).limit(1);
    assert.ok(routeRow, "the route's own audit row");
    assert.equal(routeRow.actorId, w.owner.id, "the route ran as the person");
    assert.equal(routeRow.requestId, cardEvent.requestId, "the route's row and the card's event share the dispatched request's id");

    // A decline is one event too; a refused run is one with the route's code.
    const declined = await prepareStop(app.baseUrl, w);
    await decide(app.baseUrl, w, "owner", declined.messageId, "decline");
    const [declineEvent] = await getDb().select().from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "action_card.request_declined"), eq(integrationAuditEvents.correlationId, declined.messageId)));
    assert.equal((declineEvent?.metadata as Body | undefined)?.outcome, "declined");
    stubRunner(async () => ({ status: 409, body: { error: "Busy now.", code: "agent_busy" } }));
    const refused = await prepareStop(app.baseUrl, w, "owner", "refuse me");
    await decide(app.baseUrl, w, "owner", refused.messageId, "confirm");
    const [refusedEvent] = await getDb().select().from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "action_card.request_run"), eq(integrationAuditEvents.correlationId, refused.messageId)));
    assert.deepEqual([(refusedEvent?.metadata as Body | undefined)?.outcome, (refusedEvent?.metadata as Body | undefined)?.routeCode, refusedEvent?.outcome], ["refused", "agent_busy", "failure"]);
  } finally {
    reset();
  }
});

test("the test-only hooks refuse outside tests", () => {
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => setOwnerRouteDispatcherForTest(null), /test-only/);
    assert.throws(() => setDelegableCardRegistryForTest(null), /test-only/);
    assert.throws(() => setPreparedRequestPerDayForTest(null), /test-only/);
    assert.throws(() => setPreparedRequestHooksForTest(null), /test-only/);
  } finally {
    process.env.NODE_ENV = was;
  }
});

test("the agent's reply names only what the card shows everyone in the thread; its own answers may name what it sees", async ({ app }) => {
  const w = await world(app);
  stubRunner(ok);
  try {
    // A private channel the agent and the person are in; the card is in a public channel everyone else reads too.
    const hidden = await channelService.createChannel(w.server.id, `quiet-${randomUUID().slice(0, 6)}`, undefined, "private");
    await channelService.addHuman(hidden.id, w.owner.id);
    await channelService.addAgent(hidden.id, w.agent.id);
    const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:archive", args: { channel: `#${hidden.name}` } });
    assert.equal(res.status, 201, res.text);
    assert.ok(String(res.body.preparedRequest.summary).includes(hidden.name), "the agent's own echo names what it sees");
    assert.equal((await decide(app.baseUrl, w, "owner", res.body.messageId, "confirm")).status, 200);
    const told = await waitFor(() => replies(w, res.body.messageId), (lines) => lines.length > 0);
    assert.ok(!told[0]!.includes(hidden.name), told[0]);
    assert.match(told[0]!, /Channel: a channel/);
  } finally {
    reset();
  }
});
