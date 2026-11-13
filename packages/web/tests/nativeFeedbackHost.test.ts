import assert from "node:assert/strict";
import { AxiosHeaders } from "axios";
import type { AxiosAdapter } from "axios";
import { createNativeFeedbackClient, parseFeedbackHost, readFeedbackHost } from "../src/feedback/standalone/host";
import type { FeedbackHost, FeedbackHostEvent } from "../src/feedback/standalone/host";
import { createHandsFeedbackTransport } from "../src/feedback/createHandsFeedbackTransport";
const origin = "https://raft.test";
function fixture() {
  const events: FeedbackHostEvent[] = [];
  const host: FeedbackHost = { version: "raft-feedback-v1", session: {
    accountId: "synthetic", sessionGeneration: 1, webViewGeneration: 2,
    accessToken: "synthetic-token", apiOrigin: origin, clientKind: "android", clientVersion: "1.13.0", locale: "zh-CN", theme: "brutal", mode: "light",
  }, emit: event => events.push(event) };
  return { host, events };
}
test("host validation rejects unsupported identity/origin before network", () => {
  const { host } = fixture();
  assert.equal(parseFeedbackHost(host, origin), host);
  for (const patch of [{ apiOrigin: "https://evil.test" }, { apiOrigin: `${origin}/api` }, { clientKind: "" }, { clientKind: "bad\nkind" }, { clientKind: 7 }, { accessToken: "bad\nheader" }, { sessionGeneration: -1 }, { clientVersion: "" }]) {
    assert.equal(parseFeedbackHost({ ...host, session: { ...host.session, ...patch } }, origin), null);
  }
  assert.equal(parseFeedbackHost(null, origin), null);
  // The page does not decide which clients exist: every well-formed kind passes and
  // reaches the Server unchanged, which answers 400 for kinds it does not accept.
  for (const clientKind of ["android", "ios", "ohos", "web", "some-future-client"]) {
    const named = { ...host, session: { ...host.session, clientKind } };
    assert.equal(parseFeedbackHost(named, origin), named, clientKind);
  }
  // Every locale the page ships copy for is accepted; anything else (a raw
  // navigator.language like `en-US`) is still rejected, as before.
  for (const locale of ["en", "zh-CN", "ja", "ko"]) {
    const localized = { ...host, session: { ...host.session, locale } } as FeedbackHost;
    assert.equal(parseFeedbackHost(localized, origin), localized, locale);
  }
  for (const locale of ["en-US", "zh-cn", "ja-JP", "fr"]) {
    assert.equal(parseFeedbackHost({ ...host, session: { ...host.session, locale } }, origin), null, locale);
  }
  const crossOrigin = { ...host, session: { ...host.session, apiOrigin: "https://api.raft.test" } };
  assert.equal(parseFeedbackHost(crossOrigin, origin, "https://api.raft.test"), crossOrigin);
  assert.equal(parseFeedbackHost(crossOrigin, origin, "https://other.raft.test"), null);
});
test("every feedback operation receives current native token and source; arbitrary routes cannot receive credentials", async () => {
  const { host } = fixture();
  const client = createNativeFeedbackClient(host, () => host);
  const paths: string[] = [];
  const adapter: AxiosAdapter = async config => {
    assert.equal(config.headers.get("Authorization"), `Bearer ${host.session.accessToken}`);
    assert.equal(config.headers.get("X-Raft-Client-Kind"), "android");
    assert.equal(config.headers.get("Accept-Language"), "zh-CN");
    paths.push(config.url!);
    return { data: {}, status: 200, statusText: "OK", headers: new AxiosHeaders(), config };
  };
  client.defaults.adapter = adapter;
  for (const url of ["/product-feedback", "/product-feedback/tickets", "/product-feedback/tickets/id", "/product-feedback/tickets/id/comments", "/product-feedback/tickets/id/close", "/product-feedback/tickets/id/attachments/a"]) await client.get(url);
  host.session = { ...host.session, accessToken: "rotated-token" };
  await client.get("/product-feedback/tickets");
  await assert.rejects(client.get("https://evil.test/product-feedback"), /feedback_route_not_allowed/);
  await assert.rejects(client.get("/auth/me"), /feedback_route_not_allowed/);
  await assert.rejects(client.get("/product-feedback", { baseURL: "https://evil.test" }), /feedback_origin_not_allowed/);
  assert.equal(paths.length, 7);
});
test("the host's client kind reaches the Server unchanged, whatever it is", async () => {
  for (const clientKind of ["ios", "ohos", "some-future-client"]) {
    const { host } = fixture();
    host.session = { ...host.session, clientKind };
    const client = createNativeFeedbackClient(host, () => host);
    const kinds: unknown[] = [];
    client.defaults.adapter = async config => {
      kinds.push(config.headers.get("X-Raft-Client-Kind"));
      return { data: {}, status: 200, statusText: "OK", headers: new AxiosHeaders(), config };
    };
    await client.get("/product-feedback/tickets");
    assert.deepEqual(kinds, [clientKind]);
  }
});
test("account switch fences pending responses and subsequent requests", async () => {
  const { host, events } = fixture();
  let current = host;
  const client = createNativeFeedbackClient(host, () => current);
  let calls = 0;
  client.defaults.adapter = async config => {
    calls++;
    current = { ...host, session: { ...host.session, accountId: "different" } };
    return { data: { secret: "old-account" }, status: 200, statusText: "OK", headers: new AxiosHeaders(), config };
  };
  await assert.rejects(client.get("/product-feedback/tickets"), /feedback_host_session_changed/);
  await assert.rejects(client.get("/product-feedback/tickets"), /feedback_host_session_changed/);
  assert.equal(calls, 1);
  assert.ok(events.includes("close"));
});
test("auth expiry and explicit 503 notify host, without mutation retry; other errors do not request fallback", async () => {
  const { host, events } = fixture();
  const client = createNativeFeedbackClient(host, () => host);
  let calls = 0;
  let status = 401;
  let code = "auth_required";
  client.defaults.adapter = async config => {
    calls++;
    throw { config, response: { status, data: { code } } };
  };
  await assert.rejects(client.post("/product-feedback", {}));
  assert.deepEqual(events, ["auth-required"]);
  status = 503; code = "unrelated";
  await assert.rejects(client.get("/product-feedback/tickets"));
  assert.deepEqual(events, ["auth-required"]);
  code = "feedback_integration_unavailable";
  await assert.rejects(client.get("/product-feedback/tickets"));
  await assert.rejects(client.get("/product-feedback/tickets"));
  assert.deepEqual(events, ["auth-required", "integration-unavailable"]);
  assert.equal(calls, 4);
});
test("native submission metadata is sent through shared Web transport", async () => {
  const { host } = fixture();
  const client = createNativeFeedbackClient(host, () => host);
  client.defaults.adapter = async config => {
    assert.equal(config.url, "/product-feedback");
    const form = config.data as FormData;
    assert.deepEqual(JSON.parse(String(form.get("metadata"))), { client_kind: "android", platform: "android", client_version: "1.13.0" });
    throw { config, response: { status: 503, data: { code: "feedback_integration_unavailable" } } };
  };
  const transport = createHandsFeedbackTransport(client, { metadata: async () => ({ client_kind: host.session.clientKind, platform: host.session.clientKind, client_version: host.session.clientVersion }) });
  await assert.rejects(transport.createTicket({ kind: "bug", message: "synthetic", attachments: [], submissionId: "synthetic-id" }));
});

test("request cancellation works without AbortSignal.any", async () => {
  const { host } = fixture();
  const client = createNativeFeedbackClient(host, () => host);
  const controller = new AbortController();
  client.defaults.adapter = async config => {
    assert.equal(config.signal?.aborted, false);
    controller.abort();
    assert.equal(config.signal?.aborted, true);
    throw new Error("synthetic cancelled");
  };
  await assert.rejects(client.get("/product-feedback/tickets", { signal: controller.signal }));
});

test("read host preserves bound optional diagnostics methods, and old hosts remain compatible", () => {
  const { host } = fixture();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: string[] = [];
  const diagnostics = { marker: "bound", start(this: { marker: string }) { calls.push(this.marker); }, cancel(this: { marker: string }) { calls.push(this.marker); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin }, RaftFeedback: { ...host, capabilities: ["diagnostics-upload-v1"], diagnostics } } });
  try {
    const read = readFeedbackHost()!;
    assert.deepEqual(read.capabilities, ["diagnostics-upload-v1"]);
    read.diagnostics!.start({ requestId: "a" }, host.session); read.diagnostics!.cancel({ requestId: "a" }, host.session);
    assert.deepEqual(calls, ["bound", "bound"]);
    (globalThis as unknown as { window: { RaftFeedback: FeedbackHost } }).window.RaftFeedback = host;
    assert.equal(readFeedbackHost()!.diagnostics, undefined);
  } finally { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); }
});
