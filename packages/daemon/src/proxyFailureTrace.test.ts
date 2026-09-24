import assert from "node:assert/strict";
import { test } from "vitest";
import { daemonProxyFailureTraceAttrs, daemonTransportErrorExcerpt } from "./proxyFailureTrace.js";

test("daemon proxy failure projection is route-classed, typed, bounded, and content-free", () => {
  const attrs = daemonProxyFailureTraceAttrs({
    method: "GET",
    pathname: "/internal/agent-api/tasks",
    queryKeys: ["channel", "status"],
    errorName: "TypeError",
    errorMessage: "fetch https://private.example/tasks?channel=secret failed for /Users/alice",
    errorCause: "UND_ERR_SOCKET other side closed secret@example.test",
  });
  assert.deepEqual(attrs, {
    route_family: "tasks",
    method: "GET",
    outcome: "error",
    reason: "tcp",
    error_class: "TypeError",
    error_excerpt: "Upstream TCP connection failed",
    response_code_present: false,
  });
  assert.doesNotMatch(JSON.stringify(attrs), /private|secret|Users|example\.test|channel|status/);
});

test("normalized transport traces replace raw original messages with canned excerpts", () => {
  const excerpt = daemonTransportErrorExcerpt({
    normalizedCode: "transport_failure",
    routeFamily: "agent-api/send",
    failureClass: "pre_response_transport",
    responseStarted: false,
    responseComplete: false,
    causeCode: "UND_ERR_HEADERS_TIMEOUT",
    upstreamLayer: "read_timeout",
    originalMessage: "secret user content at /Users/alice and https://private.example",
    launchId: "launch-1",
    targetHostClass: "custom_server",
    downstreamCaller: "cli",
    upstream: "server",
  });
  assert.equal(excerpt, "Upstream response timed out");
  assert.doesNotMatch(excerpt, /secret|Users|https/);
});

test("daemon proxy failure projection only maps explicit Undici read timeouts to read_timeout", () => {
  const bareTimeout = daemonProxyFailureTraceAttrs({
    method: "GET",
    pathname: "/internal/agent-api/tasks",
    queryKeys: [],
    errorName: "TypeError",
    errorMessage: "request timeout while waiting for upstream",
    errorCause: "ETIMEDOUT",
    causeCode: "ETIMEDOUT",
  });
  assert.equal(bareTimeout.reason, "unknown");

  const headersTimeout = daemonProxyFailureTraceAttrs({
    method: "GET",
    pathname: "/internal/agent-api/tasks",
    queryKeys: [],
    errorName: "TypeError",
    errorMessage: "fetch failed",
    errorCause: "Headers Timeout Error",
    causeCode: "UND_ERR_HEADERS_TIMEOUT",
  });
  assert.equal(headersTimeout.reason, "read_timeout");

  const bodyTimeout = daemonProxyFailureTraceAttrs({
    method: "GET",
    pathname: "/internal/agent-api/tasks",
    queryKeys: [],
    errorName: "TypeError",
    errorMessage: "fetch failed",
    errorCause: "Body Timeout Error",
    causeCode: "UND_ERR_BODY_TIMEOUT",
  });
  assert.equal(bodyTimeout.reason, "read_timeout");
});

test("daemon proxy failure projection closes local lifecycle failures", () => {
  const attrs = daemonProxyFailureTraceAttrs({
    method: "GET",
    pathname: "/internal/agent-api/events",
    queryKeys: [],
    errorName: "Error",
    errorMessage: "private invariant detail",
    lifecycleInvalidAgentId: "agent-secret",
    lifecycleInvalidContext: "visible-consume",
    responseStatusCode: 409,
    responseCode: "agent_lifecycle_state_invalid",
  });
  assert.equal(attrs.reason, "local_daemon_state_invalid");
  assert.equal(attrs.response_status_code, 409);
  assert.equal(attrs.response_code_present, true);
  assert.equal(JSON.stringify(attrs).includes("agent-secret"), false);
  assert.equal(JSON.stringify(attrs).includes("visible-consume"), false);
});

test("daemon proxy failure projection rejects hostile method and error-name values", () => {
  const attrs = daemonProxyFailureTraceAttrs({
    method: "SECRET-METHOD",
    pathname: "/internal/agent-api/tasks",
    queryKeys: [],
    errorName: "private-user-class",
    errorMessage: "private-user-value",
  });
  assert.equal(attrs.method, "OTHER");
  assert.equal(attrs.error_class, "OtherError");
  assert.doesNotMatch(JSON.stringify(attrs), /SECRET|private-user/);
});
