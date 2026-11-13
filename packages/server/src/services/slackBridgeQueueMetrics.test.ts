import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type { Database } from "../db/index";
import {
  slackBridgeInboundFailedEvents24h,
  slackBridgeInboundHeldEvents,
  slackBridgeInboundOldestHeldAgeSeconds,
  slackBridgeInboundOldestPendingAgeSeconds,
  slackBridgeInboundPendingEvents,
  slackBridgeInboundWorkerResultsTotal,
  slackBridgeLifecycleHealthObservationsTotal,
  slackBridgeOutboundOldestPendingAgeSeconds,
  slackBridgeOutboundPairOldestPendingAgeSeconds,
  slackBridgeOutboundPairPendingMessages,
  slackBridgeOutboundPairs,
  slackBridgeOutboundPendingMessages,
  slackBridgeOutboundWorkerResultsTotal,
} from "../metrics";
import {
  createSlackBridgeQueueMetricsSampler,
  observeSlackInboundWorkerResult,
  observeSlackLifecycleHealth,
  observeSlackOutboundWorkerResult,
  sampleSlackBridgeQueues,
} from "./slackBridgeQueueMetrics";
import { listSlackPairHeads, listSlackPairHeadsForHealth, slackPairOutboundHold } from "./slackBridgePairQueue";
import type { SlackBridgeLifecycleExecutionReceipt } from "./slackBridgeWorkerLifecycle";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const REGISTRATION = "00000000-0000-4000-8000-0000000000a1";
const OTHER_REGISTRATION = "00000000-0000-4000-8000-0000000000a2";
const ACTIVE_INSTALL = "00000000-0000-4000-8000-0000000000b1";
const REAUTH_INSTALL = "00000000-0000-4000-8000-0000000000b2";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const channel = (n: number) => `00000000-0000-4000-8000-0000000c${String(n).padStart(4, "0")}`;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MINUTE = 60_000;

// Only the storage boundary these reads touch, with the production column types.
async function openQueueFixture() {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE external_app_registrations (id uuid PRIMARY KEY, environment text NOT NULL, provider text NOT NULL);
    CREATE TABLE external_app_installs (id uuid PRIMARY KEY, state text NOT NULL, provider_authority_id text NOT NULL);
    CREATE TABLE external_channel_bindings (
      id uuid PRIMARY KEY, registration_id uuid NOT NULL, install_id uuid NOT NULL, channel_id uuid NOT NULL,
      provider_conversation_id text NOT NULL, binding_epoch integer NOT NULL, state text NOT NULL
    );
    CREATE TABLE external_delivery_partitions (
      binding_id text NOT NULL, binding_epoch integer NOT NULL,
      last_enqueued_position bigint NOT NULL, cursor_position bigint NOT NULL,
      authority_blocked_at timestamptz, authority_blocked_reason text, authority_retry_at timestamptz
    );
    CREATE TABLE external_outbound_deliveries (
      id uuid PRIMARY KEY, binding_id text NOT NULL, binding_epoch integer NOT NULL, partition_position bigint NOT NULL,
      state text NOT NULL, provider_attempts integer NOT NULL DEFAULT 0,
      lease_generation integer NOT NULL DEFAULT 0, lease_expires_at timestamptz,
      ambiguity_budget_provider_attempts integer NOT NULL DEFAULT 0, dispatched_failure_attempts integer NOT NULL DEFAULT 0,
      first_dispatched_at timestamptz, state_reason text, created_at timestamptz NOT NULL
    );
    CREATE TABLE external_inbound_events (id uuid, app_registration_id text NOT NULL, status text NOT NULL, received_at timestamptz NOT NULL);
    CREATE TABLE slack_verified_ingress_events (app_registration_id text NOT NULL, state text NOT NULL,
      first_parse_failure_at timestamptz, received_at timestamptz NOT NULL, materialized_inbound_event_id uuid);
    INSERT INTO external_app_registrations VALUES
      ('${REGISTRATION}', 'production', 'slack'), ('${OTHER_REGISTRATION}', 'production', 'slack');
    INSERT INTO external_app_installs VALUES
      ('${ACTIVE_INSTALL}', 'active', 'T1'), ('${REAUTH_INSTALL}', 'reauth_required', 'T2');
  `);
  return { client, db: drizzle(client) as unknown as Database };
}

test("a bot wait in an empty older partition remains visible while another generation has work", async () => {
  const { client, db } = await openQueueFixture();
  try {
    await client.exec(`
      INSERT INTO external_channel_bindings VALUES
        ('${id(10)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(1)}', 'C1', 1, 'revoked'),
        ('${id(11)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(1)}', 'C1', 3, 'active');
      INSERT INTO external_delivery_partitions VALUES
        ('${id(10)}', 1, 1, 1, '${ago(10 * MINUTE)}', 'slack_not_in_channel', '${ago(-MINUTE)}'),
        ('${id(11)}', 3, 1, 0, NULL, NULL, NULL);
      INSERT INTO external_outbound_deliveries (id, binding_id, binding_epoch, partition_position, state, created_at)
        VALUES ('${id(111)}', '${id(11)}', 3, 1, 'queued', '${ago(MINUTE)}');
    `);
    const coordinates = [{ bindingId: id(11), bindingEpoch: 3 }];
    const [storageHead] = await listSlackPairHeads(db, coordinates);
    assert.equal(storageHead?.authorityBlockedReason, null, "the queued head itself has no wait");
    const [visibleHead] = await listSlackPairHeadsForHealth(db, coordinates);
    assert.deepEqual(slackPairOutboundHold(visibleHead!, NOW),
      { status: "waiting", reason: "invite_app", since: ago(10 * MINUTE) });
    const sample = await sampleSlackBridgeQueues(db, { registrationId: REGISTRATION, now: NOW });
    assert.deepEqual(sample.pairs.find((pair) => pair.bindingId === id(11)),
      { bindingId: id(11), status: "waiting", pendingMessages: 1, oldestPendingAgeMs: MINUTE });
  } finally { await client.close(); }
});

function gaugeValues(metric: { get(): Promise<{ values: { labels: Record<string, string | number>; value: number }[] }> }) {
  return metric.get().then((data) => Object.fromEntries(data.values.map((row) => [
    Object.values(row.labels).join("/"), row.value,
  ])));
}

test("queue sample sums every generation of a pair, classifies its status and bounds per-pair series", async () => {
  const { client, db } = await openQueueFixture();
  try {
    await client.exec(`
      INSERT INTO external_channel_bindings VALUES
        -- Pair 1: a revoked old generation still holds two older messages.
        ('${id(10)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(1)}', 'C1', 1, 'revoked'),
        ('${id(11)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(1)}', 'C1', 3, 'active'),
        ('${id(20)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(2)}', 'C2', 1, 'active'),
        ('${id(30)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(3)}', 'C3', 1, 'active'),
        ('${id(40)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(4)}', 'C4', 1, 'active'),
        ('${id(50)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(5)}', 'C5', 1, 'paused'),
        -- Stopped pairs with nothing queued yet.
        ('${id(51)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(51)}', 'C51', 1, 'paused'),
        ('${id(61)}', '${REGISTRATION}', '${REAUTH_INSTALL}', '${channel(61)}', 'C61', 1, 'active'),
        ('${id(60)}', '${REGISTRATION}', '${REAUTH_INSTALL}', '${channel(6)}', 'C6', 1, 'active'),
        ('${id(70)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(7)}', 'C7', 1, 'active'),
        -- Master switch off: an intentional control, not a fault.
        ('${id(71)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(71)}', 'C71', 1, 'active'),
        ('${id(80)}', '${REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(8)}', 'C8', 1, 'revoked'),
        ('${id(90)}', '${OTHER_REGISTRATION}', '${ACTIVE_INSTALL}', '${channel(9)}', 'C9', 1, 'active');
      INSERT INTO external_delivery_partitions VALUES
        ('${id(10)}', 1, 3, 1, NULL, NULL, NULL),
        ('${id(11)}', 3, 2, 0, NULL, NULL, NULL),
        ('${id(20)}', 1, 1, 0, '${ago(10 * MINUTE)}', 'slack_not_in_channel', '${ago(-MINUTE)}'),
        ('${id(30)}', 1, 1, 0, NULL, NULL, NULL),
        ('${id(40)}', 1, 5, 5, NULL, NULL, NULL),
        ('${id(50)}', 1, 1, 0, NULL, NULL, NULL),
        ('${id(61)}', 1, 2, 2, NULL, NULL, NULL),
        ('${id(60)}', 1, 1, 0, NULL, NULL, NULL),
        ('${id(70)}', 1, 1, 0, NULL, NULL, NULL),
        ('${id(71)}', 1, 1, 0, '${ago(30 * MINUTE)}', 'master_disabled', NULL),
        ('${id(80)}', 1, 1, 0, NULL, NULL, NULL),
        ('${id(90)}', 1, 1, 0, NULL, NULL, NULL);
      INSERT INTO external_outbound_deliveries (id, binding_id, binding_epoch, partition_position, state, created_at) VALUES
        ('${id(101)}', '${id(10)}', 1, 2, 'queued', '${ago(20 * MINUTE)}'),
        ('${id(102)}', '${id(10)}', 1, 3, 'queued', '${ago(19 * MINUTE)}'),
        ('${id(111)}', '${id(11)}', 3, 1, 'queued', '${ago(MINUTE)}'),
        ('${id(112)}', '${id(11)}', 3, 2, 'queued', '${ago(MINUTE)}'),
        ('${id(201)}', '${id(20)}', 1, 1, 'outcome_unknown', '${ago(12 * MINUTE)}'),
        ('${id(301)}', '${id(30)}', 1, 1, 'dead', '${ago(30 * MINUTE)}'),
        ('${id(501)}', '${id(50)}', 1, 1, 'queued', '${ago(40 * MINUTE)}'),
        ('${id(601)}', '${id(60)}', 1, 1, 'queued', '${ago(3 * MINUTE)}'),
        ('${id(701)}', '${id(70)}', 1, 1, 'queued', '${ago(30_000)}'),
        ('${id(711)}', '${id(71)}', 1, 1, 'queued', '${ago(2 * MINUTE)}'),
        ('${id(801)}', '${id(80)}', 1, 1, 'queued', '${ago(50 * MINUTE)}'),
        ('${id(901)}', '${id(90)}', 1, 1, 'queued', '${ago(50 * MINUTE)}');
      INSERT INTO external_inbound_events (app_registration_id, status, received_at) VALUES
        ('${REGISTRATION}', 'queued', '${ago(10 * MINUTE)}'),
        ('${REGISTRATION}', 'queued', '${ago(MINUTE)}'),
        ('${REGISTRATION}', 'processing', '${ago(2 * MINUTE)}'),
        ('${REGISTRATION}', 'dead', '${ago(60 * MINUTE)}'),
        ('${REGISTRATION}', 'dead', '${ago(30 * 60 * MINUTE)}'),
        ('${REGISTRATION}', 'committed', '${ago(MINUTE)}'),
        ('${OTHER_REGISTRATION}', 'queued', '${ago(90 * MINUTE)}');
      INSERT INTO slack_verified_ingress_events (app_registration_id, state, first_parse_failure_at, received_at) VALUES
        ('${REGISTRATION}', 'held', '${ago(25 * MINUTE)}', '${ago(25 * MINUTE)}'),
        ('${REGISTRATION}', 'held', '${ago(5 * MINUTE)}', '${ago(5 * MINUTE)}'),
        ('${OTHER_REGISTRATION}', 'held', '${ago(90 * MINUTE)}', '${ago(90 * MINUTE)}'),
        ('${REGISTRATION}', 'queued', NULL, '${ago(15 * MINUTE)}'),
        ('${REGISTRATION}', 'processing', NULL, '${ago(4 * MINUTE)}'),
        ('${REGISTRATION}', 'materialized', NULL, '${ago(80 * MINUTE)}'),
        ('${OTHER_REGISTRATION}', 'queued', NULL, '${ago(90 * MINUTE)}');
      INSERT INTO external_inbound_events (id, app_registration_id, status, received_at) VALUES
        ('${id(999)}', '${REGISTRATION}', 'quarantined', '${ago(50 * MINUTE)}');
      INSERT INTO slack_verified_ingress_events (app_registration_id, state, first_parse_failure_at, received_at, materialized_inbound_event_id) VALUES
        ('${REGISTRATION}', 'materialized', NULL, '${ago(50 * MINUTE)}', '${id(999)}');
    `);
    const sample = await sampleSlackBridgeQueues(db, { registrationId: REGISTRATION, now: NOW });
    const pairs = Object.fromEntries(sample.pairs.map((pair) => [pair.bindingId, pair]));
    assert.deepEqual(Object.keys(pairs).sort(), [id(11), id(20), id(30), id(40), id(50), id(51), id(60), id(61), id(70), id(71)],
      "revoked current bindings and other registrations are not pairs of this runtime");
    assert.deepEqual(pairs[id(11)], { bindingId: id(11), status: "flowing", pendingMessages: 4, oldestPendingAgeMs: 20 * MINUTE },
      "an old generation's unsent messages belong to the pair and set its oldest age");
    assert.equal(pairs[id(20)]?.status, "waiting", "a pair-level block wins over its unknown head");
    assert.equal(pairs[id(30)]?.status, "stalled");
    assert.deepEqual(pairs[id(40)], { bindingId: id(40), status: "idle", pendingMessages: 0, oldestPendingAgeMs: 0 });
    assert.equal(pairs[id(50)]?.status, "paused");
    assert.equal(pairs[id(60)]?.status, "paused", "an installation waiting for reauthorization does not send");
    assert.deepEqual(pairs[id(51)], { bindingId: id(51), status: "paused", pendingMessages: 0, oldestPendingAgeMs: 0 },
      "a paused binding with nothing queued is paused, not idle");
    assert.deepEqual(pairs[id(61)], { bindingId: id(61), status: "paused", pendingMessages: 0, oldestPendingAgeMs: 0 },
      "a pair of an installation waiting for reauthorization is paused even with an empty queue");
    assert.equal(pairs[id(70)]?.status, "flowing");
    assert.equal(pairs[id(71)]?.status, "paused", "a master-switch wait is maintenance, not a waiting fault");
    assert.deepEqual(sample.inboundPending, [
      { status: "queued", events: 4, oldestAgeMs: 50 * MINUTE },
      { status: "processing", events: 2, oldestAgeMs: 4 * MINUTE },
    ]);
    assert.deepEqual(sample.inboundHeld, { events: 2, oldestAgeMs: 25 * MINUTE });
    assert.deepEqual(sample.inboundFailed24h, [
      { status: "dead", events: 1 }, { status: "revoked", events: 0 }, { status: "quarantined", events: 1 },
    ]);

    // The same heads drive what a bridged channel shows while its messages are held.
    const holds = Object.fromEntries((await listSlackPairHeads(db, [11, 20, 30, 70].map((n) => ({
      bindingId: id(n), bindingEpoch: n === 11 ? 3 : 1,
    })))).map((head) => [head.currentBindingId, slackPairOutboundHold(head, NOW)]));
    assert.deepEqual(holds, {
      [id(11)]: null,
      [id(20)]: { status: "waiting", reason: "invite_app", since: ago(10 * MINUTE) },
      [id(30)]: { status: "stalled", since: ago(30 * MINUTE) },
      [id(70)]: null,
    });

    const [botRemoved] = await listSlackPairHeads(db, [{ bindingId: id(20), bindingEpoch: 1 }]);
    assert.deepEqual(slackPairOutboundHold({ ...botRemoved!, authorityBlockedReason: "binding_paused_bot_removed" }, NOW),
      { status: "waiting", reason: "invite_app", since: ago(10 * MINUTE) }, "W7 bot removal keeps the invite hint in W6 channel projection");
    assert.deepEqual(slackPairOutboundHold({ ...botRemoved!, authorityBlockedReason: "reconciliation_history_limited" }, NOW),
      { status: "waiting", reason: "configuration", detail: "history_limited", since: ago(10 * MINUTE) },
      "an unconfirmable delivery says why in the channel projection; reason stays for older clients");
    const sampler = createSlackBridgeQueueMetricsSampler({ db, registrationId: REGISTRATION, now: () => NOW });
    await sampler.sampleNow();
    assert.deepEqual(await gaugeValues(slackBridgeOutboundPairs),
      { idle: 1, flowing: 2, waiting: 1, stalled: 1, paused: 5 });
    assert.deepEqual(await gaugeValues(slackBridgeOutboundPendingMessages),
      { idle: 0, flowing: 5, waiting: 1, stalled: 1, paused: 3 });
    assert.equal((await gaugeValues(slackBridgeOutboundOldestPendingAgeSeconds)).paused, 40 * 60);
    assert.deepEqual(await gaugeValues(slackBridgeOutboundPairPendingMessages), {
      [`${id(50)}/paused`]: 1, [`${id(30)}/stalled`]: 1, [`${id(11)}/flowing`]: 4,
      [`${id(20)}/waiting`]: 1, [`${id(60)}/paused`]: 1, [`${id(71)}/paused`]: 1,
    }, "only unhealthy or slow pairs get a series; a young flowing pair and an idle pair do not");
    assert.equal((await gaugeValues(slackBridgeOutboundPairOldestPendingAgeSeconds))[`${id(11)}/flowing`], 20 * 60);
    assert.deepEqual(await gaugeValues(slackBridgeInboundPendingEvents), { queued: 4, processing: 2 });
    assert.deepEqual(await gaugeValues(slackBridgeInboundOldestPendingAgeSeconds), { queued: 3000, processing: 240 });
    assert.deepEqual(await gaugeValues(slackBridgeInboundFailedEvents24h), { dead: 1, revoked: 0, quarantined: 1 });
    assert.equal((await slackBridgeInboundHeldEvents.get()).values[0]?.value, 2);
    assert.equal((await slackBridgeInboundOldestHeldAgeSeconds.get()).values[0]?.value, 25 * 60);
    assert.deepEqual(sampler.pairBacklog(id(11)), { pendingEvents: 4, oldestPendingEventAgeMs: 20 * MINUTE });
    assert.equal(sampler.pairBacklog(id(80)), null);

    const errors: unknown[] = [];
    const failing = createSlackBridgeQueueMetricsSampler({
      db: { select() { throw new Error("database unavailable"); } } as unknown as Database,
      registrationId: REGISTRATION,
      now: () => NOW,
      onError: (error) => errors.push(error),
    });
    await failing.sampleNow();
    assert.equal(errors.length, 1);
    assert.deepEqual(await gaugeValues(slackBridgeOutboundPairs), {}, "a failed read clears gauges instead of freezing ages");
    assert.equal(failing.pairBacklog(id(11)), null, "the lifecycle falls back to an unknown backlog");
  } finally {
    await client.close();
  }
});

test("worker and lifecycle observations count closed outcomes and skip idle ticks", async () => {
  slackBridgeOutboundWorkerResultsTotal.reset();
  slackBridgeInboundWorkerResultsTotal.reset();
  slackBridgeLifecycleHealthObservationsTotal.reset();
  observeSlackOutboundWorkerResult({ kind: "empty" });
  observeSlackOutboundWorkerResult({ kind: "disabled" });
  observeSlackOutboundWorkerResult({ kind: "attempted", deliveryId: id(1), attemptNumber: 1, outcome: "accepted", deliveryState: "accepted" });
  observeSlackOutboundWorkerResult({ kind: "skipped", deliveryId: id(2) });
  observeSlackOutboundWorkerResult({ kind: "cursor_recovered", deliveryId: id(3), state: "skipped" });
  observeSlackOutboundWorkerResult({ kind: "authority_blocked", severity: "overdue", reason: "slack_not_in_channel", deliveryId: id(4), nextRetryAt: null });
  observeSlackOutboundWorkerResult({ kind: "blocked", reason: "retry_not_due", deliveryId: id(5) });
  observeSlackOutboundWorkerResult({ kind: "authority_blocked", severity: "overdue", reason: "master_disabled", deliveryId: id(9), nextRetryAt: null });
  observeSlackOutboundWorkerResult({ kind: "authority_blocked", severity: "overdue", reason: "binding_paused_bot_removed", deliveryId: id(10), nextRetryAt: null });
  assert.deepEqual(await gaugeValues(slackBridgeOutboundWorkerResultsTotal), {
    "attempted/accepted": 1, "skipped/none": 1, "cursor_recovered/skipped": 1,
    "authority_blocked/overdue": 1, "blocked/none": 1, "authority_blocked/control_wait": 2,
  });
  observeSlackInboundWorkerResult("event", { kind: "empty" });
  observeSlackInboundWorkerResult("event", { kind: "committed", eventId: id(6), messageId: id(7) });
  observeSlackInboundWorkerResult("attachment", { kind: "retry", jobId: id(8), reason: "source_unavailable", retryAt: NOW });
  assert.deepEqual(await gaugeValues(slackBridgeInboundWorkerResultsTotal), { "event/committed": 1, "attachment/retry": 1 });
  observeSlackLifecycleHealth({ plan: { health: { state: "Degraded", reason: "backlog_backpressure" } } } as SlackBridgeLifecycleExecutionReceipt);
  observeSlackLifecycleHealth({ plan: { health: { state: "Connected", reason: null } } } as SlackBridgeLifecycleExecutionReceipt);
  assert.deepEqual(await gaugeValues(slackBridgeLifecycleHealthObservationsTotal),
    { "Degraded/backlog_backpressure": 1, "Connected/none": 1 });
});
