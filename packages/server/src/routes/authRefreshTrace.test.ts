import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { runWithTraceSpan } from "../tracing/semanticTrace";
import type { AuthRefreshReplayTrace } from "../services/sessionService";
import {
  authRefreshAttemptIdFromHeader,
  authRefreshInstallationIdFromHeader,
  type AuthRefreshOutcome,
  recordAuthRefreshTrace,
  recordAuthSessionIssuedTrace,
  refreshRequesterClass,
  rejectedRefreshFingerprint,
} from "./authRefreshTrace";

function refreshEvent(
  refreshed: AuthRefreshOutcome,
  replayTrace?: AuthRefreshReplayTrace,
  opts: { authRefreshAttemptId?: string; refreshToken?: unknown; userAgent?: string } = {},
) {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  runWithTraceSpan(span, () => recordAuthRefreshTrace(refreshed, replayTrace, opts));
  span.end();
  return sink.getAllSpans()[0]?.events.find((e) => e.name === "auth.refresh.completed");
}

test("grace replay is stamped replayed_rotation=true (the #3349 save)", () => {
  const event = refreshEvent({ userId: "user-1", sessionId: "session-1", replayedRotation: true });
  assert.equal(event?.attrs?.outcome, "replayed");
  assert.equal(event?.attrs?.replayed_rotation, true);
  assert.equal(event?.attrs?.user_id, "user-1");
  assert.equal(event?.attrs?.session_id, "session-1");
});

test("normal rotation is stamped replayed_rotation=false", () => {
  const event = refreshEvent(
    { userId: "user-1", sessionId: "session-2", replayedRotation: false },
    undefined,
    { authRefreshAttemptId: "arf_1234567890abcdef" },
  );
  assert.equal(event?.attrs?.outcome, "rotated");
  assert.equal(event?.attrs?.replayed_rotation, false);
  assert.equal(event?.attrs?.auth_refresh_attempt_id, "arf_1234567890abcdef");
  assert.equal(event?.attrs?.user_id, "user-1");
  assert.equal(event?.attrs?.session_id, "session-2");
});

test("auth refresh attempt id header is scrubbed to the bounded opaque shape", () => {
  assert.equal(authRefreshAttemptIdFromHeader("arf_1234567890abcdef"), "arf_1234567890abcdef");
  assert.equal(authRefreshAttemptIdFromHeader("  arf_1234567890abcdef  "), "arf_1234567890abcdef");
  assert.equal(authRefreshAttemptIdFromHeader("arf_123"), undefined);
  assert.equal(authRefreshAttemptIdFromHeader("rf_secret_token"), undefined);
  assert.equal(authRefreshAttemptIdFromHeader(["arf_1234567890abcdef"]), undefined);
});

test("auth refresh installation id header is scrubbed to the shared installation shape", () => {
  assert.equal(
    authRefreshInstallationIdFromHeader("ari_1234567890abcdef1234567890abcdef"),
    "ari_1234567890abcdef1234567890abcdef",
  );
  assert.equal(
    authRefreshInstallationIdFromHeader("  ari_1234567890abcdef1234567890abcdef  "),
    "ari_1234567890abcdef1234567890abcdef",
  );
  assert.equal(authRefreshInstallationIdFromHeader("ari_1234"), undefined);
  assert.equal(authRefreshInstallationIdFromHeader("ARI_1234567890abcdef1234567890abcdef"), undefined);
  assert.equal(authRefreshInstallationIdFromHeader(["ari_1234567890abcdef1234567890abcdef"]), undefined);
});

test("rejected refresh (no session, grace expired/revoked) is stamped rejected", () => {
  const event = refreshEvent(null, {
    replayLookupResult: "miss",
    redisAvailable: true,
    graceAgeBucket: null,
  });
  assert.equal(event?.attrs?.outcome, "rejected");
  assert.equal(event?.attrs?.replayed_rotation, false);
  assert.equal(event?.attrs?.replay_lookup_result, "miss");
  assert.equal(event?.attrs?.redis_available, true);
  assert.equal(event?.attrs?.grace_age_bucket, undefined);
  assert.equal(event?.attrs?.user_id, undefined);
  assert.equal(event?.attrs?.session_id, undefined);
});

test("session issuance trace records auth flow, user, and session id", () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "e".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  runWithTraceSpan(span, () => {
    recordAuthSessionIssuedTrace({
      flow: "email_login",
      userId: "user-1",
      sessionId: "session-1",
    });
  });
  span.end();

  const event = sink.getAllSpans()[0]?.events.find((e) => e.name === "auth.session.issued");
  assert.equal(event?.attrs?.flow, "email_login");
  assert.equal(event?.attrs?.user_id, "user-1");
  assert.equal(event?.attrs?.session_id, "session-1");
});

test("a rejected refresh records a keyed fingerprint and a requester class, never the token or User-Agent", () => {
  process.env.JWT_SECRET ??= "test-secret";
  const token = "raw-refresh-token";
  const userAgent = "okhttp/4.12.0";
  const event = refreshEvent(null, undefined, { refreshToken: token, userAgent });
  const fingerprint = event?.attrs?.rejected_refresh_fp;
  assert.match(String(fingerprint), /^[0-9a-f]{16}$/);
  assert.equal(fingerprint, rejectedRefreshFingerprint(token));
  assert.notEqual(fingerprint, rejectedRefreshFingerprint("another-token"));
  assert.equal(event?.attrs?.requester_class, "okhttp");
  const recorded = JSON.stringify(event);
  assert.ok(!recorded.includes(token));
  assert.ok(!recorded.includes(userAgent));
});

test("the fingerprint can't be matched to the database's token hash", () => {
  process.env.JWT_SECRET ??= "test-secret";
  const token = "raw-refresh-token";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  assert.ok(!tokenHash.startsWith(String(rejectedRefreshFingerprint(token))));
});

test("the fingerprint depends on the server secret", () => {
  const saved = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = "secret-a";
    const first = rejectedRefreshFingerprint("raw-refresh-token");
    process.env.JWT_SECRET = "secret-b";
    assert.notEqual(rejectedRefreshFingerprint("raw-refresh-token"), first);
    delete process.env.JWT_SECRET;
    assert.equal(rejectedRefreshFingerprint("raw-refresh-token"), undefined);
  } finally {
    if (saved === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved;
  }
});

test("a successful refresh records neither field", () => {
  process.env.JWT_SECRET ??= "test-secret";
  const event = refreshEvent({ userId: "user-1", sessionId: "session-1", replayedRotation: false }, undefined, {
    refreshToken: "raw-refresh-token",
    userAgent: "okhttp/4.12.0",
  });
  assert.equal(event?.attrs?.rejected_refresh_fp, undefined);
  assert.equal(event?.attrs?.requester_class, undefined);
});

test("a refresh body that isn't a string has no fingerprint", () => {
  process.env.JWT_SECRET ??= "test-secret";
  assert.equal(rejectedRefreshFingerprint({ token: "x" }), undefined);
});

test.each([
  [undefined, "unknown"],
  ["something-else/1.0", "unknown"],
  ["Mozilla/5.0 (Macintosh)", "browser"],
  ["curl/8.5.0", "other_bot"],
  ["okhttp/4.12.0", "okhttp"],
  ["MyApp/1 CFNetwork/1490 Darwin/23.0", "cfnetwork"],
  ["Dart/3.2 (dart:io)", "dart"],
  ["node", "node"],
])("requester class for %s is %s", (userAgent, expected) => {
  assert.equal(refreshRequesterClass(userAgent), expected);
});
