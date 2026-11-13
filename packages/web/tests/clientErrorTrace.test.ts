/**
 * slock.client_error family pins (L5 v0.1 field discipline + throttling).
 * The throttle IS the load-bearing part: a #185-style render loop fires
 * thousands of identical errors per second; the pipeline must see at most
 * 3 per signature per window with exact suppressed accounting.
 */

import { strict as assert } from "node:assert";
import {
  __clientErrorThrottleSizeForTest,
  __resetClientErrorThrottleForTest,
  __setClientErrorEmitterForTest,
  classifyClientError,
  clientErrorFingerprint,
  normalizeClientErrorName,
  normalizeErrorMessageForFingerprint,
  reportClientError,
  topComponentFrame,
  topStackFrame,
} from "../src/utils/clientErrorTrace";
import {
  __resetAuthTraceForTest,
  emitAuthTraceAndFlush,
  emitAuthTraceAndFlushBeforeUnload,
  emitWebEvent,
  flushAuthTraces,
  setAuthTraceFetchForTest,
  setAuthTracePrincipalIdGetter,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace";

function captureEmits() {
  const records: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __setClientErrorEmitterForTest(((name, attrs) => {
    records.push({ name, attrs: { ...attrs } });
  }) as never);
  return records;
}

test("react minified errors normalize to code-only names (no message text)", () => {
  const err = new Error("Minified React error #185; visit https://react.dev/errors/185");
  assert.equal(normalizeClientErrorName(err), "react_error_185");
  assert.equal(normalizeClientErrorName(new TypeError("boom")), "TypeError");
  assert.equal(normalizeClientErrorName("Minified React error #310;"), "react_error_310");
  assert.equal(normalizeClientErrorName("plain string"), "string_throw");
  assert.equal(normalizeClientErrorName(undefined), "unknown_error");
  const hostileName = new Error("boom");
  hostileName.name = "private-user-value";
  assert.equal(normalizeClientErrorName(hostileName), "custom_error");
});

test("client errors expose a closed query class for the lazy-chunk acceptance battery", () => {
  assert.equal(classifyClientError(new SyntaxError("Unexpected token '<' at /assets/private.js"), "window_onerror"), "chunk_syntax");
  assert.equal(classifyClientError(
    new TypeError("Failed to fetch dynamically imported module: https://private.test/assets/Panel.js"),
    "unhandled_rejection",
  ), "chunk_fetch_module");
  assert.equal(classifyClientError(
    new TypeError("Cannot read properties of undefined (reading 'default') secret-user-value"),
    "error_boundary",
  ), "lazy_type_default");
  assert.equal(classifyClientError(new Error("Minified React error #185; secret"), "window_onerror"), "react_boundary");
  assert.equal(classifyClientError(new TypeError("Network request failed"), "unhandled_rejection"), "network");
  assert.equal(classifyClientError(new Error("other secret"), "window_onerror"), "unhandled_other");
});

test("component stack top extracts the first frame name only", () => {
  const stack = "\n    at ot (https://app/assets/MachineDetailPanel.js:1:5442)\n    at div (<anonymous>)";
  assert.equal(topComponentFrame(stack), "ot");
  assert.equal(topComponentFrame(""), "unknown");
  assert.equal(topComponentFrame(null), "unknown");
  assert.equal(topComponentFrame(`\n at ${"A".repeat(100)} (x)`).length, 64);
  assert.equal(topComponentFrame("Broken@https://app/assets/app-shell-Dx1AbC_9.js:1:2\nApp@x"), "Broken", "Firefox/Safari form");
});

function errorWithStack(error: Error, stack: string): Error {
  error.stack = stack;
  return error;
}

test("top frame: asset name without hash or URL, line and column; message lines skipped", () => {
  const chromium = errorWithStack(
    new TypeError("Cannot read properties of undefined (reading 'x') at https://evil/a-12345678.js:9:9"),
    "TypeError: Cannot read properties of undefined (reading 'x') at https://evil/a-12345678.js:9:9\n"
      + "    at Ab (https://raft.example/assets/app-shell-Dx1-AbC_.js:15:57771)\n"
      + "    at https://raft.example/assets/index-BcD3eF4g.js:1:2",
  );
  assert.equal(topStackFrame(chromium), "app-shell:15:57771");
  const anonymous = errorWithStack(new Error("x"), "Error: x\n    at https://raft.example/assets/MachineDetailPanel-q1W2e3R4.js?v=1:3:40");
  assert.equal(topStackFrame(anonymous), "MachineDetailPanel:3:40");
  const firefox = errorWithStack(new Error("x"), "Ab@https://raft.example/assets/app-shell-Dx1AbC_9.js:15:57771\n@https://raft.example/x.js:1:1");
  assert.equal(topStackFrame(firefox), "app-shell:15:57771");
  const dev = errorWithStack(new Error("x"), "Error: x\n    at Broken (http://localhost:5173/src/components/Broken.tsx?t=1700:12:9)");
  assert.equal(topStackFrame(dev), "Broken:12:9");
  const devDashed = errorWithStack(new Error("x"), "Error: x\n    at Ab (http://localhost:5173/src/components/dm-sidebar.tsx:4:2)");
  assert.equal(topStackFrame(devDashed), "dm-sidebar:4:2", "only built assets lose a hash-looking suffix");
  assert.equal(topStackFrame(errorWithStack(new Error("x"), "Error: x\n    at <anonymous>")), "unknown");
  assert.equal(topStackFrame("not an error"), "unknown");
});

test("a frame outside the built assets (page URL, extension, bookmarklet) is just `external`: no path segment, no id", () => {
  const pageUrl = errorWithStack(new Error("x"), "Error: x\n    at https://raft.example/s/acme/channel/ch9f3kq2Zx:3:15");
  assert.equal(topStackFrame(pageUrl), "external");
  const safari = errorWithStack(new Error("x"), "@https://raft.example/s/acme/channel/ch9f3kq2Zx:3:15");
  assert.equal(topStackFrame(safari), "external");
  const globalCode = errorWithStack(new Error("x"), "global code@https://raft.example/s/acme/channel/ch9f3kq2Zx:3:15");
  assert.equal(topStackFrame(globalCode), "unknown", "Safari's `global code@` is not a frame the parser reads");
  assert.equal(topStackFrame(errorWithStack(new Error("x"), "Error: x\n    at f (chrome-extension://abcdef/content.js:1:2)")), "external");
  assert.equal(topStackFrame(errorWithStack(new Error("x"), "Error: x\n    at https://raft.example/assets/ch9f3kq2Zx:1:2")), "external", "an /assets/ path without a hashed asset name");
  const records = captureEmits();
  __resetClientErrorThrottleForTest();
  reportClientError({ source: "window_onerror", error: pageUrl }, 1_000);
  __setClientErrorEmitterForTest(null);
  assert.equal(records[0].attrs.topFrame, "external");
  assert.equal(records[0].attrs.errorFingerprint, clientErrorFingerprint("Error", pageUrl, "external"));
  assert.ok(!JSON.stringify(records).includes("ch9f3kq2Zx"));
});

test("fingerprint: digits and quoted text are dropped, so one crash with different values groups together", () => {
  assert.equal(
    normalizeErrorMessageForFingerprint(`Cannot read properties of undefined (reading 'name') at row 42 "ch_9f3" \`x\``),
    `Cannot read properties of undefined (reading "") at row  "" ""`,
  );
  assert.equal(
    normalizeErrorMessageForFingerprint("Can't find 'foo' in user's list"),
    `Can't find "" in user's list`,
    "apostrophes inside words are not quotes",
  );
  assert.equal(normalizeErrorMessageForFingerprint(`Item 'a' and 'b' don't match`), `Item "" and "" don't match`);
  const frame = "app-shell:15:57771";
  const a = clientErrorFingerprint("TypeError", new TypeError("Item 12 not found in 'chan-abc'"), frame);
  const b = clientErrorFingerprint("TypeError", new TypeError("Item 9876 not found in 'chan-xyz'"), frame);
  assert.equal(a, b, "stable across numbers and quoted values");
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, clientErrorFingerprint("RangeError", new TypeError("Item 12 not found in 'chan-abc'"), frame), "name counts");
  assert.notEqual(a, clientErrorFingerprint("TypeError", new TypeError("Item 12 not found in 'chan-abc'"), "app-shell:16:1"), "frame counts");
  assert.notEqual(a, clientErrorFingerprint("TypeError", new TypeError("Item 12 missing"), frame), "message shape counts");
});

test("field discipline: closed attrs, no message text, boundary carries stack top", () => {
  __resetClientErrorThrottleForTest();
  const records = captureEmits();
  const error = errorWithStack(
    new Error("Minified React error #185; SECRET user data"),
    "Error: Minified React error #185; SECRET user data\n    at ot (https://raft.example/assets/app-shell-Dx1AbC_9.js:15:57771)",
  );
  const traceId = reportClientError(
    { source: "error_boundary", error, componentStack: "\n at MachinePanel (x)" },
    1_000,
  );
  __setClientErrorEmitterForTest(null);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, "slock.client_error");
  assert.deepEqual(records[0].attrs, {
    captureSource: "error_boundary",
    errorClass: "react_boundary",
    errorName: "react_error_185",
    componentStackTop: "MachinePanel",
    suppressedCount: 0,
    errorFingerprint: clientErrorFingerprint("react_error_185", error, "app-shell:15:57771"),
    topFrame: "app-shell:15:57771",
    clientTraceId: traceId,
  }, "attrs are a closed set — and must never contain the message text");
  assert.ok(!JSON.stringify(records[0]).includes("SECRET"), "raw message must not leak");
  assert.ok(!JSON.stringify(records[0]).includes("https://"), "raw URL must not leak");
});

test("throttle: 3 per signature per window; suppressed count carried on next window's first report", () => {
  __resetClientErrorThrottleForTest();
  const records = captureEmits();
  const boom = new Error("Minified React error #185;");
  const t0 = 1_000_000;

  for (let i = 0; i < 10; i++) {
    reportClientError({ source: "error_boundary", error: boom, componentStack: "\n at ot (x)" }, t0 + i);
  }
  assert.equal(records.length, 3, "storm of 10 → exactly 3 reports in the window");

  // A DIFFERENT signature in the same window is not affected.
  reportClientError({ source: "window_onerror", error: new TypeError("x") }, t0 + 20);
  assert.equal(records.length, 4);
  assert.equal(records[3].attrs.componentStackTop, "global");

  // Next window: first report carries the 7 suppressed occurrences.
  reportClientError({ source: "error_boundary", error: boom, componentStack: "\n at ot (x)" }, t0 + 61_000);
  assert.equal(records.length, 5);
  assert.equal(records[4].attrs.suppressedCount, 7, "suppressed occurrences are quantified, not lost");

  // And the window genuinely rolled: second report in new window passes with 0 carry.
  reportClientError({ source: "error_boundary", error: boom, componentStack: "\n at ot (x)" }, t0 + 61_001);
  assert.equal(records.length, 6);
  assert.equal(records[5].attrs.suppressedCount, 0);

  __setClientErrorEmitterForTest(null);
});

test("reporter never throws even on hostile input", () => {
  __resetClientErrorThrottleForTest();
  __setClientErrorEmitterForTest((() => { throw new Error("pipeline down"); }) as never);
  assert.doesNotThrow(() => reportClientError({ source: "window_onerror", error: { weird: true } }, 1));
  __setClientErrorEmitterForTest(null);
});

test("a desktop bridge read failure: its fixed site name as the stack top, no message text", () => {
  __resetClientErrorThrottleForTest();
  const records = captureEmits();
  reportClientError({ source: "desktop_bridge", site: "localComputer.getStatus", error: new Error("Error invoking remote method: SECRET") }, 1_000);
  __setClientErrorEmitterForTest(null);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].attrs, {
    captureSource: "desktop_bridge",
    errorClass: "unhandled_other",
    errorName: "Error",
    componentStackTop: "localComputer.getStatus",
    suppressedCount: 0,
  });
  assert.ok(!JSON.stringify(records[0]).includes("SECRET"));
});

test("a reported client error returns the trace id it was sent under; a throttled one returns null", () => {
  __resetClientErrorThrottleForTest();
  const ids: unknown[] = [];
  __setClientErrorEmitterForTest(((_name: string, _attrs: unknown, options?: { traceId?: string }) => {
    ids.push(options?.traceId);
  }) as never);
  const t0 = 2_000_000;
  const returned: Array<string | null> = [];
  for (let i = 0; i < 5; i += 1) {
    returned.push(reportClientError({ source: "error_boundary", error: new Error("boom"), componentStack: "\n at TraceIdCase (x)" }, t0 + i));
  }
  const sent = returned.filter((id): id is string => id !== null);
  assert.ok(sent.length >= 1 && sent.length < returned.length, "some reports are throttled");
  for (const id of sent) assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual(ids, sent, "the id shown is the id the report carried");
  __setClientErrorEmitterForTest(null);
});

test("a crash page report goes out at once on the urgent path, even while a scheduled flush is sending, and not again in the batch", async () => {
  __resetClientErrorThrottleForTest();
  __setClientErrorEmitterForTest(null);
  __resetAuthTraceForTest({ traceUrl: "https://trace.test" });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "slock_access_token" ? "tok" : null) },
  });
  setAuthTraceServerIdGetter(() => "srv");
  setAuthTracePrincipalIdGetter(() => "usr");

  let releaseScheduled = () => {};
  const traceBodies: Array<{ keepalive: boolean; events: Array<{ name: string; attrs: Record<string, unknown> }> }> = [];
  setAuthTraceFetchForTest(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/scope-attestation")) {
      if (!init?.keepalive) await new Promise<void>((resolve) => { releaseScheduled = resolve; });
      return new Response(JSON.stringify({ attestation: "att" }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { events?: Array<{ name: string; attrs: Record<string, unknown> }> };
    traceBodies.push({ keepalive: Boolean(init?.keepalive), events: body.events ?? [] });
    return new Response(null, { status: 202 });
  });

  try {
    emitWebEvent("slock.client_error", { captureSource: "window_onerror" });
    const scheduled = flushAuthTraces(); // in flight: held at its attestation
    const traceId = reportClientError({ source: "error_boundary", error: new Error("boom"), componentStack: "\n at Panel (x)" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(traceBodies.length, 1, "the crash report did not wait for the scheduled flush");
    assert.equal(traceBodies[0].keepalive, true);
    assert.deepEqual(traceBodies[0].events.map((event) => event.attrs.clientTraceId), [traceId]);

    releaseScheduled();
    await scheduled;
    await flushAuthTraces();
    const batched = traceBodies.slice(1).flatMap((body) => body.events);
    assert.deepEqual(batched.map((event) => event.attrs.captureSource), ["window_onerror"], "no second copy in the batch");
  } finally {
    __resetAuthTraceForTest();
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("window_onerror and unhandled_rejection carry errorFingerprint + topFrame (no message, no URL, no trace id), on the batch path", () => {
  __resetClientErrorThrottleForTest();
  const sent: Array<{ attrs: Record<string, unknown>; urgent: boolean }> = [];
  __setClientErrorEmitterForTest(((_name: string, attrs: Record<string, unknown>, options: { urgent: boolean }) => {
    sent.push({ attrs: { ...attrs }, urgent: options.urgent });
  }) as never);
  const stack = "TypeError: SECRET 'chan-abc'\n    at Ab (https://raft.example/assets/app-shell-Dx1AbC_9.js:15:57771)";
  const onError = errorWithStack(new TypeError("SECRET 'chan-abc'"), stack);
  const rejection = errorWithStack(new TypeError("SECRET 'chan-abc'"), stack);
  reportClientError({ source: "window_onerror", error: onError }, 1_000);
  reportClientError({ source: "unhandled_rejection", error: rejection }, 1_000);
  __setClientErrorEmitterForTest(null);

  const fingerprint = clientErrorFingerprint("TypeError", onError, "app-shell:15:57771");
  assert.deepEqual(sent.map((s) => s.attrs), ["window_onerror", "unhandled_rejection"].map((captureSource) => ({
    captureSource,
    errorClass: "unhandled_other",
    errorName: "TypeError",
    componentStackTop: "global",
    suppressedCount: 0,
    errorFingerprint: fingerprint,
    topFrame: "app-shell:15:57771",
  })));
  assert.deepEqual(sent.map((s) => s.urgent), [false, false], "only the crash page is urgent");
  assert.ok(!JSON.stringify(sent).includes("SECRET") && !JSON.stringify(sent).includes("https://"));
});

test("window_onerror throttles per fingerprint: a second cause of the same error name is not swallowed by the first", () => {
  __resetClientErrorThrottleForTest();
  const records = captureEmits();
  const at = (frame: string) => errorWithStack(new TypeError("x is undefined"), `TypeError: x is undefined\n    at ${frame}`);
  for (let i = 0; i < 5; i++) reportClientError({ source: "window_onerror", error: at("https://h/assets/a-Dx1AbC_9.js:1:1") }, 1_000 + i);
  reportClientError({ source: "window_onerror", error: at("https://h/assets/b-Dx1AbC_9.js:2:2") }, 1_010);
  __setClientErrorEmitterForTest(null);
  assert.deepEqual(records.map((r) => r.attrs.topFrame), ["a:1:1", "a:1:1", "a:1:1", "b:2:2"]);
});

test("the urgent crash report reuses a still-valid cached attestation (one request); a rejected one falls back to the two-step send", async () => {
  __resetClientErrorThrottleForTest();
  __setClientErrorEmitterForTest(null);
  __resetAuthTraceForTest({ traceUrl: "https://trace.test" });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "slock_access_token" ? "tok" : null) },
  });
  setAuthTraceServerIdGetter(() => "srv");
  setAuthTracePrincipalIdGetter(() => "usr");
  const calls: string[] = [];
  let traceStatus = 202;
  setAuthTraceFetchForTest(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/scope-attestation")) {
      calls.push("attest");
      const expiresAt = new Date(Date.now() + 600_000).toISOString();
      return new Response(JSON.stringify({ attestation: "att", expiresAt }), { status: 200 });
    }
    calls.push(`trace:${(JSON.parse(String(init?.body)) as { attestation: string }).attestation}`);
    return new Response(null, { status: traceStatus });
  });
  const crash = async (message: string) => {
    reportClientError({ source: "error_boundary", error: new Error(message), componentStack: "\n at Panel (x)" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  try {
    emitWebEvent("slock.client_error", { captureSource: "window_onerror" });
    await flushAuthTraces(); // the scheduled path caches the attestation
    calls.length = 0;
    await crash("one");
    assert.deepEqual(calls, ["trace:att"], "cached attestation: a single request");

    calls.length = 0;
    traceStatus = 401;
    await crash("two");
    assert.deepEqual(calls, ["trace:att", "attest", "trace:att"], "rejected: fresh attestation, then send");
  } finally {
    __resetAuthTraceForTest();
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

// Digits are dropped from the fingerprint, so vary the message with letters.
const letters = (i: number) => String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26) % 26, 97 + Math.floor(i / 676));
const failing = (word: string) => errorWithStack(new TypeError(`fail ${word}`), `TypeError: fail ${word}\n    at f (https://h/assets/a-Dx1AbC_9.js:1:1)`);

test("window_onerror is capped at 20 per 60 s across fingerprints; the rest is counted on its own fingerprint", () => {
  __resetClientErrorThrottleForTest();
  const records = captureEmits();
  const t0 = 5_000_000;
  for (let i = 0; i < 25; i++) reportClientError({ source: "window_onerror", error: failing(letters(i)) }, t0 + i);
  assert.equal(records.length, 20, "a loop with a new message each time cannot flood");
  reportClientError({ source: "unhandled_rejection", error: failing("aaa") }, t0 + 30);
  assert.equal(records.length, 21, "each source has its own cap");

  reportClientError({ source: "window_onerror", error: failing(letters(24)) }, t0 + 61_000);
  __setClientErrorEmitterForTest(null);
  assert.equal(records.length, 22);
  assert.equal(records[21].attrs.suppressedCount, 1, "the capped occurrence is carried by its fingerprint's next report");
});

test("the throttle table stays bounded: expired, then oldest, entries make room", () => {
  __resetClientErrorThrottleForTest();
  captureEmits();
  for (let i = 0; i < 300; i++) reportClientError({ source: "window_onerror", error: failing(letters(i)) }, 9_000_000 + i);
  assert.equal(__clientErrorThrottleSizeForTest(), 200);
  reportClientError({ source: "window_onerror", error: new TypeError("other") }, 9_000_000 + 61_000);
  __setClientErrorEmitterForTest(null);
  assert.equal(__clientErrorThrottleSizeForTest(), 1, "every expired entry is dropped when a new one needs room");
});

async function withUrgentTraceFixture(
  opts: { expiresInMs?: number },
  run: (ctx: { calls: string[]; setPrincipal: (id: string) => void }) => Promise<void>,
) {
  __resetClientErrorThrottleForTest();
  __setClientErrorEmitterForTest(null);
  __resetAuthTraceForTest({ traceUrl: "https://trace.test" });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "slock_access_token" ? "tok" : null) },
  });
  let principal = "usr";
  setAuthTraceServerIdGetter(() => "srv");
  setAuthTracePrincipalIdGetter(() => principal);
  const calls: string[] = [];
  setAuthTraceFetchForTest(async (input) => {
    const attest = String(input).endsWith("/scope-attestation");
    calls.push(attest ? "attest" : "trace");
    if (!attest) return new Response(null, { status: 202 });
    const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 600_000)).toISOString();
    return new Response(JSON.stringify({ attestation: "att", expiresAt }), { status: 200 });
  });
  try {
    emitWebEvent("slock.client_error", { captureSource: "window_onerror" });
    await flushAuthTraces(); // the scheduled path caches the attestation for (srv, usr)
    assert.deepEqual(calls, ["attest", "trace"]);
    calls.length = 0;
    await run({ calls, setPrincipal: (id) => { principal = id; } });
  } finally {
    __resetAuthTraceForTest();
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const crashPage = () => reportClientError({ source: "error_boundary", error: new Error("boom"), componentStack: "\n at Panel (x)" });

test("the urgent crash send does not reuse another user's cached attestation", async () => {
  await withUrgentTraceFixture({}, async ({ calls, setPrincipal }) => {
    setPrincipal("other-user");
    crashPage();
    await settle();
    assert.deepEqual(calls, ["attest", "trace"]);
  });
});

test("the urgent crash send does not reuse an attestation within 60 s of expiry", async () => {
  await withUrgentTraceFixture({ expiresInMs: 30_000 }, async ({ calls }) => {
    crashPage();
    await settle();
    assert.deepEqual(calls, ["attest", "trace"]);
  });
});

test("urgent auth events (logout verdict, session cleared) stay two-step even with a valid cached attestation", async () => {
  await withUrgentTraceFixture({}, async ({ calls }) => {
    emitAuthTraceAndFlush("slock.auth.session_cleared", { logoutTrigger: "terminal_verdict" });
    await settle();
    await emitAuthTraceAndFlushBeforeUnload("slock.auth.verdict", { authVerdict: "logout" });
    assert.deepEqual(calls, ["attest", "trace", "attest", "trace"]);
    crashPage();
    await settle();
    assert.deepEqual(calls.slice(4), ["trace"], "the same cache does serve a web event");
  });
});
