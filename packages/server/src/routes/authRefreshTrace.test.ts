import { strict as assert } from "node:assert";
import { test } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { runWithTraceSpan } from "../tracing/semanticTrace.js";
import type { AuthRefreshReplayTrace } from "../services/sessionService.js";
import {
  authRefreshAttemptIdFromHeader,
  authRefreshInstallationIdFromHeader,
  type AuthRefreshOutcome,
  recordAuthRefreshTrace,
  recordAuthSessionIssuedTrace,
} from "./authRefreshTrace.js";

function refreshEvent(
  refreshed: AuthRefreshOutcome,
  replayTrace?: AuthRefreshReplayTrace,
  opts: { authRefreshAttemptId?: string } = {},
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
