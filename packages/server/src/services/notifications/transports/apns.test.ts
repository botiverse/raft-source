import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import type { MobileRegistrationTarget } from "../types";
import {
  ApnsDeliveryError,
  ApnsRequestTimeoutError,
  ApnsTopicNotAllowedError,
  DEFAULT_APNS_ALLOWED_TOPICS,
  __resetApnsHttpClientForTests,
  __resetApnsPushProviderForTests,
  __setApnsHttpClientForTests,
  __setApnsPushProviderForTests,
  apnsAlertRequest,
  apnsBackgroundRequest,
  apnsCollapseId,
  apnsTransport,
  closeApnsSessions,
  createApnsHttpClient,
  isAllowedApnsTopic,
  warmApnsSession,
  warmApnsTransport,
  type ApnsDeliveryInput,
  type ApnsHttpRequest,
} from "./apns";
import { APNS_PAYLOAD_MAX_BYTES } from "./payloadBudget";
import { CHANNEL_ID, MESSAGE_ID, SERVER_ID, THREAD_ID, channelNotification, oversizedTaskNotification, threadMentionNotification } from "./testFixtures";

const TARGET: MobileRegistrationTarget = {
  id: "registration-1",
  userId: "user-1",
  installationId: "install-1",
  provider: "apns",
  deviceToken: "abcdef123456",
  topic: "build.raft.app",
  env: "sandbox",
  alertsEnabled: true,
  osPermission: "granted",
  previewKeySet: 1,
};

const APNS_ENV = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY"] as const;

/** Configures APNs credentials and captures every HTTP/2 request the real provider makes. */
async function withConfiguredApns<T>(
  run: (requests: ApnsHttpRequest[], respond: (response: { statusCode: number; body: string }) => void) => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(APNS_ENV.map((name) => [name, process.env[name]]));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APNS_KEY_ID = "TESTKEY123";
  process.env.APNS_TEAM_ID = "TEAM123456";
  process.env.APNS_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const requests: ApnsHttpRequest[] = [];
  let response = { statusCode: 200, body: "" };
  __resetApnsPushProviderForTests();
  __setApnsHttpClientForTests(async (request) => {
    requests.push(request);
    return response;
  });
  try {
    return await run(requests, (next) => { response = next; });
  } finally {
    __resetApnsHttpClientForTests();
    __resetApnsPushProviderForTests();
    for (const name of APNS_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

// The dispatcher may call APNs while a transaction is open, so an APNs
// request that never answers must fail on its own deadline.
async function withSilentHttp2Server<T>(run: (authority: string, streams: () => number) => Promise<T>): Promise<T> {
  const server = http2.createServer();
  let streamCount = 0;
  server.on("stream", () => {
    streamCount += 1; // accept the request and never respond
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`, () => streamCount);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("APNs requests fail with a timeout when the provider never answers", async () => {
  await withSilentHttp2Server(async (authority, streams) => {
    const client = createApnsHttpClient(200);
    const started = Date.now();
    await assert.rejects(
      client({ authority, path: "/3/device/token", headers: {}, body: { aps: {} } }),
      (error: unknown) => error instanceof ApnsRequestTimeoutError,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 190, `timed out too early: ${elapsed}ms`);
    assert.ok(elapsed < 2_000, `timeout was not enforced: ${elapsed}ms`);
    assert.equal(streams(), 1, "the request must have reached the provider before timing out");
  });
});

test("configured APNs provider sends a real preview with identity custom fields and the envelope additions", async () => {
  await withConfiguredApns(async (requests) => {
    const built = channelNotification();
    const result = await apnsTransport.send(TARGET, apnsAlertRequest(built, 1));

    assert.deepEqual(result, { status: "sent" });
    const [request] = requests;
    assert.ok(request);
    assert.equal(request.authority, "https://api.sandbox.push.apple.com");
    assert.equal(request.path, "/3/device/abcdef123456");
    assert.match(request.headers.authorization, /^bearer .+/);
    const token = jwt.decode(request.headers.authorization.slice("bearer ".length), { complete: true });
    assert.equal(token?.header.kid, "TESTKEY123");
    assert.equal((token?.payload as { iss?: string }).iss, "TEAM123456");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["apns-topic"], "build.raft.app");
    assert.equal(request.headers["apns-push-type"], "alert");
    assert.equal(request.headers["apns-priority"], "10");
    assert.equal(request.headers["apns-collapse-id"], apnsCollapseId(`${SERVER_ID}:${CHANNEL_ID}`), "one per conversation");
    const expiration = Number(request.headers["apns-expiration"]);
    assert.ok(Math.abs(expiration - (Math.floor(Date.now() / 1000) + 3600)) < 5, "expires an hour from now");
    assert.deepEqual(request.body, {
      aps: {
        alert: { title: "#general", subtitle: "Acme", body: "Alice: hello" },
        badge: 1,
        sound: "default",
        "thread-id": `${SERVER_ID}:${CHANNEL_ID}`,
        category: "RAFT_MESSAGE",
      },
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      kind: "channel",
      type: "alert",
      id: `message:${MESSAGE_ID}`,
      raftCategory: "channel",
      groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
      conversationId: CHANNEL_ID,
      seq: 7,
      route: { type: "channel", serverId: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID },
      routeUrl: `/s/acme/channel/${CHANNEL_ID}?msg=${MESSAGE_ID}`,
      priority: "normal",
    });
  });
});

test("production registrations go to the production APNs host", async () => {
  await withConfiguredApns(async (requests) => {
    await apnsTransport.send({ ...TARGET, env: "production" }, apnsAlertRequest(channelNotification(), undefined));
    assert.equal(requests[0]?.authority, "https://api.push.apple.com");
    assert.equal("badge" in ((requests[0]?.body as { aps: object }).aps), false, "an unknown badge is omitted");
  });
});

test("thread APNs thread-id is the thread's own channel and carries the thread identity", () => {
  const { body } = apnsAlertRequest(threadMentionNotification(), 2);
  const aps = body.aps as Record<string, unknown>;
  assert.equal(aps["thread-id"], `${SERVER_ID}:${THREAD_ID}`);
  assert.equal(body.channelId, THREAD_ID);
  assert.equal(body.threadId, THREAD_ID);
  assert.equal(body.parentChannelId, CHANNEL_ID);
  assert.equal(body.kind, "thread");
  assert.equal(body.raftCategory, "mention");
  assert.equal(body.priority, "high");
  assert.equal(body.groupKey, `${SERVER_ID}:${THREAD_ID}`);
  assert.equal(body.conversationId, THREAD_ID);
  assert.equal(body.seq, 3);
  assert.equal((body.route as { type: string }).type, "thread");
});

test("redacted alerts carry the localization keys in aps.alert and no message content", () => {
  const senderOnly = apnsAlertRequest(channelNotification({
    envelope: { previewMode: "sender_only", body: "Alice sent a message" },
    push: {
      body: "Alice sent a message",
      messagePreview: undefined,
      localization: { bodyKey: "push.preview.sender_only.message", bodyArgs: ["Alice"] },
    },
  }), 1);
  assert.deepEqual((senderOnly.body.aps as { alert: unknown }).alert, {
    title: "#general",
    subtitle: "Acme",
    body: "Alice sent a message",
    "loc-key": "push.preview.sender_only.message",
    "loc-args": ["Alice"],
  });
  assert.equal(JSON.stringify(senderOnly).includes("hello"), false);

  const hidden = apnsAlertRequest(channelNotification({
    envelope: { previewMode: "hidden", title: "Raft", body: "You were mentioned" },
    push: {
      title: "Raft",
      subtitle: undefined,
      body: "You were mentioned",
      localization: { titleKey: "push.preview.hidden.title", bodyKey: "push.preview.hidden.mention", bodyArgs: [] },
    },
  }), 1);
  assert.deepEqual((hidden.body.aps as { alert: unknown }).alert, {
    title: "Raft",
    body: "You were mentioned",
    "title-loc-key": "push.preview.hidden.title",
    "loc-key": "push.preview.hidden.mention",
  }, "hidden has no loc-args");

  // Everything outside the alert stays as in the full form.
  const full = apnsAlertRequest(channelNotification(), 1);
  const strip = (request: typeof full) => {
    const { aps, ...rest } = request.body as { aps: Record<string, unknown> };
    const { alert: _alert, ...apsRest } = aps;
    return { apsRest, rest, collapseId: request.collapseId };
  };
  assert.deepEqual(strip(senderOnly), strip(full));
  assert.deepEqual(strip(hidden), strip(full));
});

test("loc keys go only to apps whose preview key set knows them; others get plain English", () => {
  const hiddenTask = channelNotification({
    envelope: { previewMode: "hidden", category: "task_status", title: "Raft", body: "You have a task update" },
    push: {
      title: "Raft",
      subtitle: undefined,
      body: "You have a task update",
      localization: { titleKey: "push.preview.hidden.title", bodyKey: "push.preview.hidden.task", bodyArgs: [] },
    },
  });
  const set1 = apnsAlertRequest(hiddenTask, 1, { previewKeySet: 1 });
  assert.deepEqual((set1.body.aps as { alert: unknown }).alert, { title: "Raft", body: "You have a task update" }, "an unknown key would show verbatim on iOS");
  const set2 = apnsAlertRequest(hiddenTask, 1, { previewKeySet: 2 });
  assert.deepEqual((set2.body.aps as { alert: unknown }).alert, {
    title: "Raft",
    body: "You have a task update",
    "title-loc-key": "push.preview.hidden.title",
    "loc-key": "push.preview.hidden.task",
  });
  // An original key works on set 1 (the default when the app reports none).
  const hiddenMessage = channelNotification({
    envelope: { previewMode: "hidden" },
    push: { title: "Raft", subtitle: undefined, body: "You have a new message", localization: { titleKey: "push.preview.hidden.title", bodyKey: "push.preview.hidden.message", bodyArgs: [] } },
  });
  assert.equal((apnsAlertRequest(hiddenMessage, 1).body.aps as { alert: Record<string, unknown> }).alert["loc-key"], "push.preview.hidden.message");
});

/** sender_only reply in a thread of #general: a keyed title, the redacted body. */
function senderOnlyThreadReply() {
  return channelNotification({
    envelope: { previewMode: "sender_only", title: "Thread in #general", body: "Alice sent a message" },
    push: {
      title: "Thread in #general",
      body: "Alice sent a message",
      messagePreview: "Alice sent a message",
      localization: { titleKey: "push.title.thread_in_channel", titleArgs: ["general"], bodyKey: "push.preview.sender_only.message", bodyArgs: ["Alice"] },
    },
  });
}

/** Full preview of an attachment in a DM task conversation: a keyed subtitle and body. */
function dmTaskAttachment() {
  return channelNotification({
    envelope: { title: "#7 Ship it", subtitle: "DM · Acme", body: "Alice: Sent an attachment" },
    push: {
      title: "#7 Ship it",
      subtitle: "DM · Acme",
      body: "Alice: Sent an attachment",
      localization: { subtitleKey: "push.subtitle.dm_server", subtitleArgs: ["Acme"], bodyKey: "push.body.sender_attachment", bodyArgs: ["Alice"] },
    },
  });
}

test("key set 3 apps get every banner key; set 1 and 2 apps exactly the keys they got before set 3", () => {
  const alertOf = (request: ReturnType<typeof apnsAlertRequest>) => (request.body.aps as { alert: unknown }).alert;
  const redacted = {
    title: "Thread in #general",
    subtitle: "Acme",
    body: "Alice sent a message",
    "loc-key": "push.preview.sender_only.message",
    "loc-args": ["Alice"],
  };
  assert.deepEqual(alertOf(apnsAlertRequest(senderOnlyThreadReply(), 1, { previewKeySet: 1 })), redacted, "set 1: the title key is unknown there");
  assert.deepEqual(alertOf(apnsAlertRequest(senderOnlyThreadReply(), 1, { previewKeySet: 2 })), redacted);
  assert.deepEqual(alertOf(apnsAlertRequest(senderOnlyThreadReply(), 1, { previewKeySet: 3 })), {
    ...redacted,
    "title-loc-key": "push.title.thread_in_channel",
    "title-loc-args": ["general"],
  });

  const plain = { title: "#7 Ship it", subtitle: "DM · Acme", body: "Alice: Sent an attachment" };
  assert.deepEqual(alertOf(apnsAlertRequest(dmTaskAttachment(), 1)), plain, "no key set reported = 1: plain English as before");
  assert.deepEqual(alertOf(apnsAlertRequest(dmTaskAttachment(), 1, { previewKeySet: 2 })), plain);
  assert.deepEqual(alertOf(apnsAlertRequest(dmTaskAttachment(), 1, { previewKeySet: 3 })), {
    ...plain,
    "subtitle-loc-key": "push.subtitle.dm_server",
    "subtitle-loc-args": ["Acme"],
    "loc-key": "push.body.sender_attachment",
    "loc-args": ["Alice"],
  });

  // A key set newer than the server knows gets the same keys; an unknown key never travels.
  assert.deepEqual(alertOf(apnsAlertRequest(dmTaskAttachment(), 1, { previewKeySet: 9 })), alertOf(apnsAlertRequest(dmTaskAttachment(), 1, { previewKeySet: 3 })));
  const unknown = channelNotification({ push: { localization: { titleKey: "push.title.from_the_future" } } });
  assert.deepEqual(alertOf(apnsAlertRequest(unknown, 1, { previewKeySet: 3 })), { title: "#general", subtitle: "Acme", body: "Alice: hello" });
});

test("a key without args sends no empty loc-args (the test notification)", () => {
  const built = channelNotification({
    push: {
      title: "Raft test notification",
      subtitle: undefined,
      body: "If you can read this, notifications reach this device.",
      localization: { titleKey: "push.title.test", bodyKey: "push.body.test", bodyArgs: [] },
    },
  });
  assert.deepEqual((apnsAlertRequest(built, undefined, { previewKeySet: 3 }).body.aps as { alert: unknown }).alert, {
    title: "Raft test notification",
    body: "If you can read this, notifications reach this device.",
    "title-loc-key": "push.title.test",
    "loc-key": "push.body.test",
  });
  assert.deepEqual((apnsAlertRequest(built, undefined, { previewKeySet: 2 }).body.aps as { alert: unknown }).alert, {
    title: "Raft test notification",
    body: "If you can read this, notifications reach this device.",
  });
});

test("serverBadge travels on the alert and the background pushes", () => {
  assert.equal(apnsAlertRequest(channelNotification(), 7, { serverBadge: 3 }).body.serverBadge, 3);
  assert.equal(apnsBackgroundRequest({ type: "sync", badge: 7, serverId: SERVER_ID, serverBadge: 0 }).body.serverBadge, 0);
  assert.equal(apnsBackgroundRequest({ type: "retract", badge: 7, serverBadge: 2, serverId: SERVER_ID, groupKey: `${SERVER_ID}:c`, conversationId: "c", throughSeq: null }).body.serverBadge, 2);
});

test("a silent notification omits aps.sound", () => {
  const { body } = apnsAlertRequest(channelNotification({ envelope: { silent: true } }), 1);
  assert.equal("sound" in (body.aps as object), false);
  const loud = apnsAlertRequest(channelNotification(), 1);
  assert.equal((loud.body.aps as { sound?: string }).sound, "default");
});

test("a notification without a message (reminder) carries null identity and hashes its long collapse id", () => {
  const reminderId = `reminder:${MESSAGE_ID}:2026-10-30T10:00:00.000Z`;
  assert.ok(Buffer.byteLength(reminderId) > 64);
  const request = apnsAlertRequest(channelNotification({
    envelope: { id: reminderId, category: "reminder", seq: null, conversationId: null },
    mobile: { channelId: null, messageId: undefined, kind: null },
  }), 1);
  // Contract §4.1: APNs carries the nulls of an event without a message.
  assert.equal(request.body.channelId, null);
  assert.equal(request.body.messageId, null);
  assert.equal(request.body.kind, null);
  assert.equal(request.body.seq, null);
  assert.equal(request.body.id, reminderId, "the body keeps the full id");
  assert.equal(request.collapseId, apnsCollapseId(reminderId));
  assert.match(request.collapseId!, /^h:[A-Za-z0-9_-]+$/);
  assert.ok(Buffer.byteLength(request.collapseId!) <= 64);
});

test("ordinary channel alerts of one conversation share a collapse id; mentions, DMs and events keep their own", () => {
  const first = apnsAlertRequest(channelNotification({ envelope: { id: "message:a", seq: 1 } }), 1);
  const second = apnsAlertRequest(channelNotification({ envelope: { id: "message:b", seq: 2 } }), 1);
  assert.equal(first.collapseId, second.collapseId, "chatter collapses");
  assert.equal(first.collapseId, apnsCollapseId(`${SERVER_ID}:${CHANNEL_ID}`));
  assert.ok(Buffer.byteLength(first.collapseId!) <= 64, "a <server>:<conversation> key is hashed to fit");
  for (const category of ["mention", "dm", "thread", "task_assigned", "agent_attention"] as const) {
    const personal = apnsAlertRequest(channelNotification({ envelope: { id: "message:p", category } }), 1);
    assert.equal(personal.collapseId, "message:p", `${category}: later chatter never replaces it`);
  }
  const reminders = ["reminder:r1:t1", "reminder:r2:t2"].map((id) => apnsAlertRequest(channelNotification({
    envelope: { id, category: "reminder", seq: null, conversationId: null, groupKey: `${SERVER_ID}:reminder` },
    mobile: { channelId: null, messageId: undefined, kind: null },
  }), 1).collapseId);
  assert.deepEqual(reminders, ["reminder:r1:t1", "reminder:r2:t2"], "no conversation: per event");
});

test("apnsCollapseId keeps short ids and hashes long ones stably", () => {
  assert.equal(apnsCollapseId(`message:${MESSAGE_ID}`), `message:${MESSAGE_ID}`);
  assert.equal(apnsCollapseId("x".repeat(64)), "x".repeat(64));
  const long = "y".repeat(65);
  assert.equal(apnsCollapseId(long), apnsCollapseId(long));
  assert.notEqual(apnsCollapseId(long), apnsCollapseId(`${long}z`));
  // Multi-byte text is measured in bytes.
  assert.match(apnsCollapseId("é".repeat(40)), /^h:/);
});

test("a test notification carries testId at the top level", () => {
  const request = apnsAlertRequest(channelNotification({ envelope: { category: "test" } }), undefined, { testId: "test-123" });
  assert.equal(request.body.testId, "test-123");
  assert.equal("testId" in apnsAlertRequest(channelNotification(), 1).body, false);
});

test("background sync and retract go as content-available pushes with priority 5 and no collapse id", async () => {
  await withConfiguredApns(async (requests) => {
    await apnsTransport.send(TARGET, apnsBackgroundRequest({ type: "sync", badge: 4 }));
    await apnsTransport.send(TARGET, apnsBackgroundRequest({
      type: "retract",
      badge: 2,
      serverId: SERVER_ID,
      groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
      conversationId: CHANNEL_ID,
      throughSeq: 9,
    }));
    await apnsTransport.send(TARGET, apnsBackgroundRequest({
      type: "retract",
      badge: undefined,
      serverId: SERVER_ID,
      groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
      conversationId: CHANNEL_ID,
      throughSeq: null,
    }));

    for (const request of requests) {
      assert.equal(request.headers["apns-push-type"], "background");
      assert.equal(request.headers["apns-priority"], "5");
      assert.equal(request.headers["apns-collapse-id"], undefined);
    }
    assert.deepEqual(requests[0]?.body, { aps: { "content-available": 1 }, type: "sync", badge: 4 });
    assert.deepEqual(requests[1]?.body, {
      aps: { "content-available": 1 },
      type: "retract",
      badge: 2,
      serverId: SERVER_ID,
      groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
      conversationId: CHANNEL_ID,
      throughSeq: 9,
    });
    assert.deepEqual(requests[2]?.body, {
      aps: { "content-available": 1 },
      type: "retract",
      serverId: SERVER_ID,
      groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
      conversationId: CHANNEL_ID,
      throughSeq: null,
    });
  });
  assert.deepEqual(apnsBackgroundRequest({ type: "sync", badge: undefined }).body, { aps: { "content-available": 1 }, type: "sync" });
});

test("an APNs rejection throws a classified error; 410 and BadDeviceToken are terminal, others retryable", async () => {
  await withConfiguredApns(async (_requests, respond) => {
    respond({ statusCode: 410, body: JSON.stringify({ reason: "Unregistered" }) });
    await assert.rejects(apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1)), (err: unknown) => {
      assert.ok(err instanceof ApnsDeliveryError);
      assert.equal(err.statusCode, 410);
      assert.equal(err.reason, "Unregistered");
      assert.equal(apnsTransport.isTerminalTargetError(err), true);
      return true;
    });

    respond({ statusCode: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) });
    await assert.rejects(apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1)), (err: unknown) =>
      apnsTransport.isTerminalTargetError(err));

    respond({ statusCode: 503, body: "not json" });
    await assert.rejects(apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1)), (err: unknown) => {
      assert.ok(err instanceof ApnsDeliveryError);
      assert.equal(err.reason, undefined);
      assert.equal(apnsTransport.isTerminalTargetError(err), false);
      assert.equal(apnsTransport.isNonRetryable(err), false);
      return true;
    });
  });
  assert.equal(apnsTransport.isTerminalTargetError(new ApnsRequestTimeoutError(1)), false);
});

test("without credentials the provider skips and never calls the network", async () => {
  const previous = Object.fromEntries(APNS_ENV.map((name) => [name, process.env[name]]));
  for (const name of APNS_ENV) delete process.env[name];
  let calls = 0;
  __resetApnsPushProviderForTests();
  __setApnsHttpClientForTests(async () => {
    calls += 1;
    return { statusCode: 200, body: "" };
  });
  try {
    assert.equal(apnsTransport.isConfigured(), false);
    assert.deepEqual(
      await apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1)),
      { status: "skipped", reason: "provider_not_configured" },
    );
    assert.equal(calls, 0);
  } finally {
    __resetApnsHttpClientForTests();
    for (const name of APNS_ENV) {
      if (previous[name] !== undefined) process.env[name] = previous[name];
    }
  }
});

test("the transport hands the registration and request to the provider seam", async () => {
  const inputs: ApnsDeliveryInput[] = [];
  __setApnsPushProviderForTests({
    async send(input) {
      inputs.push(input);
      return { status: "sent" };
    },
  });
  try {
    const request = apnsAlertRequest(channelNotification(), 3);
    await apnsTransport.send(TARGET, request);
    assert.deepEqual(inputs, [{
      registrationId: "registration-1",
      installationId: "install-1",
      deviceToken: "abcdef123456",
      topic: "build.raft.app",
      env: "sandbox",
      request,
    }]);
  } finally {
    __resetApnsPushProviderForTests();
  }
});

test("a very long notification fits the APNs payload limit; the identity keys are kept", () => {
  const built = oversizedTaskNotification();
  const request = apnsAlertRequest(built, 99, { serverBadge: 12, previewKeySet: 2, testId: "t-1" });
  const size = Buffer.byteLength(JSON.stringify(request.body), "utf8");
  assert.ok(size <= APNS_PAYLOAD_MAX_BYTES, `body is ${size} bytes`);
  const body = request.body as { aps: { alert: { title: string; body: string } }; id: string; groupKey: string; routeUrl: string };
  assert.equal(body.id, built.envelope.id);
  assert.equal(body.groupKey, built.envelope.groupKey);
  assert.equal(body.routeUrl, built.routeUrl);
  assert.ok(body.aps.alert.title.length > 0 && body.aps.alert.body.length > 0);
  // Within the budget nothing is cut.
  const small = apnsAlertRequest(channelNotification(), 1).body as { aps: { alert: { body: string } } };
  assert.equal(small.aps.alert.body, "Alice: hello");
});

test("the APNs subtitle is omitted without one and cut after the body, before the title", () => {
  const single = apnsAlertRequest(channelNotification({ envelope: { subtitle: undefined }, push: { subtitle: undefined } }), 1);
  assert.deepEqual((single.body.aps as { alert: unknown }).alert, { title: "#general", body: "Alice: hello" }, "single-server receiver: no subtitle");

  const long = apnsAlertRequest(channelNotification({
    push: { title: "T".repeat(1_000), subtitle: "S".repeat(3_000), body: "B".repeat(3_000) },
  }), 1);
  assert.ok(Buffer.byteLength(JSON.stringify(long.body), "utf8") <= APNS_PAYLOAD_MAX_BYTES);
  const alert = (long.body.aps as { alert: { title: string; subtitle: string; body: string } }).alert;
  assert.equal(alert.body, "", "the body goes first");
  assert.ok(alert.subtitle.endsWith("…") && alert.subtitle.length < 3_000, "then the subtitle");
  assert.equal(alert.title, "T".repeat(1_000), "the title is kept");
});

test("the provider token is minted once and reused across sends", async () => {
  await withConfiguredApns(async (requests) => {
    await apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1));
    await apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 2));
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.authorization, requests[1].headers.authorization,
      "Apple rejects a new provider token per request (TooManyProviderTokenUpdates)");
  });
});

test("an expired provider token is minted again on the next send", async () => {
  await withConfiguredApns(async (requests, respond) => {
    respond({ statusCode: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) });
    await assert.rejects(apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1)));
    respond({ statusCode: 200, body: "" });
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // a new iat second, so the JWT differs
    await apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1));
    assert.notEqual(requests[0].headers.authorization, requests[1].headers.authorization);
  });
});

async function withAnsweringHttp2Server<T>(run: (authority: string, sessions: () => number) => Promise<T>): Promise<T> {
  const server = http2.createServer();
  let sessionCount = 0;
  server.on("session", () => {
    sessionCount += 1;
  });
  server.on("stream", (stream: http2.ServerHttp2Stream) => {
    stream.respond({ ":status": 200 });
    stream.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`, () => sessionCount);
  } finally {
    closeApnsSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("requests to one APNs host share one HTTP/2 connection", async () => {
  await withAnsweringHttp2Server(async (authority, sessions) => {
    const client = createApnsHttpClient(2_000);
    const request = { authority, path: "/3/device/token", headers: {}, body: { aps: {} } };
    await Promise.all([client(request), client(request), client(request)]);
    await client(request);
    assert.equal(sessions(), 1, "no TLS handshake per notification");
  });
});

test("the boot warm-up opens the connection the first request then reuses", async () => {
  await withAnsweringHttp2Server(async (authority, sessions) => {
    await warmApnsSession(authority, 2_000);
    // The server sees the session a moment after the client's connect.
    for (let i = 0; i < 50 && sessions() === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sessions(), 1, "connected before any notification");
    const response = await createApnsHttpClient(2_000)({ authority, path: "/3/device/token", headers: {}, body: { aps: {} } });
    assert.equal(response.statusCode, 200);
    assert.equal(sessions(), 1);
  });
});

test("a warm-up that cannot connect fails within its bound and pools nothing", async () => {
  // Nothing listens on this port: the connect is refused.
  const probe = http2.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const started = Date.now();
  await assert.rejects(warmApnsSession(`http://127.0.0.1:${port}`, 1_000));
  assert.ok(Date.now() - started < 2_000);
  // A later request reconnects instead of reusing a dead session.
  await withAnsweringHttp2Server(async (authority) => {
    assert.equal((await createApnsHttpClient(2_000)({ authority, path: "/x", headers: {}, body: {} })).statusCode, 200);
  });
});

test("warmApnsTransport does nothing without APNs credentials", async () => {
  const previous = Object.fromEntries(APNS_ENV.map((name) => [name, process.env[name]]));
  for (const name of APNS_ENV) delete process.env[name];
  try {
    assert.equal(await warmApnsTransport(), "not_configured");
  } finally {
    for (const name of APNS_ENV) {
      if (previous[name] !== undefined) process.env[name] = previous[name];
    }
  }
});

test("only allowlisted topics are pushed: any other is refused as terminal without reaching the provider", async () => {
  await withConfiguredApns(async (requests) => {
    assert.deepEqual(DEFAULT_APNS_ALLOWED_TOPICS, ["build.raft.app"]);
    await assert.rejects(apnsTransport.send({ ...TARGET, topic: "dev.vgent.raft.app" }, apnsAlertRequest(channelNotification(), 1)), (err: unknown) => {
      assert.ok(err instanceof ApnsTopicNotAllowedError);
      assert.equal(err.reason, "topic_not_allowed");
      assert.equal(apnsTransport.isTerminalTargetError(err), true, "the registration is revoked");
      return true;
    });
    assert.equal(requests.length, 0, "Apple is never asked");
    await apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1));
    assert.equal(requests.length, 1);
  });
});

test("APNS_ALLOWED_TOPICS replaces the default allowlist", () => {
  const previous = process.env.APNS_ALLOWED_TOPICS;
  try {
    process.env.APNS_ALLOWED_TOPICS = " build.raft.app , build.raft.staging ,";
    assert.equal(isAllowedApnsTopic("build.raft.staging"), true);
    assert.equal(isAllowedApnsTopic("build.raft.app"), true);
    assert.equal(isAllowedApnsTopic("dev.vgent.raft.app"), false);
    process.env.APNS_ALLOWED_TOPICS = " , ";
    assert.equal(isAllowedApnsTopic("build.raft.app"), true, "an empty setting keeps the default");
    assert.equal(isAllowedApnsTopic("build.raft.staging"), false);
  } finally {
    if (previous === undefined) delete process.env.APNS_ALLOWED_TOPICS;
    else process.env.APNS_ALLOWED_TOPICS = previous;
  }
});

test("a 400 is not retried; DeviceTokenNotForTopic revokes; TopicDisallowed / BadTopic keep the registration", async () => {
  await withConfiguredApns(async (_requests, respond) => {
    for (const reason of ["TopicDisallowed", "BadTopic", "BadPriority", "DeviceTokenNotForTopic"]) {
      respond({ statusCode: 400, body: JSON.stringify({ reason }) });
      await assert.rejects(apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1)), (err: unknown) => {
        assert.ok(err instanceof ApnsDeliveryError);
        assert.equal(err.reason, reason);
        assert.equal(apnsTransport.isNonRetryable(err), true, `${reason}: the same request fails the same way`);
        assert.equal(apnsTransport.isTerminalTargetError(err), reason === "DeviceTokenNotForTopic",
          `${reason}: only a token of another app is the registration's own fault`);
        return true;
      });
    }
    respond({ statusCode: 413, body: JSON.stringify({ reason: "PayloadTooLarge" }) });
    await assert.rejects(apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1)), (err: unknown) =>
      apnsTransport.isNonRetryable(err) && !apnsTransport.isTerminalTargetError(err));
    respond({ statusCode: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) });
    await assert.rejects(apnsTransport.send(TARGET, apnsAlertRequest(channelNotification(), 1)), (err: unknown) =>
      !apnsTransport.isNonRetryable(err) && !apnsTransport.isTerminalTargetError(err));
  });
  assert.equal(apnsTransport.isNonRetryable(new ApnsRequestTimeoutError(1)), false);
});

test("requests sharing one HTTP/2 connection each carry their own apns-topic and provider token", async () => {
  const server = http2.createServer();
  const seen: Array<{ topic: unknown; authorization: unknown; path: unknown }> = [];
  let sessionCount = 0;
  server.on("session", () => { sessionCount += 1; });
  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    seen.push({ topic: headers["apns-topic"], authorization: headers.authorization, path: headers[":path"] });
    stream.respond({ ":status": 200 });
    stream.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const authority = `http://127.0.0.1:${port}`;
  try {
    const client = createApnsHttpClient(2_000);
    const request = (topic: string, token: string, device: string) =>
      client({ authority, path: `/3/device/${device}`, headers: { "apns-topic": topic, authorization: `bearer ${token}` }, body: { aps: {} } });
    await Promise.all([request("build.raft.app", "jwt-a", "d1"), request("other.topic", "jwt-b", "d2"), request("build.raft.app", "jwt-a", "d3")]);
    await request("other.topic", "jwt-b", "d4");
    assert.equal(sessionCount, 1, "one connection");
    const byPath = Object.fromEntries(seen.map((entry) => [entry.path, entry]));
    assert.deepEqual(byPath["/3/device/d1"], { topic: "build.raft.app", authorization: "bearer jwt-a", path: "/3/device/d1" });
    assert.deepEqual(byPath["/3/device/d2"], { topic: "other.topic", authorization: "bearer jwt-b", path: "/3/device/d2" });
    assert.deepEqual(byPath["/3/device/d3"], { topic: "build.raft.app", authorization: "bearer jwt-a", path: "/3/device/d3" });
    assert.deepEqual(byPath["/3/device/d4"], { topic: "other.topic", authorization: "bearer jwt-b", path: "/3/device/d4" });
  } finally {
    closeApnsSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
