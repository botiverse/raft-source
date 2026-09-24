/**
 * slock.client_error family pins (L5 v0.1 field discipline + throttling).
 * The throttle IS the load-bearing part: a #185-style render loop fires
 * thousands of identical errors per second; the pipeline must see at most
 * 3 per signature per window with exact suppressed accounting.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  __resetClientErrorThrottleForTest,
  __setClientErrorEmitterForTest,
  classifyClientError,
  normalizeClientErrorName,
  reportClientError,
  topComponentFrame,
} from "../src/utils/clientErrorTrace";

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
});

test("field discipline: closed attrs, no message text, boundary carries stack top", () => {
  __resetClientErrorThrottleForTest();
  const records = captureEmits();
  reportClientError(
    { source: "error_boundary", error: new Error("Minified React error #185; SECRET user data"), componentStack: "\n at MachinePanel (x)" },
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
