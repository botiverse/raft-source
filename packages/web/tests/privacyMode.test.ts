import assert from "node:assert/strict";

import api from "../src/api/client";
import { CLIENT_CONFIG_TIMEOUT_MS, loadClientConfig, resetClientConfigForTests } from "../src/store/clientConfig";
import { privacyModeState, resetPrivacyModeForTests, setPrivacyMode } from "../src/store/privacyMode";
import {
  emitAuthTrace,
  emitAuthTraceAndFlush,
  emitWebEventAndFlushBeforeUnload,
  flushAuthTraces,
  setAuthTraceFetchForTest,
  setAuthTracePrincipalIdGetter,
  setAuthTraceServerIdGetter,
  __resetAuthTraceForTest,
} from "../src/utils/webAuthTrace";
import { flushProductEvents, resetProductEventsForTest, setProductEventServerIdGetter, trackEvent } from "../src/analytics/track";
import { recordPublicVisit, setPublicVisitFetchForTest } from "../src/analytics/publicVisits";

// RAFT_PRIVACY_MODE on the web (store/privacyMode.ts): until the client config
// answers, telemetry is held and nothing is sent, urgent events included. "On"
// drops what was held; "off", a missing field (older server) or a failed read
// sends it. Nothing in the UI waits for the answer.

const originalGet = api.get.bind(api);

function withToken<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "slock_access_token" ? "token-1" : null) },
  });
  return run().finally(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
}

/** Answers the client config with `answer()` (a throw is a failed read); records the request's options. */
function stubClientConfig(answer: () => unknown) {
  const configs: unknown[] = [];
  api.get = (async (_url: string, config?: unknown) => {
    configs.push(config);
    return { data: answer() };
  }) as typeof api.get;
  return configs;
}

function recordingFetch() {
  const urls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.endsWith("/scope-attestation")) return new Response(JSON.stringify({ attestation: "att" }), { status: 200 });
    if (url.endsWith("/product-events/config")) return new Response(JSON.stringify({ clientEventsAllowed: true }), { status: 200 });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
  };
  return { urls, fetchImpl };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every kind of telemetry, before the config answers. */
async function emitEverything(delivered: boolean[], urls: string[]): Promise<void> {
  emitAuthTrace("slock.auth.verdict", { authVerdict: "keep-session" });
  emitAuthTraceAndFlush("slock.auth.verdict", { authVerdict: "logout" });
  await emitWebEventAndFlushBeforeUnload("slock.update_gate.decision", {
    eventKind: "decision", outcome: "decided", action: "recovery_finished", reason: "cleanup_completed",
    triggerSource: "error_boundary", cleanupFailureCount: 0,
  });
  trackEvent("community_cn_qr_page_view", { from: "direct" }, { onDelivery: (ok) => delivered.push(ok) });
  setPublicVisitFetchForTest(async (url) => { urls.push(url); });
  recordPublicVisit("acme", "public_page_viewed");
  // Flushes that fire before the answer send nothing either.
  await flushAuthTraces();
  await flushProductEvents();
  await settle();
}

beforeEach(() => {
  // tests/helpers/privacyModeOff.ts answered "off" for other tests; these start unanswered.
  resetPrivacyModeForTests();
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-1");
  setAuthTracePrincipalIdGetter(() => "user-1");
  setProductEventServerIdGetter(() => "server-1");
});

afterEach(() => {
  api.get = originalGet as typeof api.get;
  resetClientConfigForTests();
  setAuthTraceServerIdGetter(() => undefined);
  setAuthTracePrincipalIdGetter(() => undefined);
  __resetAuthTraceForTest();
  resetProductEventsForTest();
  setProductEventServerIdGetter(() => undefined);
  setPublicVisitFetchForTest(null);
  resetPrivacyModeForTests();
  setPrivacyMode(false);
});

test("the client config decides privacy mode once: only true is on; missing, odd or a failed read is off; the read has its own deadline", async () => {
  for (const [answer, expected] of [
    [() => ({ appHosts: [], privacyMode: true }), "on"],
    [() => ({ appHosts: [] }), "off"],
    [() => ({ privacyMode: "true" }), "off"],
    [() => null, "off"],
    [() => { throw new Error("Network Error"); }, "off"],
  ] as const) {
    resetClientConfigForTests();
    resetPrivacyModeForTests();
    assert.equal(privacyModeState(), "unknown");
    const configs = stubClientConfig(answer);
    await loadClientConfig();
    assert.equal(privacyModeState(), expected, String(answer));
    assert.deepEqual(configs, [{ timeout: CLIENT_CONFIG_TIMEOUT_MS }]);
  }
  // Decided once: an answered "on" is never turned off later.
  resetPrivacyModeForTests();
  setPrivacyMode(true);
  setPrivacyMode(false);
  assert.equal(privacyModeState(), "on");
});

test("privacy on: urgent events, queued traces, product events and visits from before the answer are never sent", () => withToken(async () => {
  const { urls, fetchImpl } = recordingFetch();
  setAuthTraceFetchForTest(fetchImpl);
  resetProductEventsForTest(fetchImpl);
  const delivered: boolean[] = [];
  await emitEverything(delivered, urls);
  assert.equal(urls.length, 0, "nothing leaves while unanswered");

  stubClientConfig(() => ({ privacyMode: true }));
  await loadClientConfig();
  emitAuthTraceAndFlush("slock.auth.verdict", { authVerdict: "logout" });
  await flushAuthTraces();
  await flushProductEvents();
  await settle();
  assert.equal(urls.length, 0);
  assert.deepEqual(delivered, [false], "a waiting caller is told it was dropped");
}));

for (const [name, answer] of [
  ["config says off (field missing, as from an older server)", () => ({ appHosts: [] })],
  ["config read fails", () => { throw new Error("Network Error"); }],
] as const) {
  test(`${name}: the held urgent events and the queued telemetry are sent`, () => withToken(async () => {
    const { urls, fetchImpl } = recordingFetch();
    setAuthTraceFetchForTest(fetchImpl);
    resetProductEventsForTest(fetchImpl);
    const delivered: boolean[] = [];
    await emitEverything(delivered, urls);
    assert.equal(urls.length, 0);

    stubClientConfig(answer);
    await loadClientConfig();
    await settle();
    await flushAuthTraces();
    await flushProductEvents();
    await settle();
    const traceSends = urls.filter((url) => url.endsWith("/api/web-traces")).length;
    assert.equal(traceSends, 3, "two held urgent events and the queued batch");
    assert.ok(urls.some((url) => url.endsWith("/product-events/batch")), "product events sent");
    assert.ok(urls.some((url) => url.includes("/public-visits/acme")), "public visit sent");
    assert.deepEqual(delivered, [true]);

    // Afterwards, as today: an urgent event goes out at once.
    emitAuthTraceAndFlush("slock.auth.verdict", { authVerdict: "logout" });
    await settle();
    await settle();
    assert.equal(urls.filter((url) => url.endsWith("/api/web-traces")).length, 4);
  }));
}
