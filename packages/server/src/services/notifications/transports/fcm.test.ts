import assert from "node:assert/strict";
import {
  ConfiguredFcmPushProvider,
  FcmDeliveryError,
  FcmRequestTimeoutError,
  __resetFcmTransportForTests,
  fcmAccessTokenSourceFromEnv,
  isNonRetryableFcmError,
  isTerminalFcmTokenError,
  parseFcmErrorReason,
  type FcmDeliveryInput,
  type FcmHttpClient,
} from "../../fcmPushProvider";
import type { MobileRegistrationTarget } from "../types";
import { FCM_DATA_MAX_BYTES } from "./payloadBudget";
import {
  __resetFcmPushProviderForTests,
  __setFcmPushProviderForTests,
  fcmAlertMessage,
  fcmBackgroundMessage,
  fcmTransport,
  mobilePushConversationKey,
} from "./fcm";
import {
  CHANNEL_ID,
  MESSAGE_ID,
  PARENT_MESSAGE_ID,
  SERVER_ID,
  THREAD_ID,
  channelNotification,
  oversizedTaskNotification,
  threadMentionNotification,
} from "./testFixtures";

const FCM_TOKEN = "dGVzdC1pbnN0YW5jZQ:APA91bH-test_token";

const TARGET: MobileRegistrationTarget = {
  id: "registration-1",
  userId: "user-1",
  installationId: "android-install",
  provider: "fcm",
  deviceToken: FCM_TOKEN,
  topic: "build.raft.app",
  env: "production",
  alertsEnabled: true,
  osPermission: "granted",
  previewKeySet: 1,
};

function assertAllStrings(data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) assert.equal(typeof value, "string", `${key} must be a string`);
}

test("an alert is a data message with the identity keys the client reads, the real category and the envelope additions", () => {
  const message = fcmAlertMessage(channelNotification(), 1);
  assert.deepEqual(message.data, {
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    kind: "channel",
    category: "channel",
    // Today's Android app does not know `subtitle`: the context joins the title.
    title: "#general · Acme",
    subtitle: "Acme",
    body: "Alice: hello",
    notificationKey: "conversation-key",
    badge: "1",
    type: "alert",
    id: `message:${MESSAGE_ID}`,
    groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
    conversationId: CHANNEL_ID,
    seq: "7",
    route: JSON.stringify({ type: "channel", serverId: SERVER_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID }),
    routeUrl: `/s/acme/channel/${CHANNEL_ID}?msg=${MESSAGE_ID}`,
    priority: "normal",
    silent: "false",
  });
  assert.equal(message.priority, "NORMAL");
  assert.equal("collapseKey" in message, false, "no FCM collapse: every message reaches the device");
  assertAllStrings(message.data);
});

test("a personal alert is android HIGH; a thread reply carries the thread identity", () => {
  const message = fcmAlertMessage(threadMentionNotification(), 2);
  assert.equal(message.priority, "HIGH");
  assert.equal(message.data.priority, "high");
  assert.equal(message.data.category, "mention");
  assert.equal(message.data.kind, "thread");
  assert.equal(message.data.channelId, THREAD_ID);
  assert.equal(message.data.threadId, THREAD_ID);
  assert.equal(message.data.parentChannelId, CHANNEL_ID);
  assert.equal(message.data.parentMessageId, PARENT_MESSAGE_ID);
  assert.equal(JSON.parse(message.data.route).type, "thread");
  assertAllStrings(message.data);

  for (const category of ["dm", "task_assigned", "agent_attention", "reminder", "system_notice", "test"] as const) {
    assert.equal(fcmAlertMessage(channelNotification({ envelope: { category, priority: "high" } }), 1).priority, "HIGH", category);
  }
  for (const category of ["channel", "thread", "task_status"] as const) {
    assert.equal(fcmAlertMessage(channelNotification({ envelope: { category, priority: "normal" } }), 1).priority, "NORMAL", category);
  }
});

test("a task conversation reply carries the task keys", () => {
  const message = fcmAlertMessage(channelNotification({
    mobile: { taskId: "task-1", taskConversationChannelId: "task-channel", taskMessageId: "task-message" },
  }), 1);
  assert.equal(message.data.taskId, "task-1");
  assert.equal(message.data.taskConversationChannelId, "task-channel");
  assert.equal(message.data.taskMessageId, "task-message");
});

test("silent, missing badge, and a notice without a conversation omit the null keys and serialize to strings", () => {
  const message = fcmAlertMessage(channelNotification({
    envelope: { silent: true, seq: null, conversationId: null, category: "system_notice", priority: "high" },
    mobile: { channelId: null, messageId: undefined, kind: null },
  }), undefined, { testId: "test-1" });
  assert.equal(message.data.silent, "true");
  // Contract §4.1: FCM omits the conversation identity of an event without a message.
  for (const key of ["seq", "conversationId", "channelId", "kind"]) assert.equal(key in message.data, false, key);
  assert.equal("badge" in message.data, false);
  assert.equal("messageId" in message.data, false);
  assert.equal(message.data.testId, "test-1");
  assertAllStrings(message.data);
});

test("serverBadge travels on alert, sync and retract data", () => {
  assert.equal(fcmAlertMessage(channelNotification(), 7, { serverBadge: 3 }).data.serverBadge, "3");
  const sync = fcmBackgroundMessage({ type: "sync", badge: 7, serverId: "srv-1", serverBadge: 0 });
  assert.deepEqual(sync.data, { type: "sync", serverId: "srv-1", badge: "7", serverBadge: "0" });
  const retract = fcmBackgroundMessage({ type: "retract", badge: 7, serverBadge: 2, serverId: "srv-1", groupKey: "srv-1:c", conversationId: "c", throughSeq: 4 });
  assert.equal(retract.data.serverBadge, "2");
});

test("redaction adds previewMode and the localization keys; the rest of the data is unchanged", () => {
  const full = fcmAlertMessage(channelNotification(), 1);
  assert.equal("previewMode" in full.data || "bodyKey" in full.data, false, "full data carries no localization");

  const senderOnly = fcmAlertMessage(channelNotification({
    envelope: { previewMode: "sender_only" },
    push: { body: "Alice sent a message", localization: { bodyKey: "push.preview.sender_only.message", bodyArgs: ["Alice"] } },
  }), 1);
  assert.equal(senderOnly.data.previewMode, "sender_only");
  assert.equal(senderOnly.data.titleKey, undefined, "sender_only keeps the surface title, no title key");
  assert.equal(senderOnly.data.bodyKey, "push.preview.sender_only.message");
  assert.equal(senderOnly.data.bodyArgs, JSON.stringify(["Alice"]));

  const hidden = fcmAlertMessage(channelNotification({
    envelope: { previewMode: "hidden" },
    push: {
      title: "Raft",
      subtitle: undefined,
      body: "You have a new message",
      localization: { titleKey: "push.preview.hidden.title", bodyKey: "push.preview.hidden.message", bodyArgs: [] },
    },
  }), 1);
  assert.equal(hidden.data.title, "Raft");
  assert.equal("subtitle" in hidden.data, false, "hidden: no subtitle key");
  assert.equal(hidden.data.titleKey, "push.preview.hidden.title");
  assert.equal(hidden.data.bodyArgs, "[]");
  assert.equal(JSON.stringify(hidden).includes("hello"), false);

  const identity = (data: Record<string, string>) => {
    const { title: _t, subtitle: _s, body: _b, titleKey: _tk, bodyKey: _bk, bodyArgs: _ba, previewMode: _pm, ...rest } = data;
    return rest;
  };
  assert.deepEqual(identity(senderOnly.data), identity(full.data));
  assert.deepEqual(identity(hidden.data), identity(full.data));
});

test("banner keys (key set 3) go only to an app that declares set 3; every app keeps the redacted-preview keys", () => {
  const senderOnlyThread = channelNotification({
    envelope: { previewMode: "sender_only", title: "Thread in #general" },
    push: {
      title: "Thread in #general",
      body: "Alice sent a message",
      localization: { titleKey: "push.title.thread_in_channel", titleArgs: ["general"], bodyKey: "push.preview.sender_only.message", bodyArgs: ["Alice"] },
    },
  });
  for (const previewKeySet of [undefined, 1, 2]) {
    const { data } = fcmAlertMessage(senderOnlyThread, 1, { previewKeySet });
    assert.equal(data.title, "Thread in #general · Acme", "the context stays in the title");
    assert.equal(data.previewMode, "sender_only");
    assert.equal(data.bodyKey, "push.preview.sender_only.message");
    assert.equal(data.bodyArgs, JSON.stringify(["Alice"]));
    for (const key of ["titleKey", "titleArgs", "subtitleKey", "subtitleArgs"]) assert.equal(key in data, false, `set ${previewKeySet}: no ${key}`);
  }
  const set3 = fcmAlertMessage(senderOnlyThread, 1, { previewKeySet: 3 }).data;
  assert.equal(set3.title, "Thread in #general", "set 3 shows the subtitle itself: a plain title");
  assert.equal(set3.subtitle, "Acme");
  assert.equal(set3.titleKey, "push.title.thread_in_channel");
  assert.equal(set3.titleArgs, JSON.stringify(["general"]));
  assert.equal(set3.bodyKey, "push.preview.sender_only.message");
  assertAllStrings(set3);

  const fullDmTask = channelNotification({
    push: {
      title: "#7 Ship it",
      subtitle: "DM · Acme",
      body: "Alice: Sent an attachment",
      localization: { subtitleKey: "push.subtitle.dm_server", subtitleArgs: ["Acme"], bodyKey: "push.body.sender_attachment", bodyArgs: ["Alice"] },
    },
  });
  const older = fcmAlertMessage(fullDmTask, 1, { previewKeySet: 2 }).data;
  for (const key of ["previewMode", "titleKey", "subtitleKey", "subtitleArgs", "bodyKey", "bodyArgs"]) assert.equal(key in older, false, `set 2, full preview: no ${key}`);
  const newer = fcmAlertMessage(fullDmTask, 1, { previewKeySet: 3 }).data;
  assert.equal(older.title, "#7 Ship it · DM · Acme");
  assert.equal(newer.title, "#7 Ship it");
  assert.equal("previewMode" in newer, false, "a full preview has no previewMode");
  assert.equal(newer.subtitleKey, "push.subtitle.dm_server");
  assert.equal(newer.subtitleArgs, JSON.stringify(["Acme"]));
  assert.equal(newer.bodyKey, "push.body.sender_attachment");
  assert.equal(newer.bodyArgs, JSON.stringify(["Alice"]));
  assertAllStrings(newer);

  // A hidden task update: the set 2 keys go to every Android app, as before set 3.
  const hiddenTask = channelNotification({
    envelope: { previewMode: "hidden", category: "task_status" },
    push: { title: "Raft", subtitle: undefined, body: "You have a task update", localization: { titleKey: "push.preview.hidden.title", bodyKey: "push.preview.hidden.task", bodyArgs: [] } },
  });
  const set1 = fcmAlertMessage(hiddenTask, 1, { previewKeySet: 1 }).data;
  assert.equal(set1.titleKey, "push.preview.hidden.title");
  assert.equal(set1.bodyKey, "push.preview.hidden.task");
  assert.equal(set1.bodyArgs, "[]");
});

test("mobilePushConversationKey is one stable key per conversation", () => {
  assert.equal(mobilePushConversationKey(SERVER_ID, CHANNEL_ID), mobilePushConversationKey(SERVER_ID, CHANNEL_ID));
  assert.notEqual(mobilePushConversationKey(SERVER_ID, CHANNEL_ID), mobilePushConversationKey(SERVER_ID, THREAD_ID));
  assert.match(mobilePushConversationKey(SERVER_ID, CHANNEL_ID), /^[A-Za-z0-9_-]{43}$/);
});

test("sync and retract are NORMAL data messages with string values (HIGH only for alerts, so FCM never deprioritises them)", () => {
  assert.deepEqual(fcmBackgroundMessage({ type: "sync", badge: 3 }), { data: { type: "sync", badge: "3" }, priority: "NORMAL" });
  assert.deepEqual(fcmBackgroundMessage({ type: "sync", badge: undefined }), { data: { type: "sync" }, priority: "NORMAL" });
  const retract = fcmBackgroundMessage({
    type: "retract",
    badge: 0,
    serverId: SERVER_ID,
    groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
    conversationId: CHANNEL_ID,
    throughSeq: 12,
  });
  assert.deepEqual(retract, {
    data: {
      type: "retract",
      serverId: SERVER_ID,
      conversationId: CHANNEL_ID,
      groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
      throughSeq: "12",
      badge: "0",
    },
    priority: "NORMAL",
  });
  const all = fcmBackgroundMessage({
    type: "retract",
    badge: undefined,
    serverId: SERVER_ID,
    groupKey: `${SERVER_ID}:${CHANNEL_ID}`,
    conversationId: CHANNEL_ID,
    throughSeq: null,
  });
  assert.equal(all.data.throughSeq, "", "empty string retracts the whole group");
  assert.equal("badge" in all.data, false);
  assertAllStrings(all.data);
});

test("the transport hands the registration and message to the provider and classifies its errors", async () => {
  const inputs: FcmDeliveryInput[] = [];
  let failure: Error | null = null;
  __setFcmPushProviderForTests({
    async send(input) {
      inputs.push(input);
      if (failure) throw failure;
      return { status: "sent" };
    },
  });
  try {
    const message = fcmAlertMessage(channelNotification(), 1);
    assert.deepEqual(await fcmTransport.send(TARGET, message), { status: "sent" });
    assert.deepEqual(inputs[0], {
      registrationId: "registration-1",
      installationId: "android-install",
      deviceToken: FCM_TOKEN,
      message,
    });
    assert.equal(fcmTransport.isConfigured(), true, "a provider without isConfigured counts as configured");

    failure = new FcmDeliveryError("gone", { statusCode: 404, reason: "UNREGISTERED" });
    await assert.rejects(fcmTransport.send(TARGET, message), (err: unknown) => {
      assert.equal(fcmTransport.isTerminalTargetError(err), true, "UNREGISTERED revokes the registration");
      assert.equal(fcmTransport.isNonRetryable(err), false);
      return true;
    });
    failure = new FcmDeliveryError("bad request", { statusCode: 400, reason: "INVALID_ARGUMENT" });
    await assert.rejects(fcmTransport.send(TARGET, message), (err: unknown) => {
      assert.equal(fcmTransport.isTerminalTargetError(err), false, "INVALID_ARGUMENT keeps the registration");
      assert.equal(fcmTransport.isNonRetryable(err), true, "INVALID_ARGUMENT is not retried");
      return true;
    });
    failure = new FcmDeliveryError("busy", { statusCode: 503, reason: "UNAVAILABLE" });
    await assert.rejects(fcmTransport.send(TARGET, message), (err: unknown) => {
      assert.equal(fcmTransport.isTerminalTargetError(err), false);
      assert.equal(fcmTransport.isNonRetryable(err), false, "transient failures are retried");
      return true;
    });
    assert.equal(isTerminalFcmTokenError(new FcmDeliveryError("x", { reason: "SENDER_ID_MISMATCH" })), true);
    assert.equal(isNonRetryableFcmError(new FcmRequestTimeoutError(1)), false);

    __setFcmPushProviderForTests({ send: async () => ({ status: "sent" }), isConfigured: () => false });
    assert.equal(fcmTransport.isConfigured(), false);
  } finally {
    __resetFcmPushProviderForTests();
  }
});

test("configured FCM provider skips without credentials and never calls the network", async () => {
  let calls = 0;
  const provider = new ConfiguredFcmPushProvider(
    () => async () => {
      calls += 1;
      return { statusCode: 200, body: "{}" };
    },
    () => null,
  );
  const result = await provider.send({
    registrationId: "r",
    installationId: "i",
    deviceToken: FCM_TOKEN,
    message: { data: { serverId: "s" } },
  });
  assert.deepEqual(result, { status: "skipped", reason: "provider_not_configured" });
  assert.equal(calls, 0);
  assert.equal(provider.isConfigured(), false);
});

test("configured FCM provider sends an HTTP v1 data message with the message priority and maps errors", async () => {
  const requests: Parameters<FcmHttpClient>[0][] = [];
  let nextResponse = { statusCode: 200, body: "{\"name\":\"projects/raft-mobile/messages/1\"}" };
  const provider = new ConfiguredFcmPushProvider(
    () => async (request) => {
      requests.push(request);
      return nextResponse;
    },
    () => ({ projectId: "raft-mobile", getAccessToken: async () => "access-token" }),
  );
  const input: FcmDeliveryInput = {
    registrationId: "r",
    installationId: "i",
    deviceToken: FCM_TOKEN,
    message: { data: { serverId: "s", title: "t" } },
  };

  assert.deepEqual(await provider.send(input), { status: "sent" });
  assert.equal(requests[0].url, "https://fcm.googleapis.com/v1/projects/raft-mobile/messages:send");
  assert.equal(requests[0].headers.authorization, "Bearer access-token");
  assert.deepEqual(JSON.parse(requests[0].body), {
    message: {
      fid: FCM_TOKEN,
      data: { serverId: "s", title: "t" },
      android: { priority: "HIGH", ttl: "3600s" },
    },
  }, "a message without priority stays HIGH like before");

  await provider.send({ ...input, message: fcmBackgroundMessage({ type: "sync", badge: 1 }) });
  assert.deepEqual(JSON.parse(requests[1].body).message.android, { priority: "NORMAL", ttl: "3600s" });
  assert.equal("priority" in JSON.parse(requests[1].body).message.data, false, "android.priority is not a data key");

  nextResponse = {
    statusCode: 404,
    body: JSON.stringify({
      error: {
        code: 404,
        status: "NOT_FOUND",
        details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
      },
    }),
  };
  await assert.rejects(provider.send(input), (err: unknown) => {
    assert.ok(err instanceof FcmDeliveryError);
    assert.equal(err.statusCode, 404);
    assert.equal(err.reason, "UNREGISTERED");
    return true;
  });
});

test("FCM error reason prefers the FCM errorCode over the RPC status", () => {
  assert.equal(parseFcmErrorReason(JSON.stringify({ error: { status: "INVALID_ARGUMENT" } })), "INVALID_ARGUMENT");
  assert.equal(parseFcmErrorReason(JSON.stringify({
    error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] },
  })), "SENDER_ID_MISMATCH");
  assert.equal(parseFcmErrorReason("not json"), undefined);
  assert.equal(parseFcmErrorReason(""), undefined);
});

test("production refuses a service account key and accepts only a federation config", async () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    credentials: process.env.FCM_CREDENTIALS_JSON,
    projectId: process.env.FCM_PROJECT_ID,
  };
  try {
    __resetFcmTransportForTests();
    process.env.NODE_ENV = "production";
    process.env.FCM_PROJECT_ID = "raft-mobile";
    process.env.FCM_CREDENTIALS_JSON = JSON.stringify({ type: "service_account", project_id: "raft-mobile" });
    assert.equal(fcmAccessTokenSourceFromEnv(), null, "a key JSON must not become the production credential");

    process.env.FCM_CREDENTIALS_JSON = JSON.stringify({
      type: "external_account",
      audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/aws",
      subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: { environment_id: "aws1" },
    });
    assert.equal(fcmAccessTokenSourceFromEnv()?.projectId, "raft-mobile");
  } finally {
    for (const [name, value] of [
      ["NODE_ENV", previous.nodeEnv],
      ["FCM_CREDENTIALS_JSON", previous.credentials],
      ["FCM_PROJECT_ID", previous.projectId],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    __resetFcmTransportForTests();
  }
});

test("a failed credential exchange is classified without its message text", async () => {
  const exchangeError = Object.assign(new Error("caller arn:aws:sts::1:assumed-role/x is not allowed"), {
    response: { status: 400, data: { error: "invalid_grant", error_description: "secretish detail" } },
  });
  let fcmCalls = 0;
  const provider = new ConfiguredFcmPushProvider(
    () => async () => {
      fcmCalls += 1;
      return { statusCode: 200, body: "{}" };
    },
    () => ({ projectId: "raft-mobile", getAccessToken: async () => { throw exchangeError; } }),
  );
  await assert.rejects(provider.send({
    registrationId: "r",
    installationId: "i",
    deviceToken: FCM_TOKEN,
    message: { data: {} },
  }), (err: unknown) => {
    assert.ok(err instanceof FcmDeliveryError);
    assert.equal(err.reason, "credential_exchange_failed:invalid_grant");
    assert.equal(err.statusCode, 400);
    assert.doesNotMatch(String(err.reason), /arn:|secretish/);
    assert.equal(isTerminalFcmTokenError(new FcmDeliveryError("x", { statusCode: 404, reason: "credential_exchange_failed:not_found" })), false,
      "a token-exchange 404 must never revoke the device registration");
    return true;
  });
  assert.equal(fcmCalls, 0, "FCM is not called without a token");
});

test("a very long notification fits the FCM data limit; the identity keys are kept", () => {
  const built = oversizedTaskNotification();
  const message = fcmAlertMessage(built, 99, { serverBadge: 12, testId: "t-1" });
  const size = Buffer.byteLength(JSON.stringify(message.data), "utf8");
  assert.ok(size <= FCM_DATA_MAX_BYTES, `data is ${size} bytes`);
  assert.equal(message.data.id, built.envelope.id);
  assert.equal(message.data.groupKey, built.envelope.groupKey);
  assert.equal(message.data.routeUrl, built.routeUrl);
  assert.ok(message.data.title.length > 0 && message.data.body.length > 0);
  assert.equal(fcmAlertMessage(channelNotification(), 1).data.body, "Alice: hello", "within the budget nothing is cut");
});

test("the boot prefetch runs the token exchange once and the first send reuses it", async () => {
  let exchanges = 0;
  let cached: string | null = null;
  const provider = new ConfiguredFcmPushProvider(
    () => async () => ({ statusCode: 200, body: "{}" }),
    () => ({
      projectId: "raft-mobile",
      getAccessToken: async () => {
        if (cached) return cached;
        exchanges += 1;
        cached = "token";
        return cached;
      },
    }),
  );
  assert.equal(await provider.prefetchAccessToken(), "warmed");
  await provider.send({ registrationId: "r", installationId: "i", deviceToken: FCM_TOKEN, message: { data: {} } });
  assert.equal(exchanges, 1);

  const unconfigured = new ConfiguredFcmPushProvider(() => async () => ({ statusCode: 200, body: "{}" }), () => null);
  assert.equal(await unconfigured.prefetchAccessToken(), "not_configured");
});
