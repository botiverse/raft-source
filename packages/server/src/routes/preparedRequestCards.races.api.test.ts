// RFC 085 request:prepare, Tenny's second review of slock #14735: what a failure next to a record must not undo,
// what a conversion must not miss, every run audited, the backstop on the request as it would run, and the races.
// Pins: a failing audit insert (in its savepoint) leaves the record and the decline standing; a card waiting on a
// summary reconfirm is held by a conversion's fence and bound by its freeze; a funnel failure after the record
// hides nothing; the stale-claim sweep audits the run it ends, and a run that deleted its own card is still
// audited; a param that fills a route in as a refused one is refused at prepare and at commit; the sweep racing a
// slow run, a 4xx reopen racing a stale press, and prepares racing the open-card cap each come out once.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type PreparedRequestAction } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { actionCards, channelConversionFences, channelConversionJobs, channels, integrationAuditEvents, messages } from "../db/schema";
import { freezeActionCardsForConversion, requireActionCardReconfirmationAfterCutover, unfreezeActionCardsAfterCancellation } from "../services/actionCardConversionService";
import { setPreparedRequestHooksForTest, sweepPreparedRequestCards, type PreparedRequestClaim } from "../services/preparedRequestCards";
import { recordIntegrationAuditEvent } from "../services/integrationAuditService";
import { cardRow, post } from "../test/actionCardFormFixture";
import {
  TEST_ROUTES, decide, installList, prepare, prepareArchive, prepareStop, replies, reset, stored, stubRunner, tamper, waitFor, world,
} from "../test/preparedRequestFixture";

const test = createApiTest();

/** A refusal or answer read loosely: a test asserts on whichever fields its case expects. */
type Body = Record<string, any>;

const ok = async () => ({ status: 200, body: {} });

function resetAll() {
  reset();
  setPreparedRequestHooksForTest(null);
}

/** An audit insert that fails as a real statement would, on the executor it is given (so it aborts a transaction it runs in). */
const failingAudit = async (_event: unknown, executor: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }) => {
  await executor.execute(sql`select 1 / 0`);
};

async function runEvents(messageId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "action_card.request_run"), eq(integrationAuditEvents.correlationId, messageId)));
}

// ── Fix in this PR ───────────────────────────────────────────────────────────

test("a failing audit insert never undoes the record or the decline (it runs in a savepoint)", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  setPreparedRequestHooksForTest({ auditWriter: failingAudit as never });
  try {
    const ran = await prepareStop(app.baseUrl, w);
    const confirmed = await decide(app.baseUrl, w, "owner", ran.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    const row = await cardRow(ran.messageId);
    assert.deepEqual([row.state, (row.result as Body).outcome], ["executed", "success"], "recorded, not rolled back to a claim");
    assert.equal((await stored(ran.messageId)).state, "executed");
    assert.equal(calls.length, 1);
    // No second, contradictory end: the sweep finds no claim to end.
    await sweepPreparedRequestCards(null, null);
    const told = await waitFor(() => replies(w, ran.messageId), (lines) => lines.length > 0);
    assert.equal(told.length, 1, told.join("\n"));
    assert.match(told[0]!, /ended success/);

    const declined = await prepareStop(app.baseUrl, w, "owner", "decline me");
    assert.equal((await decide(app.baseUrl, w, "owner", declined.messageId, "decline")).status, 200);
    assert.equal((await cardRow(declined.messageId)).state, "declined", "declined, not still open");
    assert.equal((await stored(declined.messageId)).state, "declined");
  } finally {
    resetAll();
  }
});

/** An audit writer whose first `failures` writes fail as a statement would; the rest are written for real. */
function flakyAudit(failures: number) {
  let left = failures;
  return async (event: Parameters<typeof recordIntegrationAuditEvent>[0], executor: Parameters<typeof recordIntegrationAuditEvent>[1]) => {
    if (left > 0) {
      left -= 1;
      await (executor as { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }).execute(sql`select 1 / 0`);
    }
    await recordIntegrationAuditEvent(event, executor);
  };
}

async function declineEvents(messageId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "action_card.request_declined"), eq(integrationAuditEvents.correlationId, messageId)));
}

test("an audit insert that fails inside the card's transaction is written once more after it commits: on a reopen, a decline and the sweep", async ({ app }) => {
  const w = await world(app);
  let open!: () => void;
  try {
    // Reopen: the route refused (4xx).
    stubRunner(async () => ({ status: 409, body: { error: "Busy now.", code: "agent_busy" } }));
    setPreparedRequestHooksForTest({ auditWriter: flakyAudit(1) as never });
    const refused = await prepareStop(app.baseUrl, w);
    assert.equal((await decide(app.baseUrl, w, "owner", refused.messageId, "confirm")).status, 409);
    assert.equal((await runEvents(refused.messageId)).length, 1, "the reopen's run event, written after commit");
    assert.equal(((await cardRow(refused.messageId)).payload as { attempt: number }).attempt, 2);

    // Decline.
    setPreparedRequestHooksForTest({ auditWriter: flakyAudit(1) as never });
    const declined = await prepareStop(app.baseUrl, w, "owner", "decline me");
    assert.equal((await decide(app.baseUrl, w, "owner", declined.messageId, "decline")).status, 200);
    assert.equal((await declineEvents(declined.messageId)).length, 1, "the decline event, written after commit");

    // The sweep ends a stale claim as unknown.
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const calls = stubRunner(async () => { await gate; return { status: 200, body: {} }; });
    setPreparedRequestHooksForTest({});
    const slow = await prepareStop(app.baseUrl, w, "owner", "slow");
    const press = decide(app.baseUrl, w, "owner", slow.messageId, "confirm");
    await waitFor(async () => calls.length, (n) => n === 1);
    const claim = (await cardRow(slow.messageId)).result as PreparedRequestClaim;
    await getDb().update(actionCards).set({ result: { ...claim, claimedAt: new Date(Date.now() - 5 * 60_000).toISOString() } }).where(eq(actionCards.messageId, slow.messageId));
    setPreparedRequestHooksForTest({ auditWriter: flakyAudit(1) as never });
    assert.equal(await sweepPreparedRequestCards(app.app.get("io") as never, app.app.get("agentOrchestrator") as never), 1);
    assert.equal((await runEvents(slow.messageId)).length, 1, "the sweep's run event, written after commit");
    open();
    await press;
  } finally {
    open?.();
    resetAll();
  }
});

test("an audit that fails again after commit is a structured audit_lost event, and the card stands", async ({ app }) => {
  const w = await world(app);
  stubRunner(async () => ({ status: 409, body: { error: "Busy now.", code: "agent_busy" } }));
  setPreparedRequestHooksForTest({ auditWriter: failingAudit as never });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const card = await prepareStop(app.baseUrl, w);
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).status, 409);
    assert.equal(((await cardRow(card.messageId)).payload as { attempt: number }).attempt, 2, "reopened all the same");
    const lost = errors.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
      .filter((entry) => entry?.event === "request_card.audit_lost");
    assert.equal(lost.length, 1);
    assert.deepEqual([lost[0]!.cardMessageId, lost[0]!.attempt, lost[0]!.outcome], [card.messageId, 1, "refused"]);
  } finally {
    console.error = original;
    resetAll();
  }
});

test("a card waiting on a summary reconfirm is held by a conversion: its reconfirm is refused under the fence, and the freeze binds it to the conversion's path", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const card = await prepareArchive(app.baseUrl, w);
    await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, w.target.id));
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).body.errorCode, "action_card_reconfirmation_required");
    assert.equal((await stored(card.messageId)).action.changePending, true);

    // A conversion of the card's conversation starts: its fence is up.
    const [job] = await getDb().insert(channelConversionJobs).values({ serverId: w.server.id, sourceChannelId: w.channel.id, sourceChannelType: "channel" }).returning();
    await getDb().insert(channelConversionFences).values({ jobId: job!.id, serverId: w.server.id, sourceChannelId: w.channel.id, conversionEpoch: job!.conversionEpoch });
    const fenced = await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {});
    assert.equal(fenced.status, 409, fenced.text);
    assert.equal(fenced.body.errorCode, "action_card_conversion_frozen");
    assert.equal((await cardRow(card.messageId)).freezeState, "reconfirm_required", "not reopened under the fence");

    // The freeze binds it, like any open card, and it is the conversion's to have confirmed again from now on.
    const conversion = { id: job!.id, serverId: w.server.id, sourceChannelId: w.channel.id, conversionEpoch: job!.conversionEpoch };
    assert.ok(await getDb().transaction((tx) => freezeActionCardsForConversion(tx, conversion)) >= 1);
    const frozen = await cardRow(card.messageId);
    assert.deepEqual([frozen.freezeState, frozen.conversionJobId], ["frozen", job!.id]);
    assert.equal((frozen.payload as PreparedRequestAction).changePending, undefined);
    const metadata = await stored(card.messageId);
    assert.equal(metadata.state, "frozen");
    assert.deepEqual(metadata.action, frozen.payload, "the row and the carrier agree");
    assert.ok((frozen.payload as PreparedRequestAction).changedAt, "it still says it changed");

    // Cut over: its Confirm again is the conversion's (its source is not Joint here, so that path refuses it).
    await getDb().transaction(async (tx) => {
      assert.equal(await requireActionCardReconfirmationAfterCutover(tx, conversion), 1);
      await tx.update(channelConversionFences).set({ status: "released" }).where(eq(channelConversionFences.jobId, job!.id));
      await tx.update(channelConversionJobs).set({ status: "done", state: "succeeded" }).where(eq(channelConversionJobs.id, job!.id));
    });
    const again = await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {});
    assert.equal(again.status, 409, again.text);
    assert.equal(again.body.errorCode, "action_card_conversion_frozen", "the conversion's own check");
    assert.equal((await cardRow(card.messageId)).freezeState, "reconfirm_required");
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).body.errorCode, "action_card_reconfirmation_required");
    assert.equal(calls.length, 0);
  } finally {
    resetAll();
  }
});

test("a cancelled conversion hands a card whose change was never confirmed again back as reconfirm_required: Confirm alone never runs it", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const card = await prepareArchive(app.baseUrl, w);
    await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, w.target.id));
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).body.errorCode, "action_card_reconfirmation_required");

    const [job] = await getDb().insert(channelConversionJobs).values({ serverId: w.server.id, sourceChannelId: w.channel.id, sourceChannelType: "channel" }).returning();
    const conversion = { id: job!.id, serverId: w.server.id, sourceChannelId: w.channel.id, conversionEpoch: job!.conversionEpoch };
    assert.ok(await getDb().transaction((tx) => freezeActionCardsForConversion(tx, conversion)) >= 1);
    assert.equal(await getDb().transaction(async (tx) => {
      const opened = await unfreezeActionCardsAfterCancellation(tx, conversion);
      await tx.update(channelConversionJobs).set({ status: "canceled", state: "canceled" }).where(eq(channelConversionJobs.id, job!.id));
      return opened;
    }), 1);

    const row = await cardRow(card.messageId);
    assert.equal(row.freezeState, "reconfirm_required", "still to be confirmed again");
    assert.equal((row.payload as PreparedRequestAction).changePending, true);
    const metadata = await stored(card.messageId);
    assert.equal(metadata.state, "reconfirm_required");
    assert.deepEqual(metadata.action, row.payload, "the row and the carrier agree");
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).body.errorCode, "action_card_reconfirmation_required");
    assert.equal(calls.length, 0, "nothing ran");

    // Confirmed again by its own path, then Confirm runs it.
    assert.equal((await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {})).status, 200);
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).status, 200);
    assert.equal(calls.length, 1);
  } finally {
    resetAll();
  }
});

test("a cancelled conversion hands back a card that was already confirmed again as it was: open, Confirm runs it", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const card = await prepareArchive(app.baseUrl, w);
    await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, w.target.id));
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).body.errorCode, "action_card_reconfirmation_required");
    assert.equal((await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {})).status, 200);

    const [job] = await getDb().insert(channelConversionJobs).values({ serverId: w.server.id, sourceChannelId: w.channel.id, sourceChannelType: "channel" }).returning();
    const conversion = { id: job!.id, serverId: w.server.id, sourceChannelId: w.channel.id, conversionEpoch: job!.conversionEpoch };
    assert.ok(await getDb().transaction((tx) => freezeActionCardsForConversion(tx, conversion)) >= 1);
    assert.equal(await getDb().transaction(async (tx) => {
      const opened = await unfreezeActionCardsAfterCancellation(tx, conversion);
      await tx.update(channelConversionJobs).set({ status: "canceled", state: "canceled" }).where(eq(channelConversionJobs.id, job!.id));
      return opened;
    }), 1);
    assert.equal((await cardRow(card.messageId)).freezeState, "ready");
    assert.equal((await stored(card.messageId)).state, "prepared");
    const confirmed = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(calls.length, 1);
  } finally {
    resetAll();
  }
});

test("a Confirm again racing a conversion's freeze: the freeze landing between its checks and its write leaves it refused and the card the conversion's", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const card = await prepareArchive(app.baseUrl, w);
    await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, w.target.id));
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).body.errorCode, "action_card_reconfirmation_required");

    const [job] = await getDb().insert(channelConversionJobs).values({ serverId: w.server.id, sourceChannelId: w.channel.id, sourceChannelType: "channel" }).returning();
    const conversion = { id: job!.id, serverId: w.server.id, sourceChannelId: w.channel.id, conversionEpoch: job!.conversionEpoch };
    // The conversion fences the conversation and freezes its cards after the Confirm again read the card.
    setPreparedRequestHooksForTest({ beforeReconfirmWrite: async () => {
      await getDb().insert(channelConversionFences).values({ jobId: job!.id, serverId: w.server.id, sourceChannelId: w.channel.id, conversionEpoch: job!.conversionEpoch });
      assert.ok(await getDb().transaction((tx) => freezeActionCardsForConversion(tx, conversion)) >= 1);
    } });
    const again = await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {});
    assert.equal(again.status, 409, again.text);
    const row = await cardRow(card.messageId);
    assert.deepEqual([row.freezeState, row.conversionJobId], ["frozen", job!.id], "the freeze holds it; the Confirm again wrote nothing");
    assert.equal(row.reconfirmedAt, null);
    assert.equal((await stored(card.messageId)).state, "frozen");
    assert.equal(calls.length, 0);
  } finally {
    resetAll();
  }
});

test("a funnel failure after the record hides nothing: the person gets the card, the agent its reply", async ({ app }) => {
  const w = await world(app);
  stubRunner(ok);
  setPreparedRequestHooksForTest({ funnel: async () => { throw new Error("product_events is down"); } });
  try {
    const card = await prepareStop(app.baseUrl, w);
    const confirmed = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.body.metadata.state, "executed");
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
    assert.match(told[0]!, /ended success/);
  } finally {
    resetAll();
  }
});

// ── Before PR3 ───────────────────────────────────────────────────────────────

test("every run is audited: the stale-claim sweep audits the run it ends, with the id its request carried", async ({ app }) => {
  const w = await world(app);
  try {
    const card = await prepareStop(app.baseUrl, w);
    const requestId = randomUUID();
    const claim: PreparedRequestClaim = { kind: "prepared-request-claim", token: randomUUID(), userId: w.owner.id, claimedAt: new Date(Date.now() - 5 * 60_000).toISOString(), attempt: 1, requestId };
    await getDb().update(actionCards).set({ result: claim }).where(eq(actionCards.messageId, card.messageId));
    assert.ok(await sweepPreparedRequestCards(null, null) >= 1);
    const [event] = await runEvents(card.messageId);
    assert.ok(event, "the sweep's run event");
    assert.deepEqual([(event.metadata as Body).outcome, event.requestId, event.actorId], ["unknown", requestId, w.owner.id]);
  } finally {
    resetAll();
  }
});

test("a run that deleted its own card (its conversation went) is still audited, outside the card", async ({ app }) => {
  const w = await world(app);
  // The route's run takes the card's carrier message with it (as deleting its conversation would, by cascade).
  const calls = stubRunner(async (input) => {
    await getDb().delete(messages).where(eq(messages.id, input.cardMessageId));
    return { status: 200, body: {} };
  });
  try {
    const card = await prepareStop(app.baseUrl, w);
    const confirmed = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(calls.length, 1);
    assert.equal(confirmed.status, 410, confirmed.text);
    assert.equal(confirmed.body.errorCode, "REQUEST_CARD_GONE");
    assert.equal((await getDb().select().from(actionCards).where(eq(actionCards.messageId, card.messageId))).length, 0, "the card went");
    const [event] = await runEvents(card.messageId);
    assert.ok(event, "the run's event, written outside the card");
    assert.deepEqual([(event.metadata as Body).outcome, event.requestId], ["success", calls[0]!.requestId]);
  } finally {
    resetAll();
  }
});

test("the backstop reads the request as it would run: a param that fills a route in as a refused one is refused at prepare and at commit", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    // An entry whose last path param is the verb, an enum (a word a param may take only when its enum lists it).
    const stop = TEST_ROUTES["POST /api/agents/:id/stop"]!;
    const verbRoute = { ...stop, paramsSchema: z.strictObject({ id: z.uuid(), verb: z.enum(["stop", "credentials", "scopes"]) }) };
    const withVerb = (verb: string) => ({ ...verbRoute, operation: { ...stop.operation, resolve: async () => ({ ok: true as const, params: { id: w.worker.id, verb }, body: { reason: "x" } }) } });
    installList({ "POST /api/agents/:id/:verb": withVerb("credentials") });
    const refused = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.body.code, "unknown_operation");

    installList({ "POST /api/agents/:id/:verb": withVerb("stop") });
    const card = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(card.status, 201, card.text);
    // Stored with a refused word in its param anyway (a hand in the database): the run's own path is refused.
    await tamper(card.body.messageId, (action) => ({ ...action, params: { ...action.params, verb: "scopes" } }));
    const pressed = await decide(app.baseUrl, w, "owner", card.body.messageId, "confirm");
    assert.equal(pressed.status, 409, pressed.text);
    assert.equal(pressed.body.errorCode, "request_not_available");
    assert.equal(calls.length, 0);
    assert.deepEqual([(await cardRow(card.body.messageId)).state, (await cardRow(card.body.messageId)).result], ["prepared", null]);
  } finally {
    resetAll();
  }
});

test("a word in an id's place is refused at prepare, and a stored one is never built into a path", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const stop = TEST_ROUTES["POST /api/agents/:id/stop"]!;
    // A schema looser than the list allows (the structure test refuses it): the runtime still takes uuids only.
    const loose = (id: string) => ({ ...stop, paramsSchema: z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) }),
      operation: { ...stop.operation, resolve: async () => ({ ok: true as const, params: { id }, body: { reason: "x" } }) } });
    installList({ "POST /api/agents/:id/stop": loose("me") });
    const refused = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.body.code, "invalid_args");

    installList({ "POST /api/agents/:id/stop": loose(w.worker.id) });
    const card = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(card.status, 201, card.text);
    await tamper(card.body.messageId, (action) => ({ ...action, params: { ...action.params, id: "me" } }));
    const pressed = await decide(app.baseUrl, w, "owner", card.body.messageId, "confirm");
    assert.equal(pressed.status, 409, pressed.text);
    assert.equal(calls.length, 0, "nothing ran");
  } finally {
    resetAll();
  }
});

test("a body field that makes content public or carries a secret is refused at prepare, and at commit when stored anyway", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(ok);
  try {
    const stop = TEST_ROUTES["POST /api/agents/:id/stop"]!;
    const withBody = (body: Record<string, unknown>) => ({ ...stop, bodySchema: z.strictObject({ reason: z.string(), settings: z.record(z.string(), z.unknown()).optional() }),
      operation: { ...stop.operation, resolve: async () => ({ ok: true as const, params: { id: w.worker.id }, body }) } });
    installList({ "POST /api/agents/:id/stop": withBody({ reason: "x", settings: { visitor_visible: true } }) });
    const refused = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.body.code, "invalid_args");
    assert.match(String(refused.body.error), /settings\.visitor_visible/u);

    installList({ "POST /api/agents/:id/stop": withBody({ reason: "x" }) });
    const card = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(card.status, 201, card.text);
    await tamper(card.body.messageId, (action) => ({ ...action, body: { ...action.body, settings: { apiKey: "k" } } }));
    const pressed = await decide(app.baseUrl, w, "owner", card.body.messageId, "confirm");
    assert.equal(pressed.status, 409, pressed.text);
    assert.equal(calls.length, 0, "nothing ran");
    assert.deepEqual([(await cardRow(card.body.messageId)).state, (await cardRow(card.body.messageId)).result], ["prepared", null]);
  } finally {
    resetAll();
  }
});

// ── Races ────────────────────────────────────────────────────────────────────

test("the sweep racing a slow run: it ends the claim unknown once; the run, answering late, records nothing more", async ({ app }) => {
  const w = await world(app);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const calls = stubRunner(async () => { await gate; return { status: 200, body: {} }; });
  try {
    const card = await prepareStop(app.baseUrl, w);
    const press = decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    await waitFor(async () => calls.length, (n) => n === 1);
    // The run outlives the claim window.
    const claim = (await cardRow(card.messageId)).result as PreparedRequestClaim;
    await getDb().update(actionCards).set({ result: { ...claim, claimedAt: new Date(Date.now() - 5 * 60_000).toISOString() } }).where(eq(actionCards.messageId, card.messageId));
    assert.equal(await sweepPreparedRequestCards(app.app.get("io") as never, app.app.get("agentOrchestrator") as never), 1);
    open();
    const answered = await press;
    assert.equal(answered.status, 200, answered.text);
    const row = await cardRow(card.messageId);
    assert.deepEqual([row.state, (row.result as Body).outcome], ["executed", "unknown"]);
    assert.equal((await runEvents(card.messageId)).length, 1, "one run event");
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await replies(w, card.messageId)).length, 1, told.join("\n"));
    assert.match(told[0]!, /ended unknown/);
  } finally {
    open();
    resetAll();
  }
});

test("a 4xx reopen racing a stale press: the press that read the old attempt can't claim the reopened card", async ({ app }) => {
  const w = await world(app);
  let releaseStale!: () => void;
  const staleWaits = new Promise<void>((resolve) => { releaseStale = resolve; });
  let first = true;
  const calls = stubRunner(async () => ({ status: 409, body: { error: "Busy now.", code: "agent_busy" } }));
  setPreparedRequestHooksForTest({ beforeClaim: async () => { if (first) { first = false; await staleWaits; } } });
  try {
    const card = await prepareStop(app.baseUrl, w);
    // The stale press reads the card at attempt 1 and stops before its claim.
    const stale = decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Another press claims, runs, is refused, and reopens the card at attempt 2.
    const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(refused.body.errorCode, "request_refused", refused.text);
    assert.equal((await stored(card.messageId)).action.attempt, 2);
    releaseStale();
    const late = await stale;
    assert.equal(late.status, 409, late.text);
    assert.equal(late.body.errorCode, "REQUEST_ALREADY_CONFIRMING");
    assert.equal(calls.length, 1, "the stale press ran nothing");
    assert.deepEqual([(await cardRow(card.messageId)).state, (await cardRow(card.messageId)).result], ["prepared", null]);
  } finally {
    releaseStale();
    resetAll();
  }
});

test("prepares racing the open-card cap: exactly 5 open, the rest refused", async ({ app }) => {
  const w = await world(app);
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      prepare(app.baseUrl, w, { to: `@${w.alice.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}`, why: `race ${i}` } })));
    assert.equal(results.filter((res) => res.status === 201).length, 5, results.map((res) => `${res.status} ${res.body.code ?? ""}`).join(", "));
    for (const res of results.filter((res) => res.status !== 201)) assert.equal(res.body.code, "too_many_open_requests", res.text);
  } finally {
    resetAll();
  }
});
