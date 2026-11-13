import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { PiProviderCallTracker, type PiProviderCallEnded } from "./piProviderCallTracker";

const MODEL = { api: "openai-codex-responses", provider: "openai" };

type Hooks = {
  onResponse?: (response: { status?: unknown }, model: unknown) => unknown;
  onProviderStreamEvent?: (data: unknown, model: unknown) => unknown;
  onPayload?: (payload: unknown, model: unknown) => unknown;
};

function message(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: MODEL.api,
    provider: MODEL.provider,
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 0,
  } as AssistantMessage;
}

function harness() {
  let now = 1_000;
  const ended: PiProviderCallEnded[] = [];
  const tracker = new PiProviderCallTracker((row) => ended.push(row), () => now);
  return { tracker, ended, advance: (ms: number) => { now += ms; } };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a completed call ends once with its highest phase and timings, and the caller still reads every event", async () => {
  const h = harness();
  const stream = createAssistantMessageEventStream();
  let hooks: Hooks = {};
  const returned = h.tracker.observe(MODEL, {} as Hooks, (observed) => { hooks = observed; return stream; });
  assert.equal(returned, stream);

  h.advance(100);
  hooks.onResponse?.({ status: 200 }, MODEL);
  h.advance(50);
  hooks.onProviderStreamEvent?.({ type: "x" }, MODEL);
  const final = message("stop");
  stream.push({ type: "start", partial: final });
  stream.push({ type: "done", reason: "stop", message: final });
  stream.end();

  const seen: string[] = [];
  for await (const event of stream) seen.push(event.type);
  await flush();
  assert.deepEqual(seen, ["start", "done"]);
  assert.equal(h.ended.length, 1);
  assert.deepEqual(h.ended[0], {
    call_context: "outside_compaction",
    api: "openai-codex-responses",
    provider: "openai",
    outcome: "completed",
    phase: "streaming",
    http_responses_seen: 1,
    last_http_status: 200,
    duration_ms_bucket: "<1s",
    ms_to_headers_bucket: "<1s",
    ms_to_first_event_bucket: "<1s",
  });
});

test("an HTTP failure before any response headers ends as error with no headers seen", async () => {
  const h = harness();
  const stream = createAssistantMessageEventStream();
  h.tracker.observe(MODEL, {}, () => stream);
  const failed = message("error");
  stream.push({ type: "error", reason: "error", error: failed });
  stream.end();
  await flush();
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0]!.outcome, "error");
  assert.equal(h.ended[0]!.phase, "started");
  assert.equal(h.ended[0]!.http_responses_seen, 0);
  assert.equal(h.ended[0]!.error_class, "unknown");
});

test("an error after a 5xx response is classed provider_http; a later response never lowers the phase", async () => {
  const h = harness();
  const stream = createAssistantMessageEventStream();
  let hooks: Hooks = {};
  h.tracker.observe(MODEL, {} as Hooks, (observed) => { hooks = observed; return stream; });
  hooks.onProviderStreamEvent?.({}, MODEL);
  // SSE fallback inside the same call: headers arrive after the WebSocket already streamed.
  hooks.onResponse?.({ status: 503 }, MODEL);
  stream.push({ type: "error", reason: "error", error: message("error") });
  stream.end();
  await flush();
  assert.equal(h.ended[0]!.phase, "streaming");
  assert.equal(h.ended[0]!.http_responses_seen, 1);
  assert.equal(h.ended[0]!.error_class, "provider_http");
});

test("the caller's hooks keep their return value, async shape and exceptions", async () => {
  const h = harness();
  const callerResult = Promise.resolve("caller");
  const thrown = new Error("caller hook failed");
  let hooks: Hooks = {};
  const caller: Hooks = {
    onResponse: () => callerResult,
    onProviderStreamEvent: () => { throw thrown; },
  };
  h.tracker.observe(MODEL, caller, (observed) => { hooks = observed; return createAssistantMessageEventStream(); });
  assert.equal(hooks.onResponse?.({ status: 200 }, MODEL), callerResult);
  assert.throws(() => hooks.onProviderStreamEvent?.({}, MODEL), (error) => error === thrown);
  // Observation still happened before the caller's hook threw.
  assert.equal(h.tracker.snapshot().oldest?.phase, "streaming");
  // Hooks the SDK did not set stay absent from the caller's point of view: they return undefined.
  const bare: Hooks = {};
  let bareHooks: Hooks = {};
  h.tracker.observe(MODEL, bare, (observed) => { bareHooks = observed; return createAssistantMessageEventStream(); });
  assert.equal(bareHooks.onResponse?.({ status: 200 }, MODEL), undefined);
});

test("other options pass through untouched, including onPayload", async () => {
  const h = harness();
  const onPayload = () => ({ replaced: true });
  let seen: Hooks & { signal?: unknown } = {};
  const signal = new AbortController().signal;
  h.tracker.observe(MODEL, { onPayload, signal } as Hooks, (observed) => { seen = observed; return createAssistantMessageEventStream(); });
  assert.equal(seen.onPayload, onPayload);
  assert.equal(seen.signal, signal);
});

test("a synchronous throw ends the call as sync_throw and rethrows the same error", () => {
  const h = harness();
  const error = new Error("No API key for provider: x");
  assert.throws(() => h.tracker.observe(MODEL, {}, () => { throw error; }), (thrown) => thrown === error);
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0]!.outcome, "sync_throw");
  assert.equal(h.tracker.snapshot().openCount, 0);
});

test("a rejected result ends the call once without an unhandled rejection", async () => {
  const h = harness();
  const rejecting = { result: () => Promise.reject(new Error("boom")) };
  h.tracker.observe(MODEL, {}, () => rejecting);
  await flush();
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0]!.outcome, "result_rejected");
});

test("cancel racing completion ends the call exactly once", async () => {
  const h = harness();
  const stream = createAssistantMessageEventStream();
  h.tracker.observe(MODEL, {}, () => stream);
  stream.push({ type: "done", reason: "stop", message: message("stop") });
  stream.push({ type: "error", reason: "aborted", error: message("aborted") });
  stream.end();
  await flush();
  h.tracker.abandonAll();
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0]!.outcome, "completed");
});

test("an old call ending leaves a newer open call in the snapshot", async () => {
  const h = harness();
  const first = createAssistantMessageEventStream();
  const second = createAssistantMessageEventStream();
  h.tracker.observe(MODEL, {}, () => first);
  h.advance(10);
  let hooks: Hooks = {};
  h.tracker.observe(MODEL, {} as Hooks, (observed) => { hooks = observed; return second; });
  assert.equal(h.tracker.snapshot().openCount, 2);
  first.push({ type: "done", reason: "stop", message: message("stop") });
  first.end();
  await flush();
  h.advance(40);
  hooks.onResponse?.({ status: 200 }, MODEL);
  h.advance(5);
  const snapshot = h.tracker.snapshot();
  assert.equal(snapshot.openCount, 1);
  assert.deepEqual(snapshot.oldest, { phase: "headers", callContext: "unknown", ageMs: 45 });
});

test("abandoned calls end once; a late result for one is ignored", async () => {
  const h = harness();
  const stream = createAssistantMessageEventStream();
  h.tracker.observe(MODEL, {}, () => stream);
  h.tracker.abandonAll();
  stream.push({ type: "done", reason: "stop", message: message("stop") });
  stream.end();
  await flush();
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0]!.outcome, "abandoned");
  assert.equal(h.tracker.snapshot().openCount, 0);
});

test("call context is a time window: inside compaction, outside, and unknown when ambiguous", async () => {
  const h = harness();
  h.tracker.noteCompactionStarted();
  h.tracker.observe(MODEL, {}, () => createAssistantMessageEventStream());
  assert.equal(h.tracker.snapshot().oldest?.callContext, "compaction");
  h.tracker.abandonAll();
  h.tracker.noteCompactionEnded();

  h.tracker.observe(MODEL, {}, () => createAssistantMessageEventStream());
  assert.equal(h.tracker.snapshot().oldest?.callContext, "outside_compaction");
  // A compaction starting while this call is open makes its window ambiguous.
  h.tracker.noteCompactionStarted();
  assert.equal(h.tracker.snapshot().oldest?.callContext, "unknown");
});

test("unknown api and provider names stay in closed sets; a virtual model is not tracked", () => {
  const h = harness();
  h.tracker.observe({ api: "secret-internal-api", provider: "acme" }, {}, () => createAssistantMessageEventStream());
  h.tracker.abandonAll();
  assert.equal(h.ended[0]!.api, "unknown");
  assert.equal(h.ended[0]!.provider, "custom");

  const inner = createAssistantMessageEventStream();
  let called = false;
  const options = {};
  h.tracker.observe({ api: "pi-virtual", provider: "pi" }, options, (observed) => {
    called = true;
    assert.equal(observed, options);
    return inner;
  });
  assert.equal(called, true);
  assert.equal(h.tracker.snapshot().openCount, 0);
});

test("durations are exported only as buckets", async () => {
  const h = harness();
  const stream = createAssistantMessageEventStream();
  let hooks: Hooks = {};
  h.tracker.observe(MODEL, {} as Hooks, (observed) => { hooks = observed; return stream; });
  h.advance(2_000);
  hooks.onResponse?.({ status: 200 }, MODEL);
  h.advance(70_000);
  hooks.onProviderStreamEvent?.({}, MODEL);
  h.advance(1_000_000);
  stream.push({ type: "done", reason: "stop", message: message("stop") });
  stream.end();
  await flush();
  const row = h.ended[0]!;
  assert.equal(row.ms_to_headers_bucket, "1-10s");
  assert.equal(row.ms_to_first_event_bucket, "1-5m");
  assert.equal(row.duration_ms_bucket, "15-60m");
  assert.equal(Object.values(row).some((value) => typeof value === "number" && value > 599), false, "no raw duration is exported");
});
