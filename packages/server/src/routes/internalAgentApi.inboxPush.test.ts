import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// External Agent inbox notice push (raft-agent-inbox-notice.v1) and `/events`
// cursor acks.
//
// Pins:
//   1. registration is agent-self, External-only, secret supplied by the
//      receiver, validated, stored encrypted and never returned;
//   2. a delivery to the agent's inbox is announced at once by a signed notice
//      (targets + "Inbox update" text, no bodies), without reading the chain,
//      and the notice never moves the inbox cursor;
//   3. notices merge per agent while one is in flight / backing off; a retry
//      sends the latest merged state; replicas never coordinate;
//   4. 3 consecutive 404/410 disable, a run of 401s only at 3+ spanning 24 hours, 400
//      never disables, a new PUT re-enables; a stop tells the owner once (at
//      most once per 24 hours; never when the owner revoked the credential),
//      and the sweep probes a stopped endpoint (1 hour, doubling, capped at
//      24 hours, giving up after 30 days) and re-enables it on a 2xx; the sweep re-announces unread a notice never reached, and
//      reminds once per pending state of unread still pending once the last
//      notice is stale;
//   5. `/events?ack=cursor` acknowledges on the next request's `since`;
//      `/events?wait_for=` waits for the chain to catch up to a notice
//      (whose targets carry `latestSeq`), then answers as without it, with
//      `retry_after_ms` while still behind;
//   6. a third-party app event (no durable row) is announced as its own
//      `agent-event:<id8>` target, once per event, never after it expires, by
//      the direct push and, when that notice was lost, by the sweep.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

import { BasicTracer, MemoryTraceSink, type AgentMessage } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { traceAgentIdHash, traceServerIdHash } from "../tracing/traceIdentity";
import { agentInboxPushRegistrations, agents, assistantDoorbells, assistantDoorbellSources, featureFlags, messages, servers, serverSsoConnections, serverSsoDomains, tasks, thirdPartyAgentEvents, threadFollows, users } from "../db/schema";
import { ASSISTANT_DOORBELL_COALESCE_MS, drainAssistantDoorbells, recordAssistantOwnerTaskAction, setAssistantReadsDms } from "../services/assistantService";
import { mutateMessageReaction } from "../services/messageReactionService";
import { createFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, SERVER_SSO_FEATURE_FLAG_KEY, SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { forgetSsoRequirementCache } from "../services/sso/ssoEnforcement";
import { proofForSsoLogin } from "../services/sessionIssueGate";
import { createSession } from "../services/sessionService";
import { listAgentAppEvents } from "../services/agentAppEventsService";
import { createOAuthClient, requestAgentAccess } from "../services/oauthService";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, findOrCreateDM, findOrCreateUserDM, getAgentLegacyReadCursor, getOrCreateThread, type AgentInboxChainSelection } from "../services/channelService";
import {
  createMessage,
  __setExternalAgentInboxChainSelectorForTests,
} from "../services/messageService";
import { mintAgentCredential, revokeAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService";
import { recordAgentInboxEventsPendingAck } from "../services/agentInboxEvents";
import { __setAppWebhookEncryptionKeyForTests } from "../services/appWebhookConfigService";
import {
  AGENT_INBOX_NOTICE_DIRECT_LEASE_MS,
  AGENT_INBOX_NOTICE_POST_TIMEOUT_MS,
  AGENT_INBOX_NOTICE_REMIND_AFTER_MS,
  AGENT_INBOX_PUSH_BAD_REQUEST_RETRY_DELAYS_MS,
  AGENT_INBOX_PUSH_PROBE_FIRST_DELAY_MS,
  AgentInboxPendingNotice,
  agentInboxPushNextProbeBackoffMs,
  agentInboxPushRetryDelayMs,
  probeDisabledAgentInboxPushRegistrations,
  sendAgentInboxNotice,
  startAgentInboxPushWorker,
  sweepAgentInboxNotices,
  type AgentInboxNotice,
  type AgentInboxPushPausedCause,
} from "../services/agentInboxPushService";
import { WebhookPostError, type WebhookPost } from "../services/appNotificationDeliveryService";
import { __setAgentEventsWaitForDepsForTests } from "./agentEventsWaitFor";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// `chainReads` counts inbox chain reads per agent: the notice hot path makes none.
const chainReads = new Map<string, number>();
__setExternalAgentInboxChainSelectorForTests(async (agentId: string): Promise<AgentInboxChainSelection> => {
  chainReads.set(agentId, (chainReads.get(agentId) ?? 0) + 1);
  return { source: "chain", rows: await referenceAgentInboxChain(agentId) };
});
__setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));

const SECRET = "Q2hvb3NlLWEtcmFuZG9tLXNlY3JldC1vZi0zMi1ieXRlcw_x"; // 47 base64url chars
const URL_A = "https://receiver.example.com/raft/inbox";

async function seedAgent(runtime: "external" | "claude" = "external", options: { owned?: boolean } = {}) {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `inbox-push-${suffix}@slock.test`,
    name: `inbox-push-${suffix}`,
    displayName: "Inbox Push Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Inbox Push Test", `inbox-push-${suffix}`, owner!.id);
  const creator = options.owned ? { creatorType: "user" as const, creatorId: owner!.id } : {};
  const agent = await createAgent(server.id, `PushExt${suffix.slice(0, 6)}`, runtime === "external"
    ? { runtime: "external", model: "external", ...creator }
    : { runtime: "claude", model: "sonnet", ...creator });
  const channel = await createChannel(server.id, `inbox-push-room-${suffix.slice(0, 6)}`);
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "inbox-push-test", issuedVia: "computer", createdByUserId: null });
  return {
    ownerId: owner!.id,
    serverId: server.id,
    channelId: channel.id,
    channelName: channel.name,
    agentId: agent.id,
    apiKey: minted.apiKey,
    credentialId: minted.credentialId,
  };
}

type Fixture = Awaited<ReturnType<typeof seedAgent>>;

async function sendHumanMessage(f: Fixture, content: string) {
  const message = await createMessage(f.channelId, "user", f.ownerId, content);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: f.agentId,
    serverId: f.serverId,
    kind: "channel",
    sourceChannelId: f.channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);
  return message;
}

function freshProcess(app: { app: { set: (key: string, value: unknown) => void } }) {
  const orchestrator = new AgentOrchestrator() as any;
  app.app.set("agentOrchestrator", orchestrator);
  return orchestrator as AgentOrchestrator;
}

async function api(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

async function register(app: { baseUrl: string }, f: Fixture, url = URL_A, secret = SECRET) {
  const res = await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url, secret });
  assert.equal(res.status, 200, res.raw);
  return res.body;
}

type Posted = { endpointUrl: string; body: string; headers: Record<string, string>; notice: AgentInboxNotice };

function recorder(responses: Array<Awaited<ReturnType<WebhookPost>> | Error>) {
  const posted: Posted[] = [];
  let index = 0;
  const post: WebhookPost = async (input) => {
    posted.push({ ...input, notice: JSON.parse(input.body) });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  return { posted, post };
}

/** A clock `offsetMs` ahead of real time (the registration timestamps are real time). */
function clockAt(offsetMs: number) {
  return () => new Date(Date.now() + offsetMs);
}

async function registrationRow(agentId: string) {
  const [row] = await getDb().select().from(agentInboxPushRegistrations).where(eq(agentInboxPushRegistrations.agentId, agentId));
  return row!;
}

/** The AgentMessage the orchestrator hands over when it delivers a persisted message to the inbox. */
function delivered(f: Fixture, message: { id: string; seq: number; content: string; createdAt: Date }, extra: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: f.channelId,
    channel_name: f.channelName,
    channel_type: "channel",
    sender_id: f.ownerId,
    sender_name: "owner",
    sender_type: "human",
    content: message.content,
    timestamp: message.createdAt.toISOString(),
    seq: message.seq,
    message_id: message.id,
    ...extra,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "condition not reached in time");
}

async function withWorker<T>(
  orchestrator: AgentOrchestrator,
  post: WebhookPost,
  run: (worker: ReturnType<typeof startAgentInboxPushWorker>) => Promise<T>,
  options: Partial<Parameters<typeof startAgentInboxPushWorker>[0]> = {},
): Promise<T> {
  const worker = startAgentInboxPushWorker({
    agentOrchestrator: orchestrator,
    post,
    sweepIntervalMs: 60 * 60_000,
    tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
    ...options,
  });
  try {
    return await run(worker);
  } finally {
    worker.stop();
  }
}

test("registration: agent-self PUT/GET/DELETE, receiver secret validated and never returned", async ({ app }) => {
  const f = await seedAgent();

  for (const [body, code] of [
    [{ url: URL_A, secret: "short" }, "INVALID_SECRET"],
    [{ url: URL_A, secret: "a".repeat(64) }, "INVALID_SECRET"],
    [{ url: URL_A, secret: "0123456789abcdef".repeat(3) }, "INVALID_SECRET"],
    [{ url: "http://receiver.example.com/x", secret: SECRET }, "INVALID_URL"],
    [{ url: "https://127.0.0.1/x", secret: SECRET }, "INVALID_URL"],
    [{ url: URL_A, secret: SECRET, extra: true }, "INVALID_BODY"],
  ] as const) {
    const res = await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, code);
  }
  assert.equal((await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url: URL_A, secret: "0123456789abcdef".repeat(4) })).status, 200, "64 hex chars");

  const status = await register(app, f);
  assert.equal(status.registered, true);
  assert.equal(status.url, URL_A);
  assert.equal(status.enabled, true);
  assert.equal(status.consecutiveFailures, 0);
  const got = await api(app.baseUrl, f.apiKey, "GET", "/push-webhook");
  assert.equal(got.status, 200);
  assert.deepEqual(Object.keys(got.body).sort(), [
    "consecutiveFailures", "disabledAt", "disabledReason", "enabled", "lastAttemptAt", "lastDeliveryAt", "lastError", "nextAttemptAt", "probeStoppedAt", "recovery", "registered", "url",
  ]);
  assert.ok(!got.raw.includes(SECRET), "the secret is never returned");
  const row = await registrationRow(f.agentId);
  assert.ok(!JSON.stringify(row).includes(SECRET), "the secret is stored encrypted");
  assert.equal(row.credentialId, f.credentialId, "bound to the calling credential");

  assert.equal((await api(app.baseUrl, f.apiKey, "DELETE", "/push-webhook")).status, 204);
  assert.equal((await api(app.baseUrl, f.apiKey, "GET", "/push-webhook")).body.registered, false);
});

test("registration: a managed agent is refused (it uses the daemon transport)", async ({ app }) => {
  const f = await seedAgent("claude");
  const res = await api(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url: URL_A, secret: SECRET });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "AGENT_NOT_EXTERNAL");
});


test("notice: a delivery is announced at once, signed, with targets and text, no bodies, no chain read, no cursor move", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "secret body text");
  const cursorBefore = await getAgentLegacyReadCursor(f.agentId, f.channelId);
  const readsBefore = chainReads.get(f.agentId) ?? 0;
  const rec = recorder([{
    status: 200,
    requestId: "rcv-req-7f3a",
    timing: { dnsMs: 12, connectMs: 41, tlsMs: 96, ttfbMs: 612, socketReused: false },
  }]);
  const sink = new MemoryTraceSink();
  await withWorker(orchestrator, rec.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1, { mentioned: true }));
    await waitFor(() => rec.posted.length === 1);
    await worker.idle();
  }, { tracer: new BasicTracer({ sink }) });

  assert.equal(chainReads.get(f.agentId) ?? 0, readsBefore, "the hot path never reads the inbox chain");
  const [posted] = rec.posted;
  const notice = posted!.notice;
  assert.deepEqual(Object.keys(notice).sort(), ["noticeId", "occurredAt", "recipientAgentId", "schema", "targets", "text"]);
  assert.equal(notice.schema, "raft-agent-inbox-notice.v1");
  assert.equal(notice.recipientAgentId, f.agentId);
  assert.equal(posted!.headers["x-raft-delivery-id"], notice.noticeId);
  assert.equal(posted!.headers["x-raft-signature-256"], `sha256=${createHmac("sha256", SECRET).update(posted!.body).digest("hex")}`);
  assert.deepEqual(notice.targets, [{
    target: `#${f.channelName}`,
    channelId: f.channelId,
    channelType: "channel",
    pendingCount: 1,
    firstPendingMsgId: m1.id,
    latestMsgId: m1.id,
    latestSeq: String(m1.seq),
    latestSenderName: "owner",
    latestSenderType: "human",
    flags: ["mention"],
  }]);
  assert.match(notice.text, /^Inbox update: 1 changed target\n#inbox-push-room-/);
  assert.ok(!posted!.body.includes("secret body text"), "no message bodies");
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), cursorBefore, "a notice moves no cursor");
  const status = (await api(app.baseUrl, f.apiKey, "GET", "/push-webhook")).body;
  assert.ok(status.lastDeliveryAt);
  assert.equal(status.consecutiveFailures, 0);

  const span = sink.getAllSpans().find((candidate) => candidate.name === "server.agent_push.notice");
  assert.equal(span?.attrs?.mode, "direct");
  assert.equal(span?.attrs?.outcome, "delivered");
  assert.equal(span?.attrs?.http_status, 200);
  assert.equal(span?.attrs?.targets_count, 1);
  assert.equal(typeof span?.attrs?.latency_ms, "number");
  // Correlation: the notice carries this span's trace id; the receiver's request id lands on the span.
  assert.equal(posted!.headers["x-raft-trace-id"], span?.context.traceId);
  assert.match(posted!.headers["x-raft-trace-id"] ?? "", /^[0-9a-f]{32}$/);
  assert.equal(span?.attrs?.["push.response_request_id"], "rcv-req-7f3a");
  // Where the POST's time went (cumulative ms): DNS, connect, TLS, first byte.
  assert.equal(span?.attrs?.["push.dns_ms"], 12);
  assert.equal(span?.attrs?.["push.connect_ms"], 41);
  assert.equal(span?.attrs?.["push.tls_ms"], 96);
  assert.equal(span?.attrs?.["push.ttfb_ms"], 612);
  assert.equal(span?.attrs?.["push.socket_reused"], false);
  // Grouping by agent without the raw id: the keyed hash, never agentId itself.
  assert.match(String(span?.attrs?.agent_id_hash), /^[0-9a-f]{16}$/);
  assert.equal(span?.attrs?.agent_id_hash, traceAgentIdHash(f.agentId));
  assert.equal(span?.attrs?.server_id_hash, traceServerIdHash(f.serverId));
  const raw = JSON.stringify(span);
  assert.ok(!raw.includes("receiver.example.com") && !raw.includes("secret body") && !raw.includes(SECRET), "no URL, content or secret in trace");
  assert.ok(!raw.includes(f.agentId), "no raw agent id in trace");
  assert.ok(!raw.includes(f.serverId), "no raw server id in trace");
});

test("notice: deliveries while a notice is in flight merge into the next one", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const [m1, m2, m3] = [await sendHumanMessage(f, "one"), await sendHumanMessage(f, "two"), await sendHumanMessage(f, "three")];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posted: AgentInboxNotice[] = [];
  const post: WebhookPost = async (input) => {
    posted.push(JSON.parse(input.body));
    if (posted.length === 1) await gate;
    return { status: 200 };
  };
  await withWorker(orchestrator, post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => posted.length === 1);
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m2));
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(posted.length, 1, "one notice in flight per agent");
    release();
    await waitFor(() => posted.length === 2);
    await worker.idle();
  });
  assert.equal(posted[0]!.targets[0]!.pendingCount, 1);
  const merged = posted[1]!.targets[0]!;
  assert.equal(merged.pendingCount, 2);
  assert.equal(merged.firstPendingMsgId, m2.id);
  assert.equal(merged.latestMsgId, m3.id);
  assert.equal(merged.latestSeq, String(m3.seq), "the merged row's latest seq, for /events wait_for");
});

test("notice: two replicas notify independently (harmless duplicates, no coordination)", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const replicaA = new AgentOrchestrator();
  const replicaB = new AgentOrchestrator();
  const m1 = await sendHumanMessage(f, "on a");
  const m2 = await sendHumanMessage(f, "on b");
  const rec = recorder([{ status: 200 }]);
  await withWorker(replicaA, rec.post, (workerA) => withWorker(replicaB, rec.post, async (workerB) => {
    replicaA.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    replicaB.emit("external-inbox-delivered", f.agentId, delivered(f, m2));
    await waitFor(() => rec.posted.length === 2);
    await workerA.idle();
    await workerB.idle();
  }));
  assert.deepEqual(rec.posted.map((p) => p.notice.targets[0]!.latestMsgId).sort(), [m1.id, m2.id].sort());
  assert.equal((await registrationRow(f.agentId)).consecutiveFailures, 0);
});

test("notice: 5xx backs off and the retry sends the latest merged state", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "first");
  const m2 = await sendHumanMessage(f, "second");
  const rec = recorder([{ status: 503 }, { status: 200 }]);
  let offsetMs = 0;
  await withWorker(orchestrator, rec.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => rec.posted.length === 1);
    await waitFor(() => (rec.posted.length === 1));
    const row = await waitForRow(f.agentId, (r) => r.consecutiveFailures === 1);
    assert.equal(row.lastError, "http_503");
    // Arrives during the backoff: merged, not sent on its own.
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rec.posted.length, 1);
    offsetMs = 60_000; // the backoff is over when the retry timer fires
    await waitFor(() => rec.posted.length === 2);
    await worker.idle();
  }, { clock: () => new Date(Date.now() + offsetMs), retryTimerMs: () => 100 });
  const retried = rec.posted[1]!.notice.targets[0]!;
  assert.equal(retried.pendingCount, 2, "the failed rows and the newer one");
  assert.equal(retried.firstPendingMsgId, m1.id);
  assert.equal(retried.latestMsgId, m2.id);
  assert.notEqual(rec.posted[1]!.notice.noticeId, rec.posted[0]!.notice.noticeId);
  assert.equal((await registrationRow(f.agentId)).consecutiveFailures, 0);
});

async function waitForRow(agentId: string, predicate: (row: Awaited<ReturnType<typeof registrationRow>>) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await registrationRow(agentId);
    if (predicate(row) || Date.now() > deadline) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("notice: 3 consecutive 404/410 disable; 400 and 401 never count; a new PUT re-enables", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "one");
  const rec = recorder([{ status: 404 }, { status: 400 }, { status: 410 }, { status: 401 }, { status: 404 }, { status: 410 }, { status: 404 }]);
  let offsetMs = 0;
  await withWorker(orchestrator, rec.post, async () => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    for (let sent = 1; sent <= 6; sent += 1) {
      await waitFor(() => rec.posted.length === sent);
      await waitForRow(f.agentId, (row) => row.consecutiveFailures === sent || row.disabledAt !== null);
      offsetMs += 7 * 60 * 60_000; // past any backoff, 400's included
    }
    await waitForRow(f.agentId, (row) => row.disabledAt !== null);
  }, { clock: () => new Date(Date.now() + offsetMs), retryTimerMs: () => 20 });
  const status = (await api(app.baseUrl, f.apiKey, "GET", "/push-webhook")).body;
  // 404 then 400 (breaks the run), 410 then 401 (breaks it too), then 404,
  // 410, 404: the third in a row disables.
  assert.equal(rec.posted.length, 7);
  assert.equal(status.enabled, false);
  assert.equal(status.disabledReason, "endpoint_rejected");
  const reenabled = await register(app, f);
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.consecutiveFailures, 0);
});

test("400: recorded as lastError, retried on the long schedule, never disables", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "one");
  const rec = recorder([{ status: 400 }]);
  await withWorker(orchestrator, rec.post, async () => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => rec.posted.length === 1);
    const row = await waitForRow(f.agentId, (r) => r.consecutiveFailures === 1);
    assert.equal(row.lastError, "http_400");
    assert.equal(row.consecutiveRejections, 0);
    assert.equal(row.disabledAt, null);
    assert.ok(row.nextAttemptAt.getTime() >= Date.now() + AGENT_INBOX_PUSH_BAD_REQUEST_RETRY_DELAYS_MS[0]! - 5_000);
  });
});

test("POST is bounded: a hung receiver costs one timed-out attempt", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "one");
  const hung: WebhookPost = () => new Promise(() => undefined);
  const started = Date.now();
  await withWorker(orchestrator, hung, async () => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    const row = await waitForRow(f.agentId, (r) => r.consecutiveFailures === 1, 25_000);
    assert.equal(row.lastError, "timeout");
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= AGENT_INBOX_NOTICE_POST_TIMEOUT_MS - 500 && elapsed < AGENT_INBOX_NOTICE_POST_TIMEOUT_MS + 8_000, `bounded at ${elapsed} ms`);
}, 30_000);

test("sweep: unread written after the last delivered notice (a dropped notice) is announced; nothing new, no notice", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "notice for this was lost");
  const rec = recorder([{ status: 200 }]);
  const sink = new MemoryTraceSink();
  const first = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], tracer: new BasicTracer({ sink }) });
  assert.equal(first.sent, 1);
  assert.equal(rec.posted[0]!.notice.targets[0]!.latestMsgId, m1.id);
  assert.equal(rec.posted[0]!.notice.targets[0]!.latestSeq, String(m1.seq), "the sweep notice carries the seq too");
  const spans = sink.getAllSpans();
  assert.ok(spans.some((span) => span.name === "server.agent_push.sweep" && span.attrs?.sent === 1));
  assert.equal(spans.find((span) => span.name === "server.agent_push.notice")?.attrs?.mode, "sweep");
  assert.equal(spans.find((span) => span.name === "server.agent_push.notice")?.attrs?.reason, "new");

  const again = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] });
  assert.equal(again.sent, 0, "the unread was announced already");
  assert.equal(rec.posted.length, 1);
});

test("sweep: unread still pending after a stale notice (the pull beat the chain) is reminded once per pending state", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "notified, but the pull saw an empty chain");
  // The hot-path notice for m1 was delivered after m1 was written.
  await getDb().update(agentInboxPushRegistrations).set({ lastDeliveryAt: new Date(m1.createdAt.getTime() + 1) })
    .where(eq(agentInboxPushRegistrations.agentId, f.agentId));
  const rec = recorder([{ status: 200 }]);
  const sweep = (options: { remindAfterMs?: number; tracer?: BasicTracer } = {}) =>
    sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], ...options });

  const fresh = await sweep();
  assert.equal(fresh.checked, 1);
  assert.equal(fresh.sent, 0, `a notice fresher than ${AGENT_INBOX_NOTICE_REMIND_AFTER_MS} ms with nothing new is not repeated`);
  assert.equal(rec.posted.length, 0);

  // A short interval stands in for the default one, so the clock stays real.
  const remindAfterMs = 50;
  const elapse = () => new Promise((resolve) => setTimeout(resolve, remindAfterMs + 20));
  await elapse();
  const sink = new MemoryTraceSink();
  const reminded = await sweep({ remindAfterMs, tracer: new BasicTracer({ sink }) });
  assert.equal(reminded.sent, 1);
  assert.equal(rec.posted[0]!.notice.targets[0]!.latestMsgId, m1.id);
  const notice = sink.getAllSpans().find((span) => span.name === "server.agent_push.notice");
  assert.equal(notice?.attrs?.mode, "sweep");
  assert.equal(notice?.attrs?.reason, "remind");
  const remindedAt = (await registrationRow(f.agentId)).lastDeliveryAt!;
  assert.ok(remindedAt.getTime() > m1.createdAt.getTime() + 1, "the reminder moves lastDeliveryAt");

  // A stable backlog: silence across further sweeps, however many intervals pass.
  for (let i = 0; i < 4; i += 1) {
    await elapse();
    const later = await sweep({ remindAfterMs });
    assert.equal(later.sent, 0, "a pending state is reminded once");
  }
  assert.equal(rec.posted.length, 1);

  // New unread after that is a normal notice.
  const m2 = await sendHumanMessage(f, "new after the reminder");
  const newSink = new MemoryTraceSink();
  const announced = await sweep({ remindAfterMs, tracer: new BasicTracer({ sink: newSink }) });
  assert.equal(announced.sent, 1);
  assert.equal(rec.posted[1]!.notice.targets[0]!.latestMsgId, m2.id);
  assert.equal(newSink.getAllSpans().find((span) => span.name === "server.agent_push.notice")?.attrs?.reason, "new");
});

test("sweep: replicas sweeping at once send one reminder per pending state", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "pending while every replica sweeps");
  await getDb().update(agentInboxPushRegistrations).set({ lastDeliveryAt: new Date(m1.createdAt.getTime() + 1) })
    .where(eq(agentInboxPushRegistrations.agentId, f.agentId));
  const rec = recorder([{ status: 200 }, { status: 200 }, { status: 200 }, { status: 200 }]);
  const remindAfterMs = 50;
  await new Promise((resolve) => setTimeout(resolve, remindAfterMs + 20));
  // Four replicas sweep the same registration concurrently.
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], remindAfterMs })));
  assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 1);
  assert.equal(rec.posted.length, 1);
  assert.equal((await registrationRow(f.agentId)).remindedMaxSeq, Number(m1.seq));

  // A later sweep (any replica, e.g. one that just restarted) does not repeat it.
  await new Promise((resolve) => setTimeout(resolve, remindAfterMs + 20));
  const later = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], remindAfterMs });
  assert.equal(later.sent, 0);
  assert.equal(rec.posted.length, 1);
});

test("sweep: a second sweep during an in-flight sweep notice does not send it again", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  await sendHumanMessage(f, "notice for this was lost");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posted: string[] = [];
  const slowPost: WebhookPost = async (input) => {
    posted.push(input.body);
    await gate;
    return { status: 200 };
  };
  const first = sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: slowPost, agentIds: [f.agentId] });
  // Wait until the first sweep is mid-POST, then sweep again from "another replica".
  while (posted.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: slowPost, agentIds: [f.agentId] });
  assert.equal(second.sent, 0);
  release();
  assert.equal((await first).sent, 1);
  assert.equal(posted.length, 1);
  assert.equal((await registrationRow(f.agentId)).leaseExpiresAt, null, "the lease ends with the send");
});

/** A post that records each call and holds it until `release()`. */
function gatedPost() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posted: string[] = [];
  const post: WebhookPost = async (input) => {
    posted.push(input.body);
    await gate;
    return { status: 200 };
  };
  return { posted, post, release };
}

test("sweep: a direct notice in flight holds the registration; the sweep skips it", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "direct notice on a slow receiver");
  const direct = gatedPost();
  const rec = recorder([{ status: 200 }]);
  await withWorker(orchestrator, direct.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => direct.posted.length === 1);
    // Another replica's sweep sees unread with no delivered notice yet.
    const swept = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] });
    assert.equal(swept.sent, 0, "the direct notice is on the wire");
    assert.equal(rec.posted.length, 0);
    direct.release();
    await worker.idle();
  });
  assert.equal(direct.posted.length, 1);
  assert.equal((await registrationRow(f.agentId)).leaseExpiresAt, null, "the direct send hands its lease back");
});

test("sweep: once a stuck direct notice's lease expires, the sweep takes over", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "direct notice that never comes back");
  const direct = gatedPost();
  const rec = recorder([{ status: 200 }]);
  await withWorker(orchestrator, direct.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitFor(() => direct.posted.length === 1);
    // No cleanup ran (as after a crash); the sweep's clock is past the lease.
    const swept = await sweepAgentInboxNotices({
      agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId],
      clock: clockAt(AGENT_INBOX_NOTICE_DIRECT_LEASE_MS + 1_000),
    });
    assert.equal(swept.sent, 1);
    assert.equal(rec.posted[0]!.notice.targets[0]!.latestMsgId, m1.id);
    direct.release();
    await worker.idle();
  });
});

test("sweep: rows a cursor pull already handed over are neither re-announced nor reminded", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "handed over, not yet acknowledged");
  await recordAgentInboxEventsPendingAck(f.agentId, [Number(m1.seq)]);
  const rec = recorder([{ status: 200 }]);
  const remindAfterMs = 50;
  await new Promise((resolve) => setTimeout(resolve, remindAfterMs + 20));
  const swept = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], remindAfterMs });
  assert.equal(swept.sent, 0);
  assert.equal(rec.posted.length, 0);

  // Unread written after the hand-over is still announced.
  const m2 = await sendHumanMessage(f, "new after the pull");
  const next = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId], remindAfterMs });
  assert.equal(next.sent, 1);
  assert.equal(rec.posted[0]!.notice.targets[0]!.latestMsgId, m2.id);
});

test("credential revocation stops notices", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  await revokeAgentCredential({ credentialId: f.credentialId, reason: "test" });
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "after revoke");
  const rec = recorder([{ status: 200 }]);
  await withWorker(orchestrator, rec.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitForRow(f.agentId, (row) => row.disabledAt !== null);
    await worker.idle();
  });
  assert.equal(rec.posted.length, 0);
  assert.equal((await registrationRow(f.agentId)).disabledReason, "credential_revoked");
});

test("cross-agent isolation: a notice goes only to the recipient's own endpoint", async ({ app }) => {
  const a = await seedAgent();
  const b = await seedAgent();
  await register(app, a, "https://a.example.com/hook");
  await register(app, b, "https://b.example.com/hook", `${SECRET}B`);
  const orchestrator = freshProcess(app);
  const aMsg = await sendHumanMessage(a, "for a");
  const rec = recorder([{ status: 200 }]);
  await withWorker(orchestrator, rec.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", a.agentId, delivered(a, aMsg));
    await waitFor(() => rec.posted.length === 1);
    await worker.idle();
  });
  assert.equal(rec.posted[0]!.endpointUrl, "https://a.example.com/hook");
  assert.equal(rec.posted[0]!.notice.recipientAgentId, a.agentId);
  assert.equal((await api(app.baseUrl, b.apiKey, "GET", "/push-webhook")).body.url, "https://b.example.com/hook");
  assert.equal((await api(app.baseUrl, b.apiKey, "DELETE", "/push-webhook")).status, 204);
  assert.equal((await api(app.baseUrl, a.apiKey, "GET", "/push-webhook")).body.registered, true);
});

test("/events ack=cursor: a lost response is delivered again; the next since acknowledges it", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "one");
  const m2 = await sendHumanMessage(f, "two");
  const cursorBefore = await getAgentLegacyReadCursor(f.agentId, f.channelId);
  freshProcess(app);

  const first = await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
  assert.equal(first.body.ack_mode, "cursor");
  assert.deepEqual(first.body.events.map((e: any) => e.seq), [m1.seq, m2.seq]);
  assert.equal(first.body.last_seen_seq, m2.seq);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), cursorBefore, "not acknowledged by the response");

  // The response was lost: the client repeats its old cursor (none yet).
  const again = await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
  assert.deepEqual(again.body.events.map((e: any) => e.seq), [m1.seq, m2.seq], "delivered again");

  const m3 = await sendHumanMessage(f, "three");
  const next = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${again.body.last_seen_seq}`);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), m2.seq, "since acknowledged the previous batch");
  assert.deepEqual(next.body.events.map((e: any) => e.seq), [m3.seq]);
  // Lost again: repeating the same since re-delivers m3 and acknowledges nothing new.
  const repeat = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${again.body.last_seen_seq}`);
  assert.deepEqual(repeat.body.events.map((e: any) => e.seq), [m3.seq]);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), m2.seq);
  const done = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${repeat.body.last_seen_seq}`);
  assert.deepEqual(done.body.events, []);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), m3.seq);
});

test("/events without ack=cursor keeps the immediate ack published clients rely on", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "legacy");
  freshProcess(app);
  const first = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(first.body.ack_mode, "immediate");
  assert.deepEqual(first.body.events.map((e: any) => e.seq), [m1.seq]);
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), m1.seq);
  assert.deepEqual((await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest")).body.events, []);
  // A constant/stale numeric since (a published SDK caller) never loops either.
  const m2 = await sendHumanMessage(f, "legacy two");
  assert.deepEqual((await api(app.baseUrl, f.apiKey, "GET", "/events?since=0")).body.events.map((e: any) => e.seq), [m2.seq]);
  assert.deepEqual((await api(app.baseUrl, f.apiKey, "GET", "/events?since=0")).body.events, []);
});

/**
 * `/events?wait_for=`: the chain re-check is faked (`answers[i]` is the i-th
 * read's rows; the last repeats), and so are the clock and sleep, so no test
 * waits for real. The pull itself reads the reference chain as usual.
 */
function fakeChainWait(answers: Array<Array<{ targetId: string; latestSeq: number | null; inAgentInbox?: boolean; targetLatestSeq?: number | null }>>, opts: { overloaded?: boolean } = {}) {
  const reads: Array<readonly string[]> = [];
  const sleeps: number[] = [];
  let nowMs = 0;
  __setAgentEventsWaitForDepsForTests({
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    overloaded: () => opts.overloaded === true,
    readSeqs: async (_agentId, targetIds) => {
      reads.push(targetIds);
      return answers[Math.min(reads.length - 1, answers.length - 1)]!
        .map((row) => ({ inAgentInbox: true, targetLatestSeq: null, ...row, maxMentionSeq: null, lastReadSeq: 0 }));
    },
  });
  return { reads, sleeps };
}

test("/events wait_for: absent, the response is unchanged and the chain is not re-checked", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "no wait");
  freshProcess(app);
  const wait = fakeChainWait([[]]);
  try {
    const res = await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.body.events.map((e: any) => e.seq), [m1.seq]);
    assert.equal(res.body.has_more, false);
    assert.equal("retry_after_ms" in res.body, false);
    assert.deepEqual(wait.reads, []);
  } finally {
    __setAgentEventsWaitForDepsForTests({});
  }
});

test("/events wait_for: the chain catches up after one re-check, then the normal answer", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "lagging");
  freshProcess(app);
  const wait = fakeChainWait([[], [{ targetId: f.channelId, latestSeq: m1.seq }]]);
  try {
    const res = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&wait_for=${f.channelId}:${m1.seq}`);
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.body.events.map((e: any) => e.seq), [m1.seq]);
    assert.equal(res.body.has_more, false);
    assert.equal("retry_after_ms" in res.body, false);
    assert.deepEqual(wait.reads, [[f.channelId], [f.channelId]]);
    assert.deepEqual(wait.sleeps, [200]);
  } finally {
    __setAgentEventsWaitForDepsForTests({});
  }
});

test("/events wait_for: a thread notice waits on the thread's own channel id (not the parent), then delivers the reply", async ({ app }) => {
  const f = await seedAgent();
  const parent = await createMessage(f.channelId, "user", f.ownerId, "thread parent");
  const thread = await getOrCreateThread(parent.id, f.ownerId, "user");
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: f.agentId,
    parentMessageId: parent.id,
    reason: "manual",
  });
  const reply = await createMessage(thread.id, "user", f.ownerId, "thread reply");
  freshProcess(app);
  // The chain row of a thread is keyed by the thread's own channel: behind first, then caught up.
  const wait = fakeChainWait([[], [{ targetId: thread.id, latestSeq: reply.seq }]]);
  try {
    const res = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&wait_for=${thread.id}:${reply.seq}`);
    assert.equal(res.status, 200, res.raw);
    assert.ok(res.body.events.some((e: any) => e.message_id === reply.id), "the thread reply is delivered");
    assert.equal("retry_after_ms" in res.body, false);
    assert.deepEqual(wait.reads, [[thread.id], [thread.id]], "re-checks the thread's row, not the parent channel's");
  } finally {
    __setAgentEventsWaitForDepsForTests({});
  }
});

test("/events wait_for: the agent already read the conversation (no agent row) and the chain holds it: immediate, no retry_after_ms", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "read elsewhere");
  freshProcess(app);
  const wait = fakeChainWait([[{ targetId: f.channelId, latestSeq: null, inAgentInbox: false, targetLatestSeq: m1.seq }]]);
  try {
    const res = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&wait_for=${f.channelId}:${m1.seq}`);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.has_more, false);
    assert.equal("retry_after_ms" in res.body, false);
    assert.deepEqual(wait.reads, [[f.channelId]], "one check");
    assert.deepEqual(wait.sleeps, [], "no wait");
  } finally {
    __setAgentEventsWaitForDepsForTests({});
  }
});

test("/events wait_for: still behind at the cap, what was found plus has_more and retry_after_ms; cursor acks unchanged", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "in the chain");
  freshProcess(app);
  // The notice is for a message the chain does not hold yet (seq beyond m1).
  const behind = m1.seq + 1_000;
  const wait = fakeChainWait([[{ targetId: f.channelId, latestSeq: m1.seq }]]);
  const cursorBefore = await getAgentLegacyReadCursor(f.agentId, f.channelId);
  try {
    const first = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&wait_for=${f.channelId}:${behind}`);
    assert.equal(first.status, 200, first.raw);
    assert.deepEqual(first.body.events.map((e: any) => e.seq), [m1.seq], "the events found are returned");
    assert.equal(first.body.has_more, true);
    assert.equal(first.body.retry_after_ms, 1_000);
    assert.equal(first.body.last_seen_seq, m1.seq);
    assert.deepEqual(wait.sleeps, [200, 400, 800, 1_600, 3_000], "backoff up to the 6 s cap");
    assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), cursorBefore, "a cursor batch is not acked by its own response");

    // The retry: since acknowledges the previous batch as without wait_for.
    const retry = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${first.body.last_seen_seq}&wait_for=${f.channelId}:${behind}&wait_attempt=1`);
    assert.equal(retry.status, 200, retry.raw);
    assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), m1.seq, "since acknowledged the previous batch");
    assert.deepEqual(retry.body.events, []);
    assert.equal(retry.body.retry_after_ms, 2_000, "the server backs off from wait_attempt");
    // Later retries: 4000, then 8000 at most.
    for (const [attempt, expected] of [[2, 4_000], [3, 8_000], [4, 8_000]] as const) {
      const later = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${first.body.last_seen_seq}&wait_for=${f.channelId}:${behind}&wait_attempt=${attempt}`);
      assert.equal(later.body.retry_after_ms, expected, `wait_attempt=${attempt}`);
    }
  } finally {
    __setAgentEventsWaitForDepsForTests({});
  }
});

test("/events wait_for: a pair at or below since needs no wait and no chain read", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "already handed over");
  freshProcess(app);
  const wait = fakeChainWait([[]]);
  try {
    const res = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${m1.seq}&wait_for=${f.channelId}:${m1.seq}`);
    assert.equal(res.status, 200, res.raw);
    assert.equal("retry_after_ms" in res.body, false);
    assert.equal(res.body.has_more, false);
    assert.deepEqual(wait.reads, []);
    assert.deepEqual(wait.sleeps, []);
  } finally {
    __setAgentEventsWaitForDepsForTests({});
  }
});

test("/events wait_for: RisingWave overloaded, no wait and no re-check; retry_after_ms", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "overloaded");
  freshProcess(app);
  const wait = fakeChainWait([[]], { overloaded: true });
  try {
    const res = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&wait_for=${f.channelId}:${m1.seq + 1_000}&wait_attempt=0`);
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.body.events.map((e: any) => e.seq), [m1.seq]);
    assert.equal(res.body.has_more, true);
    assert.equal(res.body.retry_after_ms, 8_000, "the longest backoff whatever the attempt");
    assert.deepEqual(wait.reads, []);
    assert.deepEqual(wait.sleeps, []);
  } finally {
    __setAgentEventsWaitForDepsForTests({});
  }
});

test("/events wait_for: a pair the pull found anyway is satisfied, even when the wait was skipped", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "pull has it");
  freshProcess(app);
  fakeChainWait([[]], { overloaded: true });
  try {
    const res = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&wait_for=${f.channelId}:${m1.seq}`);
    assert.deepEqual(res.body.events.map((e: any) => e.seq), [m1.seq]);
    assert.equal(res.body.has_more, false);
    assert.equal("retry_after_ms" in res.body, false);
  } finally {
    __setAgentEventsWaitForDepsForTests({});
  }
});

test("/events wait_for: at the per-process waiter limit, no wait; retry_after_ms", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "busy process");
  freshProcess(app);
  const wait = fakeChainWait([[]]);
  const previous = process.env.AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_WAITERS;
  process.env.AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_WAITERS = "0";
  try {
    const res = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&wait_for=${f.channelId}:${m1.seq + 1_000}`);
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.has_more, true);
    assert.equal(res.body.retry_after_ms, 8_000);
    assert.equal(wait.reads.length, 1, "one check, then no waiting");
    assert.deepEqual(wait.sleeps, []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_WAITERS;
    else process.env.AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_WAITERS = previous;
    __setAgentEventsWaitForDepsForTests({});
  }
});

test("/events wait_for / wait_attempt: malformed is a 400 before anything is acknowledged", async ({ app }) => {
  const f = await seedAgent();
  const m1 = await sendHumanMessage(f, "bad param");
  freshProcess(app);
  await api(app.baseUrl, f.apiKey, "GET", "/events?ack=cursor");
  const cursorBefore = await getAgentLegacyReadCursor(f.agentId, f.channelId);
  const tooMany = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}:1`).join(",");
  for (const bad of [`${f.channelId}`, `${f.channelId}:abc`, `#general:5`, tooMany]) {
    const res = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${m1.seq}&wait_for=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.code, "wait_for_invalid");
  }
  for (const bad of ["-1", "1.5", "abc"]) {
    const res = await api(app.baseUrl, f.apiKey, "GET", `/events?ack=cursor&since=${m1.seq}&wait_for=${f.channelId}:${m1.seq}&wait_attempt=${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.code, "wait_attempt_invalid");
  }
  assert.equal(await getAgentLegacyReadCursor(f.agentId, f.channelId), cursorBefore, "a rejected request acknowledges nothing");
});

/** An app on the agent's Server with an agent token allowed to write notifications to it. */
async function appWithAgentToken(app: { baseUrl: string }, f: Fixture) {
  const suffix = randomUUID().slice(0, 8);
  const { client, clientSecret } = await createOAuthClient({
    serverId: f.serverId,
    createdByUserId: f.ownerId,
    clientId: `push-app-${suffix}`,
    name: "Push Reminder App",
    returnUrl: "https://reminder.example.test/callback",
    allowedScopes: ["openid", "profile", "agent:notification:write"],
  });
  const [server] = await getDb().select({ slug: servers.slug }).from(servers).where(eq(servers.id, f.serverId));
  // The assistant logs in to the App itself (`raft integration login`, the
  // agent-initiated request). An App asking for it by id never finds it: an
  // installed App is never a personal assistant's owner (#13520).
  const { request } = await requestAgentAccess({
    clientId: client.id,
    serverSlug: server!.slug,
    agentId: f.agentId,
    scopes: ["openid", "profile", "agent:notification:write"],
    initiatedByAgent: true,
  });
  const response = await fetch(`${app.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret,
      grantType: "urn:slock:grant-type:agent_request",
      requestId: request.id,
      resource: `urn:raft:server:${f.serverId}:agent-inbound`,
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return { client, accessToken: (await response.json() as { access_token: string }).access_token };
}

async function insertAppEvent(f: Fixture, clientId: string, expiresAt: Date) {
  const [event] = await getDb().insert(thirdPartyAgentEvents).values({
    serverId: f.serverId,
    agentId: f.agentId,
    clientId,
    kind: "notification",
    summary: "Reminder: stand-up",
    payload: {},
    payloadHash: "hash",
    resource: "test",
    expiresAt,
  }).returning();
  return event!;
}

test("app event: an external agent woken by nothing else gets exactly one notice, addressed agent-event:<id8>", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const { accessToken } = await appWithAgentToken(app, f);
  const rec = recorder([{ status: 200 }]);
  let eventId = "";
  await withWorker(orchestrator, rec.post, async (worker) => {
    const write = await fetch(`${app.baseUrl}/api/oauth/agent-events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "notification", summary: "Reminder: stand-up in 5 minutes" }),
    });
    assert.equal(write.status, 202, await write.clone().text());
    eventId = (await write.json() as { id: string }).id;
    await waitFor(() => rec.posted.length === 1);
    await worker.idle();
  });

  const notice = rec.posted[0]!.notice;
  assert.deepEqual(notice.targets, [{
    target: `agent-event:${eventId.slice(0, 8)}`,
    pendingCount: 1,
    firstPendingMsgId: eventId,
    latestMsgId: eventId,
    latestSenderName: notice.targets[0]!.latestSenderName,
    latestSenderType: "third_party_app",
    flags: [],
  }]);
  assert.match(notice.text, new RegExp(`agent-event:${eventId.slice(0, 8)}`));
  assert.ok(!rec.posted[0]!.body.includes("stand-up in 5 minutes"), "no event body in the notice");

  // The sweep sees the event still unacknowledged, but it was announced.
  const swept = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] });
  assert.equal(swept.sent, 0);
  assert.equal(rec.posted.length, 1, "exactly one notice for one event");
});

test("app event: the sweep announces an event whose notice was lost, once, and never an expired one", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const { client } = await appWithAgentToken(app, f);
  await insertAppEvent(f, client.id, new Date(Date.now() - 1_000));
  const live = await insertAppEvent(f, client.id, new Date(Date.now() + 60 * 60_000));
  const rec = recorder([{ status: 200 }]);

  const first = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] });
  assert.equal(first.sent, 1);
  assert.deepEqual(rec.posted[0]!.notice.targets.map((target) => target.target), [`agent-event:${live.id.slice(0, 8)}`]);

  const again = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] });
  assert.equal(again.sent, 0, "announced already");
  const [row] = await getDb().select({ status: thirdPartyAgentEvents.status }).from(thirdPartyAgentEvents)
    .where(eq(thirdPartyAgentEvents.id, live.id));
  assert.equal(row?.status, "queued", "announcing never claims the event");
});

test("app event: one event is one row however often it is added, and an expired one drops out", () => {
  const message = (id: string, expiresAt: Date) => ({
    channel_id: "third-party-agent-events:agent",
    channel_name: "third-party-agent-events:agent",
    channel_type: "dm",
    sender_name: "reminder-app",
    sender_type: "third_party_app",
    message_id: id,
    timestamp: new Date().toISOString(),
    content: "",
    third_party_event: { id, kind: "notification", client_id: "reminder-app", client_name: "Reminder", external_event_id: null, payload_hash: "h", payload: {}, expires_at: expiresAt.toISOString(), source: {} },
  }) as unknown as AgentMessage;
  const live = "aaaaaaaa-0000-4000-8000-000000000001";
  const expiring = "bbbbbbbb-0000-4000-8000-000000000002";
  const pending = new AgentInboxPendingNotice();
  pending.addMessage(message(live, new Date(Date.now() + 60_000)));
  pending.addMessage(message(live, new Date(Date.now() + 60_000)));
  const other = new AgentInboxPendingNotice();
  other.addMessage(message(live, new Date(Date.now() + 60_000)));
  other.addMessage(message(expiring, new Date(Date.now() + 1_000)));
  pending.absorb(other);
  assert.deepEqual([...pending.rows.values()].map((row) => [row.target, row.pendingCount]).sort(), [
    ["agent-event:aaaaaaaa", 1],
    ["agent-event:bbbbbbbb", 1],
  ]);
  pending.dropExpired(Date.now() + 2_000);
  assert.deepEqual([...pending.rows.keys()], ["agent-event:aaaaaaaa"]);
});

test("backoff: transient failures retry at 5s, 15s, 1m, then every 5 minutes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((failures) => agentInboxPushRetryDelayMs(failures)), [
    5_000, 15_000, 60_000, 5 * 60_000, 5 * 60_000, 5 * 60_000, 5 * 60_000,
  ]);
});

test("a response timeout keeps the connect and TLS timings and records its phase; lastError stays timeout", async ({ app }) => {
  const f = await seedAgent();
  await register(app, f);
  const orchestrator = freshProcess(app);
  const m1 = await sendHumanMessage(f, "receiver accepts the connection and never answers");
  const silent: WebhookPost = async () => {
    throw new WebhookPostError(new Error("Webhook request timed out"), { dnsMs: 4, connectMs: 31, tlsMs: 88, socketReused: false }, "response");
  };
  const sink = new MemoryTraceSink();
  await withWorker(orchestrator, silent, async () => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    await waitForRow(f.agentId, (r) => r.consecutiveFailures === 1);
  }, { tracer: new BasicTracer({ sink }) });
  assert.equal((await registrationRow(f.agentId)).lastError, "timeout", "an existing lastError value, unchanged");
  const span = sink.getAllSpans().find((candidate) => candidate.name === "server.agent_push.notice");
  assert.equal(span?.attrs?.error_code, "timeout");
  assert.equal(span?.attrs?.["push.timeout_phase"], "response");
  assert.equal(span?.attrs?.["push.connect_ms"], 31);
  assert.equal(span?.attrs?.["push.tls_ms"], 88);
  assert.equal(span?.attrs?.["push.ttfb_ms"], null);
});

for (const [retryAfter, expectedMs] of [["30", 30_000], ["3600", 5 * 60_000]] as const) {
  test(`503 with Retry-After ${retryAfter}s retries after ${expectedMs / 1000}s (capped at 5 minutes)`, async ({ app }) => {
    const f = await seedAgent();
    await register(app, f);
    const orchestrator = freshProcess(app);
    const m1 = await sendHumanMessage(f, "receiver asks to come back later");
    const rec = recorder([{ status: 503, retryAfter }]);
    const before = Date.now();
    let row: Awaited<ReturnType<typeof registrationRow>> | undefined;
    await withWorker(orchestrator, rec.post, async () => {
      orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
      row = await waitForRow(f.agentId, (r) => r.consecutiveFailures === 1);
    });
    assert.equal(row!.lastError, "http_503");
    const waitMs = row!.nextAttemptAt.getTime() - before;
    assert.ok(waitMs >= expectedMs - 1_000 && waitMs <= expectedMs + 5_000, `next attempt in ${waitMs} ms`);
  });
}

// RFC 074 §2 assistant doorbell: a `system.assistant` event in the same table
// as app events, so it rides the same push, sweep and /events paths.
async function seedAssistant(app: { baseUrl: string }) {
  const f = await seedAgent();
  await getDb().update(agents).set({ assistantOwnerUserId: f.ownerId }).where(eq(agents.id, f.agentId));
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) {
    await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  } else {
    await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: true });
  }
  await register(app, f);
  return f;
}

async function ownerFact(f: Fixture, channelId: string, kind: "channel" | "dm" | "thread", extra: { unreadEligible?: boolean } = {}) {
  const message = await createMessage(channelId, "agent", f.agentId, `activity ${randomUUID().slice(0, 6)}`);
  await recordInboxNotificationFacts([{
    receiverType: "user",
    receiverId: f.ownerId,
    serverId: f.serverId,
    kind,
    sourceChannelId: channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: extra.unreadEligible ?? true,
  }]);
  return message;
}

async function pendingDoorbell(agentId: string) {
  const [row] = await getDb().select().from(assistantDoorbells).where(eq(assistantDoorbells.agentId, agentId));
  return row ?? null;
}

async function doorbellEvents(agentId: string) {
  return getDb().select().from(thirdPartyAgentEvents)
    .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.systemApp, "system.assistant")));
}

test("assistant doorbell: an owner inbox change pushes one agent-event notice; bursts merge for 30s", async ({ app }) => {
  const f = await seedAssistant(app);
  const orchestrator = freshProcess(app);
  const rec = recorder([{ status: 200 }]);

  await ownerFact(f, f.channelId, "channel");
  const second = await ownerFact(f, f.channelId, "channel");
  assert.ok(await pendingDoorbell(f.agentId), "the owner's fact rang the doorbell in its transaction");

  await withWorker(orchestrator, rec.post, async (worker) => {
    assert.equal(await drainAssistantDoorbells({ deliverer: orchestrator }), 1);
    await waitFor(() => rec.posted.length === 1);
    await worker.idle();
  });
  const [event] = await doorbellEvents(f.agentId);
  assert.ok(event);
  assert.equal(event.clientId, null);
  assert.equal(event.kind, "event");
  assert.equal(event.payload.type, "owner_inbox_updated");
  assert.equal(event.payload.owner_user_id, f.ownerId);
  // The ringing conversation with its highest seq: the assistant's "caught up" check.
  assert.deepEqual(event.payload.sources, [{ channel_id: f.channelId, max_seq: second.seq, owner_action: false }]);
  assert.equal(event.payload.includes_owner_actions, false);
  assert.equal(event.status, "delivering");
  assert.deepEqual(rec.posted[0]!.notice.targets.map((target) => [target.target, target.latestSenderName, target.latestSenderType]), [
    [`agent-event:${event.id.slice(0, 8)}`, "system.assistant", "third_party_app"],
  ]);
  assert.equal(await pendingDoorbell(f.agentId), null);

  // More activity within 30 s waits for the window, then goes out as one.
  const third = await ownerFact(f, f.channelId, "channel");
  const fourth = await ownerFact(f, f.channelId, "channel");
  assert.ok(fourth.seq > third.seq);
  assert.equal(await drainAssistantDoorbells({ deliverer: orchestrator }), 0);
  assert.ok(await pendingDoorbell(f.agentId), "still pending inside the window");
  const later = new Date(event.createdAt.getTime() + ASSISTANT_DOORBELL_COALESCE_MS + 1_000);
  assert.equal(await drainAssistantDoorbells({ deliverer: orchestrator, now: later }), 1);
  const events = await doorbellEvents(f.agentId);
  assert.equal(events.length, 2);
  const merged = events.find((candidate) => candidate.id !== event.id)!;
  assert.deepEqual(merged.payload.sources, [{ channel_id: f.channelId, max_seq: fourth.seq, owner_action: false }], "only this window's changes, at their highest seq");
  assert.deepEqual(await getDb().select().from(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, f.agentId)), [], "sent with the doorbell");
});

test("an assistant a server admin paused is not woken (doorbell, notice, sweep) until its owner starts it again", async ({ app }) => {
  const f = await seedAssistant(app);
  const orchestrator = freshProcess(app);
  const rec = recorder([{ status: 200 }]);
  await getDb().update(agents).set({ assistantPausedAt: new Date(), assistantPausedByUserId: f.ownerId }).where(eq(agents.id, f.agentId));

  await ownerFact(f, f.channelId, "channel");
  assert.equal(await drainAssistantDoorbells({ deliverer: orchestrator }), 0);
  assert.equal(await pendingDoorbell(f.agentId), null, "the doorbell is dropped, not held for later");
  assert.deepEqual(await doorbellEvents(f.agentId), []);

  const message = await sendHumanMessage(f, "while paused");
  await withWorker(orchestrator, rec.post, async (worker) => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, message));
    await worker.idle();
  });
  assert.equal((await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] })).checked, 0);
  assert.equal(rec.posted.length, 0, "nothing woke it");
  assert.equal((await registrationRow(f.agentId)).disabledAt, null, "a pause is not a disable");

  // Its owner starts it again: the sweep announces what waited.
  await getDb().update(agents).set({ assistantPausedAt: null, assistantPausedByUserId: null }).where(eq(agents.id, f.agentId));
  assert.equal((await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] })).sent, 1);
  assert.equal(rec.posted[0]!.notice.targets.some((target) => target.latestMsgId === message.id), true);
});

test("an assistant whose owner's organization requires SSO is not woken while the owner has no SSO sign-in; it is once they sign in (RFC 083 §6.2)", async ({ app }) => {
  const f = await seedAssistant(app);
  const orchestrator = freshProcess(app);
  const rec = recorder([{ status: 200 }]);
  // The owner's employer (another Server) requires SSO for the owner's email domain; the platform reviewed it.
  for (const key of [SERVER_SSO_FEATURE_FLAG_KEY, SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY]) {
    await getDb().insert(featureFlags).values({ key, randomizationUnit: "server", salt: "test", defaultEnabled: true })
      .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: true } });
  }
  const [owner] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, f.ownerId));
  const [corpOwner] = await getDb().insert(users).values({ email: `corp-${randomUUID()}@elsewhere.test`, name: `corp-${randomUUID().slice(0, 8)}`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true }).returning();
  const corp = await createServer("Corp", `corp-${randomUUID().slice(0, 8)}`, corpOwner!.id);
  const [connection] = await getDb().insert(serverSsoConnections).values({
    serverId: corp.id, protocol: "oidc", status: "active", required: true, displayName: "Corp",
    config: { protocol: "oidc", issuer: "https://corp.okta.com", clientId: "raft" },
  }).returning();
  await getDb().insert(serverSsoDomains).values({ serverId: corp.id, domain: owner!.email.split("@")[1]!, verificationToken: randomUUID(), verifiedAt: new Date() });
  forgetSsoRequirementCache();
  try {
    const message = await sendHumanMessage(f, "while the owner is not signed in with SSO");
    await withWorker(orchestrator, rec.post, async (worker) => {
      orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, message));
      await worker.idle();
    });
    await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] });
    assert.equal(rec.posted.length, 0, "nothing woke it");
    assert.equal((await registrationRow(f.agentId)).disabledAt, null, "held like a pause, not a disable");

    const gate = await proofForSsoLogin(f.ownerId, connection!.id);
    assert.equal(gate.secondFactorRequired, false);
    if (!gate.secondFactorRequired) await createSession(gate.proof);
    assert.equal((await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] })).sent, 1, "signed in with SSO: the sweep announces what waited");
    assert.equal(rec.posted[0]!.notice.targets.some((target) => target.latestMsgId === message.id), true);
  } finally {
    await getDb().update(serverSsoConnections).set({ required: false }).where(eq(serverSsoConnections.id, connection!.id));
    forgetSsoRequirementCache();
  }
});

test("assistant doorbell sources: only conversations the owner can still see; a source orphaned by a claim rings in the next window", async ({ app }) => {
  const f = await seedAssistant(app);
  const orchestrator = freshProcess(app);
  const suffix = randomUUID().slice(0, 8);
  const hidden = await createChannel(f.serverId, `doorbell-hidden-${suffix}`, undefined, "private");

  const visible = await ownerFact(f, f.channelId, "channel");
  await ownerFact(f, hidden.id, "channel");
  assert.equal((await getDb().select().from(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, f.agentId))).length, 2);
  // Outside any request context (the poll), the send is still traced through the worker's tracer.
  const sink = new MemoryTraceSink();
  assert.equal(await drainAssistantDoorbells({ deliverer: orchestrator, tracer: new BasicTracer({ sink }) }), 1);
  const sentEvents = sink.getAllLogEvents().filter((event) => event.name === "server.assistant.doorbell.sent");
  assert.equal(sentEvents.length, 1);
  assert.equal(sentEvents[0]!.attrs?.source_count, 1);
  const [first] = await doorbellEvents(f.agentId);
  assert.deepEqual(first!.payload.sources, [{ channel_id: f.channelId, max_seq: visible.seq, owner_action: false }], "a conversation the owner cannot see is never listed");

  // A source written after its doorbell was claimed (no pending doorbell left) gets one.
  await getDb().insert(assistantDoorbellSources).values({ agentId: f.agentId, sourceChannelId: f.channelId, maxSeq: visible.seq + 1 });
  assert.equal(await pendingDoorbell(f.agentId), null);
  const later = new Date(first!.createdAt.getTime() + ASSISTANT_DOORBELL_COALESCE_MS + 1_000);
  assert.equal(await drainAssistantDoorbells({ deliverer: orchestrator, now: later }), 1);
  const events = await doorbellEvents(f.agentId);
  assert.equal(events.length, 2);
  assert.deepEqual(events.find((event) => event.id !== first!.id)!.payload.sources, [{ channel_id: f.channelId, max_seq: visible.seq + 1, owner_action: false }]);
});

test("assistant doorbell: DMs ring unless the owner turns DM reading off; its own DM and the owner's own sends never ring", async ({ app }) => {
  const f = await seedAssistant(app);
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [peer] = await db.insert(users).values({
    email: `doorbell-peer-${suffix}@slock.test`,
    name: `doorbell-peer-${suffix}`,
    displayName: "Peer",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  await addMember(f.serverId, peer!.id);
  const dm = await findOrCreateUserDM(f.serverId, f.ownerId, peer!.id);
  assert.ok(dm);
  const dmParent = await createMessage(dm.id, "user", peer!.id, "dm parent");
  const dmThread = await getOrCreateThread(dmParent.id, peer!.id, "user");

  // DM reading off: neither the DM nor its thread rings; nor does the owner's own send.
  await setAssistantReadsDms(f.agentId, false);
  await ownerFact(f, dm.id, "dm");
  await ownerFact(f, dmThread.id, "thread");
  await ownerFact(f, f.channelId, "channel", { unreadEligible: false });
  assert.equal(await pendingDoorbell(f.agentId), null);

  // The assistant's own DM with its owner never rings, whatever the switch says.
  await setAssistantReadsDms(f.agentId, true);
  const ownDm = await findOrCreateDM(f.serverId, f.ownerId, f.agentId);
  assert.ok(ownDm);
  await ownerFact(f, ownDm.id, "dm");
  assert.equal(await pendingDoorbell(f.agentId), null);

  // RFC 077, on (the default): the owner's DMs and threads under them ring, and are sources.
  await ownerFact(f, dm.id, "dm");
  await ownerFact(f, dmThread.id, "thread");
  assert.ok(await pendingDoorbell(f.agentId));
  const sourceIds = (await db.select().from(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, f.agentId))).map((row) => row.sourceChannelId);
  assert.deepEqual(sourceIds.sort(), [dm.id, dmThread.id].sort());
  // Turned off after they rang: the drain drops those sources, and with nothing left sends nothing.
  await setAssistantReadsDms(f.agentId, false);
  assert.equal(await drainAssistantDoorbells({ deliverer: freshProcess(app) }), 0);
  assert.equal(await pendingDoorbell(f.agentId), null);
  assert.equal((await doorbellEvents(f.agentId)).length, 0);

  // A thread under a channel does ring.
  const parent = await createMessage(f.channelId, "user", f.ownerId, "channel parent");
  const thread = await getOrCreateThread(parent.id, f.ownerId, "user");
  await ownerFact(f, thread.id, "thread");
  assert.ok(await pendingDoorbell(f.agentId));
});

test("assistant doorbell: a failed delivery stays queued; the sweep announces it and /events delivers it", async ({ app }) => {
  const f = await seedAssistant(app);
  const orchestrator = freshProcess(app);
  await ownerFact(f, f.channelId, "channel");
  const failing = { deliverMessage: async () => { throw new Error("replica gone"); } };
  assert.equal(await drainAssistantDoorbells({ deliverer: failing as never }), 1);
  const [event] = await doorbellEvents(f.agentId);
  assert.equal(event?.status, "queued", "released back to queued");

  const rec = recorder([{ status: 200 }]);
  const swept = await sweepAgentInboxNotices({ agentOrchestrator: orchestrator, post: rec.post, agentIds: [f.agentId] });
  assert.equal(swept.sent, 1);
  assert.deepEqual(rec.posted[0]!.notice.targets.map((target) => target.target), [`agent-event:${event!.id.slice(0, 8)}`]);

  const pulled = await api(app.baseUrl, f.apiKey, "GET", "/events?since=latest");
  assert.equal(pulled.status, 200, pulled.raw);
  assert.ok(pulled.raw.includes(event!.id), "the doorbell is delivered by the next pull");
  assert.ok(pulled.raw.includes("owner_inbox_updated"));
});

test("assistant doorbell: OAuth clients never see or touch system rows; one source per row", async ({ app }) => {
  const f = await seedAssistant(app);
  const orchestrator = freshProcess(app);
  const { client, accessToken } = await appWithAgentToken(app, f);
  await ownerFact(f, f.channelId, "channel");
  await drainAssistantDoorbells({ deliverer: orchestrator });
  const [system] = await doorbellEvents(f.agentId);
  assert.ok(system);

  // The only client write path, with an externalEventId: its dedupe is keyed
  // to its own client_id, so it creates its own row and never returns ours.
  const write = await fetch(`${app.baseUrl}/api/oauth/agent-events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "notification", summary: "client event", externalEventId: "x-1" }),
  });
  assert.equal(write.status, 202, await write.clone().text());
  const written = await write.json() as { id: string };
  assert.notEqual(written.id, system.id);

  // Filtering by a client never returns system rows; the system filter returns only them.
  const byClient = await listAgentAppEvents({ agentId: f.agentId, clientId: client.id });
  assert.deepEqual(byClient.events.map((event) => event.id), [written.id]);
  const bySystem = await listAgentAppEvents({ agentId: f.agentId, clientId: "system.assistant" });
  assert.deepEqual(bySystem.events.map((event) => [event.id, event.app.name]), [[system.id, "system.assistant"]]);

  // Exactly one of client_id / system_app.
  const base = { serverId: f.serverId, agentId: f.agentId, kind: "event" as const, summary: "x", payload: {}, payloadHash: "h", resource: "r", expiresAt: new Date(Date.now() + 60_000) };
  await assert.rejects(getDb().insert(thirdPartyAgentEvents).values({ ...base, clientId: null, systemApp: null }));
  await assert.rejects(getDb().insert(thirdPartyAgentEvents).values({ ...base, clientId: client.id, systemApp: "system.assistant" }));
});

test("assistant doorbell: the owner's own sends, reactions and task changes ring as owner actions; a message the assistant sent for them does not", async ({ app }) => {
  const f = await seedAssistant(app);
  const db = getDb();
  const ownerSend = async (extra: { delegated?: boolean } = {}) => {
    const message = await createMessage(f.channelId, "user", f.ownerId, `mine ${randomUUID().slice(0, 6)}`);
    if (extra.delegated) await db.update(messages).set({ delegatedByAgentId: f.agentId }).where(eq(messages.id, message.id));
    await recordInboxNotificationFacts([{
      receiverType: "user", receiverId: f.ownerId, serverId: f.serverId, kind: "channel", sourceChannelId: f.channelId,
      messageId: message.id, messageSeq: message.seq, activityAt: message.createdAt, personalMention: false, unreadEligible: false,
    }]);
    return message;
  };
  const ownerActionSources = async () => (await db.select().from(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, f.agentId)));

  await ownerSend({ delegated: true });
  assert.equal(await pendingDoorbell(f.agentId), null, "a message the assistant sent for the owner never rings as the owner's action");

  const mine = await ownerSend();
  assert.ok(await pendingDoorbell(f.agentId));
  assert.deepEqual((await ownerActionSources()).map((row) => [row.sourceChannelId, row.maxSeq, row.ownerAction]), [[f.channelId, mine.seq, true]]);
  assert.equal(await drainAssistantDoorbells({ deliverer: freshProcess(app) }), 1);
  const [event] = await doorbellEvents(f.agentId);
  assert.equal(event!.payload.includes_owner_actions, true);
  assert.deepEqual(event!.payload.sources, [{ channel_id: f.channelId, max_seq: mine.seq, owner_action: true }]);

  // A reaction by the owner rings too.
  const other = await createMessage(f.channelId, "agent", f.agentId, "react to me");
  await mutateMessageReaction({ channelId: f.channelId, messageId: other.id, emoji: "👍", actor: { kind: "user", id: f.ownerId }, operation: "add" });
  assert.deepEqual((await ownerActionSources()).map((row) => [row.maxSeq, row.ownerAction]), [[other.seq, true]]);

  // A task change by the owner rings too.
  await db.delete(assistantDoorbellSources).where(eq(assistantDoorbellSources.agentId, f.agentId));
  const host = await createMessage(f.channelId, "user", f.ownerId, "task host");
  const [task] = await db.insert(tasks).values({ channelId: f.channelId, taskNumber: 9001, title: "t", createdByType: "user", createdById: f.ownerId, messageId: host.id }).returning();
  await recordAssistantOwnerTaskAction({ actorUserId: f.ownerId, taskRowId: task!.id }, db);
  assert.deepEqual((await ownerActionSources()).map((row) => [row.maxSeq, row.ownerAction]), [[host.seq, true]]);
});

// ---------------------------------------------------------------------------
// A stop tells the owner; a stopped endpoint is probed back

const HOUR = 60 * 60_000;

/** A clock that only moves when told (the registration starts at real time). */
function steppedClock() {
  let nowMs = Date.now();
  return {
    clock: () => new Date(nowMs),
    advance(ms: number) { nowMs += ms; },
    get nowMs() { return nowMs; },
  };
}

function ownerNotices() {
  const notices: Array<{ agentId: string; cause: AgentInboxPushPausedCause }> = [];
  return { notices, notifyOwner: async (input: { agentId: string; cause: AgentInboxPushPausedCause }) => { notices.push(input); } };
}

async function pendingFor(f: Fixture, content = "hello") {
  const pending = new AgentInboxPendingNotice();
  pending.addMessage(delivered(f, await sendHumanMessage(f, content)));
  return pending;
}

/** One direct notice answered with `status`, then the clock moves past its backoff. */
async function sendAnswered(
  f: Fixture,
  pending: InstanceType<typeof AgentInboxPendingNotice>,
  status: number,
  t: ReturnType<typeof steppedClock>,
  notifyOwner: ReturnType<typeof ownerNotices>["notifyOwner"],
  stepMs = 10 * 60_000,
) {
  const rec = recorder([{ status }]);
  const result = await sendAgentInboxNotice({ agentId: f.agentId, pending, mode: "direct", post: rec.post, clock: t.clock, notifyOwner });
  assert.equal(rec.posted.length, 1, `status ${status} was not sent (${result.outcome})`);
  t.advance(stepMs);
  return result;
}

test("stop: concurrent failures that cross the limit disable once and tell the owner exactly once", async ({ app }) => {
  const f = await seedAgent("external", { owned: true });
  await register(app, f);
  const pending = await pendingFor(f);
  await getDb().update(agentInboxPushRegistrations).set({ consecutiveRejections: 2 }).where(eq(agentInboxPushRegistrations.agentId, f.agentId));
  const t = steppedClock(); // one instant for all: only the NULL -> set transition may claim the notice
  const owner = ownerNotices();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const post: WebhookPost = async () => {
    started += 1;
    await gate;
    return { status: 404 };
  };
  const sends = Array.from({ length: 4 }, () => sendAgentInboxNotice({
    agentId: f.agentId, pending, mode: "direct", post, clock: t.clock, notifyOwner: owner.notifyOwner,
  }));
  await waitFor(() => started === 4);
  release();
  const results = await Promise.all(sends);
  assert.ok(results.every((result) => result.outcome === "disabled"), JSON.stringify(results));
  assert.deepEqual(owner.notices, [{ agentId: f.agentId, cause: "endpoint_failing" }]);
  const row = await registrationRow(f.agentId);
  assert.equal(row.disabledReason, "endpoint_rejected");
  assert.equal(row.lastDisabledNoticeAt?.getTime(), t.nowMs);
});

test("stop: the owner is told at most once per 24 hours, however often push flaps", async ({ app }) => {
  const f = await seedAgent("external", { owned: true });
  const t = steppedClock();
  const owner = ownerNotices();
  const pending = await pendingFor(f);
  const stopOnce = async () => {
    await register(app, f);
    for (let i = 0; i < 3; i += 1) await sendAnswered(f, pending, 404, t, owner.notifyOwner);
    assert.notEqual((await registrationRow(f.agentId)).disabledAt, null);
  };
  await stopOnce();
  assert.equal(owner.notices.length, 1);
  t.advance(HOUR);
  await stopOnce(); // re-registered and stopped again within the day: silent
  assert.equal(owner.notices.length, 1);
  t.advance(21 * HOUR);
  await stopOnce(); // 23 hours after the first notice: still silent
  assert.equal(owner.notices.length, 1);
  t.advance(HOUR);
  await stopOnce(); // 24.5 hours after it: told again
  assert.equal(owner.notices.length, 2);
});

test("stop: no notice when the owner revoked the credential themselves; another person's revocation is told; neither is probed", async ({ app }) => {
  const own = await seedAgent("external", { owned: true });
  const other = await seedAgent("external", { owned: true });
  await register(app, own);
  await register(app, other);
  const [admin] = await getDb().insert(users).values({
    email: `inbox-push-admin-${randomUUID()}@slock.test`,
    name: `inbox-push-admin-${randomUUID().slice(0, 8)}`,
    displayName: "Admin",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  await revokeAgentCredential({ credentialId: own.credentialId, reason: "test", revokedByUserId: own.ownerId });
  await revokeAgentCredential({ credentialId: other.credentialId, reason: "test", revokedByUserId: admin!.id });
  const t = steppedClock();
  const owner = ownerNotices();
  const rec = recorder([{ status: 200 }]);
  for (const f of [own, other]) {
    const result = await sendAgentInboxNotice({ agentId: f.agentId, pending: await pendingFor(f), mode: "direct", post: rec.post, clock: t.clock, notifyOwner: owner.notifyOwner });
    assert.equal(result.outcome, "disabled");
    const row = await registrationRow(f.agentId);
    assert.equal(row.disabledReason, "credential_revoked");
    assert.equal(row.nextProbeAt, null, "a revoked credential is never probed");
  }
  assert.deepEqual(owner.notices, [{ agentId: other.agentId, cause: "credential_revoked" }]);
  t.advance(30 * 24 * HOUR);
  const probed = await probeDisabledAgentInboxPushRegistrations({ post: rec.post, clock: t.clock, agentIds: [own.agentId, other.agentId] });
  assert.equal(probed.probed, 0);
  assert.equal(rec.posted.length, 0);
});

test("401: never counts toward the 3 rejections; a run of 401s disables only after 24 hours, and any other answer restarts it", async ({ app }) => {
  const f = await seedAgent("external", { owned: true });
  await register(app, f);
  const t = steppedClock();
  const owner = ownerNotices();
  const pending = await pendingFor(f);
  const firstAt = t.nowMs;
  await sendAnswered(f, pending, 401, t, owner.notifyOwner, 12 * HOUR);
  let row = await registrationRow(f.agentId);
  assert.equal(row.firstUnauthorizedAt?.getTime(), firstAt);
  assert.equal(row.consecutiveRejections, 0);
  await sendAnswered(f, pending, 401, t, owner.notifyOwner, HOUR);
  await sendAnswered(f, pending, 401, t, owner.notifyOwner, 10 * HOUR + 55 * 60_000);
  await sendAnswered(f, pending, 401, t, owner.notifyOwner, 5 * 60_000); // 23:55 into the run
  row = await registrationRow(f.agentId);
  assert.equal(row.disabledAt, null, "four 401s in under 24 hours do not disable");
  assert.equal(owner.notices.length, 0);
  const result = await sendAnswered(f, pending, 401, t, owner.notifyOwner); // 24:00
  assert.equal(result.outcome, "disabled");
  row = await registrationRow(f.agentId);
  assert.equal(row.disabledReason, "endpoint_rejected");
  assert.equal(row.lastError, "http_401");
  assert.deepEqual(owner.notices, [{ agentId: f.agentId, cause: "endpoint_failing" }]);

  // Any other outcome ends the run: 401, 503, then 401s for 23 hours do not disable.
  const g = await seedAgent("external", { owned: true });
  await register(app, g);
  const pendingG = await pendingFor(g);
  await sendAnswered(g, pendingG, 401, t, owner.notifyOwner, HOUR);
  await sendAnswered(g, pendingG, 503, t, owner.notifyOwner, HOUR);
  assert.equal((await registrationRow(g.agentId)).firstUnauthorizedAt, null);
  await sendAnswered(g, pendingG, 401, t, owner.notifyOwner, 23 * HOUR);
  await sendAnswered(g, pendingG, 401, t, owner.notifyOwner, HOUR); // 23 hours into the new run, 25 since the first 401
  assert.equal((await registrationRow(g.agentId)).disabledAt, null);
  assert.equal((await sendAnswered(g, pendingG, 401, t, owner.notifyOwner)).outcome, "disabled");
  // A 2xx ends the run too.
  const h = await seedAgent("external", { owned: true });
  await register(app, h);
  const pendingH = await pendingFor(h);
  await sendAnswered(h, pendingH, 401, t, owner.notifyOwner, HOUR);
  await sendAnswered(h, pendingH, 200, t, owner.notifyOwner, HOUR);
  assert.equal((await registrationRow(h.agentId)).firstUnauthorizedAt, null);
});

test("probe: backoff schedule", () => {
  assert.equal(AGENT_INBOX_PUSH_PROBE_FIRST_DELAY_MS, HOUR);
  const schedule: number[] = [];
  let backoff: number | null = AGENT_INBOX_PUSH_PROBE_FIRST_DELAY_MS;
  for (let i = 0; i < 7; i += 1) {
    backoff = agentInboxPushNextProbeBackoffMs(backoff);
    schedule.push(backoff / HOUR);
  }
  assert.deepEqual(schedule, [2, 4, 8, 16, 24, 24, 24]);
});

test("probe: a stopped endpoint is probed at 1h, then doubling to every 24h; a 2xx re-enables it silently and the sweep follows", async ({ app }) => {
  const f = await seedAgent("external", { owned: true });
  await register(app, f);
  const t = steppedClock();
  const owner = ownerNotices();
  const pending = await pendingFor(f);
  for (let i = 0; i < 2; i += 1) await sendAnswered(f, pending, 410, t, owner.notifyOwner);
  const stoppedAt = t.nowMs;
  await sendAnswered(f, pending, 410, t, owner.notifyOwner, 0);
  let row = await registrationRow(f.agentId);
  assert.equal(row.disabledAt?.getTime(), stoppedAt);
  assert.equal(row.nextProbeAt?.getTime(), stoppedAt + HOUR);
  assert.equal(row.probeBackoffMs, HOUR);
  assert.equal(owner.notices.length, 1);

  const failing = recorder([{ status: 404 }]);
  const recovered: string[] = [];
  const probe = (post: WebhookPost) => probeDisabledAgentInboxPushRegistrations({
    post, clock: t.clock, agentIds: [f.agentId], onRecovered: (agentId) => recovered.push(agentId),
  });
  t.advance(HOUR - 60_000);
  assert.equal((await probe(failing.post)).probed, 0, "not before the hour");
  t.advance(60_000);
  const probedAt: number[] = [];
  for (const expectedBackoffHours of [2, 4, 8, 16, 24, 24]) {
    // Two replicas probe at once: one claims it.
    const [a, b] = await Promise.all([probe(failing.post), probe(failing.post)]);
    assert.equal(a.probed + b.probed, 1);
    probedAt.push(t.nowMs - stoppedAt);
    row = await registrationRow(f.agentId);
    assert.notEqual(row.disabledAt, null);
    assert.equal(row.probeBackoffMs, expectedBackoffHours * HOUR);
    assert.equal(row.nextProbeAt?.getTime(), t.nowMs + expectedBackoffHours * HOUR);
    assert.equal((await probe(failing.post)).probed, 0, "nothing until the next probe is due");
    t.advance(expectedBackoffHours * HOUR);
  }
  assert.deepEqual(probedAt.map((ms) => ms / HOUR), [1, 3, 7, 15, 31, 55]);
  const notice = failing.posted[0]!;
  assert.equal(notice.notice.schema, "raft-agent-inbox-notice.v1");
  assert.equal(notice.notice.recipientAgentId, f.agentId);
  assert.deepEqual(notice.notice.targets, []);
  assert.equal(notice.headers["x-raft-signature-256"], `sha256=${createHmac("sha256", SECRET).update(notice.body, "utf8").digest("hex")}`);

  const answering = recorder([{ status: 204 }]);
  assert.deepEqual(await probe(answering.post), { probed: 1, recovered: 1 });
  row = await registrationRow(f.agentId);
  assert.equal(row.disabledAt, null);
  assert.equal(row.disabledReason, null);
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.consecutiveRejections, 0);
  assert.equal(row.firstUnauthorizedAt, null);
  assert.equal(row.nextProbeAt, null);
  assert.equal(row.probeBackoffMs, null);
  assert.equal(row.lastError, null);
  assert.deepEqual(recovered, [f.agentId]);
  assert.equal(owner.notices.length, 1, "no notice on recovery");
  const status = (await api(app.baseUrl, f.apiKey, "GET", "/push-webhook")).body;
  assert.equal(status.enabled, true);
  // Sendable again.
  assert.equal((await sendAgentInboxNotice({ agentId: f.agentId, pending, mode: "direct", post: answering.post, clock: t.clock })).outcome, "delivered");
});

test("probe: the worker's sweep probes a stopped endpoint and, once it answers, announces the unread", async ({ app }) => {
  const f = await seedAgent("external", { owned: true });
  await register(app, f);
  const orchestrator = freshProcess(app);
  const owner = ownerNotices();
  let offsetMs = 0;
  const clock = () => new Date(Date.now() + offsetMs);
  const rec = recorder([{ status: 404 }, { status: 404 }, { status: 404 }, { status: 200 }]);
  const m1 = await sendHumanMessage(f, "while stopped");
  await withWorker(orchestrator, rec.post, async () => {
    orchestrator.emit("external-inbox-delivered", f.agentId, delivered(f, m1));
    for (let sent = 1; sent <= 2; sent += 1) {
      await waitFor(() => rec.posted.length === sent);
      await waitForRow(f.agentId, (row) => row.consecutiveFailures === sent);
      offsetMs += 10 * 60_000;
    }
    await waitForRow(f.agentId, (row) => row.disabledAt !== null);
    assert.equal(rec.posted.length, 3);
    assert.deepEqual(owner.notices, [{ agentId: f.agentId, cause: "endpoint_failing" }]);
    offsetMs += HOUR + 60_000;
    // probe (2xx) -> re-enabled -> sweep of that agent announces the unread
    await waitFor(() => rec.posted.length >= 5, 15_000);
  }, { clock, retryTimerMs: () => 20, sweepIntervalMs: 100, notifyOwner: owner.notifyOwner });
  assert.deepEqual(rec.posted[3]!.notice.targets, [], "the probe");
  assert.equal(rec.posted[4]!.notice.targets[0]?.latestMsgId, m1.id, "then the unread");
  assert.equal((await registrationRow(f.agentId)).disabledAt, null);
});

test("stop: a failing owner notice never undoes the disable; a rotation is not told; an inactive agent is not told", async ({ app }) => {
  const t = steppedClock();
  const f = await seedAgent("external", { owned: true });
  await register(app, f);
  const pending = await pendingFor(f);
  await getDb().update(agentInboxPushRegistrations).set({ consecutiveRejections: 2 }).where(eq(agentInboxPushRegistrations.agentId, f.agentId));
  const throwing = async () => { throw new Error("DM unavailable"); };
  const result = await sendAgentInboxNotice({ agentId: f.agentId, pending, mode: "direct", post: recorder([{ status: 404 }]).post, clock: t.clock, notifyOwner: throwing });
  assert.equal(result.outcome, "disabled");
  assert.equal((await registrationRow(f.agentId)).disabledReason, "endpoint_rejected");

  const owner = ownerNotices();
  const rotated = await seedAgent("external", { owned: true });
  await register(app, rotated);
  await revokeAgentCredential({ credentialId: rotated.credentialId, reason: "rotated" });
  const gone = await seedAgent("external", { owned: true });
  await register(app, gone);
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.agentId));
  for (const [g, reason] of [[rotated, "credential_revoked"], [gone, "agent_inactive"]] as const) {
    const sent = await sendAgentInboxNotice({ agentId: g.agentId, pending: await pendingFor(g), mode: "direct", post: recorder([{ status: 200 }]).post, clock: t.clock, notifyOwner: owner.notifyOwner });
    assert.equal(sent.outcome, "disabled");
    assert.equal((await registrationRow(g.agentId)).disabledReason, reason);
  }
  assert.equal(owner.notices.length, 0);
});

test("probe: a row stopped before probes existed is probed at once; a credential revoked since is not probed but takes that reason", async ({ app }) => {
  const legacy = await seedAgent("external", { owned: true });
  const revoked = await seedAgent("external", { owned: true });
  await register(app, legacy);
  await register(app, revoked);
  const stoppedAt = new Date(Date.now() - 3 * 24 * HOUR);
  for (const f of [legacy, revoked]) {
    // As an older replica stops it: no next_probe_at.
    await getDb().update(agentInboxPushRegistrations)
      .set({ disabledAt: stoppedAt, disabledReason: "endpoint_rejected", consecutiveRejections: 3 })
      .where(eq(agentInboxPushRegistrations.agentId, f.agentId));
  }
  await revokeAgentCredential({ credentialId: revoked.credentialId, reason: "test", revokedByUserId: revoked.ownerId });
  const rec = recorder([{ status: 503 }]);
  const t = steppedClock();
  assert.deepEqual(await probeDisabledAgentInboxPushRegistrations({ post: rec.post, clock: t.clock, agentIds: [legacy.agentId, revoked.agentId] }), { probed: 1, recovered: 0 });
  assert.equal(rec.posted.length, 1);
  assert.equal(rec.posted[0]!.notice.recipientAgentId, legacy.agentId);
  const legacyRow = await registrationRow(legacy.agentId);
  assert.equal(legacyRow.probeBackoffMs, 2 * HOUR);
  assert.equal(legacyRow.lastError, "http_503");
  const revokedRow = await registrationRow(revoked.agentId);
  assert.equal(revokedRow.disabledReason, "credential_revoked");
  assert.equal(revokedRow.nextProbeAt, null);
});

test("401: disables only with BOTH at least 3 in a row AND 24 hours since the first; a PUT resets the run", async ({ app }) => {
  const t = steppedClock();
  const owner = ownerNotices();
  // Two 401s a day apart: not enough 401s.
  const spaced = await seedAgent("external", { owned: true });
  await register(app, spaced);
  const pendingSpaced = await pendingFor(spaced);
  await sendAnswered(spaced, pendingSpaced, 401, t, owner.notifyOwner, 24 * HOUR);
  await sendAnswered(spaced, pendingSpaced, 401, t, owner.notifyOwner);
  let row = await registrationRow(spaced.agentId);
  assert.equal(row.disabledAt, null, "2 spaced 401s over 24 hours do not disable");
  assert.equal(row.consecutiveUnauthorized, 2);
  // A third one, the run now spanning over 24 hours: disables.
  assert.equal((await sendAnswered(spaced, pendingSpaced, 401, t, owner.notifyOwner)).outcome, "disabled");
  assert.equal((await registrationRow(spaced.agentId)).disabledReason, "endpoint_rejected");

  // Three (and more) 401s within 24 hours: not enough time.
  const quick = await seedAgent("external", { owned: true });
  await register(app, quick);
  const pendingQuick = await pendingFor(quick);
  for (let i = 0; i < 4; i += 1) await sendAnswered(quick, pendingQuick, 401, t, owner.notifyOwner, HOUR);
  row = await registrationRow(quick.agentId);
  assert.equal(row.disabledAt, null, "3+ 401s within 24 hours do not disable");
  assert.equal(row.consecutiveUnauthorized, 4);
  // A new PUT resets both.
  await register(app, quick);
  row = await registrationRow(quick.agentId);
  assert.equal(row.consecutiveUnauthorized, 0);
  assert.equal(row.firstUnauthorizedAt, null);
  assert.equal(owner.notices.length, 1);
});

test("probe: gives up 30 days after the stop (no notice), is never claimed again, and a PUT re-enables", async ({ app }) => {
  const f = await seedAgent("external", { owned: true });
  await register(app, f);
  const t = steppedClock();
  const owner = ownerNotices();
  const pending = await pendingFor(f);
  for (let i = 0; i < 2; i += 1) await sendAnswered(f, pending, 404, t, owner.notifyOwner);
  const stoppedAt = t.nowMs;
  await sendAnswered(f, pending, 404, t, owner.notifyOwner, 0);
  assert.equal(owner.notices.length, 1);
  const rec = recorder([{ status: 404 }]);
  const probe = () => probeDisabledAgentInboxPushRegistrations({ post: rec.post, clock: t.clock, agentIds: [f.agentId] });
  // Still probed just before day 30.
  t.advance(30 * 24 * HOUR - HOUR - (t.nowMs - stoppedAt));
  assert.equal((await probe()).probed, 1);
  assert.equal(rec.posted.length, 1);
  // The next probe falls after day 30: probing stops instead.
  t.advance(2 * HOUR);
  assert.equal((await probe()).probed, 0);
  assert.equal(rec.posted.length, 1);
  let row = await registrationRow(f.agentId);
  assert.equal(row.probeStoppedAt?.getTime(), t.nowMs);
  assert.notEqual(row.disabledAt, null);
  const stoppedRow = JSON.stringify(row);
  // Never claimed again.
  for (const step of [HOUR, 24 * HOUR, 365 * 24 * HOUR]) {
    t.advance(step);
    assert.deepEqual(await probe(), { probed: 0, recovered: 0 });
  }
  assert.equal(rec.posted.length, 1);
  assert.equal(JSON.stringify(await registrationRow(f.agentId)), stoppedRow, "the row is not touched again");
  assert.equal(owner.notices.length, 1, "no notice when probing stops");
  const status = (await api(app.baseUrl, f.apiKey, "GET", "/push-webhook")).body;
  assert.equal(status.enabled, false);
  assert.equal(status.probeStoppedAt, row.probeStoppedAt!.toISOString());
  assert.match(status.recovery, /stopped probing/);
  assert.match(status.recovery, /PUT \/push-webhook/);
  // A new PUT re-enables and clears the stop.
  const reenabled = await register(app, f);
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.recovery, null);
  row = await registrationRow(f.agentId);
  assert.equal(row.probeStoppedAt, null);
  assert.equal(row.disabledAt, null);
});
