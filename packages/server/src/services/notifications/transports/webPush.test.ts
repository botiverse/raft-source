import assert from "node:assert/strict";
import { Agent as HttpsAgent } from "node:https";
import type { WebPushSubscriptionTarget } from "../types";
import {
  WEB_PUSH_LOOKUP_TIMEOUT_MS,
  WEB_PUSH_REQUEST_TIMEOUT_MS,
  WebPushEndpointRemovedError,
  WebPushEndpointRejectedError,
  WebPushNetworkError,
  WebPushRequestError,
  WebPushSubscriptionGoneError,
  __resetWebPushRuntimeForTests,
  __setWebPushRuntimeForTests,
  fitWebPushPayload,
  isAllowedWebPushEndpoint,
  webPushEndpointHostname,
  webPushFailureDetail,
  webPushBodyExcerpt,
  webPushPayload,
  webPushService,
  webPushServiceLabel,
  webPushTransport,
  pushEndpointHash,
} from "./webPush";
import { WEB_PUSH_PAYLOAD_MAX_BYTES } from "./payloadBudget";
import { CHANNEL_ID, MESSAGE_ID, SERVER_ID, channelNotification, oversizedTaskNotification } from "./testFixtures";

function subscription(endpoint: string): WebPushSubscriptionTarget {
  return {
    id: "subscription-1",
    userId: "user-1",
    endpoint,
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  };
}

const PAYLOAD = { title: "t", body: "b" };

afterEach(() => {
  __resetWebPushRuntimeForTests();
});

test("endpoints that are not a public HTTPS host are rejected as terminal without contacting them", async () => {
  const resolved: string[] = [];
  let sends = 0;
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async (hostname) => {
      resolved.push(hostname);
      return [{ address: "10.0.0.5", family: 4 }];
    },
    sendNotification: async () => {
      sends += 1;
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  for (const endpoint of [
    "https://fcm.googleapis.com/sub/private-range",
    "http://updates.push.services.mozilla.com/wpush/v2/plain-http",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/sub/loopback",
    "https://push.internal/sub/internal-suffix",
  ]) {
    await assert.rejects(webPushTransport.send(subscription(endpoint), PAYLOAD), (err: unknown) => {
      assert.ok(err instanceof WebPushEndpointRejectedError, endpoint);
      assert.equal(webPushTransport.isTerminalTargetError(err), true, "the caller deletes the subscription");
      assert.equal(webPushTransport.isNonRetryable(err), true);
      return true;
    });
  }
  assert.equal(sends, 0, "no push endpoint may be contacted");
  assert.deepEqual(resolved, ["fcm.googleapis.com"], "only a syntactically acceptable host reaches DNS");
});

test("a name resolution failure is transient: not terminal, retryable", async () => {
  let sends = 0;
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => {
      throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    },
    sendNotification: async () => {
      sends += 1;
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  await assert.rejects(webPushTransport.send(subscription("https://fcm.googleapis.com/fcm/send/transient"), PAYLOAD), (err: unknown) => {
    assert.equal(webPushTransport.isTerminalTargetError(err), false, "the subscription is kept");
    assert.equal(webPushTransport.isNonRetryable(err), false);
    return true;
  });
  assert.equal(sends, 0);
});

test("delivery pins the connection to the public address the endpoint resolved to", async () => {
  const lookups: Array<{ hostname: string; options: unknown }> = [];
  const sends: Array<{ endpoint: string; payload: unknown; options: Record<string, unknown> | undefined }> = [];
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async (hostname, options) => {
      lookups.push({ hostname, options });
      return [
        { address: "142.250.72.10", family: 4 },
        { address: "2607:f8b0:4004:c07::5f", family: 6 },
      ];
    },
    sendNotification: async (target, payload, options) => {
      sends.push({ endpoint: target.endpoint, payload, options: options as Record<string, unknown> | undefined });
      return { statusCode: 201, body: "", headers: {} };
    },
  });

  const result = await webPushTransport.send(subscription("https://fcm.googleapis.com/fcm/send/pinned"), PAYLOAD);

  assert.deepEqual(result, { status: "sent" });
  assert.deepEqual(lookups, [{ hostname: "fcm.googleapis.com", options: { all: true, verbatim: true } }]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].endpoint, "https://fcm.googleapis.com/fcm/send/pinned");
  assert.equal(sends[0].payload, JSON.stringify(PAYLOAD));
  assert.equal(sends[0].options?.TTL, 3600);
  const agent = sends[0].options?.agent;
  assert.ok(agent instanceof HttpsAgent, "delivery must go through an https.Agent the transport controls");
  const pinnedLookup = agent.options.lookup as unknown as (
    hostname: string,
    options: { all: boolean },
    callback: (error: Error | null, ...rest: unknown[]) => void,
  ) => void;
  const single = await new Promise<unknown[]>((resolve) => {
    pinnedLookup("fcm.googleapis.com", { all: false }, (_error, ...rest) => resolve(rest));
  });
  assert.deepEqual(single, ["142.250.72.10", 4], "the socket connects to the address that passed the check");
  const all = await new Promise<unknown[]>((resolve) => {
    pinnedLookup("fcm.googleapis.com", { all: true }, (_error, ...rest) => resolve(rest));
  });
  assert.deepEqual(all, [[{ address: "142.250.72.10", family: 4 }]]);
});

test("404 and 410 are terminal (the caller deletes the subscription); other failures are classified", async () => {
  let status = 410;
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "142.250.72.10", family: 4 }],
    sendNotification: async () => {
      throw Object.assign(new Error("push service error"), { statusCode: status });
    },
  });
  const target = subscription("https://fcm.googleapis.com/fcm/send/gone");
  for (const gone of [404, 410]) {
    status = gone;
    await assert.rejects(webPushTransport.send(target, PAYLOAD), (err: unknown) => {
      assert.ok(err instanceof WebPushSubscriptionGoneError);
      assert.equal(err.statusCode, gone);
      assert.equal(webPushTransport.isTerminalTargetError(err), true);
      return true;
    });
  }
  status = 413;
  await assert.rejects(webPushTransport.send(target, PAYLOAD), (err: unknown) => {
    assert.equal(webPushTransport.isTerminalTargetError(err), false);
    assert.equal(webPushTransport.isNonRetryable(err), true, "an oversized payload cannot succeed on retry");
    return true;
  });
  for (const transient of [429, 500, 503]) {
    status = transient;
    await assert.rejects(webPushTransport.send(target, PAYLOAD), (err: unknown) => {
      assert.equal(webPushTransport.isTerminalTargetError(err), false);
      assert.equal(webPushTransport.isNonRetryable(err), false, `${transient} is retried`);
      return true;
    });
  }
});

test("without VAPID keys the transport skips without resolving or sending", async () => {
  let calls = 0;
  __setWebPushRuntimeForTests({
    enabled: false,
    lookup: async () => {
      calls += 1;
      return [];
    },
  });
  assert.equal(webPushTransport.isConfigured(), false);
  assert.deepEqual(
    await webPushTransport.send(subscription("https://fcm.googleapis.com/fcm/send/x"), PAYLOAD),
    { status: "skipped", reason: "provider_not_configured" },
  );
  assert.equal(calls, 0);
});

test("the payload is the envelope in push text style, tagged by conversation, with an absolute url", () => {
  const built = channelNotification();
  const payload = webPushPayload(built, "https://app.raft.build");
  assert.equal(payload.title, "#general · Acme", "no subtitle on the web: the server label (2+ servers) joins the title");
  assert.equal(payload.body, "Alice: hello");
  assert.equal(payload.tag, `${SERVER_ID}:${CHANNEL_ID}`);
  assert.equal(payload.groupKey, `${SERVER_ID}:${CHANNEL_ID}`);
  assert.equal(payload.renotify, true);
  assert.equal(payload.silent, false);
  assert.equal(payload.url, `https://app.raft.build/s/acme/channel/${CHANNEL_ID}?msg=${MESSAGE_ID}`);
  assert.equal(payload.id, `message:${MESSAGE_ID}`);
  assert.equal(payload.seq, 7);
  assert.equal(payload.v, 1);
  assert.equal(payload.category, "channel");
  assert.equal(payload.previewMode, "full");
  assert.deepEqual(payload.route, built.envelope.route);
  assert.equal("testId" in payload, false);

  // A single-server receiver has no subtitle: the title alone.
  const singleServer = webPushPayload(channelNotification({ envelope: { subtitle: undefined }, push: { subtitle: undefined } }), "https://app.raft.build");
  assert.equal(singleServer.title, "#general");

  const silentTest = webPushPayload(channelNotification({ envelope: { silent: true } }), "https://app.raft.build", { testId: "t-1" });
  assert.equal(silentTest.silent, true);
  assert.equal(silentTest.testId, "t-1");
});

test("webPushEndpointHostname accepts only public HTTPS DNS names", () => {
  assert.equal(webPushEndpointHostname("https://fcm.googleapis.com/fcm/send/x"), "fcm.googleapis.com");
  assert.equal(webPushEndpointHostname("https://Updates.Push.Services.Mozilla.com./x"), "updates.push.services.mozilla.com");
  for (const bad of ["http://fcm.googleapis.com/x", "https://user:pw@fcm.googleapis.com/x", "https://10.0.0.1/x", "https://localhost/x", "https://a.local/x", "not a url", 42]) {
    assert.equal(webPushEndpointHostname(bad), null, String(bad));
  }
});

test("a very long notification fits the Web Push budget and keeps what the service worker reads", () => {
  const built = oversizedTaskNotification();
  const unbounded = Buffer.byteLength(JSON.stringify({ ...built.envelope, title: built.push.title, body: built.push.body }), "utf8");
  assert.ok(unbounded > 4_096, `the fixture must exceed the push service limit (${unbounded} bytes)`);

  const payload = webPushPayload(built, "https://app.raft.build", { testId: "t-1" });
  const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
  assert.ok(size <= WEB_PUSH_PAYLOAD_MAX_BYTES, `payload is ${size} bytes`);
  assert.equal("task" in payload, false, "optional fields go first");
  assert.equal(payload.url, `https://app.raft.build${built.routeUrl}`);
  assert.equal(payload.groupKey, built.envelope.groupKey);
  assert.equal(payload.tag, built.envelope.groupKey);
  assert.equal(payload.id, built.envelope.id);
  assert.equal(payload.seq, built.envelope.seq);
  assert.equal(payload.testId, "t-1");
  assert.ok(typeof payload.title === "string" && payload.title.length > 0);
  assert.ok(typeof payload.body === "string" && payload.body.length > 0);

  // A notification within the budget is sent whole.
  const small = webPushPayload(channelNotification(), "https://app.raft.build");
  assert.deepEqual(small.route, channelNotification().envelope.route);
  assert.deepEqual(small.sender, channelNotification().envelope.sender);
});

test("the envelope's localization rides along and is the first field dropped over budget", () => {
  const localization = { titleKey: "push.title.thread_in_channel", titleArgs: ["general"] };
  const built = channelNotification({ envelope: { title: "Thread in #general", localization }, push: { title: "Thread in #general", localization } });
  assert.deepEqual(webPushPayload(built, "https://app.raft.build").localization, localization);
  const fitted = fitWebPushPayload({ title: "T", body: "B", url: "u", groupKey: "g", localization, task: { id: "t" } }, 80);
  assert.equal("localization" in fitted, false);
  assert.deepEqual(fitted.task, { id: "t" }, "dropped before the task");
});

test("fitWebPushPayload cuts the body before the title when dropping fields is not enough", () => {
  const fitted = fitWebPushPayload({ title: "Title", body: "漢".repeat(2_000), url: "https://app.raft.build/x", groupKey: "g" }, 1_000);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), "utf8") <= 1_000);
  assert.equal(fitted.title, "Title");
  assert.ok(String(fitted.body).endsWith("…"));
});

test("requests carry a socket timeout so a silent push service cannot hold the drain", async () => {
  let options: Record<string, unknown> | undefined;
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "142.250.72.10", family: 4 }],
    sendNotification: async (_target, _payload, sendOptions) => {
      options = sendOptions as Record<string, unknown>;
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  await webPushTransport.send(subscription("https://fcm.googleapis.com/fcm/send/timeout"), PAYLOAD);
  assert.equal(options?.timeout, WEB_PUSH_REQUEST_TIMEOUT_MS);
  // A socket timeout carries no status: transient, retried, subscription kept.
  const timeout = new Error("Socket timeout");
  assert.equal(webPushTransport.isTerminalTargetError(timeout), false);
  assert.equal(webPushTransport.isNonRetryable(timeout), false);
});

function webPushError(statusCode: number, body: string) {
  // The shape web-push's WebPushError has.
  return Object.assign(new Error("Received unexpected response code"), { statusCode, body, headers: {}, endpoint: "redacted" });
}

test("a subscription made for another VAPID key is deleted like 404 / 410", async () => {
  let failure = webPushError(403, "");
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "17.188.0.1", family: 4 }],
    sendNotification: async () => {
      throw failure;
    },
  });
  const cases: Array<{ endpoint: string; status: number; body: string; reason: string }> = [
    { endpoint: "https://web.push.apple.com/QAbc", status: 403, body: JSON.stringify({ reason: "VapidPkHashMismatch" }), reason: "status_403:apple:VapidPkHashMismatch" },
    {
      endpoint: "https://fcm.googleapis.com/fcm/send/stale",
      status: 403,
      body: "the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.\n",
      reason: "status_403:fcm:credentials_mismatch",
    },
    { endpoint: "https://fcm.googleapis.com/fcm/send/stale", status: 400, body: "<HTML><TITLE>UnauthorizedRegistration</TITLE></HTML>", reason: "status_400:fcm:UnauthorizedRegistration" },
  ];
  for (const { endpoint, status, body, reason } of cases) {
    failure = webPushError(status, body);
    await assert.rejects(webPushTransport.send(subscription(endpoint), PAYLOAD), (err: unknown) => {
      assert.ok(err instanceof WebPushRequestError, reason);
      assert.equal(err.reason, reason);
      assert.equal(err.statusCode, status);
      assert.equal(webPushTransport.isTerminalTargetError(err), true, `${reason}: the caller deletes the subscription`);
      return true;
    });
  }
});

test("a 403 / 400 without a key-mismatch reason is dropped, not retried, and keeps the subscription", async () => {
  let failure = webPushError(403, "");
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "34.120.0.1", family: 4 }],
    sendNotification: async () => {
      throw failure;
    },
  });
  const cases: Array<{ endpoint: string; status: number; body: string; reason: string }> = [
    // An invalid VAPID JWT is the server's own problem: deleting would wipe every subscription.
    { endpoint: "https://web.push.apple.com/QAbc", status: 403, body: JSON.stringify({ reason: "BadJwtToken" }), reason: "status_403:apple:BadJwtToken" },
    { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", status: 400, body: JSON.stringify({ code: 400, errno: 111, error: "Bad Request" }), reason: "status_400:mozilla:errno_111" },
    { endpoint: "https://fcm.googleapis.com/fcm/send/x", status: 403, body: "", reason: "status_403:fcm:empty_body" },
    { endpoint: "https://fcm.googleapis.com/fcm/send/x", status: 413, body: "", reason: "status_413:fcm:empty_body" },
  ];
  for (const { endpoint, status, body, reason } of cases) {
    failure = webPushError(status, body);
    await assert.rejects(webPushTransport.send(subscription(endpoint), PAYLOAD), (err: unknown) => {
      assert.ok(err instanceof WebPushRequestError, reason);
      assert.equal(err.reason, reason);
      assert.equal(webPushTransport.isTerminalTargetError(err), false, `${reason}: the subscription is kept`);
      assert.equal(webPushTransport.isNonRetryable(err), true, `${reason}: the same request cannot succeed`);
      return true;
    });
  }
});

test("webPushFailureDetail never returns free text", () => {
  assert.equal(webPushFailureDetail(JSON.stringify({ reason: "user@example.com said no" })), null);
  assert.equal(webPushFailureDetail("some arbitrary html"), null);
  assert.equal(webPushFailureDetail(undefined), null);
  assert.equal(webPushService("https://wns2-by3p.notify.windows.com/w/?token=x"), "wns");
  assert.equal(webPushService("https://push.example.org/x"), "other");
});

test("a rejection whose body is not recognised records a scrubbed excerpt of it, or that it was empty", async () => {
  let failure = webPushError(403, "");
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "142.250.72.10", family: 4 }],
    sendNotification: async () => {
      throw failure;
    },
  });
  const secretPath = "dGhpcy1pcy1hLXN1YnNjcmlwdGlvbi1jYXBhYmlsaXR5LXRva2Vu";
  const endpoint = `https://fcm.googleapis.com/fcm/send/${secretPath}`;
  const cases: Array<{ body: string; reason: string }> = [
    { body: "", reason: "status_403:fcm:empty_body" },
    { body: "  \n ", reason: "status_403:fcm:empty_body" },
    {
      body: "<html><body><h1>403 Forbidden</h1>Request forbidden by administrative rules.</body></html>",
      reason: "status_403:fcm:text(403 Forbidden Request forbidden by administrativ)",
    },
    {
      body: `Invalid subscription https://fcm.googleapis.com/fcm/send/${secretPath} for user someone@example.com`,
      reason: "status_403:fcm:text(Invalid subscription fcm.googleapis.com for user)",
    },
  ];
  for (const { body, reason } of cases) {
    failure = webPushError(403, body);
    await assert.rejects(webPushTransport.send(subscription(endpoint), PAYLOAD), (err: unknown) => {
      assert.ok(err instanceof WebPushRequestError, reason);
      assert.equal(err.reason, reason);
      assert.ok(!err.reason.includes(secretPath), "the endpoint path never reaches the reason");
      assert.ok(!err.reason.includes("someone@example.com"), "an email never reaches the reason");
      assert.equal(webPushTransport.isTerminalTargetError(err), false);
      assert.equal(webPushTransport.isNonRetryable(err), true);
      return true;
    });
  }
});

/** The push hosts of production's subscriptions (read-only read, 2026-11-01 19:21Z). */
const PRODUCTION_PUSH_HOSTS: ReadonlyArray<{ host: string; allowed: boolean }> = [
  { host: "fcm.googleapis.com", allowed: true },
  { host: "web.push.apple.com", allowed: true },
  ...["sg2p", "by3p", "pn1p", "db5p", "bn3p", "par02p", "ch1p", "ln2p", "bl2p", "am3p"]
    .map((shard) => ({ host: `wns2-${shard}.notify.windows.com`, allowed: true })),
  { host: "jmt17.google.com", allowed: true },
  { host: "updates.push.services.mozilla.com", allowed: true },
  { host: "permanently-removed.invalid", allowed: false },
  { host: "push.vgent.dev", allowed: false },
  { host: "test.push.service", allowed: false },
];

test("exactly the known push services of production's subscriptions are allowed", () => {
  for (const { host, allowed } of PRODUCTION_PUSH_HOSTS) {
    assert.equal(isAllowedWebPushEndpoint(`https://${host}/fcm/send/abc`), allowed, host);
  }
  // Exact Google hosts only, never every google.com / googleapis.com name.
  for (const host of ["android.googleapis.com"]) assert.equal(isAllowedWebPushEndpoint(`https://${host}/gcm/send/x`), true, host);
  for (const host of ["mail.google.com", "jmt18.google.com", "storage.googleapis.com", "api.push.apple.com", "fcm.googleapis.com.evil.example"]) {
    assert.equal(isAllowedWebPushEndpoint(`https://${host}/x`), false, host);
  }
  assert.equal(isAllowedWebPushEndpoint("not a url"), false);
  assert.equal(webPushService("https://jmt17.google.com/fcm/send/x"), "fcm");
});

test("a subscription on an unsupported host is skipped and kept, never resolved or contacted", async () => {
  let contacted = 0;
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => {
      contacted += 1;
      return [{ address: "142.250.72.10", family: 4 }];
    },
    sendNotification: async () => {
      contacted += 1;
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  for (const host of ["push.vgent.dev", "test.push.service"]) {
    assert.deepEqual(
      await webPushTransport.send(subscription(`https://${host}/push/secret-path`), PAYLOAD),
      { status: "skipped", reason: `unsupported_host:${host}` },
    );
  }
  assert.equal(contacted, 0);
});

test("a browser-removed subscription (.invalid host) is deleted without being contacted", async () => {
  let contacted = 0;
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => {
      contacted += 1;
      return [];
    },
    sendNotification: async () => {
      contacted += 1;
      return { statusCode: 201, body: "", headers: {} };
    },
  });
  await assert.rejects(webPushTransport.send(subscription("https://permanently-removed.invalid/fcm/send/x"), PAYLOAD), (err: unknown) => {
    assert.ok(err instanceof WebPushEndpointRemovedError);
    assert.equal(err.reason, "endpoint_removed");
    assert.equal(webPushTransport.isTerminalTargetError(err), true, "the caller deletes the subscription");
    return true;
  });
  assert.equal(contacted, 0);
});

test("webPushBodyExcerpt removes tokens, keys and emails and stays short", () => {
  const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL2ZjbS5nb29nbGVhcGlzLmNvbSJ9.c2lnbmF0dXJl";
  const excerpt = webPushBodyExcerpt(`bad token ${jwt} key BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQt from a@b.co`);
  assert.equal(excerpt, "text(bad token <redacted> key <redacted> from <email>)");
  assert.ok(webPushBodyExcerpt("x".repeat(500)).length <= "text()".length + 48);
  assert.equal(webPushBodyExcerpt("\u0000\u0001"), "unreadable_body");
  assert.equal(webPushBodyExcerpt(undefined), "empty_body");
  assert.equal(webPushServiceLabel("https://fcm.googleapis.com/fcm/send/x"), "fcm");
  assert.equal(webPushServiceLabel("https://push.example.org/x/y?z=1"), "other=push.example.org");
});

test("a push host lookup that hangs fails as a transient network error within its deadline", async () => {
  vi.useFakeTimers();
  try {
    let sends = 0;
    __setWebPushRuntimeForTests({
      enabled: true,
      lookup: () => new Promise(() => {}),
      sendNotification: async () => {
        sends += 1;
        return { statusCode: 201, body: "", headers: {} };
      },
    });
    const sent = webPushTransport.send(subscription("https://updates.push.services.mozilla.com/wpush/v2/x"), PAYLOAD);
    const checked = assert.rejects(sent, (err: unknown) => {
      assert.ok(err instanceof WebPushNetworkError);
      assert.equal(err.reason, "network_lookup_LOOKUP_TIMEOUT:mozilla");
      assert.equal(webPushTransport.isTerminalTargetError(err), false);
      assert.equal(webPushTransport.isNonRetryable(err), false);
      return true;
    });
    await vi.advanceTimersByTimeAsync(WEB_PUSH_LOOKUP_TIMEOUT_MS);
    await checked;
    assert.equal(sends, 0);
  } finally {
    vi.useRealTimers();
  }
});

test("a request that gets no answer is a transient network error naming the service", async () => {
  __setWebPushRuntimeForTests({
    enabled: true,
    lookup: async () => [{ address: "142.250.72.10", family: 4 }],
    sendNotification: async () => {
      throw new Error("Socket timeout");
    },
  });
  await assert.rejects(webPushTransport.send(subscription("https://fcm.googleapis.com/fcm/send/x"), PAYLOAD), (err: unknown) => {
    assert.ok(err instanceof WebPushNetworkError);
    assert.equal(err.reason, "network_socket_timeout:fcm");
    assert.equal(webPushTransport.isNonRetryable(err), false);
    return true;
  });
});

test("pushEndpointHash is the shared rule (the web computes the same: notificationPresenceReport.test.ts)", () => {
  assert.equal(pushEndpointHash("https://fcm.googleapis.com/fcm/send/vector"), "SqlB9EmZz4HGASE_");
});
