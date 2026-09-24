import assert from "node:assert/strict";
import { test } from "vitest";
import {
  EMITTABLE_ROUTE_FAILURE_SUBKINDS,
  RouteFailureError,
  resolveRouteFailureKind,
  resolveRouteFailureSubkind,
  sanitizeRouteErrorMessage,
  type RouteFailureSubkind,
} from "./routeFailure.js";

test("resolveRouteFailureSubkind returns the tagged subkind for a RouteFailureError", () => {
  assert.equal(
    resolveRouteFailureSubkind(new RouteFailureError("daemon_timeout", "timed out")),
    "daemon_timeout",
  );
  assert.equal(
    resolveRouteFailureSubkind(new RouteFailureError("daemon_offline", "ws not ready")),
    "daemon_offline",
  );
  assert.equal(
    resolveRouteFailureSubkind(new RouteFailureError("daemon_error_unsupported", "unsupported")),
    "daemon_error_unsupported",
  );
});

test("resolveRouteFailureSubkind never sniffs a free-form message — falls back to unknown", () => {
  // A bare Error carrying a daemon-reported reason must NOT be classified by
  // string content. This is the closed-classifier discipline: no string-match.
  assert.equal(resolveRouteFailureSubkind(new Error("Runtime model detect request timed out")), "unknown");
  assert.equal(resolveRouteFailureSubkind(new Error("ENOENT models_cache.json missing")), "unknown");
  assert.equal(resolveRouteFailureSubkind("unsupported"), "unknown");
  assert.equal(resolveRouteFailureSubkind(undefined), "unknown");
  assert.equal(resolveRouteFailureSubkind(null), "unknown");
});

test("resolveRouteFailureKind groups closed subkinds into low-cardinality owner buckets", () => {
  assert.equal(resolveRouteFailureKind("daemon_offline"), "daemon_unavailable");
  assert.equal(resolveRouteFailureKind("daemon_timeout"), "daemon_unavailable");
  assert.equal(resolveRouteFailureKind("daemon_error_unsupported"), "daemon_error");
  assert.equal(resolveRouteFailureKind("daemon_threw"), "daemon_error");
  assert.equal(resolveRouteFailureKind("unknown"), "server_exception");
});

test("daemon_threw is in the ratified taxonomy but NOT in the emittable set (path-b)", () => {
  // daemon_threw is forward-declared in the type but requires a structured
  // daemon errorCode (task #77) before the server may emit it. Guard the
  // path-(b) emittable set so a future edit that accidentally starts emitting
  // it (e.g. via string-matching a free-form message) fails here.
  const emittable = new Set<RouteFailureSubkind>(EMITTABLE_ROUTE_FAILURE_SUBKINDS);
  assert.ok(!emittable.has("daemon_threw"), "daemon_threw must stay reserved");

  // Locks the ratified initial set (design anchor #proj-daemon:40c26bd4).
  assert.deepEqual(
    [...EMITTABLE_ROUTE_FAILURE_SUBKINDS].sort(),
    ["daemon_error_unsupported", "daemon_offline", "daemon_timeout", "unknown"],
  );
});

test("every emittable subkind round-trips through RouteFailureError; reserved values are excluded by type", () => {
  // RouteFailureError accepts only EmittableRouteFailureSubkind, so a reserved
  // value like `new RouteFailureError("daemon_threw", ...)` is a COMPILE error
  // (the real guard). At runtime we assert every emittable value round-trips,
  // and that nothing the resolver can produce via a RouteFailureError is the
  // reserved value.
  for (const subkind of EMITTABLE_ROUTE_FAILURE_SUBKINDS) {
    const resolved = resolveRouteFailureSubkind(new RouteFailureError(subkind, "x"));
    assert.equal(resolved, subkind);
    assert.notEqual(resolved, "daemon_threw");
  }
  // @ts-expect-error reserved value must not be constructable
  void (() => new RouteFailureError("daemon_threw", "must not compile"));
});

test("RouteFailureError runtime guard rejects a reserved subkind cast through `as any`", () => {
  // Defense-in-depth: the type guard is the primary line, but a dynamic/wire
  // value cast through `as any` could bypass it. The constructor must still
  // refuse, so a reserved value can never reach a trace before its enabling
  // path lands (task #77).
  assert.throws(
    () => new RouteFailureError("daemon_threw" as never, "x"),
    /not emittable/,
  );
  assert.throws(
    () => new RouteFailureError("nonsense" as never, "x"),
    /not emittable/,
  );
});

test("sanitizeRouteErrorMessage redacts secrets and URLs (byte-aligned with #74)", () => {
  const dirty =
    "fetch failed http://127.0.0.1:9999/internal/agent-api/send?token=sk_agent_abc123 sap_deadbeef key sk_machine_cafef00d";
  const clean = sanitizeRouteErrorMessage(dirty);
  assert.ok(clean.includes("[url]"), "url should be redacted");
  assert.ok(clean.includes("sk_[redacted]"), "sk_ token should be redacted");
  assert.ok(clean.includes("sap_[redacted]"), "sap_ token should be redacted");
  assert.doesNotMatch(clean, /127\.0\.0\.1/, "host inside url must be gone");
  assert.doesNotMatch(clean, /sk_agent_abc123|sk_machine_cafef00d|sap_deadbeef/, "raw token bytes must be gone");
});

test("sanitizeRouteErrorMessage collapses database query failures", () => {
  const clean = sanitizeRouteErrorMessage(
    'Failed query: delete from "daemons" where "daemons"."id" = $1 params: private-machine-id server_members',
  );
  assert.equal(clean, "Database query failed");
});

test("sanitizeRouteErrorMessage collapses whitespace and caps at 240 chars", () => {
  assert.equal(sanitizeRouteErrorMessage("  a\n\t  b   c  "), "a b c");

  const long = "x".repeat(500);
  const capped = sanitizeRouteErrorMessage(long);
  assert.equal(capped.length, 240);
  assert.ok(capped.endsWith("..."), "over-cap message ends with ellipsis");

  const exact = "y".repeat(240);
  assert.equal(sanitizeRouteErrorMessage(exact), exact, "exactly-240 message is untouched");
});

test("trace errors redact daemon, Bearer and JWT credentials", () => {
  const secrets = ["sk_daemon_synthetic-secret", "Bearer opaque-synthetic-secret", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdWRpdCJ9.c3ludGhldGlj"];
  for (const secret of secrets) assert.ok(!sanitizeRouteErrorMessage(`failed: ${secret}`).includes(secret), secret);
});
