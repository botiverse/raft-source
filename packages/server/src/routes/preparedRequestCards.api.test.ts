// RFC 085 PR2: the request:prepare card (services/preparedRequestPrepare.ts, services/preparedRequestCards.ts).
// The delegable list is empty in production until the first templates, so these tests put entries of their own on it
// (setDelegableCardRegistryForTest): `channel:archive` over the real POST /api/channels/:id/archive (its own
// archiveChannels check, run as the person), and `agent:stop` over POST /api/agents/:id/stop, whose runs a stand-in
// runner answers (setOwnerRouteDispatcherForTest) when a test needs a 5xx, no answer, a throw or a race.
//
// Pins: prepare behind prepared_request_card_v0 (off: refused as an unknown type); unknown operation, schema-invalid
// args, args the agent can't see (the uniform refusal); at most 5 open cards per agent and person; the summary echoed.
// Commit: only the person named; a changed summary moves the card to reconfirm_required, unless the preparing agent
// can't see the new one (changed_since_prepared); one claim, never two runs; the person's own session through the
// route's middleware (its own permission check refuses); a 4xx reopens it with the next attempt's key; a 5xx, no
// answer or a throw is unknown and never runs again; declined (served to clients as expired); 30 days; withdrawn; the
// agent hears one result kind and never the route's body.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { preparedRequestFormId } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { actionCards, channelAgents, channels } from "../db/schema";
import * as channelService from "../services/channelService";
import { sweepPreparedRequestCards } from "../services/preparedRequestCards";
import { setOwnerRouteDispatcherForTest } from "../services/assistantOwnerActionCards";
import { AGENT_CHANNEL_NOT_FOUND_REFUSAL } from "./agentRouteRefusals";
import { cardRow, post } from "../test/actionCardFormFixture";
import {
  agentApi, decide, prepare, prepareArchive, prepareStop, replies, reset, stored, stubRunner, waitFor, world,
} from "../test/preparedRequestFixture";

const test = createApiTest();

/** A refusal or answer read loosely: a test asserts on whichever fields its case expects. */
type Body = Record<string, any>;

// ── Prepare ──────────────────────────────────────────────────────────────────

test("flag off: prepare refuses request:prepare with the same answer as a card type the server doesn't know", async ({ app }) => {
  const w = await world(app, { flag: false });
  try {
    const off = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:archive", args: { channel: `#${w.target.name}` } });
    const unknown = await agentApi(app.baseUrl, w.agentKey, "/prepare-action", { target: `#${w.channel.name}`, action: { type: "request:nope", to: "@x" } });
    assert.equal(off.status, 400, off.text);
    assert.equal(off.status, unknown.status);
    assert.equal(off.body.errorCode, "INVALID_ACTION");
    assert.equal(off.body.errorCode, unknown.body.errorCode);
    assert.equal(off.body.error, unknown.body.error.replace("request:nope", "request:prepare"));
    assert.equal(off.body.suggestedNextAction, unknown.body.suggestedNextAction.replace("request:nope", "request:prepare"));
    assert.ok(!String(off.body.suggestedNextAction).split("Card types this server accepts:")[1]!.includes("request:prepare"), "not offered as a type");
    assert.equal((await getDb().select().from(actionCards).where(eq(actionCards.requesterAgentId, w.agent.id))).length, 0);
  } finally {
    reset();
  }
});

test("prepare: unknown operation, args that don't fit, and args the agent can't see (the uniform refusal, no probing)", async ({ app }) => {
  const w = await world(app);
  try {
    const unknownOp = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "server:delete", args: {} });
    assert.equal(unknownOp.status, 400, unknownOp.text);
    assert.equal(unknownOp.body.code, "unknown_operation");

    const badArgs = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:archive", args: { chanel: `#${w.target.name}` } });
    assert.equal(badArgs.status, 400, badArgs.text);
    assert.equal(badArgs.body.code, "invalid_args");
    assert.match(badArgs.body.error, /args/);

    // A private channel the agent isn't in reads exactly like one that doesn't exist.
    const hidden = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:archive", args: { channel: `#${w.hidden.name}` } });
    const missing = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:archive", args: { channel: "#no-such-channel" } });
    assert.equal(hidden.status, 404, hidden.text);
    assert.deepEqual({ status: hidden.status, body: hidden.body }, { status: missing.status, body: missing.body });
    assert.equal(hidden.body.code, AGENT_CHANNEL_NOT_FOUND_REFUSAL.code);
    assert.equal(hidden.body.error, AGENT_CHANNEL_NOT_FOUND_REFUSAL.error);

    // A person who isn't here: the uniform person refusal. Someone who can't act in the conversation: said so.
    const nobody = await prepare(app.baseUrl, w, { to: "@nobody-here", operation: "channel:archive", args: { channel: `#${w.target.name}` } });
    assert.equal(nobody.status, 404, nobody.text);
    assert.equal(nobody.body.code, "user_not_found");
    const notHere = await prepare(app.baseUrl, w, { to: `@${w.bob.name}`, operation: "channel:archive", args: { channel: `#${w.target.name}` } });
    assert.equal(notHere.status, 409, notHere.text);
    assert.equal(notHere.body.code, "addressee_cannot_act_here");
    assert.equal((await getDb().select().from(actionCards).where(eq(actionCards.requesterAgentId, w.agent.id))).length, 0, "no card for any of them");
  } finally {
    reset();
  }
});

test("prepare: the card stores route, params, parsed body, model and digest, mentions the person, and the agent hears the summary back", async ({ app }) => {
  const w = await world(app);
  try {
    const card = await prepareArchive(app.baseUrl, w, "owner", "Ops asked for this.");
    assert.deepEqual(card.preparedRequest, {
      summary: `Channel (Channel: #${w.target.name})`,
      title: "Channel",
      for: `@${w.owner.name}`,
      operation: "channel:archive",
      result: "reply",
    });
    assert.equal(card.metadata.presentation?.card, undefined, "the agent never reads presentation.card");
    const metadata = await stored(card.messageId);
    const action = metadata.action;
    assert.equal(action.type, "request:prepare");
    assert.equal(action.route, "POST /api/channels/:id/archive");
    assert.deepEqual(action.params, { id: w.target.id });
    assert.deepEqual(action.body, {});
    assert.deepEqual(action.addressee, { kind: "user", userId: w.owner.id, handle: w.owner.name });
    assert.deepEqual(action.summaryModel, { channel: { kind: "channel", id: w.target.id }, visibility: { kind: "text", text: "public" } });
    assert.equal(action.permission, "archiveChannels");
    assert.equal(action.attempt, 1);
    assert.match(action.digest, /^[0-9a-f]{64}$/);
    assert.equal(action.note, "Ops asked for this.");
    assert.deepEqual((await cardRow(card.messageId)).payload, action, "the row and the carrier hold the same action");
    // The card the person sees: the decision form keyed by the digest, the note as raw text, no route answer.
    const spec = metadata.presentation!.card!;
    assert.ok(spec.forms?.[preparedRequestFormId(action.digest)], JSON.stringify(metadata.presentation));
    assert.ok(JSON.stringify(spec).includes("Ops asked for this."));
    assert.equal(metadata.presentation!.genericApprovalAllowed, false);

    // The body schema's output only: the agent's "  quiet please  " is sent trimmed.
    const stop = await prepareStop(app.baseUrl, w);
    assert.deepEqual((await stored(stop.messageId)).action.body, { reason: "quiet please" });
    assert.equal(stop.preparedRequest.summary, `Move @named-${w.worker.id.slice(0, 4)} to another computer (Agent: @named-${w.worker.id.slice(0, 4)})`);
  } finally {
    reset();
  }
});

test("prepare: at most 5 open cards per agent and person; the 6th is refused and names the open ones", async ({ app }) => {
  const w = await world(app);
  try {
    const open = [];
    for (let i = 0; i < 5; i += 1) open.push(await prepareStop(app.baseUrl, w, "alice"));
    const sixth = await prepare(app.baseUrl, w, { to: `@${w.alice.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(sixth.status, 409, sixth.text);
    assert.equal(sixth.body.code, "too_many_open_requests");
    for (const card of open) assert.ok(sixth.body.error.includes(card.messageId.slice(0, 8)), sixth.body.error);
    // Another person is counted apart.
    await prepareStop(app.baseUrl, w, "owner");
    // Withdrawn, one is no longer open.
    const withdrawn = await agentApi(app.baseUrl, w.agentKey, `/actions/${open[0]!.messageId}/withdraw`);
    assert.equal(withdrawn.status, 200, withdrawn.text);
    await prepareStop(app.baseUrl, w, "alice");
  } finally {
    reset();
  }
});

// ── Commit ───────────────────────────────────────────────────────────────────

test("commit through the real route as the person: the owner's archive runs; the agent hears success and never the route's body", async ({ app }) => {
  const w = await world(app);
  try {
    const card = await prepareArchive(app.baseUrl, w);
    // Only the person named decides.
    const notThem = await decide(app.baseUrl, w, "alice", card.messageId, "confirm");
    assert.equal(notThem.status, 403, notThem.text);
    assert.equal(notThem.body.errorCode, "NOT_ADDRESSEE");
    assert.equal((await cardRow(card.messageId)).state, "prepared");

    const confirmed = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.ok((await channelService.getChannel(w.target.id))?.archivedAt, "the route ran: the channel is archived");
    const row = await cardRow(card.messageId);
    assert.equal(row.state, "executed");
    assert.equal(row.executedByUserId, w.owner.id);
    const result = (await stored(card.messageId)).result as Body;
    assert.deepEqual(Object.keys(result).sort(), ["attempt", "decidedAt", "decidedByUserId", "kind", "outcome", "status"]);
    assert.deepEqual({ kind: result.kind, outcome: result.outcome, status: result.status, attempt: result.attempt }, { kind: "prepared-request", outcome: "success", status: 200, attempt: 1 });
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.match(told[0]!, /ended success\. @[\w-]+ confirmed it, and it ran\.$/);
    assert.ok(told[0]!.includes(`#${w.target.name}`));
    // The route answered with the archived channel; none of it reaches the agent or the card.
    assert.ok(!told[0]!.includes("archivedAt") && !JSON.stringify(result).includes("archived"));
  } finally {
    reset();
  }
});

test("commit: the route's own permission check refuses a person without it; the card reopens with the next attempt and the agent hears the code", async ({ app }) => {
  const w = await world(app);
  try {
    // Alice is a member: the card was shown to her, but the route decides (archiveChannels).
    const card = await prepareArchive(app.baseUrl, w, "alice");
    const refused = await decide(app.baseUrl, w, "alice", card.messageId, "confirm");
    // The card's own refusal, never the route's status as /execute's; the route's own sentence, to the person who pressed.
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_refused");
    assert.equal(refused.body.error, "Only admins can archive channels");
    assert.deepEqual([(refused.body as Body).routeStatus, (refused.body as Body).routeCode], [403, "channel_archive_forbidden"]);
    assert.equal(((refused.body as Body).metadata as Body).action.attempt, 2, "the card as it is now");
    assert.equal((await channelService.getChannel(w.target.id))?.archivedAt ?? null, null);
    const row = await cardRow(card.messageId);
    assert.equal(row.state, "prepared");
    assert.equal(row.result, null, "no claim left");
    const action = (await stored(card.messageId)).action;
    assert.equal(action.attempt, 2);
    assert.deepEqual({ status: action.refusal?.status, code: action.refusal?.code, attempt: action.refusal?.attempt }, { status: 403, code: "channel_archive_forbidden", attempt: 1 });
    assert.ok(!JSON.stringify(action).includes("Only admins"), "the route's sentence is not on the card the agent reads");
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
    assert.match(told[0]!, /ended refused \(channel_archive_forbidden\)\./);
  } finally {
    reset();
  }
});

test("a 4xx reopens the card and the next confirm runs with the next attempt's idempotency key", async ({ app }) => {
  const w = await world(app);
  let first = true;
  const calls = stubRunner(async () => {
    if (first) { first = false; return { status: 409, body: { error: "The agent is busy", code: "agent_busy", secret: "route-body-sentinel" } }; }
    return { status: 200, body: { ok: true, secret: "route-body-sentinel" } };
  });
  try {
    const card = await prepareStop(app.baseUrl, w);
    const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_refused");
    assert.equal((refused.body as Body).routeCode, "agent_busy");
    assert.ok(!refused.text.includes("route-body-sentinel"), "only the route's sentence, never its body");
    const again = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(calls.map((call) => call.idempotencyKey), [`${card.messageId}:1`, `${card.messageId}:2`]);
    assert.deepEqual(calls[0]!.request, { method: "POST", path: `/api/agents/${w.worker.id}/stop`, body: { reason: "quiet please" } });
    assert.equal(calls[0]!.ownerRequest.headers.authorization, `Bearer ${w.tokens.owner}`, "the person's own session");
    assert.equal(calls[0]!.serverId, w.server.id);
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length >= 2);
    assert.ok(told.some((line) => line.includes("ended refused (agent_busy)")));
    assert.ok(told.some((line) => line.includes("ended success")));
    for (const line of told) assert.ok(!line.includes("route-body-sentinel") && !line.includes("busy\""), line);
    assert.ok(!JSON.stringify(await stored(card.messageId)).includes("route-body-sentinel"));
  } finally {
    reset();
  }
});

test("a double click or a retry never runs twice: one claim, the other is told it's being confirmed", async ({ app }) => {
  const w = await world(app);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls = stubRunner(async () => { await gate; return { status: 200, body: {} }; });
  try {
    const card = await prepareStop(app.baseUrl, w);
    const firstPress = decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    await waitFor(async () => calls.length, (n) => n === 1);
    // Answered at once, while the first still runs (a second run would wait on the same gate).
    const second = await Promise.race([
      decide(app.baseUrl, w, "owner", card.messageId, "confirm"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the second press did not answer at once (runs: ${calls.length})`)), 5_000)),
    ]);
    assert.equal(second.status, 409, second.text);
    assert.equal(second.body.errorCode, "REQUEST_ALREADY_CONFIRMING");
    // Withdrawing and declining wait for it too.
    const withdraw = await agentApi(app.baseUrl, w.agentKey, `/actions/${card.messageId}/withdraw`);
    assert.equal(withdraw.body.errorCode, "REQUEST_ALREADY_CONFIRMING", withdraw.text);
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "decline")).body.errorCode, "REQUEST_ALREADY_CONFIRMING");
    release();
    assert.equal((await firstPress).status, 200);
    // The same form again after it ended: the card, and still one run.
    const retry = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(retry.status, 200, retry.text);
    assert.equal(calls.length, 1);
  } finally {
    release();
    reset();
  }
});

test("a 5xx, no answer in time, or a throw is unknown: the card ends and never runs again", async ({ app }) => {
  const w = await world(app);
  for (const answer of [
    async () => ({ status: 503, body: { error: "upstream down" } }),
    async () => ({ status: 504, body: { error: "The route didn't answer", code: "assistant_owner_action_timeout" } }),
    async () => { throw new Error("socket hang up"); },
  ] as const) {
    const calls = stubRunner(answer as Parameters<typeof stubRunner>[0]);
    try {
      const card = await prepareStop(app.baseUrl, w, "owner");
      const pressed = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
      assert.equal(pressed.status, 200, pressed.text);
      const row = await cardRow(card.messageId);
      assert.equal(row.state, "executed");
      assert.equal((row.result as Body).outcome, "unknown");
      const again = await post(app.baseUrl, w, "owner", `${card.messageId}/execute`, { expectedState: "prepared", form: { id: preparedRequestFormId((await stored(card.messageId)).action.digest), values: { decision: "confirm" } } });
      assert.ok(again.status === 200 || again.status === 409, again.text);
      assert.equal(calls.length, 1, "never run again");
      const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
      assert.match(told[0]!, /ended unknown\. .* it may have run\. It won't run again/);
    } finally {
      setOwnerRouteDispatcherForTest(null);
    }
  }
  reset();
});

test("a claim that outlived its run (the process stopped) is ended unknown by the sweep and never runs", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(async () => ({ status: 200, body: {} }));
  try {
    const card = await prepareStop(app.baseUrl, w);
    const action = (await stored(card.messageId)).action;
    await getDb().update(actionCards)
      .set({ result: { kind: "prepared-request-claim", token: randomUUID(), claimedAt: new Date(Date.now() - 5 * 60_000).toISOString(), userId: w.owner.id, attempt: action.attempt } })
      .where(eq(actionCards.messageId, card.messageId));
    const pressed = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(pressed.body.errorCode, "REQUEST_ALREADY_CONFIRMING");
    assert.ok(await sweepPreparedRequestCards(app.app.get("io") as never, app.app.get("agentOrchestrator") as never) >= 1);
    const row = await cardRow(card.messageId);
    assert.equal(row.state, "executed");
    assert.equal((row.result as Body).outcome, "unknown");
    assert.equal(calls.length, 0);
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
    assert.match(told[0]!, /ended unknown/);
  } finally {
    reset();
  }
});

test("a changed summary: the old digest is refused, the card moves to reconfirm_required with the new one, and Confirm again opens it", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(async () => ({ status: 200, body: {} }));
  try {
    const card = await prepareArchive(app.baseUrl, w);
    const before = (await stored(card.messageId)).action;
    const oldForm = preparedRequestFormId(before.digest);
    // The channel turned private since (the agent and the owner are still in it).
    await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, w.target.id));
    const changed = await decide(app.baseUrl, w, "owner", card.messageId, "confirm", oldForm);
    assert.equal(changed.status, 409, changed.text);
    assert.equal(changed.body.errorCode, "action_card_reconfirmation_required");
    assert.equal(calls.length, 0, "nothing ran");
    const after = await stored(card.messageId);
    assert.equal(after.state, "reconfirm_required");
    assert.deepEqual(after.action.summaryModel.visibility, { kind: "text", text: "private" });
    assert.notEqual(after.action.digest, before.digest);
    assert.ok(after.action.changedAt);
    const row = await cardRow(card.messageId);
    assert.deepEqual([row.state, row.freezeState, row.result], ["prepared", "reconfirm_required", null]);
    // The card's own fallback names are everyone's: a channel now private is no longer named on it.
    assert.ok(JSON.stringify((await stored(card.messageId)).presentation).includes(w.target.name) === false);
    // Confirming again with what it showed before: refused, still nothing runs.
    const stale = await decide(app.baseUrl, w, "owner", card.messageId, "confirm", oldForm);
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.errorCode, "action_card_reconfirmation_required");
    // Only the person named confirms it again; Confirm again (the card's reconfirm) opens it.
    assert.equal((await post(app.baseUrl, w, "alice", `${card.messageId}/reconfirm`, {})).body.errorCode, "NOT_ADDRESSEE");
    const reconfirmed = await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {});
    assert.equal(reconfirmed.status, 200, reconfirmed.text);
    assert.equal(reconfirmed.body.metadata.state, "prepared");
    // The form it showed before the change stays refused.
    const oldDigest = await decide(app.baseUrl, w, "owner", card.messageId, "confirm", oldForm);
    assert.equal(oldDigest.status, 422, oldDigest.text);
    assert.equal(calls.length, 0);
    // It moves again while it waits to be confirmed again: Confirm again shows it as it is now, and asks again.
    await getDb().update(channels).set({ type: "channel" }).where(eq(channels.id, w.target.id));
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).body.errorCode, "action_card_reconfirmation_required");
    await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, w.target.id));
    const movedAgain = await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {});
    assert.equal(movedAgain.status, 409, movedAgain.text);
    assert.equal(movedAgain.body.errorCode, "action_card_reconfirmation_required");
    assert.deepEqual((await stored(card.messageId)).action.summaryModel.visibility, { kind: "text", text: "private" });
    assert.equal((await post(app.baseUrl, w, "owner", `${card.messageId}/reconfirm`, {})).status, 200);
    const ran = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(ran.status, 200, ran.text);
    assert.equal(calls.length, 1);
  } finally {
    reset();
  }
});

test("a changed summary the preparing agent can't see is never offered: the card ends changed_since_prepared (Warden)", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(async () => ({ status: 200, body: {} }));
  try {
    // At commit: the channel turned private and the agent left it; the owner still sees it.
    const card = await prepareArchive(app.baseUrl, w);
    await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, w.target.id));
    await getDb().delete(channelAgents).where(and(eq(channelAgents.channelId, w.target.id), eq(channelAgents.agentId, w.agent.id)));
    const refused = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_changed_unavailable");
    const row = await cardRow(card.messageId);
    assert.equal(row.state, "expired");
    assert.equal((row.result as Body).outcome, "changed_since_prepared");
    assert.equal(calls.length, 0);
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
    assert.match(told[0]!, /ended changed_since_prepared/);
    assert.ok(!told[0]!.includes(w.target.name), "the agent isn't told the name it can no longer see");

    // At Confirm again: the card changed while the agent could see it, then the agent lost it.
    await channelService.addAgent(w.target.id, w.agent.id);
    await getDb().update(channels).set({ type: "channel" }).where(eq(channels.id, w.target.id));
    const second = await prepareArchive(app.baseUrl, w);
    await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, w.target.id));
    assert.equal((await decide(app.baseUrl, w, "owner", second.messageId, "confirm")).body.errorCode, "action_card_reconfirmation_required");
    await getDb().delete(channelAgents).where(and(eq(channelAgents.channelId, w.target.id), eq(channelAgents.agentId, w.agent.id)));
    const again = await post(app.baseUrl, w, "owner", `${second.messageId}/reconfirm`, {});
    assert.equal(again.status, 409, again.text);
    assert.equal(again.body.errorCode, "request_changed_unavailable");
    assert.equal((await cardRow(second.messageId)).state, "expired");
    assert.equal(calls.length, 0);
  } finally {
    reset();
  }
});

test("declined: nothing runs, the agent hears it, and clients are served a state they know (expired) while the card stores declined", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(async () => ({ status: 200, body: {} }));
  try {
    const card = await prepareStop(app.baseUrl, w);
    // Alice is in the card's conversation and sees it, but it isn't hers to decide.
    const notThem = await decide(app.baseUrl, w, "alice", card.messageId, "decline");
    assert.equal(notThem.status, 403, notThem.text);
    assert.equal(notThem.body.errorCode, "NOT_ADDRESSEE");
    const declined = await decide(app.baseUrl, w, "owner", card.messageId, "decline");
    assert.equal(declined.status, 200, declined.text);
    assert.equal(declined.body.metadata.state, "expired", "served as a state every client knows");
    assert.equal((declined.body.metadata.result as Body).outcome, "declined");
    assert.equal((await cardRow(card.messageId)).state, "declined");
    assert.equal((await stored(card.messageId)).state, "declined", "stored as what it is");
    // History reads serve it the same way (messageService.listMessagesByIds is what reads and broadcasts use).
    const { listMessagesByIds } = await import("../services/messageService");
    const [read] = await listMessagesByIds([card.messageId]);
    assert.equal((read?.actionMetadata as Body | undefined)?.state, "expired");
    // The broadcast too.
    const broadcast = w.emitted.filter((emit) => emit.event === "message:updated" && (emit.payload as Body)?.id === card.messageId).at(-1);
    assert.equal(((broadcast?.payload as Body)?.actionMetadata as Body)?.state, "expired");
    assert.equal(calls.length, 0);
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
    assert.match(told[0]!, /ended declined\. @[\w-]+ declined it\. Nothing ran\.$/);
    const late = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(late.status, 409, late.text);
    assert.equal(calls.length, 0);
  } finally {
    reset();
  }
});

test("30 days unconfirmed: a confirm is refused, the sweep ends it expired and the agent hears it", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(async () => ({ status: 200, body: {} }));
  try {
    const card = await prepareStop(app.baseUrl, w);
    await getDb().update(actionCards).set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) }).where(eq(actionCards.messageId, card.messageId));
    const late = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(late.status, 409, late.text);
    assert.equal(late.body.errorCode, "ACTION_CARD_EXPIRED");
    assert.ok(await sweepPreparedRequestCards(app.app.get("io") as never, app.app.get("agentOrchestrator") as never) >= 1);
    assert.equal((await cardRow(card.messageId)).state, "expired");
    assert.equal(calls.length, 0);
    const told = await waitFor(() => replies(w, card.messageId), (lines) => lines.length > 0);
    assert.match(told[0]!, /ended expired\. Nobody confirmed it within 30 days/);
  } finally {
    reset();
  }
});

test("withdrawn by the agent that prepared it: the receipt is the generic result kind, and the person can no longer confirm", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(async () => ({ status: 200, body: {} }));
  try {
    const card = await prepareArchive(app.baseUrl, w);
    const withdrawn = await agentApi(app.baseUrl, w.agentKey, `/actions/${card.messageId.slice(0, 8)}/withdraw`);
    assert.equal(withdrawn.status, 200, withdrawn.text);
    assert.equal(withdrawn.body.metadata.state, "withdrawn");
    assert.deepEqual(withdrawn.body.preparedRequest, { outcome: "withdrawn", summary: `Channel (Channel: #${w.target.name})` });
    const again = await agentApi(app.baseUrl, w.agentKey, `/actions/${card.messageId}/withdraw`);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.alreadyWithdrawn, true);
    const pressed = await decide(app.baseUrl, w, "owner", card.messageId, "confirm");
    assert.equal(pressed.status, 409, pressed.text);
    assert.equal(calls.length, 0);
  } finally {
    reset();
  }
});

test("only the person named, and the session that confirms is theirs; nothing of it is stored", async ({ app }) => {
  const w = await world(app);
  const calls = stubRunner(async () => ({ status: 200, body: {} }));
  try {
    const card = await prepareStop(app.baseUrl, w, "alice");
    assert.equal((await decide(app.baseUrl, w, "owner", card.messageId, "confirm")).body.errorCode, "NOT_ADDRESSEE");
    assert.equal(calls.length, 0);
    const confirmed = await decide(app.baseUrl, w, "alice", card.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(calls[0]!.ownerRequest.headers.authorization, `Bearer ${w.tokens.alice}`);
    assert.ok(!JSON.stringify(await cardRow(card.messageId)).includes(w.tokens.alice));
    assert.ok(!JSON.stringify(await stored(card.messageId)).includes(w.tokens.alice));
  } finally {
    reset();
  }
});
