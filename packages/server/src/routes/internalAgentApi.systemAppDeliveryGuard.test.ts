// Delivery-time guards for system-app agent events (systemAppDeliveryGuards):
// a guarded app's event is handed over by no path (first push, push sweep,
// reconnect / `/events` rebuild, buffered hand-over) once its guard vetoes it
// (false, or left out of the verdicts), and is expired instead; a re-read by
// `agent-event:<id>` answers as for an unknown id (the row is left as is).
// Fail closed: a required app with no guard, or a guard that throws, delivers
// nothing but leaves its rows queued, so they are delivered once the guard
// answers. Unguarded apps and OAuth rows are untouched.
//
// "system.raftbench" stands in for a guarded app: it is marked as requiring a
// guard only inside these tests (the test hook is restored after each).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { thirdPartyAgentEvents, users } from "../db/schema";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { registerMachine } from "../services/machineService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createOAuthClient } from "../services/oauthService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { __setAppWebhookEncryptionKeyForTests } from "../services/appWebhookConfigService";
import { sweepAgentInboxNotices } from "../services/agentInboxPushService";
import type { WebhookPost } from "../services/appNotificationDeliveryService";
import { __setExternalAgentInboxChainSelectorForTests } from "../services/messageService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import {
  buildSystemAppAgentMessage,
  createSystemAppAgentEvent,
  deliverSystemAppAgentEvent,
  type SystemApp,
  type SystemAppAgentEvent,
  type SystemAppAgentEventDeliverer,
} from "../services/systemAppAgentEvents";
import {
  __setSystemAppsRequiringDeliveryGuardForTests,
  partitionDeliverableSystemAppEvents,
  registerSystemAppDeliveryGuard,
} from "../services/systemAppDeliveryGuards";
import { __setWithheldReceiveBackoffMsForTests } from "./internal";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
__setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));
// The push sweep reads the agent's inbox chain first (as in the inbox push tests).
__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));

const SECRET = "Q2hvb3NlLWEtcmFuZG9tLXNlY3JldC1vZi0zMi1ieXRlcw_x";
const GUARDED: SystemApp = "system.raftbench";

let restoreRequired: () => void = () => {};
let unregister: () => void = () => {};
let warnings: string[] = [];
/** Each guard call's batch of event ids. */
let guardCalls: string[][] = [];

beforeEach(() => {
  restoreRequired = __setSystemAppsRequiringDeliveryGuardForTests([GUARDED]);
  guardCalls = [];
  warnings = [];
  // Only the guard's own warnings (the app logs unrelated ones too).
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[SystemAppDeliveryGuard]")) warnings.push(line);
  });
});

afterEach(() => {
  unregister();
  unregister = () => {};
  restoreRequired();
  vi.restoreAllMocks();
});

/**
 * A guard that lets through events whose payload says `allow: true` ("payload"),
 * answers only for those and leaves the rest out ("partial"), or throws.
 */
function registerGuard(mode: "payload" | "partial" | "throw" = "payload") {
  unregister = registerSystemAppDeliveryGuard(GUARDED, async (events) => {
    guardCalls.push(events.map((event) => event.id));
    if (mode === "throw") throw new Error("visibility lookup failed");
    const answered = mode === "partial" ? events.filter((event) => event.payload.allow === true) : events;
    return new Map(answered.map((event) => [event.id, event.payload.allow === true]));
  });
}

function replaceGuard(mode: "payload" | "partial" | "throw") {
  unregister();
  registerGuard(mode);
}

async function seedAgent() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `guard-${suffix}@slock.test`,
    name: `guard-${suffix}`,
    displayName: "Guard Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Delivery Guard Test", `guard-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `Guard${suffix.slice(0, 6)}`, { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "guard-test", issuedVia: "computer", createdByUserId: null });
  return { ownerId: owner!.id, serverId: server.id, agentId: agent.id, apiKey: minted.apiKey };
}

type Fixture = Awaited<ReturnType<typeof seedAgent>>;

function event(f: Fixture, summary: string, payload: Record<string, unknown>, systemApp: SystemApp = GUARDED) {
  return createSystemAppAgentEvent({ serverId: f.serverId, agentId: f.agentId, systemApp, summary, payload, ttlMs: 60 * 60_000 });
}

const statusOf = async (id: string) =>
  (await getDb().select({ status: thirdPartyAgentEvents.status }).from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, id)))[0]?.status;

function recordingDeliverer() {
  const delivered: AgentMessage[] = [];
  const deliverer: SystemAppAgentEventDeliverer = {
    deliverMessage: async (_agentId: string, message: AgentMessage) => {
      delivered.push(message);
      return { status: "queued", reason: "direct_dispatch" };
    },
  };
  return { delivered, deliverer };
}

function freshProcess(app: { app: { set: (key: string, value: unknown) => void } }) {
  const orchestrator = new AgentOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  return orchestrator;
}

async function api(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, raw: text };
}

async function sweptTargets(app: { baseUrl: string }, f: Fixture, orchestrator: AgentOrchestrator) {
  const registered = await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url: "https://receiver.example.com/raft/inbox", secret: SECRET });
  assert.equal(registered.status, 200, registered.raw);
  const targets: string[] = [];
  const post: WebhookPost = async (input) => {
    for (const target of (JSON.parse(input.body) as { targets: Array<{ target: string }> }).targets) targets.push(target.target);
    return { status: 200 };
  };
  await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post, agentIds: [f.agentId] });
  return targets;
}

const eventTarget = (e: SystemAppAgentEvent) => `agent-event:${e.id.slice(0, 8)}`;

test("a vetoed event is delivered by no path and is expired; allowed ones are delivered; one guard call per batch", async ({ app }) => {
  registerGuard();
  const f = await seedAgent();
  const orchestrator = freshProcess(app);

  // First push.
  const pushAllowed = await event(f, "push allowed", { allow: true });
  const pushVetoed = await event(f, "push vetoed", { allow: false });
  const { delivered, deliverer } = recordingDeliverer();
  assert.equal(await deliverSystemAppAgentEvent({ event: pushAllowed, deliverer }), true);
  assert.equal(await deliverSystemAppAgentEvent({ event: pushVetoed, deliverer }), false);
  assert.deepEqual(delivered.map((m) => m.message_id), [pushAllowed.id]);
  assert.equal(await statusOf(pushVetoed.id), "expired");
  // Settle the pushed one so the later paths only see their own events.
  await getDb().update(thirdPartyAgentEvents).set({ status: "delivered" }).where(eq(thirdPartyAgentEvents.id, pushAllowed.id));

  // Push sweep: announces only the allowed event, from one guard call.
  const sweepAllowed = await event(f, "sweep allowed", { allow: true });
  const sweepVetoed = await event(f, "sweep vetoed", { allow: false });
  guardCalls = [];
  assert.deepEqual(await sweptTargets(app, f, orchestrator), [eventTarget(sweepAllowed)]);
  // A batch is a set: events created in the same millisecond tie on created_at and fall back to id order.
  assert.deepEqual(guardCalls.map((ids) => [...ids].sort()), [[sweepAllowed.id, sweepVetoed.id].sort()]);
  assert.equal(await statusOf(sweepVetoed.id), "expired");
  assert.equal(await statusOf(sweepAllowed.id), "queued", "announcing still claims nothing");

  // Reconnect rebuild + `/events` pull.
  const pullVetoed = await event(f, "pull vetoed", { allow: false });
  guardCalls = [];
  const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(pulled.status, 200, pulled.raw);
  assert.deepEqual(guardCalls.map((ids) => [...ids].sort()), [[sweepAllowed.id, pullVetoed.id].sort()], "the rebuilt batch is guarded once, not again at hand-over");
  assert.ok(pulled.raw.includes(sweepAllowed.id), "the allowed event is pulled");
  assert.ok(!pulled.raw.includes(pullVetoed.id), "the vetoed event is not");
  assert.equal(await statusOf(pullVetoed.id), "expired");
  assert.equal(await statusOf(sweepAllowed.id), "delivered");
  for (const vetoed of [pushVetoed, sweepVetoed, pullVetoed]) assert.ok(!pulled.raw.includes(vetoed.id));
  assert.deepEqual(warnings, [], "a plain veto is not a warning");
});

test("an event already in the agent's buffer is re-guarded at hand-over", async ({ app }) => {
  registerGuard();
  const f = await seedAgent();
  const orchestrator = freshProcess(app);
  // Buffered while allowed; the recipient has lost access since.
  const buffered = await event(f, "buffered", { allow: false });
  orchestrator.deliverToLocalInbox(f.agentId, buildSystemAppAgentMessage(buffered), { notifyPendingReceive: false });

  const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(pulled.status, 200, pulled.raw);
  assert.ok(!pulled.raw.includes(buffered.id), "not handed over");
  assert.equal(await statusOf(buffered.id), "expired");
  assert.equal(orchestrator.peekPendingMessages(f.agentId).length, 0, "dropped from the buffer");
});

test("a buffered event its guard withholds (fail closed) is not handed over but stays buffered and queued", async ({ app }) => {
  registerGuard("throw");
  const f = await seedAgent();
  const orchestrator = freshProcess(app);
  const buffered = await event(f, "buffered", { allow: true });
  orchestrator.deliverToLocalInbox(f.agentId, buildSystemAppAgentMessage(buffered), { notifyPendingReceive: false });

  const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(pulled.status, 200, pulled.raw);
  assert.ok(!pulled.raw.includes(buffered.id));
  assert.equal(orchestrator.peekPendingMessages(f.agentId).length, 1, "still buffered");
  assert.equal(await statusOf(buffered.id), "queued");

  replaceGuard("payload");
  const recovered = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.ok(recovered.raw.includes(buffered.id), "handed over once the guard answers");
});

test("the legacy daemon receive re-guards buffered events too", async ({ app }) => {
  registerGuard();
  const f = await seedAgent();
  const { machine, apiKey: machineKey } = await registerMachine(f.serverId, f.ownerId, "guard-machine");
  await placeAgentOnMachine(f.agentId, machine.id);
  const orchestrator = freshProcess(app);
  const allowed = await event(f, "allowed", { allow: true });
  const vetoed = await event(f, "vetoed", { allow: false });
  for (const e of [allowed, vetoed]) {
    orchestrator.deliverToLocalInbox(f.agentId, buildSystemAppAgentMessage(e), { notifyPendingReceive: false });
  }

  const res = await fetch(`${app.baseUrl}/internal/agent/${f.agentId}/receive?block=false&timeout=1`, {
    headers: { Authorization: `Bearer ${machineKey}` },
  });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  assert.ok(raw.includes(allowed.id), raw);
  assert.ok(!raw.includes(vetoed.id), raw);
  assert.equal(await statusOf(vetoed.id), "expired");
  assert.deepEqual(guardCalls.map((ids) => [...ids].sort()), [[allowed.id, vetoed.id].sort()], "one call for the batch");
});

test("the legacy daemon's long poll (block=true) backs off while all it has is withheld, and answers once the guard does", async ({ app }) => {
  registerGuard("throw");
  __setWithheldReceiveBackoffMsForTests(100);
  try {
    const f = await seedAgent();
    const { machine, apiKey: machineKey } = await registerMachine(f.serverId, f.ownerId, "guard-machine");
    await placeAgentOnMachine(f.agentId, machine.id);
    const orchestrator = freshProcess(app);
    const withheld = await event(f, "withheld", { allow: true });
    orchestrator.deliverToLocalInbox(f.agentId, buildSystemAppAgentMessage(withheld), { notifyPendingReceive: false });
    const receive = async (timeoutMs: number) => {
      const started = Date.now();
      const res = await fetch(`${app.baseUrl}/internal/agent/${f.agentId}/receive?block=true&timeout=${timeoutMs}`, {
        headers: { Authorization: `Bearer ${machineKey}` },
      });
      const raw = await res.text();
      assert.equal(res.status, 200, raw);
      return { raw, elapsedMs: Date.now() - started };
    };

    // Not at once: it waits out the poll, reading again every backoff, then answers empty.
    const calls = guardCalls.length;
    const waited = await receive(600);
    assert.deepEqual(JSON.parse(waited.raw), { messages: [] });
    assert.ok(waited.elapsedMs >= 550, `answered after ${waited.elapsedMs} ms`);
    assert.ok(guardCalls.length - calls >= 3, `read again while it waited (${guardCalls.length - calls} guard calls)`);
    assert.ok(guardCalls.length - calls <= 8, `backed off between reads (${guardCalls.length - calls} guard calls)`);
    assert.equal(orchestrator.peekPendingMessages(f.agentId).length, 1, "still buffered");
    assert.equal(await statusOf(withheld.id), "queued");

    // The guard answers mid-poll: the event goes out then, not at the poll's end.
    setTimeout(() => replaceGuard("payload"), 200);
    const recovered = await receive(10_000);
    assert.ok(recovered.raw.includes(withheld.id), recovered.raw);
    assert.ok(recovered.elapsedMs < 5_000, `answered after ${recovered.elapsedMs} ms`);
  } finally {
    __setWithheldReceiveBackoffMsForTests(null);
  }
});

test("fail closed: a guard that throws delivers nothing on any path, logs the app and count, and leaves the rows queued", async ({ app }) => {
  registerGuard("throw");
  const f = await seedAgent();
  const orchestrator = freshProcess(app);

  const pushed = await event(f, "push", { allow: true });
  const { delivered, deliverer } = recordingDeliverer();
  assert.equal(await deliverSystemAppAgentEvent({ event: pushed, deliverer }), false);
  assert.equal(delivered.length, 0);
  assert.equal(await statusOf(pushed.id), "queued", "the first push's claim is released");

  const swept = await event(f, "sweep", { allow: true });
  assert.deepEqual(await sweptTargets(app, f, orchestrator), []);

  const pulledEvent = await event(f, "pull", { allow: true });
  const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(pulled.status, 200, pulled.raw);
  for (const e of [pushed, swept, pulledEvent]) {
    assert.ok(!pulled.raw.includes(e.id));
    assert.equal(await statusOf(e.id), "queued", "withheld, not expired");
  }
  assert.deepEqual(warnings.map((w) => w.match(/withholding (\d+) event/)?.[1]), ["1", "2", "3"], warnings.join("\n"));
  for (const warning of warnings) assert.match(warning, /system\.raftbench delivery guard failed; withholding \d+ event\(s\).*visibility lookup failed/);

  // Withheld, not lost: once the guard answers, the next pull delivers them.
  replaceGuard("payload");
  const recovered = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(recovered.status, 200, recovered.raw);
  for (const e of [pushed, swept, pulledEvent]) assert.ok(recovered.raw.includes(e.id), e.summary);
});

test("fail closed: a required app with no guard registered delivers nothing, logs the app and count, and leaves the rows queued", async ({ app }) => {
  const f = await seedAgent();
  const orchestrator = freshProcess(app);

  const pushed = await event(f, "push", { allow: true });
  const { delivered, deliverer } = recordingDeliverer();
  assert.equal(await deliverSystemAppAgentEvent({ event: pushed, deliverer }), false);
  assert.equal(delivered.length, 0);
  assert.equal(await statusOf(pushed.id), "queued", "the first push's claim is released");

  const first = await event(f, "one", { allow: true });
  const second = await event(f, "two", { allow: true });
  assert.deepEqual(await sweptTargets(app, f, orchestrator), []);
  const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(pulled.status, 200, pulled.raw);
  for (const e of [pushed, first, second]) {
    assert.ok(!pulled.raw.includes(e.id));
    assert.equal(await statusOf(e.id), "queued", "withheld, not expired");
  }
  assert.match(warnings[0]!, /system\.raftbench requires a delivery guard and none is registered; withholding 1 event\(s\)/);
  assert.match(warnings[1]!, /system\.raftbench requires a delivery guard and none is registered; withholding 3 event\(s\)/);

  // E.g. a replica that predates the guard's deploy: once one with the guard
  // serves the agent, the events are delivered.
  registerGuard("payload");
  const recovered = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(recovered.status, 200, recovered.raw);
  for (const e of [pushed, first, second]) assert.ok(recovered.raw.includes(e.id), e.summary);
});

test("an event the guard leaves out of its verdicts is vetoed: withheld and expired", async ({ app }) => {
  registerGuard("partial");
  const f = await seedAgent();
  const orchestrator = freshProcess(app);

  // Empty verdict map on the first push.
  const pushed = await event(f, "push omitted", { allow: false });
  const { delivered, deliverer } = recordingDeliverer();
  assert.equal(await deliverSystemAppAgentEvent({ event: pushed, deliverer }), false);
  assert.equal(delivered.length, 0);
  assert.equal(await statusOf(pushed.id), "expired");

  // Partial map on the sweep and the pull.
  const answered = await event(f, "answered", { allow: true });
  const omitted = await event(f, "omitted", { allow: false });
  assert.deepEqual(await sweptTargets(app, f, orchestrator), [eventTarget(answered)]);
  assert.equal(await statusOf(omitted.id), "expired");
  const omittedAtPull = await event(f, "omitted at pull", { allow: false });
  const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(pulled.status, 200, pulled.raw);
  assert.ok(pulled.raw.includes(answered.id));
  assert.ok(!pulled.raw.includes(omitted.id) && !pulled.raw.includes(omittedAtPull.id));
  assert.equal(await statusOf(omittedAtPull.id), "expired");
  assert.deepEqual(warnings, []);
});

test("unguarded apps and OAuth-client rows are unchanged: no guard call, delivered as before", async ({ app }) => {
  registerGuard("throw");
  const f = await seedAgent();
  const orchestrator = freshProcess(app);

  const pushed = await event(f, "assistant push", { allow: false }, "system.assistant");
  const { delivered, deliverer } = recordingDeliverer();
  assert.equal(await deliverSystemAppAgentEvent({ event: pushed, deliverer }), true);
  assert.deepEqual(delivered.map((m) => m.message_id), [pushed.id]);
  await getDb().update(thirdPartyAgentEvents).set({ status: "delivered" }).where(eq(thirdPartyAgentEvents.id, pushed.id));

  const pending = await event(f, "assistant pending", { allow: false }, "system.assistant");
  assert.deepEqual(await sweptTargets(app, f, orchestrator), [eventTarget(pending)]);
  const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(pulled.status, 200, pulled.raw);
  assert.ok(pulled.raw.includes(pending.id));
  assert.equal(await statusOf(pending.id), "delivered");

  // An OAuth-client row (client_id set) is never handed to a guard.
  const oauthRow = { ...pending, clientId: randomUUID(), systemApp: null };
  const split = await partitionDeliverableSystemAppEvents([oauthRow], (row) => row);
  assert.deepEqual(split, { deliverable: [oauthRow], vetoed: [], withheld: [] });

  assert.deepEqual(guardCalls, []);
  assert.deepEqual(warnings, []);
});

test("agent-event:<id> re-read: a withheld system-app event answers exactly like an unknown id and keeps its row", async ({ app }) => {
  registerGuard();
  const f = await seedAgent();
  const read = async (target: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}`, {
      headers: { Authorization: `Bearer ${f.apiKey}` },
    });
    return { status: res.status, text: await res.text() };
  };
  const allowed = await event(f, "allowed notice", { allow: true });
  const withheld = await event(f, "withheld title and excerpt", { allow: false });
  const assistant = await event(f, "assistant notice", { allow: false }, "system.assistant");
  // Delivered before the recipient lost access.
  await getDb().update(thirdPartyAgentEvents).set({ status: "delivered", deliveredAt: new Date() }).where(eq(thirdPartyAgentEvents.agentId, f.agentId));

  const unknown = await read(`agent-event:${randomUUID()}`);
  assert.equal(unknown.status, 404, unknown.text);
  for (const target of [withheld.id, withheld.id.slice(0, 8)]) {
    // The bytes, not just the status: no distinguishable state.
    assert.deepEqual(await read(`agent-event:${target}`), unknown);
  }
  assert.equal(await statusOf(withheld.id), "delivered", "a re-read withholds, never expires");
  // The guard runs before the expiry check: a vetoed event that has also
  // expired is still the unknown-id answer, not EXPIRED (410).
  const expiredWithheld = await event(f, "expired withheld", { allow: false });
  await getDb().update(thirdPartyAgentEvents)
    .set({ status: "expired", expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(thirdPartyAgentEvents.id, expiredWithheld.id));
  assert.deepEqual(await read(`agent-event:${expiredWithheld.id}`), unknown);
  const expiredAllowed = await event(f, "expired allowed", { allow: true });
  await getDb().update(thirdPartyAgentEvents)
    .set({ status: "expired", expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(thirdPartyAgentEvents.id, expiredAllowed.id));
  assert.equal((await read(`agent-event:${expiredAllowed.id}`)).status, 410, "an allowed expired event still says so");
  const ok = await read(`agent-event:${allowed.id}`);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.text.includes("allowed notice"));

  // Fail closed: a throwing guard, or a required app without one, withholds too.
  unregister();
  registerGuard("throw");
  assert.deepEqual(await read(`agent-event:${allowed.id}`), unknown);
  assert.match(warnings.at(-1)!, /system\.raftbench delivery guard failed; withholding 1 event\(s\)/);
  unregister();
  unregister = () => {};
  assert.deepEqual(await read(`agent-event:${allowed.id}`), unknown);
  assert.match(warnings.at(-1)!, /system\.raftbench requires a delivery guard and none is registered/);
  assert.equal(await statusOf(allowed.id), "delivered");

  // Unguarded apps and OAuth-client rows read as before.
  registerGuard("throw");
  guardCalls = [];
  const assistantRead = await read(`agent-event:${assistant.id}`);
  assert.equal(assistantRead.status, 200, assistantRead.text);
  assert.ok(assistantRead.text.includes("assistant notice"));
  const { client } = await createOAuthClient({
    serverId: f.serverId,
    createdByUserId: f.ownerId,
    clientId: `guard-${randomUUID().slice(0, 8)}`,
    name: "Guard OAuth Client",
    allowedScopes: ["openid", "agent:event:write", "agent:notification:write"],
  });
  const [oauthRow] = await getDb().insert(thirdPartyAgentEvents).values({
    serverId: f.serverId,
    agentId: f.agentId,
    clientId: client.id,
    kind: "notification",
    summary: "oauth notice",
    payload: {},
    payloadHash: "0".repeat(64),
    resource: `urn:raft:server:${f.serverId}:agent-inbound`,
    status: "delivered",
    expiresAt: new Date(Date.now() + 60 * 60_000),
  }).returning();
  const oauthRead = await read(`agent-event:${oauthRow!.id}`);
  assert.equal(oauthRead.status, 200, oauthRead.text);
  assert.ok(oauthRead.text.includes("oauth notice"));
  assert.deepEqual(guardCalls, []);
});
