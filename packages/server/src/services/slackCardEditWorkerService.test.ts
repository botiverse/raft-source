// RFC 082 §4.6 (§8 "Slack edits"): a card update edits its bridged Slack
// message. Service-level: the card update writes the intent, the worker edits
// through a Slack Web API double (no real Slack).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { messageCardMetadataAtSend, SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { dbTest as test } from "../test/integration/dbTest";
import {
  agents,
  channels,
  externalAppInstalls,
  externalCardEditAttempts,
  externalCardEditPairNotices,
  externalCardEditSyncs,
  externalChannelBindings,
  externalDeliveryAttempts,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalOutboundDeliveries,
  messageCardRevisions,
  messages,
  serverAgentMembers,
} from "../db/schema";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import {
  APP,
  card,
  confirmOriginal,
  CONVERSATION,
  recordAudience,
  seedCardOnPair,
  seedJointSlackCardEditFixture,
  seedSlackCardEditFixture,
  TEAM,
  TS,
  updateCard,
  type SlackCardEditFixture as Fixture,
} from "../test/slackCardEditFixture";
import { archiveChannel, removeAgent, unarchiveChannel } from "./channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "./channelConversionService";
import { applyMessageCardUpdate } from "./messageCardService";
import { updateFeatureFlag } from "./featureFlagService";
import * as planService from "./planService";
import {
  __setSlackCardEditBeforePairNoticeLockHookForTests,
  listSlackCardEditPanelNotices,
  readSlackCardEditSyncState,
  recordSlackCardEditIntent,
  SLACK_CARD_EDIT_LATER_RECHECK_MS,
  SLACK_CARD_EDIT_LEASE_MS,
  SLACK_CARD_EDIT_NOT_CONFIRMED_NOTICE_MS,
  SLACK_CARD_EDIT_ORIGINAL_WAIT_MS,
  SLACK_CARD_EDIT_QUIET_PERIOD_MS,
  slackCardEditSyncStatus,
} from "./slackCardEditSync";
import {
  __setSlackCardEditAfterProviderIoHookForTests,
  __setSlackCardEditBeforeSenderPostingCheckHookForTests,
  classifySlackCardOriginal,
  processSlackCardEditSyncOnce,
  raiseSlackCardEditNotConfirmedNotices,
  type SlackCardEditWorkerDependencies,
  type SlackCardEditWorkerResult,
} from "./slackCardEditWorkerService";
import {
  SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
  type SlackJsonObject,
  type SlackWebApiRequest,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter";

afterEach(() => {
  __setSlackCardEditAfterProviderIoHookForTests(null);
  __setSlackCardEditBeforeSenderPostingCheckHookForTests(null);
  __setSlackCardEditBeforePairNoticeLockHookForTests(null);
  vi.restoreAllMocks();
});

/** A Slack double for one bridged message: chat.update applies, history reads back what it shows. */
function fakeSlack(fixture: Fixture) {
  const state = {
    shownRevision: 1,
    shownText: fixture.message.content,
    requests: [] as SlackWebApiRequest[],
    script: [] as Array<(request: SlackWebApiRequest) => Promise<SlackWebApiTransportResult> | SlackWebApiTransportResult>,
    late: [] as SlackWebApiRequest[],
    leases: 0,
    releases: 0,
    /** Other cards of the pair: ts → delivery id, what Slack shows, and scripted answers for that ts. */
    others: new Map<string, { deliveryId: string; shownRevision: number; script: Array<(request: SlackWebApiRequest) => SlackWebApiTransportResult> }>(),
  };
  const ok = (body: SlackJsonObject): SlackWebApiTransportResult => ({
    kind: "response", status: 200, headers: {}, body: { ok: true, ...body },
    observedAuthority: { providerAppId: APP, providerAuthorityId: TEAM },
  });
  const error = (code: string, status = 200): SlackWebApiTransportResult => ({
    kind: "response", status, headers: {}, body: { ok: false, error: code },
    observedAuthority: { providerAppId: APP, providerAuthorityId: TEAM },
  });
  const apply = (request: SlackWebApiRequest) => {
    const payload = (request.body.metadata as { event_payload: { card_revision: number } }).event_payload;
    const other = state.others.get(String(request.body.ts));
    if (other) { other.shownRevision = payload.card_revision; return; }
    state.shownRevision = payload.card_revision;
    state.shownText = String(request.body.text);
  };
  const handle = (request: SlackWebApiRequest): SlackWebApiTransportResult => {
    if (request.method === "chat.update") {
      apply(request);
      return ok({ channel: CONVERSATION, ts: String(request.body.ts) });
    }
    if (request.method === "conversations.history" || request.method === "conversations.replies") {
      const ts = String(request.body.latest);
      const other = state.others.get(ts);
      const revision = other ? other.shownRevision : state.shownRevision;
      return ok({ messages: [{
        ts, app_id: APP, bot_id: "B_BOT", text: other ? "other" : state.shownText,
        metadata: { event_type: "raft_message", event_payload: {
          delivery_id: other ? other.deliveryId : fixture.delivery.id,
          ...(revision > 1 ? { card_revision: revision } : {}),
        } },
      }] });
    }
    throw new Error(`unexpected Slack method ${request.method}`);
  };
  return {
    state, ok, error, apply,
    /** Answer as the double would without a script. */
    passthrough: handle,
    /** The request times out; Slack received it and applies it later (land()). */
    timeoutLandsLater(request: SlackWebApiRequest): SlackWebApiTransportResult {
      state.late.push(request);
      return { kind: "transport_failure", phase: "after_send", code: "timeout" };
    },
    land() {
      for (const request of state.late.splice(0)) apply(request);
    },
    transport: {
      evidence: "double" as const,
      async call(request: SlackWebApiRequest) {
        state.requests.push(structuredClone(request));
        const other = state.others.get(String(request.body.ts));
        if (other) {
          const scripted = other.script.shift();
          return scripted ? scripted(request) : handle(request);
        }
        const scripted = state.script.shift();
        return scripted ? scripted(request) : handle(request);
      },
    },
    methods: () => state.requests.map((request) => request.method),
  };
}

function worker(fixture: Fixture, slack: ReturnType<typeof fakeSlack>, clock: { now: Date }, leaseOwner = "card-worker",
  hooks: { onLease?: () => Promise<void>; credentialMs?: number } = {}) {
  const dependencies: SlackCardEditWorkerDependencies = {
    registrationId: fixture.registration.id,
    transport: slack.transport,
    async leaseCredential({ fence, now }) {
      slack.state.leases += 1;
      await hooks.onLease?.();
      return {
        schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA, leaseId: randomUUID(), installId: fence.installId,
        providerAppId: fence.providerAppId, providerAuthorityId: fence.providerAuthorityId,
        connectionEpoch: fence.connectionEpoch, credentialRevision: fence.credentialRevision,
        leaseExpiresAt: new Date(now.getTime() + (hooks.credentialMs ?? 60_000)),
      };
    },
    async releaseCredential() { slack.state.releases += 1; },
    now: () => clock.now,
  };
  return {
    step: (): Promise<SlackCardEditWorkerResult> => processSlackCardEditSyncOnce({ db: fixture.db, leaseOwner, dependencies }),
    async drain(): Promise<SlackCardEditWorkerResult[]> {
      const results: SlackCardEditWorkerResult[] = [];
      for (let index = 0; index < 20; index += 1) {
        const result = await processSlackCardEditSyncOnce({ db: fixture.db, leaseOwner, dependencies });
        if (result.kind === "empty") return results;
        results.push(result);
      }
      throw new Error("the card edit worker did not settle");
    },
  };
}

function clockAt(start = new Date()) {
  const clock = { now: start };
  return { clock, advance(ms: number) { clock.now = new Date(clock.now.getTime() + ms); } };
}

async function syncRow(fixture: Fixture) {
  const [row] = await fixture.db.select().from(externalCardEditSyncs)
    .where(eq(externalCardEditSyncs.deliveryId, fixture.delivery.id));
  return row!;
}

async function status(fixture: Fixture) {
  const [state] = await readSlackCardEditSyncState(fixture.db, fixture.message.id);
  return state!.status;
}

/** What the setup panel shows for the fixture's pair (the same projection the panel reads). */
async function panelKinds(fixture: Pick<Fixture, "db" | "binding">, at: Date): Promise<string[]> {
  return (await listSlackCardEditPanelNotices(fixture.db, [{ bindingId: fixture.binding.id, bindingEpoch: fixture.binding.bindingEpoch }], at))
    .map((notice) => notice.kind).sort();
}

async function tableKinds(db: Fixture["db"]): Promise<string[]> {
  return (await db.select().from(externalCardEditPairNotices)).map((notice) => notice.kind).sort();
}

function editRevisions(slack: ReturnType<typeof fakeSlack>): number[] {
  return slack.state.requests.filter((request) => request.method === "chat.update")
    .map((request) => (request.body.metadata as { event_payload: { card_revision: number } }).event_payload.card_revision);
}

// ---------------------------------------------------------------------------
// 2. Edit only a confirmed original.

test("an update while the original is queued or unknown edits only after the original is confirmed, never re-posting", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db, { original: "queued" });
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready for testing", clock.now);
  assert.deepEqual(await run.step(), { kind: "waiting", syncId: (await syncRow(fixture)).id, reason: "original_queued" });
  assert.deepEqual(slack.methods(), [], "no Slack id yet: nothing is guessed, nothing posted");
  assert.equal((await syncRow(fixture)).nextAttemptAt?.getTime(), clock.now.getTime() + SLACK_CARD_EDIT_ORIGINAL_WAIT_MS);

  await db.update(externalOutboundDeliveries).set({ state: "outcome_unknown", providerAttempts: 1, firstDispatchedAt: clock.now })
    .where(eq(externalOutboundDeliveries.id, fixture.delivery.id));
  advance(SLACK_CARD_EDIT_ORIGINAL_WAIT_MS);
  const unknown = await run.step();
  assert.equal(unknown.kind === "waiting" ? unknown.reason : unknown.kind, "original_outcome_unknown");
  assert.deepEqual(slack.methods(), [], "an original whose outcome is unknown is never edited or re-posted");

  await confirmOriginal(db, fixture);
  advance(SLACK_CARD_EDIT_ORIGINAL_WAIT_MS);
  const edited = await run.step();
  assert.equal(edited.kind === "attempted" ? edited.outcome : edited.kind, "succeeded");
  assert.deepEqual(slack.methods(), ["chat.update"]);
  assert.equal(slack.state.requests[0]!.body.ts, TS, "the confirmed original's stored ts");
  assert.equal((await status(fixture)).summary, "confirmed");
});

// ---------------------------------------------------------------------------
// 3. An original that ends without a ts ends its pending sync, with its reason.

const ENDINGS = [
  { label: "refused before dispatch, then skipped", delivery: { state: "skipped" as const, stateReason: "operator_audited_skip", providerAttempts: 0 }, attempts: [], link: null, reason: "original_not_sent" },
  { label: "definitely refused by Slack, then skipped", delivery: { state: "skipped" as const, stateReason: "operator_audited_skip", providerAttempts: 1 }, attempts: ["deterministic_failure" as const], link: null, reason: "original_not_sent" },
  { label: "target deleted before sending", delivery: { state: "skipped" as const, stateReason: "destination_deleted", providerAttempts: 0 }, attempts: [], link: null, reason: "original_not_sent" },
  { label: "outcome unknown, then skipped by an admin", delivery: { state: "skipped" as const, stateReason: "operator_audited_skip", providerAttempts: 1 }, attempts: ["outcome_unknown" as const], link: "unknown" as const, reason: "original_unknown_skipped" },
  { label: "outcome unknown, then its target deleted", delivery: { state: "skipped" as const, stateReason: "destination_deleted_outcome_unconfirmed", providerAttempts: 1 }, attempts: ["outcome_unknown" as const], link: "unknown" as const, reason: "original_unknown_ended" },
];

for (const ending of ENDINGS) {
  test(`the original ends while an update waits (${ending.label}): the sync ends as ${ending.reason}, nothing edited or posted, nothing moves to a new pair`, async ({ db }) => {
    const fixture = await seedSlackCardEditFixture(db, { original: "queued" });
    const slack = fakeSlack(fixture);
    const { clock } = clockAt();
    const run = worker(fixture, slack, clock);
    await updateCard(fixture, "Ready for testing", clock.now);
    await db.update(externalOutboundDeliveries).set({ ...ending.delivery,
      firstDispatchedAt: ending.delivery.providerAttempts > 0 ? clock.now : null })
      .where(eq(externalOutboundDeliveries.id, fixture.delivery.id));
    for (const [index, outcome] of ending.attempts.entries()) {
      await db.insert(externalDeliveryAttempts).values({
        deliveryId: fixture.delivery.id, attemptNumber: index + 1, leaseGeneration: index + 1, runtimeRevision: "runtime-card",
        credentialRevision: 1, dispatchAuthorization: "automatic", providerIoStartedAt: clock.now, outcome,
        outcomeReason: outcome, terminalAt: clock.now,
      });
    }
    if (ending.link) {
      await db.insert(externalMessageLinks).values({
        deliveryId: fixture.delivery.id, provider: "slack", installId: fixture.install.id, providerAuthorityId: TEAM,
        providerConversationId: CONVERSATION, providerMessageId: null, bindingId: fixture.binding.id, bindingEpoch: 1,
        connectionEpoch: 1, raftMessageId: fixture.message.id, firstDirection: "raft_outbound",
        payloadFingerprint: "d".repeat(64), outcomeState: ending.link, authorityState: "active",
      });
    }
    assert.deepEqual(await run.step(), { kind: "ended", syncId: (await syncRow(fixture)).id, reason: ending.reason });
    assert.deepEqual(slack.methods(), []);
    // A later update, even at a new pair epoch, never revives it or reaches the new pair.
    await db.update(externalChannelBindings).set({ bindingEpoch: 2 }).where(eq(externalChannelBindings.id, fixture.binding.id));
    await updateCard(fixture, "Approved", clock.now);
    const sync = await syncRow(fixture);
    assert.equal(sync.state, "ended");
    assert.equal(sync.endReason, ending.reason);
    assert.equal(sync.latestRevision, 2);
    assert.equal((await db.select().from(externalCardEditSyncs)).length, 1);
    assert.deepEqual(await run.drain(), []);
    assert.deepEqual(slack.methods(), []);
    assert.equal((await status(fixture)).summary, "ended");
  });
}

test("a pair that ended before its original was sent ends the sync as never sent", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db, { original: "queued" });
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  await updateCard(fixture, "Ready for testing", clock.now);
  await db.update(externalChannelBindings).set({ state: "revoked", stateReason: "binding_removed" })
    .where(eq(externalChannelBindings.id, fixture.binding.id));
  const result = await worker(fixture, slack, clock).step();
  assert.equal(result.kind === "ended" ? result.reason : result.kind, "original_not_sent");
  assert.deepEqual(slack.methods(), []);
});

test("the original's fate is classified from its delivery, attempts and link only", () => {
  const delivery = { id: "d1", state: "accepted" as const, stateReason: null, providerMessageId: TS, providerAttempts: 1 };
  const link = { deliveryId: "d1", outcomeState: "accepted" as const, providerMessageId: TS, providerThreadId: null };
  assert.deepEqual(classifySlackCardOriginal({ delivery, link, attemptOutcomes: ["accepted"] }),
    { kind: "confirmed", providerMessageId: TS, providerThreadId: null });
  assert.equal(classifySlackCardOriginal({ delivery, link: { ...link, providerMessageId: "1793700000.000200" }, attemptOutcomes: [] }).kind,
    "waiting", "a receipt that does not match is never guessed");
  assert.equal(classifySlackCardOriginal({ delivery, link: null, attemptOutcomes: [] }).kind, "waiting");
  for (const state of ["queued", "dispatching", "retry_wait", "outcome_unknown", "dead", "quarantined"] as const) {
    assert.equal(classifySlackCardOriginal({ delivery: { ...delivery, state, providerMessageId: null }, link: null, attemptOutcomes: [] }).kind, "waiting", state);
  }
  assert.deepEqual(classifySlackCardOriginal({ delivery: { ...delivery, state: "skipped", stateReason: "operator_audited_skip", providerMessageId: null, providerAttempts: 2 },
    link: null, attemptOutcomes: ["deterministic_failure"] }), { kind: "ended", reason: "original_unknown_skipped" },
  "a legacy attempt without its row is not proof of never sent");
});

// ---------------------------------------------------------------------------
// 4. One edit at a time, merged into the latest; a success clears only its own revision.

test("several updates collapse into one edit with the latest text and card_revision", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  await updateCard(fixture, "Uploading", clock.now);
  await updateCard(fixture, "In review", clock.now);
  await updateCard(fixture, "Ready for testing", clock.now);
  await worker(fixture, slack, clock).drain();
  assert.deepEqual(editRevisions(slack), [4]);
  assert.equal(slack.state.requests[0]!.body.text, "Build 1.19.0 · Ready for testing");
  assert.equal((await status(fixture)).summary, "confirmed");
  assert.equal((await db.select().from(externalCardEditAttempts)).length, 1);
});

test("r2 in flight, r3 committed: r2's success leaves r3 pending, then r3 is sent", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "In review", clock.now);
  slack.state.script.push(async (request) => {
    // The attempt row is durable before the network call.
    const [attempt] = await db.select().from(externalCardEditAttempts);
    assert.equal(attempt!.state, "sending");
    assert.equal(attempt!.cardRevision, 2);
    assert.equal(attempt!.leaseGeneration, (await syncRow(fixture)).leaseGeneration);
    await updateCard(fixture, "Ready for testing", clock.now);
    slack.apply(request);
    return slack.ok({ channel: CONVERSATION, ts: TS });
  });
  const first = await run.step();
  assert.equal(first.kind === "attempted" ? `${first.revision}:${first.outcome}` : first.kind, "2:succeeded");
  const afterR2 = await syncRow(fixture);
  assert.equal(afterR2.succeededRevision, 2);
  assert.equal(afterR2.latestRevision, 3);
  assert.deepEqual(await status(fixture), { uncertain: false, latestResult: null, pending: true, ended: null,
    confirmed: false, summary: "pending" }, "an earlier success while a newer revision waits is pending");
  const second = await run.step();
  assert.equal(second.kind === "attempted" ? `${second.revision}:${second.outcome}` : second.kind, "3:succeeded");
  assert.deepEqual(editRevisions(slack), [2, 3]);
  assert.equal((await status(fixture)).summary, "confirmed");
});

// ---------------------------------------------------------------------------
// 5. Durable attempts and fencing.

test("expired, not reclaimed, late receipt: the old worker cannot record a completion; recovery marks it unknown", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready for testing", clock.now);
  slack.state.script.push((request) => {
    // The lease expires while Slack answers; nobody has reclaimed it yet.
    advance(SLACK_CARD_EDIT_LEASE_MS + 1);
    slack.apply(request);
    return slack.ok({ channel: CONVERSATION, ts: TS });
  });
  const late = await run.step();
  assert.equal(late.kind, "outcome_fenced");
  const [sending] = await db.select().from(externalCardEditAttempts);
  assert.equal(sending!.state, "sending", "the attempt stays sending until recovery");
  const fenced = await syncRow(fixture);
  assert.equal(fenced.succeededRevision, null, "no completion recorded");
  assert.equal(fenced.leaseOwner, "card-worker", "nothing written at all, the lease included");

  const recovered = await worker(fixture, slack, clock, "another-worker").step();
  assert.equal(recovered.kind, "recovered_unknown");
  const [unknown] = await db.select().from(externalCardEditAttempts);
  assert.equal(unknown!.state, "unknown");
  const sync = await syncRow(fixture);
  assert.ok(sync.uncertainAt, "the latch is set");
  assert.equal(sync.quietUntil?.getTime(), clock.now.getTime() + SLACK_CARD_EDIT_QUIET_PERIOD_MS);
  assert.equal(sync.readbackStage, 1);
  assert.deepEqual(editRevisions(slack), [2], "not re-sent as if never sent");
  assert.equal((await status(fixture)).confirmed, false);
});

test("a worker that crashes after sending leaves the attempt sending; recovery marks it unknown, then waits and reads back", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready for testing", clock.now);
  __setSlackCardEditAfterProviderIoHookForTests(() => { throw new Error("worker crashed after sending"); });
  await assert.rejects(run.step(), /worker crashed after sending/u);
  __setSlackCardEditAfterProviderIoHookForTests(null);
  assert.equal((await db.select().from(externalCardEditAttempts))[0]!.state, "sending");
  assert.deepEqual(await run.drain(), [], "the lease still runs: nobody touches it");

  advance(SLACK_CARD_EDIT_LEASE_MS);
  assert.equal((await run.step()).kind, "recovered_unknown");
  assert.equal((await db.select().from(externalCardEditAttempts))[0]!.state, "unknown");
  assert.equal((await status(fixture)).confirmed, false, "never confirmed");
  advance(SLACK_CARD_EDIT_QUIET_PERIOD_MS - 1);
  assert.deepEqual(await run.drain(), [], "the quiet period sends and reads nothing");
  advance(1);
  const read = await run.step();
  assert.deepEqual(read.kind === "read_back" ? read.result : read, { kind: "shown", revision: 2 });
  assert.deepEqual(slack.methods(), ["chat.update", "conversations.history"], "read back, not re-sent");
  assert.equal((await status(fixture)).summary, "not_confirmed", "a read-back is not proof");
});

// ---------------------------------------------------------------------------
// 6. Every edit re-checked like a send.

for (const change of ["binding_epoch", "connection_epoch", "installation_revoked", "cant_update_message"] as const) {
  test(`an identity or installation change (${change}) makes the edit fail without a new post`, async ({ db }) => {
    const fixture = await seedSlackCardEditFixture(db);
    const slack = fakeSlack(fixture);
    const { clock } = clockAt();
    await updateCard(fixture, "Ready for testing", clock.now);
    if (change === "binding_epoch") {
      await db.update(externalChannelBindings).set({ bindingEpoch: 2 }).where(eq(externalChannelBindings.id, fixture.binding.id));
    } else if (change === "connection_epoch") {
      // A reinstall or another bot moves the connection epoch.
      await db.update(externalAppInstalls).set({ connectionEpoch: 2, providerBotId: "B_OTHER" }).where(eq(externalAppInstalls.id, fixture.install.id));
      await db.update(externalChannelBindings).set({ connectionEpoch: 2 }).where(eq(externalChannelBindings.id, fixture.binding.id));
    } else if (change === "installation_revoked") {
      await db.update(externalAppInstalls).set({ state: "revoked", stateReason: "provider_uninstalled" }).where(eq(externalAppInstalls.id, fixture.install.id));
    } else {
      slack.state.script.push(() => slack.error("cant_update_message"));
    }
    const results = await worker(fixture, slack, clock).drain();
    assert.equal(results.length, 1);
    assert.equal((await syncRow(fixture)).endReason, "identity_changed");
    assert.deepEqual(slack.methods(), change === "cant_update_message" ? ["chat.update"] : []);
    assert.ok(!slack.methods().includes("chat.postMessage"), "never re-sent as a new message");
  });
}

test("a paused pair, the master switch off, an audience mismatch or a pair write block start no edit; it resumes after", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready for testing", clock.now);
  const waits: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
    ["binding_inactive",
      () => db.update(externalChannelBindings).set({ state: "paused", stateReason: "operator_paused" }).where(eq(externalChannelBindings.id, fixture.binding.id)),
      () => db.update(externalChannelBindings).set({ state: "active", stateReason: null }).where(eq(externalChannelBindings.id, fixture.binding.id))],
    ["master_flag_disabled",
      () => updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: false }),
      () => updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: true })],
    ["slack_not_in_channel",
      () => db.update(externalDeliveryPartitions).set({ authorityBlockedAt: clock.now, authorityBlockedReason: "slack_not_in_channel" })
        .where(eq(externalDeliveryPartitions.bindingId, fixture.binding.id)),
      () => db.update(externalDeliveryPartitions).set({ authorityBlockedAt: null, authorityBlockedReason: null })
        .where(eq(externalDeliveryPartitions.bindingId, fixture.binding.id))],
  ];
  for (const [reason, pause, resume] of waits) {
    await pause();
    const held = await run.step();
    assert.equal(held.kind === "waiting" ? held.reason : held.kind, reason);
    assert.equal((await syncRow(fixture)).holdReason, reason);
    assert.deepEqual(slack.methods(), [], `${reason}: no edit starts`);
    await resume();
    advance(60 * 60_000);
  }
  const sent = await run.step();
  assert.equal(sent.kind === "attempted" ? sent.outcome : sent.kind, "succeeded");
  assert.equal((await syncRow(fixture)).holdReason, null);
});

test("a deletion or retraction before an edit starts means no edit starts", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  await updateCard(fixture, "Ready for testing", clock.now);
  await db.update(messages).set({ deletedAt: clock.now }).where(eq(messages.id, fixture.message.id));
  const ended = await worker(fixture, slack, clock).step();
  assert.equal(ended.kind === "ended" ? ended.reason : ended.kind, "source_deleted");
  assert.deepEqual(slack.methods(), []);
});

test("a deletion while an edit is in flight, the request landing afterwards, leaves it not confirmed and never called withdrawn", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  await updateCard(fixture, "Ready for testing", clock.now);
  slack.state.script.push(async (request) => {
    await db.update(messages).set({ deletedAt: clock.now }).where(eq(messages.id, fixture.message.id));
    slack.apply(request);
    return slack.ok({ channel: CONVERSATION, ts: TS });
  });
  const results = await worker(fixture, slack, clock).drain();
  assert.deepEqual(results.map((result) => result.kind === "attempted" ? result.outcome : result.kind), ["succeeded"]);
  const state = await status(fixture);
  assert.equal(state.confirmed, false);
  assert.equal(state.summary, "ended");
  assert.equal(state.ended, "source_deleted", "the Raft message was deleted; nothing says the Slack copy was withdrawn");
  assert.deepEqual(await worker(fixture, slack, clock).drain(), []);
  assert.deepEqual(slack.methods(), ["chat.update"], "no further edit after the deletion");
});

test("a card whose sender was removed is not edited", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  await updateCard(fixture, "Ready for testing", clock.now);
  await db.update(agents).set({ deletedAt: clock.now }).where(eq(agents.id, fixture.agent.id));
  const result = await worker(fixture, slack, clock).step();
  assert.equal(result.kind === "ended" ? result.reason : result.kind, "sender_removed");
  assert.deepEqual(slack.methods(), []);
});

// ---------------------------------------------------------------------------
// 7. No attention anywhere in the payload; text plus the original's metadata.

test("the edit is text plus the original's metadata and card_revision, with every mention form inert in the whole payload", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  await updateCard(fixture, "Ready", clock.now,
    "Ready @alice @here @channel @everyone <@U123ABC> <!subteam^S123ABC> <!here> <!channel> <!everyone|everyone> & done");
  await worker(fixture, slack, clock).drain();
  const [request] = slack.state.requests;
  assert.equal(request!.method, "chat.update");
  assert.deepEqual(Object.keys(request!.body).sort(), ["channel", "link_names", "metadata", "parse", "text", "ts"],
    "no blocks, attachments, files, username or icon");
  const payload = JSON.stringify(request!.body);
  for (const attention of ["<@", "<!", "@alice", "@here", "@channel", "@everyone"]) {
    assert.ok(!payload.includes(attention), `the whole chat.update body is free of ${attention}`);
  }
  assert.equal(request!.body.parse, "none");
  assert.equal(request!.body.link_names, false);
  assert.deepEqual(request!.body.metadata, {
    event_type: "raft_message",
    event_payload: {
      delivery_id: fixture.delivery.id,
      reconciliation_marker: fixture.delivery.reconciliationMarker,
      source_message_id: fixture.message.id,
      source_permalink: `https://app.slock.ai/s/${fixture.server.slug}/channel/${fixture.channel.id}?msg=${fixture.message.id}`,
      source_sender_type: "agent",
      connection_epoch: 1,
      binding_epoch: 1,
      card_revision: 2,
    },
  }, "the original post's metadata survives, with card_revision added");
});

// ---------------------------------------------------------------------------
// 8. Length.

test("msg_too_long is final for its revision and shown; a fallback over the send rule never reaches Slack; a newer revision still goes", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready for testing", clock.now);
  slack.state.script.push(() => slack.error("msg_too_long"));
  const refused = await run.step();
  assert.equal(refused.kind === "attempted" ? refused.outcome : refused.kind, "refused");
  advance(60 * 60_000);
  assert.deepEqual(await run.drain(), [], "no retry loop");
  assert.deepEqual(editRevisions(slack), [2]);
  const sync = await syncRow(fixture);
  assert.equal(sync.refusedRevision, 2);
  assert.equal(sync.refusedReason, "msg_too_long");
  assert.equal((await status(fixture)).summary, "not_synced", "never confirmed");
  const notices = await db.select().from(externalCardEditPairNotices);
  assert.deepEqual(notices.map((notice) => notice.kind), ["latest_update_not_shown"]);

  await updateCard(fixture, "Shipped", clock.now, "x".repeat(40_001));
  const local = await run.step();
  assert.equal(local.kind === "refused" ? local.reason : local.kind, "slack_text_length_rule");
  assert.deepEqual(editRevisions(slack), [2], "the send rule refuses it before Slack, without truncating");

  await updateCard(fixture, "Shipped", clock.now);
  await run.drain();
  assert.deepEqual(editRevisions(slack), [2, 4]);
  assert.equal((await status(fixture)).summary, "confirmed");
});

// ---------------------------------------------------------------------------
// 9. Status: the latch, the latest result, pending; read-backs; the T notice.

test("late old request: r2 times out, r3 is sent, r2 lands after the read-back that showed r3; the next update sends the latest; never confirmed", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "In review", clock.now);
  slack.state.script.push((request) => slack.timeoutLandsLater(request));
  const timedOut = await run.step();
  assert.equal(timedOut.kind === "attempted" ? timedOut.outcome : timedOut.kind, "unknown");
  await updateCard(fixture, "Ready for testing", clock.now);
  assert.deepEqual(await run.drain(), [{ kind: "waiting", syncId: (await syncRow(fixture)).id, reason: "quiet_period" }],
    "nothing more is sent for the quiet period, even for a newer revision");

  advance(SLACK_CARD_EDIT_QUIET_PERIOD_MS);
  const results = await run.drain();
  assert.deepEqual(results.map((result) => result.kind), ["read_back", "attempted"], "the read-back finds r1, then the latest is sent");
  assert.deepEqual(editRevisions(slack), [2, 3]);
  advance(SLACK_CARD_EDIT_LATER_RECHECK_MS);
  const recheck = await run.drain();
  assert.deepEqual(recheck.map((result) => result.kind === "read_back" ? result.result : result.kind), [{ kind: "shown", revision: 3 }]);
  slack.land();
  assert.equal(slack.state.shownRevision, 2, "the old request landed after the last planned check");
  advance(SLACK_CARD_EDIT_LATER_RECHECK_MS);
  assert.deepEqual(await run.drain(), [], "no check is left to catch it");
  assert.equal((await status(fixture)).summary, "not_confirmed", "nothing reports a false synced");

  await updateCard(fixture, "Approved", clock.now);
  await run.drain();
  assert.deepEqual(editRevisions(slack), [2, 3, 4], "the next card update sends the latest again");
  assert.equal(slack.state.shownRevision, 4);
  assert.equal((await status(fixture)).summary, "not_confirmed", "a later definite success never clears the latch");
});

test("a later check repairs an old request that landed after the newer revision was sent", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "In review", clock.now);
  slack.state.script.push((request) => slack.timeoutLandsLater(request));
  await run.step();
  await updateCard(fixture, "Ready for testing", clock.now);
  advance(SLACK_CARD_EDIT_QUIET_PERIOD_MS);
  await run.drain();
  slack.land();
  advance(SLACK_CARD_EDIT_LATER_RECHECK_MS);
  const results = await run.drain();
  assert.deepEqual(results.map((result) => result.kind === "read_back" ? result.result : result.kind),
    [{ kind: "shown", revision: 2 }, "attempted"], "the later read-back finds r2 showing and sends r3 again");
  assert.equal(slack.state.shownRevision, 3);
  assert.equal((await status(fixture)).confirmed, false);
});

test("overlap: r2 unknown, r3 refused with msg_too_long, a read-back shows an older revision: r3 is not re-sent; r4 goes; never confirmed", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "In review", clock.now);
  slack.state.script.push(() => ({ kind: "transport_failure", phase: "after_send", code: "timeout" }));
  await run.step();
  await updateCard(fixture, "Ready for testing", clock.now);
  advance(SLACK_CARD_EDIT_QUIET_PERIOD_MS);
  // The read-back answers as Slack shows it (r1: r2 never landed); then r3 is refused.
  slack.state.script.push(slack.passthrough, () => slack.error("msg_too_long"));
  const results = await run.drain();
  assert.deepEqual(results.map((result) => result.kind === "attempted" ? result.outcome : result.kind), ["read_back", "refused"]);
  assert.deepEqual(editRevisions(slack), [2, 3]);
  advance(SLACK_CARD_EDIT_LATER_RECHECK_MS);
  const recheck = await run.drain();
  assert.deepEqual(recheck.map((result) => result.kind === "read_back" ? result.result : result.kind), [{ kind: "shown", revision: 1 }]);
  assert.deepEqual(editRevisions(slack), [2, 3], "a refused revision is never sent again by repair");
  const facts = await status(fixture);
  assert.deepEqual([facts.uncertain, facts.latestResult, facts.summary], [true, "refused", "not_synced"],
    "the failure and the uncertainty both stay visible");
  assert.ok(clock.now.getTime() - (await syncRow(fixture)).uncertainAt!.getTime() < SLACK_CARD_EDIT_NOT_CONFIRMED_NOTICE_MS,
    "well before T");
  assert.deepEqual(await panelKinds(fixture, clock.now), ["latest_update_not_shown", "not_confirmed"],
    "the read-back found an older revision it cannot replace: not confirmed at once, beside the refusal");
  assert.deepEqual(await tableKinds(db), ["latest_update_not_shown", "not_confirmed"]);
  advance(SLACK_CARD_EDIT_NOT_CONFIRMED_NOTICE_MS);
  await raiseSlackCardEditNotConfirmedNotices(db, clock.now);
  assert.deepEqual(await panelKinds(fixture, clock.now), ["latest_update_not_shown", "not_confirmed"],
    "a genuine unknown and a later refusal: both shown, neither hides the other");

  await updateCard(fixture, "Approved", clock.now);
  await run.drain();
  assert.deepEqual(editRevisions(slack), [2, 3, 4], "a new revision goes through the usual checks");
  const after = await status(fixture);
  assert.deepEqual([after.latestResult, after.confirmed, after.summary], ["succeeded", false, "not_confirmed"],
    "even a definite success after an unknown outcome is not confirmed");
  assert.deepEqual(await panelKinds(fixture, clock.now), ["not_confirmed"], "the refusal was superseded; the latch stays");
});

test("notice even when it looks right: after T the pair gets one deduplicated not-confirmed notice for all its messages", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "In review", clock.now);
  slack.state.script.push((request) => { slack.apply(request); return { kind: "transport_failure", phase: "after_send", code: "timeout" }; });
  await run.step();
  // A second card message of the same pair, also uncertain.
  const [other] = await db.insert(messages).values({
    channelId: fixture.channel.id, senderType: "agent", senderId: fixture.agent.id, content: "Build 1.20.0 · In review",
    messageType: "chat", actionMetadata: messageCardMetadataAtSend(card("In review"), clock.now),
  }).returning();
  const otherDelivery = await db.transaction(async (tx) => {
    await tx.update(externalDeliveryPartitions).set({ lastEnqueuedPosition: 2 })
      .where(eq(externalDeliveryPartitions.bindingId, fixture.binding.id));
    const [inserted] = await tx.insert(externalOutboundDeliveries).values({
      sourceMessageId: other!.id, bindingId: fixture.binding.id, bindingEpoch: 1, partitionPosition: 2,
      enqueueRuntimeRevision: "runtime-card", renderSnapshotSchema: "slack-bridge-render-snapshot.v5", renderSnapshot: {},
      renderSnapshotDigest: "e".repeat(64), reconciliationMarker: "N".repeat(43), state: "queued",
    }).returning();
    return inserted;
  });
  await db.insert(externalCardEditSyncs).values({
    deliveryId: otherDelivery!.id, sourceMessageId: other!.id, bindingId: fixture.binding.id, bindingEpoch: 1,
    latestRevision: 2, uncertainAt: clock.now, notConfirmedSince: clock.now,
  });
  advance(SLACK_CARD_EDIT_QUIET_PERIOD_MS);
  await run.drain();
  advance(SLACK_CARD_EDIT_LATER_RECHECK_MS);
  const checks = await run.drain();
  assert.deepEqual(checks.map((result) => result.kind === "read_back" ? result.result : result.kind),
    [{ kind: "shown", revision: 2 }], "both read-backs showed the latest");
  assert.deepEqual(await db.select().from(externalCardEditPairNotices), [], "no notice yet: they looked right");
  assert.deepEqual(await panelKinds(fixture, clock.now), [], "both read-backs looked right: nothing before T");
  assert.equal(await raiseSlackCardEditNotConfirmedNotices(db, clock.now), 0, "before T");
  advance(SLACK_CARD_EDIT_NOT_CONFIRMED_NOTICE_MS);
  assert.equal(await raiseSlackCardEditNotConfirmedNotices(db, clock.now), 2, "both messages are past T");
  assert.equal(await raiseSlackCardEditNotConfirmedNotices(db, clock.now), 0, "raised once");
  const notices = await db.select().from(externalCardEditPairNotices);
  assert.deepEqual(notices.map((notice) => [notice.bindingId, notice.bindingEpoch, notice.kind]),
    [[fixture.binding.id, 1, "not_confirmed"]]);
  assert.deepEqual(await panelKinds(fixture, clock.now), ["not_confirmed"], "after T, the fallback");
  assert.equal((await syncRow(fixture)).noticeKind, "not_confirmed", "recorded per message for operators");
});

// ---------------------------------------------------------------------------
// 10. Failures that end a sync, and kept ones.

test("channel_not_found and missing permissions are kept and shown, not dropped; message_not_found ends the sync", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready for testing", clock.now);
  for (const [code, reason] of [["channel_not_found", "slack_channel_not_found"], ["missing_scope", "slack_permission_missing"],
    ["not_in_channel", "slack_not_in_channel"]] as const) {
    slack.state.script.push(() => slack.error(code));
    const kept = await run.step();
    assert.equal(kept.kind === "attempted" ? kept.outcome : kept.kind, "kept", code);
    const sync = await syncRow(fixture);
    assert.equal(sync.state, "open", `${code}: kept`);
    assert.equal(sync.holdReason, reason);
    const [notice] = await db.select().from(externalCardEditPairNotices).where(eq(externalCardEditPairNotices.kind, "edit_waiting"));
    assert.equal(notice?.reason, reason, `${code}: shown to the pair's admins`);
    assert.ok(sync.nextAttemptAt && sync.nextAttemptAt > clock.now, "retried later");
    advance(60 * 60_000);
  }
  await run.step();
  assert.equal((await status(fixture)).summary, "confirmed");
  assert.deepEqual(await db.select().from(externalCardEditPairNotices), [], "the waiting notice clears once an edit lands");

  await updateCard(fixture, "Shipped", clock.now);
  slack.state.script.push(() => slack.error("message_not_found"));
  const gone = await run.step();
  assert.equal(gone.kind === "attempted" ? gone.outcome : gone.kind, "message_not_found");
  assert.equal((await syncRow(fixture)).endReason, "message_not_found");
  await updateCard(fixture, "Archived", clock.now);
  assert.deepEqual(await run.drain(), []);
  assert.deepEqual(editRevisions(slack), [2, 2, 2, 2, 3]);
});

// ---------------------------------------------------------------------------
// 12. Files.

test("a stored card message that has files anyway is never edited; its sync ends as can't be shown in Slack, shown to the pair", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  await insertAttachmentsWithObjects(db, {
    messageId: fixture.message.id, messagePosition: 0, channelId: fixture.channel.id, uploaderId: fixture.agent.id,
    uploaderType: "agent", filename: "build.log", storageKey: `test/${randomUUID()}`, mimeType: "text/plain", sizeBytes: 10,
  });
  await updateCard(fixture, "Ready for testing", clock.now);
  const result = await worker(fixture, slack, clock).step();
  assert.equal(result.kind === "ended" ? result.reason : result.kind, "card_has_files");
  assert.deepEqual(slack.methods(), [], "never edited, never re-sent, files never re-sent");
  const [notice] = await db.select().from(externalCardEditPairNotices);
  assert.equal(notice?.kind, "updates_cannot_be_shown");
  assert.equal((await syncRow(fixture)).noticeKind, "updates_cannot_be_shown");
  assert.equal((await db.select().from(externalCardEditSyncs).where(and(
    eq(externalCardEditSyncs.state, "ended"), eq(externalCardEditSyncs.endReason, "card_has_files")))).length, 1);
});

// ---------------------------------------------------------------------------
// Review fixes: a matched audience (Cardy 1), the attempt start re-checks
// everything (Cardy 2), pair notices as a projection of the syncs (Cardy 6,
// peng), not-confirmed only from the latch (Cardy 7), recoverable channel
// states (peng 9), and the lock order (peng).

const TS_B = "1793700000.000200";

/** A second card message of the fixture's pair, its original accepted, and the Slack double taught its ts. */
async function secondCard(fixture: Fixture, slack: ReturnType<typeof fakeSlack>) {
  const second = await seedCardOnPair(fixture, { original: "accepted", ts: TS_B, position: 2 });
  slack.state.others.set(TS_B, { deliveryId: second.delivery.id, shownRevision: 1, script: [] });
  return { ...fixture, ...second };
}

test("an edit needs a MATCHED audience: none, unavailable, mismatch or expired starts no edit, is shown waiting, and resumes once matched", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db, { audience: "none" });
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready for testing", clock.now);
  const observations: Array<[string, (() => Promise<void>) | null]> = [
    ["no observation", null],
    ["unavailable", () => recordAudience(fixture, "unavailable")],
    ["mismatch", () => recordAudience(fixture, "mismatch")],
    ["matched but expired", () => recordAudience(fixture, "matched", { expiresAt: new Date(clock.now.getTime() - 1) })],
  ];
  for (const [label, observe] of observations) {
    await observe?.();
    const held = await run.step();
    assert.equal(held.kind, "waiting", label);
    assert.deepEqual(slack.methods(), [], `${label}: no chat.update`);
    assert.ok((await syncRow(fixture)).holdReason, `${label}: held`);
    assert.deepEqual(await panelKinds(fixture, clock.now), ["edit_waiting"], `${label}: shown to the pair's admins`);
    assert.deepEqual(await db.select().from(externalCardEditAttempts), []);
    advance(60 * 60_000);
  }
  await recordAudience(fixture, "matched", { expiresAt: new Date(clock.now.getTime() + 60 * 60_000) });
  const sent = await run.step();
  assert.equal(sent.kind === "attempted" ? sent.outcome : sent.kind, "succeeded", "a fresh matched observation resumes it");
  assert.deepEqual(editRevisions(slack), [2]);
  assert.deepEqual(await panelKinds(fixture, clock.now), []);
});

test("a private channel edits only under a matched audience", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db, { privacy: "private" });
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready for testing", clock.now);
  await run.drain();
  assert.deepEqual(editRevisions(slack), [2], "matched: edited");
  await recordAudience(fixture, "unavailable");
  await updateCard(fixture, "Shipped", clock.now);
  assert.equal((await run.step()).kind, "waiting");
  assert.deepEqual(editRevisions(slack), [2], "the audience is no longer matched: no edit");
  await recordAudience(fixture, "matched");
  advance(60 * 60_000);
  await run.drain();
  assert.deepEqual(editRevisions(slack), [2, 3]);
});

const DURING_CREDENTIAL: Array<[string, (fixture: Fixture) => Promise<unknown>, { kind: "waiting" | "ended"; reason: string }]> = [
  ["the master switch turned off", () => updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: false }),
    { kind: "waiting", reason: "master_flag_disabled" }],
  ["the pair paused", (fixture) => fixture.db.update(externalChannelBindings).set({ state: "paused", stateReason: "operator_paused" })
    .where(eq(externalChannelBindings.id, fixture.binding.id)), { kind: "waiting", reason: "binding_inactive" }],
  ["an audience mismatch observed", (fixture) => recordAudience(fixture, "mismatch"),
    { kind: "waiting", reason: "frozen_audience_snapshot_missing_or_expired" }],
  ["the audience became unavailable", (fixture) => recordAudience(fixture, "unavailable"),
    { kind: "waiting", reason: "slack_audience_not_matched" }],
  ["the sender removed", (fixture) => fixture.db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, fixture.agent.id)),
    { kind: "ended", reason: "sender_removed" }],
  ["the pair epoch moved", (fixture) => fixture.db.update(externalChannelBindings).set({ bindingEpoch: 2 })
    .where(eq(externalChannelBindings.id, fixture.binding.id)), { kind: "ended", reason: "identity_changed" }],
  ["the message deleted", (fixture) => fixture.db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, fixture.message.id)),
    { kind: "ended", reason: "source_deleted" }],
  // The card update route's own boundaries (Cardy, #12710 review of 9753fd25).
  ["the channel archived (the real archive writer)", (fixture) => archiveChannel(fixture.channel.id, fixture.owner.id),
    { kind: "waiting", reason: "channel_archived" }],
  ["the free plan's external freeze reached", async () => {
    vi.spyOn(planService, "getChannelBillingReadOnly").mockResolvedValue({ reason: "external_limit_frozen", freezeAt: new Date(0) });
  }, { kind: "waiting", reason: "channel_read_only:external_limit_frozen" }],
  ["the channel over the plan's channel quota", async () => {
    vi.spyOn(planService, "isChannelReadOnlyByQuota").mockResolvedValue(true);
  }, { kind: "waiting", reason: "channel_read_only:quota" }],
];

for (const [label, change, expected] of DURING_CREDENTIAL) {
  test(`${label} while the credential is leased: the attempt start re-checks it; no attempt row, no chat.update`, async ({ db }) => {
    const fixture = await seedSlackCardEditFixture(db);
    const slack = fakeSlack(fixture);
    const { clock } = clockAt();
    await updateCard(fixture, "Ready for testing", clock.now);
    let changed = false;
    const run = worker(fixture, slack, clock, "card-worker", { async onLease() {
      if (!changed) { changed = true; await change(fixture); }
    } });
    const result = await run.step();
    assert.ok(changed, "the change committed between the first check and the attempt start");
    assert.equal(result.kind, expected.kind);
    assert.equal(result.kind === "waiting" || result.kind === "ended" ? result.reason : null, expected.reason);
    assert.deepEqual(await db.select().from(externalCardEditAttempts), [], "no attempt row");
    assert.deepEqual(slack.methods(), [], "no chat.update");
  });
}

// Time passing during the final check (peng, #12710 review of bbc374e7):
// what depends on time is judged at a fresh clock once the locks are held.
const EXPIRING_DURING_CHECK: Array<[string, (fixture: Fixture, start: Date) => Promise<unknown>, number, string]> = [
  ["the worker lease", async () => undefined, SLACK_CARD_EDIT_LEASE_MS + 1, "lease_lost"],
  ["the matched audience", (fixture, start) => recordAudience(fixture, "matched", { expiresAt: new Date(start.getTime() + 10_000) }),
    11_000, "slack_audience_not_matched"],
  ["the credential", async () => undefined, 6_000, "credential_expired_before_send"],
];

for (const [label, seed, elapsed, expected] of EXPIRING_DURING_CHECK) {
  test(`${label} running out while the final check runs: no attempt row, no chat.update, the credential released`, async ({ db }) => {
    const fixture = await seedSlackCardEditFixture(db);
    const slack = fakeSlack(fixture);
    const { clock, advance } = clockAt();
    await seed(fixture, clock.now);
    await updateCard(fixture, "Ready for testing", clock.now);
    // The credential outlives the worker lease unless it is the one running out.
    const run = worker(fixture, slack, clock, "card-worker", { credentialMs: label === "the credential" ? 5_000 : 120_000 });
    __setSlackCardEditBeforeSenderPostingCheckHookForTests(() => advance(elapsed));
    const result = await run.step();
    assert.equal(result.kind === "waiting" ? result.reason : result.kind, expected);
    assert.deepEqual(await db.select().from(externalCardEditAttempts), [], "no attempt row");
    assert.deepEqual(slack.methods(), [], "no chat.update");
    assert.equal(slack.state.releases, slack.state.leases, "the credential released");
  });
}

test("the worker lease running out after the attempt row, before the call (its commit waited): no chat.update; recovery treats it as unknown", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  await updateCard(fixture, "Ready for testing", clock.now);
  const run = worker(fixture, slack, clock, "card-worker", { credentialMs: 120_000 });
  let inAttemptStart = false;
  __setSlackCardEditBeforeSenderPostingCheckHookForTests(() => { inAttemptStart = true; });
  // The attempt start's pair notice refresh comes after its attempt insert.
  __setSlackCardEditBeforePairNoticeLockHookForTests(() => {
    if (inAttemptStart) { inAttemptStart = false; advance(SLACK_CARD_EDIT_LEASE_MS + 1); }
  });
  const result = await run.step();
  assert.equal(result.kind, "lease_lost");
  assert.deepEqual(slack.methods(), [], "no chat.update");
  assert.equal(slack.state.releases, slack.state.leases, "the credential released");
  assert.deepEqual((await db.select().from(externalCardEditAttempts)).map((attempt) => attempt.state), ["sending"]);
  __setSlackCardEditBeforePairNoticeLockHookForTests(null);
  const recovered = await run.step();
  assert.equal(recovered.kind, "recovered_unknown");
});

test("the matched audience running out after the attempt row, before the call (its commit waited): no chat.update; the attempt closed as not sent; it edits once matched again", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  await recordAudience(fixture, "matched", { expiresAt: new Date(clock.now.getTime() + 10_000) });
  await updateCard(fixture, "Ready for testing", clock.now);
  // The worker lease and the credential outlive the audience.
  const run = worker(fixture, slack, clock, "card-worker", { credentialMs: 120_000 });
  let inAttemptStart = false;
  __setSlackCardEditBeforeSenderPostingCheckHookForTests(() => { inAttemptStart = true; });
  __setSlackCardEditBeforePairNoticeLockHookForTests(() => {
    if (inAttemptStart) { inAttemptStart = false; advance(11_000); }
  });
  const result = await run.step();
  assert.equal(result.kind === "waiting" ? result.reason : result.kind, "slack_audience_not_matched");
  assert.deepEqual(slack.methods(), [], "no chat.update");
  assert.equal(slack.state.releases, slack.state.leases, "the credential released");
  assert.deepEqual((await db.select().from(externalCardEditAttempts)).map((attempt) => [attempt.state, attempt.outcomeReason]),
    [["failed", "not_sent_audience_expired"]]);
  __setSlackCardEditBeforeSenderPostingCheckHookForTests(null);
  __setSlackCardEditBeforePairNoticeLockHookForTests(null);
  await recordAudience(fixture, "matched", { expiresAt: new Date(clock.now.getTime() + 60 * 60_000) });
  advance(60 * 60_000 - 1);
  const resumed = await run.step();
  assert.equal(resumed.kind === "attempted" ? resumed.outcome : resumed.kind, "succeeded");
  assert.deepEqual(editRevisions(slack), [2]);
});

// A recovery read-back is provider I/O too, admitted like an edit (peng, #12710 review of 49fcea31).
const DURING_READBACK_LEASE: Array<[string, (fixture: Fixture) => Promise<unknown>, string | null]> = [
  ["nothing changed", async () => undefined, null],
  ["the master switch turned off", () => updateFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, { enabled: false }),
    "master_flag_disabled"],
  ["the pair paused", (fixture) => fixture.db.update(externalChannelBindings).set({ state: "paused", stateReason: "operator_paused" })
    .where(eq(externalChannelBindings.id, fixture.binding.id)), "binding_inactive"],
  ["the message deleted", (fixture) => fixture.db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, fixture.message.id)),
    "source_deleted"],
];

for (const conversation of ["channel", "thread"] as const) {
  for (const [label, change, expected] of DURING_READBACK_LEASE) {
    test(`${label} while a ${conversation} card's due read-back leases its credential: ${expected ? "no read call" : "it reads back"}`, async ({ db }) => {
      const fixture = await seedSlackCardEditFixture(db, { conversation });
      const slack = fakeSlack(fixture);
      const { clock } = clockAt();
      await updateCard(fixture, "Ready for testing", clock.now);
      // A read-back due after an unknown outcome.
      await db.update(externalCardEditSyncs).set({
        uncertainAt: clock.now, readbackStage: 1, readbackDueAt: clock.now, quietUntil: null, nextAttemptAt: clock.now,
      }).where(eq(externalCardEditSyncs.deliveryId, fixture.delivery.id));
      let changed = false;
      const run = worker(fixture, slack, clock, "card-worker", { async onLease() {
        if (!changed) { changed = true; await change(fixture); }
      } });
      const result = await run.step();
      assert.ok(changed);
      const read = conversation === "thread" ? "conversations.replies" : "conversations.history";
      if (expected === null) {
        assert.equal(result.kind, "read_back");
        assert.deepEqual(slack.methods(), [read]);
      } else {
        assert.equal(result.kind === "waiting" || result.kind === "ended" ? result.reason : result.kind, expected);
        assert.deepEqual(slack.methods(), [], `no ${read} call`);
        assert.equal((await syncRow(fixture)).state, expected === "source_deleted" ? "ended" : "open");
      }
      assert.equal(slack.state.releases, slack.state.leases, "the credential released");
    });
  }
}

for (const conversation of ["channel", "thread"] as const) {
  test(`a ${conversation} card whose channel is archived while the credential is leased waits, no attempt or chat.update; unarchived, the edit goes`, async ({ db }) => {
    const fixture = await seedSlackCardEditFixture(db, { conversation });
    const slack = fakeSlack(fixture);
    const { clock, advance } = clockAt();
    let archived = false;
    const run = worker(fixture, slack, clock, "card-worker", { async onLease() {
      if (archived) return;
      archived = true;
      // The real archive writer, on the paired channel (a thread is archived with its parent).
      await archiveChannel(fixture.channel.id, fixture.owner.id);
    } });
    await updateCard(fixture, "Ready for testing", clock.now);
    const held = await run.step();
    assert.ok(archived, "the archive committed between the first check and the attempt start");
    assert.equal(held.kind === "waiting" ? held.reason : held.kind, "channel_archived");
    assert.deepEqual(await db.select().from(externalCardEditAttempts), [], "no attempt row");
    assert.deepEqual(slack.methods(), [], "no chat.update");
    // While archived the first check holds it too.
    advance(60 * 60_000);
    const still = await run.step();
    assert.equal(still.kind === "waiting" ? still.reason : still.kind, "channel_archived");
    assert.deepEqual(slack.methods(), []);
    await unarchiveChannel(fixture.channel.id);
    advance(60 * 60_000);
    const resumed = await run.step();
    assert.equal(resumed.kind === "attempted" ? resumed.outcome : resumed.kind, "succeeded");
    assert.deepEqual(editRevisions(slack), [2]);
  });
}

test("one card's success does not hide another card's wait on the same pair; the last held card clearing does", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const other = await secondCard(fixture, slack);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(other, "Ready", clock.now);
  slack.state.others.get(TS_B)!.script.push(() => slack.error("not_in_channel"));
  assert.equal((await run.step()).kind, "attempted");
  assert.deepEqual(await panelKinds(fixture, clock.now), ["edit_waiting"], "B is held");
  await updateCard(fixture, "Ready", clock.now);
  const first = await run.step();
  assert.equal(first.kind === "attempted" ? first.outcome : first.kind, "succeeded", "A succeeds meanwhile");
  assert.deepEqual(await panelKinds(fixture, clock.now), ["edit_waiting"], "B is still held: its notice stays");
  assert.deepEqual(await tableKinds(db), ["edit_waiting"]);
  advance(60 * 60_000);
  await run.drain();
  assert.deepEqual(await panelKinds(fixture, clock.now), [], "the last held card cleared: the notice goes");
  assert.deepEqual(await tableKinds(db), []);
});

for (const order of ["enter_then_clear", "clear_then_enter"] as const) {
  test(`a held card clearing and another entering waiting (${order}) leaves the pair's notice present`, async ({ db }) => {
    const fixture = await seedSlackCardEditFixture(db);
    const slack = fakeSlack(fixture);
    const other = await secondCard(fixture, slack);
    const { clock, advance } = clockAt();
    const run = worker(fixture, slack, clock);
    // A is held first.
    await updateCard(fixture, "Ready", clock.now);
    slack.state.script.push(() => slack.error("channel_not_found"));
    await run.step();
    const enterB = async () => {
      await updateCard(other, "Ready", clock.now);
      slack.state.others.get(TS_B)!.script.push(() => slack.error("missing_scope"));
      const entered = await run.step();
      assert.equal(entered.kind === "attempted" ? entered.revision : null, 2, "B's step");
    };
    const clearA = async () => {
      advance(60 * 60_000);
      const cleared = await run.step();
      assert.equal(cleared.kind === "attempted" ? cleared.outcome : cleared.kind, "succeeded", "A's step");
    };
    if (order === "enter_then_clear") { await enterB(); await clearA(); } else { await clearA(); await enterB(); }
    const [syncA] = await db.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.deliveryId, fixture.delivery.id));
    const [syncB] = await db.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.deliveryId, other.delivery.id));
    assert.equal(syncA!.holdReason, null);
    assert.equal(syncB!.holdReason, "slack_permission_missing");
    assert.deepEqual(await panelKinds(fixture, clock.now), ["edit_waiting"]);
    const [notice] = await db.select().from(externalCardEditPairNotices);
    assert.equal(notice?.reason, "slack_permission_missing", "the notice names the card still held");
  });
}

test("an older refused revision superseded by a newer one no longer shows; another card still refused keeps it", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const other = await secondCard(fixture, slack);
  const { clock } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready", clock.now);
  slack.state.script.push(() => slack.error("msg_too_long"));
  await run.step();
  assert.deepEqual(await panelKinds(fixture, clock.now), ["latest_update_not_shown"]);
  await updateCard(fixture, "Shipped", clock.now);
  assert.deepEqual(await panelKinds(fixture, clock.now), [], "a newer pending revision supersedes the refusal");
  await run.drain();
  assert.equal((await status(fixture)).summary, "confirmed");
  assert.deepEqual(await panelKinds(fixture, clock.now), [], "refused, then a newer revision succeeded: the notice is gone");
  assert.deepEqual(await tableKinds(db), []);

  await updateCard(other, "Ready", clock.now);
  slack.state.others.get(TS_B)!.script.push(() => slack.error("msg_too_long"));
  await run.drain();
  await updateCard(fixture, "Archived", clock.now);
  await run.drain();
  assert.deepEqual(await panelKinds(fixture, clock.now), ["latest_update_not_shown"], "one card recovered, the other is still refused");
});

test("not confirmed comes only from the uncertainty latch: a definite refusal or plain pending past T never raises it", async ({ db }) => {
  const refusal = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(refusal);
  const { clock, advance } = clockAt();
  const run = worker(refusal, slack, clock);
  await updateCard(refusal, "Ready", clock.now);
  slack.state.script.push(() => slack.error("msg_too_long"));
  await run.step();
  // A second card of the pair stays plain pending: its original is still queued.
  const pending = await seedCardOnPair(refusal, { original: "queued", ts: TS_B, position: 2 });
  await updateCard({ ...refusal, ...pending }, "Ready", clock.now);
  advance(SLACK_CARD_EDIT_NOT_CONFIRMED_NOTICE_MS + 60_000);
  await raiseSlackCardEditNotConfirmedNotices(db, clock.now);
  assert.deepEqual(await panelKinds(refusal, clock.now), ["latest_update_not_shown"],
    "the refusal keeps its own notice; neither it nor pending is called not confirmed");
  assert.deepEqual(await tableKinds(db), ["latest_update_not_shown"]);
  const [refusedSync] = await db.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.deliveryId, refusal.delivery.id));
  assert.equal(refusedSync!.uncertainAt, null);
});

test("is_inactive is a recoverable channel state: held, not refused, and the same revision goes once the channel is back; msg_too_long still never retries", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready", clock.now);
  slack.state.script.push(() => slack.error("is_inactive"));
  const held = await run.step();
  assert.equal(held.kind === "attempted" ? held.outcome : held.kind, "kept");
  const sync = await syncRow(fixture);
  assert.equal(sync.refusedRevision, null, "not refused");
  assert.equal(sync.holdReason, "slack_channel_inactive");
  assert.deepEqual(await panelKinds(fixture, clock.now), ["edit_waiting"]);
  advance(60 * 60_000);
  await run.drain();
  assert.deepEqual(editRevisions(slack), [2, 2], "the same revision, delivered once the channel recovers");
  assert.equal((await status(fixture)).summary, "confirmed");

  await updateCard(fixture, "Shipped", clock.now);
  slack.state.script.push(() => slack.error("msg_too_long"));
  await run.drain();
  advance(60 * 60_000);
  assert.deepEqual(await run.drain(), []);
  assert.deepEqual(editRevisions(slack), [2, 2, 3], "a content refusal is final");
});

test("two cards of one pair updated and edited at once both complete, with the pair's notices right", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const other = await secondCard(fixture, slack);
  const { clock } = clockAt();
  const workers = [worker(fixture, slack, clock, "card-worker-a"), worker(fixture, slack, clock, "card-worker-b")];
  slack.state.others.get(TS_B)!.script.push(() => slack.error("not_in_channel"));
  for (let round = 0; round < 3; round += 1) {
    await Promise.all([
      updateCard(fixture, `A${round}`, clock.now),
      updateCard(other, `B${round}`, clock.now),
      workers[0]!.step(),
      workers[1]!.step(),
    ]);
  }
  await Promise.all(workers.map((run) => run.drain()));
  const [a] = await readSlackCardEditSyncState(db, fixture.message.id);
  const [b] = await readSlackCardEditSyncState(db, other.message.id);
  assert.deepEqual([a!.status.summary, a!.sync.latestRevision, a!.sync.shownRevision], ["confirmed", 4, 4]);
  assert.deepEqual([b!.status.summary, b!.sync.latestRevision, b!.sync.shownRevision], ["confirmed", 4, 4],
    "B was held once (not_in_channel); a newer revision woke it and it landed");
  assert.ok(editRevisions(slack).length >= 3);
  assert.deepEqual(await panelKinds(fixture, clock.now), [], "nothing is held or refused any more");
  assert.deepEqual(await tableKinds(db), []);
});

for (const conversation of ["public channel", "private channel", "thread"] as const) {
  test(`the sender removed from its ${conversation} while the credential is leased: refused at the attempt start, no attempt row, no chat.update`, async ({ db }) => {
    const fixture = await seedSlackCardEditFixture(db, {
      privacy: conversation === "private channel" ? "private" : "public",
      conversation: conversation === "thread" ? "thread" : "channel",
    });
    const slack = fakeSlack(fixture);
    const { clock } = clockAt();
    let remove = false;
    let removed = false;
    const run = worker(fixture, slack, clock, "card-worker", { async onLease() {
      if (!remove || removed) return;
      removed = true;
      // The real membership writer (a thread's posting follows its parent channel's membership).
      await removeAgent(fixture.channel.id, fixture.agent.id);
    } });
    await updateCard(fixture, "Ready for testing", clock.now);
    const first = await run.step();
    assert.equal(first.kind === "attempted" ? first.outcome : first.kind, "succeeded", "a member's card edits");
    remove = true;
    await updateCard(fixture, "Shipped", clock.now);
    const result = await run.step();
    assert.ok(removed, "the removal committed between the first check and the attempt start");
    assert.equal(result.kind === "ended" ? result.reason : result.kind, "sender_removed");
    assert.deepEqual((await db.select().from(externalCardEditAttempts)).map((attempt) => attempt.cardRevision), [2],
      "no attempt row for the revision after the removal");
    assert.deepEqual(editRevisions(slack), [2], "no chat.update after the removal");
  });
}

test("a read-back after an unknown outcome that cannot read the message shows not confirmed at once, before T", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready", clock.now);
  slack.state.script.push(() => ({ kind: "transport_failure", phase: "after_send", code: "timeout" }));
  await run.step();
  assert.deepEqual(await panelKinds(fixture, clock.now), [], "an unknown outcome alone, younger than T");
  advance(SLACK_CARD_EDIT_QUIET_PERIOD_MS);
  slack.state.script.push(() => slack.ok({ messages: [] }));
  const read = await run.step();
  assert.deepEqual(read.kind === "read_back" ? read.result : read, { kind: "unreadable", reason: "readback_message_missing" });
  assert.deepEqual(await panelKinds(fixture, clock.now), ["not_confirmed"], "the message cannot be read back: at once");
  assert.deepEqual(await tableKinds(db), ["not_confirmed"]);
  assert.ok((await syncRow(fixture)).readbackProblemAt);
});

// ---------------------------------------------------------------------------
// A Joint Channel's card (stored once, in canonical storage): its Slack copy is
// the bridged HOST projection's, and each edit is checked on the host's own
// conversation (the projection, or the host's local face of a thread); no
// other Server's side edits through here.

for (const conversation of ["channel", "thread"] as const) {
  test(`a joint ${conversation} card bridged on the host's projection edits its Slack copy (the sender's posting checked on the host's side)`, async ({ db }) => {
    const fixture = await seedJointSlackCardEditFixture(db, { conversation });
    assert.notEqual(fixture.message.channelId, fixture.channel.id, "stored in canonical storage, not on the bridged projection");
    const slack = fakeSlack(fixture);
    const { clock } = clockAt();
    const run = worker(fixture, slack, clock);
    await updateCard(fixture, "Ready for testing", clock.now);
    const result = await run.step();
    assert.equal(result.kind === "attempted" ? result.outcome : JSON.stringify(result), "succeeded");
    assert.deepEqual(editRevisions(slack), [2]);
    assert.equal(await status(fixture).then((value) => value.summary), "confirmed");
  });
}

test("a joint card's edit waits while the joint is archived (on its projections; the canonical row never is), and ends once the sender leaves the host's projection", async ({ db }) => {
  const fixture = await seedJointSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock, advance } = clockAt();
  const run = worker(fixture, slack, clock);
  await archiveChannel(fixture.channel.id, fixture.owner.id);
  const [canonical] = await db.select({ archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, fixture.message.channelId));
  assert.equal(canonical!.archivedAt, null);
  await updateCard(fixture, "Ready for testing", clock.now);
  const held = await run.step();
  assert.equal(held.kind === "waiting" ? held.reason : JSON.stringify(held), "channel_archived");
  assert.deepEqual(slack.methods(), []);
  await unarchiveChannel(fixture.channel.id);
  await removeAgent(fixture.channel.id, fixture.agent.id);
  advance(60 * 60_000);
  const ended = await run.step();
  assert.equal(ended.kind === "ended" ? ended.reason : JSON.stringify(ended), "sender_removed");
  assert.deepEqual(slack.methods(), [], "no chat.update");
});

test("a joint card bridged on a participant's projection (no provisioning makes one) is never edited: identity_changed, no chat.update", async ({ db }) => {
  const fixture = await seedJointSlackCardEditFixture(db, { pairRole: "participant" });
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  const run = worker(fixture, slack, clock);
  await updateCard(fixture, "Ready for testing", clock.now);
  const result = await run.step();
  assert.equal(result.kind === "ended" ? result.reason : JSON.stringify(result), "identity_changed");
  assert.deepEqual(slack.methods(), [], "nothing sent to Slack");
  assert.equal(slack.state.leases, 0, "not even a credential leased");
});

test("a card the other side's agent sent through its own projection has no Slack copy: its update records no edit and nothing reaches Slack", async ({ db }) => {
  const fixture = await seedJointSlackCardEditFixture(db);
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  const run = worker(fixture, slack, clock);
  const first = card("In review");
  const [peerCard] = await db.insert(messages).values({
    channelId: fixture.message.channelId, senderType: "agent", senderId: fixture.joint.otherAgent.id, content: "Build 1.19.0 · In review",
    messageType: "chat", actionMetadata: messageCardMetadataAtSend(first, new Date()),
  }).returning();
  await db.insert(messageCardRevisions).values({ messageId: peerCard!.id, revision: 1, card: first, content: peerCard!.content, senderAgentId: fixture.joint.otherAgent.id });
  const updated = await applyMessageCardUpdate({
    messageId: peerCard!.id, senderAgentId: fixture.joint.otherAgent.id, card: card("Ready"), content: "Build 1.19.0 · Ready", now: clock.now,
    jointPostingAuthorityChannelId: fixture.joint.otherProjection.id,
  });
  assert.equal(updated.kind, "updated");
  assert.deepEqual(await db.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.sourceMessageId, peerCard!.id)), []);
  assert.deepEqual(await run.step(), { kind: "empty" });
  assert.deepEqual(slack.methods(), []);
});

test("a bridged channel converted to joint: the card's sender still updates it; its Slack copy, from the bridge's epoch before the conversion, is never edited (identity_changed, not sender_removed)", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  // The joint posting authority reads the agent's server membership, as createAgent writes it.
  await db.insert(serverAgentMembers).values({ serverId: fixture.server.id, agentId: fixture.agent.id });
  const slack = fakeSlack(fixture);
  const { clock } = clockAt();
  const run = worker(fixture, slack, clock);
  const job = await startChannelToJointConversion({ serverId: fixture.server.id, sourceChannelId: fixture.channel.id, createdByUserId: fixture.owner.id });
  await runChannelConversionJob(job.id);
  const [moved] = await db.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, fixture.message.id));
  assert.notEqual(moved!.channelId, fixture.channel.id, "the card moved to canonical storage");
  const [binding] = await db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, fixture.binding.id));
  assert.equal(binding!.channelId, fixture.channel.id, "the bridge stays anchored to the host's projection");
  assert.equal(binding!.bindingEpoch, fixture.binding.bindingEpoch + 1, "the conversion started a new bridge epoch");

  const updated = await applyMessageCardUpdate({
    messageId: fixture.message.id, senderAgentId: fixture.agent.id, card: card("Ready for testing"), content: "Build 1.19.0 · Ready for testing",
    now: clock.now, jointPostingAuthorityChannelId: fixture.channel.id,
  });
  assert.equal(updated.kind === "updated" ? updated.answer.revision : updated.kind, 2);
  const result = await run.step();
  assert.equal(result.kind === "ended" ? result.reason : JSON.stringify(result), "identity_changed");
  assert.deepEqual(slack.methods(), []);
});
