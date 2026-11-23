import assert from "node:assert/strict";
import {
  buildRuntimeErrorActivityDiagnostic,
  buildRuntimeErrorDiagnosticEnvelope,
  credentialInvalidReasonOf,
  formatRuntimeBillingExhaustedMessage,
  formatRuntimeInputTooLargeMessage,
  formatRuntimeLoginRequiredMessage,
  formatRuntimePlanAccessMessage,
  formatRuntimeStartTimeoutMessage,
  isRuntimePlanAccessErrorText,
  buildBoundedVisibleCrashDetail,
  MAX_VISIBLE_CRASH_DETAIL_CHARS,
  scrubRuntimeErrorDiagnosticText,
  runtimeErrorTraceClassAttrs,
  normalizeRuntimeErrorForFingerprint,
  RUNTIME_MODEL_REFUSAL_MESSAGE,
  modelRefusalTraceClassAttrs,
} from "./runtimeErrorDiagnostics";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES } from "../../shared/src/test/diagnosticRedactionCredentialSamples";
import {
  boundedRuntimeErrorDetail,
  classifyRuntimeErrorCode,
  MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS,
  scrubRuntimeErrorText,
} from "@botiverse/raft-shared";
import {
  recoverableRuntimeDeliveryBackoffReason,
  recoverableRuntimeProcessCloseReason,
  runtimeErrorFingerprintFenceResetEvent,
} from "./runtimeErrorDeliveryPolicy";

// A finished compaction is not progress for the repeated-error fences:
// Claude Code compacts, then fails the turn with "Prompt is too long"; counted
// as progress, it reset the fence every turn (and made that turn's end reset it).
test("runtimeErrorFingerprintFenceResetEvent: a finished compaction is not progress; output and a finished review are", () => {
  assert.equal(runtimeErrorFingerprintFenceResetEvent("compaction_finished", false), false);
  assert.equal(runtimeErrorFingerprintFenceResetEvent("compaction_finished", true), false);
  for (const kind of ["thinking", "text", "tool_call", "tool_output", "review_finished"] as const) {
    assert.equal(runtimeErrorFingerprintFenceResetEvent(kind, false), true, kind);
  }
  assert.equal(runtimeErrorFingerprintFenceResetEvent("turn_end", false), false);
  assert.equal(runtimeErrorFingerprintFenceResetEvent("turn_end", true), true);
});

test("buildRuntimeErrorDiagnosticEnvelope classifies and bounds provider errors", () => {
  const envelope = buildRuntimeErrorDiagnosticEnvelope(
    "API Error: 400 Bad Request: Improperly formed request in /Users/alice/project/session.jsonl",
  );

  assert.equal(envelope.spanAttrs.runtime_error_class, "ProviderApiError");
  assert.equal(envelope.spanAttrs.runtime_error_http_status, 400);
  assert.equal(envelope.spanAttrs.runtime_error_message_present, true);
  assert.equal(envelope.spanAttrs.runtime_error_message_length_bucket, "<1k");
  assert.equal(envelope.spanAttrs.runtime_error_message_truncated, false);
  assert.equal(typeof envelope.spanAttrs.runtime_error_fingerprint, "string");
  assert.equal(envelope.eventAttrs.runtime_error_message_excerpt, "API Error: 400 Bad Request: Improperly formed request in [REDACTED_PATH]");
});

test("buildRuntimeErrorDiagnosticEnvelope keeps generic 403 responses out of user reauth", () => {
  for (const message of [
    "API Error: 403 Request not allowed",
    "unexpected status 403 Forbidden",
  ]) {
    const envelope = buildRuntimeErrorDiagnosticEnvelope(message);
    assert.equal(envelope.spanAttrs.runtime_error_class, "ProviderApiError");
    assert.equal(envelope.spanAttrs.turn_reason, "provider_api_error");
    assert.equal(envelope.spanAttrs.runtime_error_http_status, 403);
    assert.equal(envelope.spanAttrs.runtime_error_action, "none");
    assert.equal(envelope.spanAttrs.runtime_error_action_required, false);
  }
});

test("buildRuntimeErrorDiagnosticEnvelope reserves 403 user reauth for explicit auth evidence", () => {
  for (const message of [
    "API Error: 403 Forbidden: invalid api key",
    "API Error: 403 Authentication failed: please log in",
  ]) {
    const envelope = buildRuntimeErrorDiagnosticEnvelope(message);
    assert.equal(envelope.spanAttrs.runtime_error_class, "AuthError");
    assert.equal(envelope.spanAttrs.turn_reason, "auth_failed");
    assert.equal(envelope.spanAttrs.runtime_error_http_status, 403);
    assert.equal(envelope.spanAttrs.runtime_error_action, "user_reauth");
    assert.equal(envelope.spanAttrs.runtime_error_action_required, true);
  }
});

test("buildRuntimeErrorDiagnosticEnvelope redacts secrets and truncates long messages", () => {
  const envelope = buildRuntimeErrorDiagnosticEnvelope(
    [
      "ProviderModelNotFoundError: failed with Bearer abcdefghijklmnopqrstuvwxyz",
      "key sk-ant-1234567890abcdef",
      "email user@example.com",
      "url https://example.com/v1?api_key=secret",
      "body",
      "x".repeat(5000),
    ].join(" "),
  );

  assert.equal(envelope.spanAttrs.runtime_error_class, "ProviderModelNotFoundError");
  assert.equal(envelope.spanAttrs.turn_reason, "unclassified_runtime_error");
  assert.equal(envelope.spanAttrs.runtime_error_message_length_bucket, "4k-16k");
  assert.equal(envelope.spanAttrs.runtime_error_message_truncated, true);
  assert.equal(String(envelope.eventAttrs.runtime_error_message_excerpt).length, 4096);

  const excerpt = String(envelope.eventAttrs.runtime_error_message_excerpt);
  assert.equal(excerpt.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(excerpt.includes("sk-ant-1234567890abcdef"), false);
  assert.equal(excerpt.includes("user@example.com"), false);
  assert.match(excerpt, /Bearer \[REDACTED_TOKEN\]/);
  assert.match(excerpt, /\[REDACTED_TOKEN\]/);
  assert.match(excerpt, /\[REDACTED_EMAIL\]/);
  assert.match(excerpt, /\[REDACTED_QUERY\]|%5BREDACTED_QUERY%5D/);
});

// Security review (2026-11): the excerpt's scrubber let JSON-quoted keys,
// Basic auth, bare JWTs, cloud keys and secret flags through to telemetry.
test("buildRuntimeErrorDiagnosticEnvelope: the excerpt masks every shared credential sample and keeps the error readable", () => {
  for (const { label, sample, mustNotContain } of DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES) {
    const excerpt = String(buildRuntimeErrorDiagnosticEnvelope(sample).eventAttrs.runtime_error_message_excerpt);
    assert.ok(!excerpt.includes(mustNotContain), `${label} leaked into the excerpt: ${excerpt}`);
  }
  const envelope = buildRuntimeErrorDiagnosticEnvelope(
    'API Error: 401 from https://api.example.test/v1/messages {"type":"error","api_key": "Zq81mNw2Lp0x"} Authorization: Basic dXNlcjpodW50ZXIy',
  );
  assert.equal(
    envelope.eventAttrs.runtime_error_message_excerpt,
    'API Error: 401 from https://api.example.test/v1/messages {"type":"error","api_key": "[REDACTED_TOKEN]"} Authorization: Basic [REDACTED_TOKEN]',
  );
  assert.equal(envelope.spanAttrs.runtime_error_http_status, 401, "the raw text still drives classification");
});

test("buildRuntimeErrorDiagnosticEnvelope: the fingerprint is taken on scrubbed text, so a new secret value is not a new error", () => {
  const fingerprint = (message: string) => buildRuntimeErrorDiagnosticEnvelope(message).spanAttrs.runtime_error_fingerprint;
  assert.equal(fingerprint('401 {"api_key": "Zq81mNw2Lp0x"}'), fingerprint('401 {"api_key": "Ab12cd34Ef"}'));
  assert.equal(fingerprint("exit 1: claude --api-key Zq81mNw2Lp0x"), fingerprint("exit 1: claude --api-key Ab12cd34Ef"));
  // Text with nothing to mask fingerprints exactly as before: scrubbing leaves it alone.
  for (const message of [
    "API Error: 400 model claude-sonnet-4-5-20250929 not found (request 123e4567-e89b-12d3-a456-426614174000)",
    "fatal: bad object 3c0f7bab8e1d2f3a4b5c6d7e8f90123456789abc in src/tokenizer.ts",
  ]) {
    assert.equal(scrubRuntimeErrorDiagnosticText(message), message);
    assert.equal(normalizeRuntimeErrorForFingerprint(scrubRuntimeErrorDiagnosticText(message)), normalizeRuntimeErrorForFingerprint(message));
  }
});

test("buildRuntimeErrorDiagnosticEnvelope detoxes poisoned stderr (env-assignment + GitHub tokens + trace-no-raw)", () => {
  // #688 load-bearing poisoned specimen: secrets that the old scrubber (Bearer/sk-*/email/url/path)
  // did NOT cover. They must not appear in the user-visible excerpt, yet the original must still
  // drive internal classification (not fake-green by dropping the whole detail).
  // Built at runtime so secret scanners don't flag this test sample.
  const ghpToken = "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789";
  const poisoned = [
    "Error: ANTHROPIC_API_KEY=sk-ant-api03-this-is-a-long-secret-value-1234567890",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "OPENAI_API_KEY=sk-abcdef0123456789abcdef0123456789",
    ghpToken,
    "github" + "_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmNO",
    "connection password=hunter2 sentinel",
    "NODE_ENV=production must survive",
    "API Error: 500 Internal Server Error upstream",
  ].join("\n");

  const envelope = buildRuntimeErrorDiagnosticEnvelope(poisoned);
  const excerpt = String(envelope.eventAttrs.runtime_error_message_excerpt);

  assert.equal(excerpt.includes("sk-ant-api03-this-is-a-long-secret-value-1234567890"), false, "anthropic value leaks");
  assert.equal(excerpt.includes("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"), false, "aws secret leaks");
  assert.equal(excerpt.includes("sk-abcdef0123456789abcdef0123456789"), false, "openai value leaks");
  assert.equal(excerpt.includes(ghpToken), false, "ghp token leaks");
  assert.equal(excerpt.includes("11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmNO"), false, "github_pat leaks");
  assert.equal(excerpt.includes("hunter2"), false, "password value leaks");

  assert.match(excerpt, /ANTHROPIC_API_KEY\s*=\s*\[REDACTED_TOKEN\]/);
  assert.match(excerpt, /AWS_SECRET_ACCESS_KEY\s*=\s*\[REDACTED_TOKEN\]/);
  assert.match(excerpt, /OPENAI_API_KEY\s*=\s*\[REDACTED_TOKEN\]/);
  assert.match(excerpt, /NODE_ENV=production/, "benign assignment must survive");
  assert.equal(excerpt.includes("ghp_"), false);
  assert.equal(excerpt.includes("github_pat_"), false);

  // raw input still drives internal classification (not dropped): the message
  // classifies as a provider 500 even though its excerpt is fully scrubbed.
  assert.equal(envelope.spanAttrs.runtime_error_class, "ProviderServerError");
  assert.equal(envelope.spanAttrs.runtime_error_http_status, 500);
  assert.equal(typeof envelope.spanAttrs.runtime_error_fingerprint, "string");
});

test("buildRuntimeErrorDiagnosticEnvelope classifies provider stream failures", () => {
  const streamClosed = buildRuntimeErrorDiagnosticEnvelope("stream closed before response.completed");
  assert.equal(streamClosed.spanAttrs.runtime_error_class, "ProviderStreamError");
  assert.equal(streamClosed.spanAttrs.turn_reason, "provider_stream_error");

  const decodingFailure = buildRuntimeErrorDiagnosticEnvelope("error decoding response body");
  assert.equal(decodingFailure.spanAttrs.runtime_error_class, "ProviderStreamError");
  assert.equal(decodingFailure.spanAttrs.turn_reason, "provider_stream_error");
});

test("buildRuntimeErrorActivityDiagnostic preserves exact compaction failure classes without raw text", () => {
  const providerFailure = buildRuntimeErrorActivityDiagnostic("Compaction failed: 503: synthetic upstream unavailable");
  assert.equal(providerFailure.errorClass, "ProviderServerError");
  assert.equal(providerFailure.errorReason, "provider_server_error");
  assert.match(providerFailure.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(Object.values(providerFailure).some(value => String(value).includes("synthetic upstream")), false);

  const aborted = buildRuntimeErrorActivityDiagnostic("This operation was aborted");
  assert.equal(aborted.errorClass, "OperationAbortedError");
  assert.equal(aborted.errorReason, "operation_aborted");
  assert.match(aborted.fingerprint, /^[0-9a-f]{16}$/);
});

test("buildRuntimeErrorActivityDiagnostic reports when the owner must act, in the same terms as the envelope", () => {
  const credential = buildRuntimeErrorActivityDiagnostic("Authentication failed: missing API token");
  assert.equal(credential.errorClass, "AuthError");
  assert.equal(credential.requiredAction, "user_reauth");
  assert.equal(
    buildRuntimeErrorDiagnosticEnvelope("Authentication failed: missing API token").spanAttrs.runtime_error_action,
    credential.requiredAction,
  );

  // Retrying can fix these: no owner action, and the field is absent (not "none").
  for (const text of ["Selected model is at capacity. Please try a different model.", "Compaction failed: 503: synthetic upstream unavailable"]) {
    assert.equal("requiredAction" in buildRuntimeErrorActivityDiagnostic(text), false, text);
  }
});

test("buildRuntimeErrorDiagnosticEnvelope treats Codex provider capacity as recoverable rate limiting", () => {
  const capacity = buildRuntimeErrorDiagnosticEnvelope("Selected model is at capacity. Please try a different model.");
  assert.equal(capacity.spanAttrs.runtime_error_class, "RateLimitError");
  assert.equal(capacity.spanAttrs.turn_reason, "rate_limited");
  assert.equal(capacity.spanAttrs.runtime_error_action_required, false);

  const credential = buildRuntimeErrorDiagnosticEnvelope("Authentication failed: missing API token");
  assert.equal(credential.spanAttrs.runtime_error_class, "AuthError");
  assert.equal(credential.spanAttrs.turn_reason, "auth_failed");
  assert.equal(credential.spanAttrs.runtime_error_action_required, true);
});

test("buildRuntimeErrorDiagnosticEnvelope classifies local startup-payload and observed provider limits", () => {
  const localGuard = buildRuntimeErrorDiagnosticEnvelope(
    "INPUT_TOO_LARGE: Claude daemon-owned startup payload is too large before command launch (estimated 1052777 tokens, budget 968000, context limit 1000000, model claude-fable-5).",
  );
  assert.equal(localGuard.spanAttrs.runtime_error_class, "InputTooLargeError");
  assert.equal(localGuard.spanAttrs.turn_reason, "input_too_large");
  assert.equal(localGuard.spanAttrs.runtime_error_action_required, false);
  assert.equal(localGuard.spanAttrs.runtime_input_estimated_tokens, 1_052_777);
  assert.equal(localGuard.spanAttrs.runtime_input_budget_tokens, 968_000);
  assert.equal(localGuard.spanAttrs.runtime_input_context_limit_tokens, 1_000_000);
  assert.equal(localGuard.spanAttrs.runtime_input_model, "claude-fable-5");

  const providerRaw = buildRuntimeErrorDiagnosticEnvelope(
    "API Error: 400 Invalid request: Input too large: estimated 1052777 tokens exceeds the maximum allowed for model claude-fable-5 (1000000).",
  );
  assert.equal(providerRaw.spanAttrs.runtime_error_class, "InputTooLargeError");
  assert.equal(providerRaw.spanAttrs.turn_reason, "input_too_large");
  assert.equal(providerRaw.spanAttrs.runtime_error_http_status, 400);
  assert.equal(providerRaw.spanAttrs.runtime_input_estimated_tokens, 1_052_777);
  assert.equal(providerRaw.spanAttrs.runtime_input_context_limit_tokens, 1_000_000);
  assert.equal(providerRaw.spanAttrs.runtime_input_model, "claude-fable-5");
});

test("buildRuntimeErrorDiagnosticEnvelope classifies OpenCode's context-window overflow as input too large", () => {
  const envelope = buildRuntimeErrorDiagnosticEnvelope(
    "Your input exceeds the context window of this model. Please adjust your input and try again.",
  );
  assert.equal(envelope.spanAttrs.runtime_error_class, "InputTooLargeError");
  assert.equal(envelope.spanAttrs.turn_reason, "input_too_large");
  assert.equal(envelope.spanAttrs.runtime_error_action_required, false);
});

// A model refusal is decided on the error event's typed marker, never on its
// text: the fixed text alone is an ordinary RuntimeError. Its trace class is
// its own; the closed protocol vocabulary has none, so the wire says RuntimeError.
test("a model refusal's trace class comes from the typed marker; its fixed text alone classifies as nothing special", () => {
  assert.deepEqual(modelRefusalTraceClassAttrs(), { runtime_error_class: "ModelRefusalError", turn_reason: "model_refusal" });
  const envelope = buildRuntimeErrorDiagnosticEnvelope(RUNTIME_MODEL_REFUSAL_MESSAGE);
  assert.equal(envelope.spanAttrs.runtime_error_class, "RuntimeError");
  assert.equal(envelope.spanAttrs.runtime_error_action_required, false);
  const activity = buildRuntimeErrorActivityDiagnostic(RUNTIME_MODEL_REFUSAL_MESSAGE);
  assert.equal(activity.errorClass, "RuntimeError");
  assert.equal(activity.errorReason, "unclassified_runtime_error");
  assert.equal(credentialInvalidReasonOf(RUNTIME_MODEL_REFUSAL_MESSAGE), null);
});

test("buildRuntimeErrorDiagnosticEnvelope classifies Anthropic maximum-context responses and extracts token accounting", () => {
  const providerRaw = buildRuntimeErrorDiagnosticEnvelope(
    "API Error: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"This model's maximum context length is 1,048,565 tokens. However, you requested 1,048,925 tokens (1,016,925 in the messages, 32,000 in the completion). Please reduce the length of the messages or completion.\"}}",
  );

  assert.equal(providerRaw.spanAttrs.runtime_error_class, "InputTooLargeError");
  assert.equal(providerRaw.spanAttrs.turn_reason, "input_too_large");
  assert.equal(providerRaw.spanAttrs.runtime_error_http_status, 400);
  assert.equal(providerRaw.spanAttrs.runtime_error_action, "none");
  assert.equal(providerRaw.spanAttrs.runtime_error_action_required, false);
  assert.equal(providerRaw.spanAttrs.runtime_input_context_limit_tokens, 1_048_565);
  assert.equal(providerRaw.spanAttrs.runtime_input_requested_tokens, 1_048_925);
  assert.equal(providerRaw.spanAttrs.runtime_input_message_tokens, 1_016_925);
  assert.equal(providerRaw.spanAttrs.runtime_input_completion_tokens, 32_000);
  assert.equal(providerRaw.spanAttrs.runtime_input_overage_tokens, 360);
});

test("buildRuntimeErrorDiagnosticEnvelope classifies Codex OAuth invalidation as auth errors", () => {
  const refreshReuse = buildRuntimeErrorDiagnosticEnvelope(
    "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
  );
  assert.equal(refreshReuse.spanAttrs.runtime_error_class, "AuthError");
  assert.equal(refreshReuse.spanAttrs.turn_reason, "auth_failed");
  assert.equal(refreshReuse.spanAttrs.runtime_error_action, "user_reauth");
  assert.equal(refreshReuse.spanAttrs.runtime_error_action_required, true);

  const invalidated = buildRuntimeErrorDiagnosticEnvelope(
    "unexpected status 401: Your authentication token has been invalidated.",
  );
  assert.equal(invalidated.spanAttrs.runtime_error_class, "AuthError");
  assert.equal(invalidated.spanAttrs.turn_reason, "auth_failed");
  assert.equal(invalidated.spanAttrs.runtime_error_http_status, 401);
  assert.equal(invalidated.spanAttrs.runtime_error_action, "user_reauth");
  assert.equal(invalidated.spanAttrs.runtime_error_action_required, true);

  const tokenRevoked = buildRuntimeErrorDiagnosticEnvelope(
    "codex_models_manager::manager failed against chatgpt.com: token_revoked",
  );
  assert.equal(tokenRevoked.spanAttrs.runtime_error_class, "AuthError");
  assert.equal(tokenRevoked.spanAttrs.turn_reason, "auth_failed");
  assert.equal(tokenRevoked.spanAttrs.runtime_error_action, "user_reauth");
  assert.equal(tokenRevoked.spanAttrs.runtime_error_action_required, true);
});

test("buildRuntimeErrorDiagnosticEnvelope keeps Codex launcher failures out of auth-required projection", () => {
  const launcherFailure = buildRuntimeErrorDiagnosticEnvelope(
    String.raw`unknown command 'C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js': Failed to authenticate because the access token could not be refreshed`,
  );

  assert.equal(launcherFailure.spanAttrs.runtime_error_class, "LauncherError");
  assert.equal(launcherFailure.spanAttrs.turn_reason, "launcher_error");
  assert.equal(launcherFailure.spanAttrs.runtime_error_action, "none");
  assert.equal(launcherFailure.spanAttrs.runtime_error_action_required, false);
  assert.deepEqual(buildRuntimeErrorActivityDiagnostic(
    String.raw`unknown command 'C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js': Failed to authenticate because the access token could not be refreshed`,
  ), {
    errorClass: "LauncherError",
    errorReason: "launcher_error",
    fingerprint: launcherFailure.spanAttrs.runtime_error_fingerprint,
    reasonProvenance: "runtime_error_event",
  });
});

test("buildRuntimeErrorDiagnosticEnvelope classifies Codex model account incompatibility", () => {
  const unsupportedModel = buildRuntimeErrorDiagnosticEnvelope(
    "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
  );

  assert.equal(unsupportedModel.spanAttrs.runtime_error_class, "ModelConfigError");
  assert.equal(unsupportedModel.spanAttrs.turn_reason, "model_config_error");
  assert.equal(unsupportedModel.spanAttrs.runtime_error_action, "none");
  assert.equal(unsupportedModel.spanAttrs.runtime_error_action_required, false);
});

test("buildRuntimeErrorDiagnosticEnvelope classifies login-required runtime failures as auth action", () => {
  const notLoggedIn = buildRuntimeErrorDiagnosticEnvelope("Antigravity CLI is not logged in. Please log in first.");
  assert.equal(notLoggedIn.spanAttrs.runtime_error_class, "AuthError");
  assert.equal(notLoggedIn.spanAttrs.turn_reason, "auth_failed");
  assert.equal(notLoggedIn.spanAttrs.runtime_error_action, "user_reauth");
  assert.equal(notLoggedIn.spanAttrs.runtime_error_action_required, true);

  const missingToken = buildRuntimeErrorDiagnosticEnvelope("Authentication failed: missing API token");
  assert.equal(missingToken.spanAttrs.runtime_error_class, "AuthError");
  assert.equal(missingToken.spanAttrs.turn_reason, "auth_failed");
  assert.equal(missingToken.spanAttrs.runtime_error_action, "user_reauth");
  assert.equal(missingToken.spanAttrs.runtime_error_action_required, true);

  const bareUnauthorized = buildRuntimeErrorDiagnosticEnvelope("API Error: 401 Unauthorized");
  assert.equal(bareUnauthorized.spanAttrs.runtime_error_class, "AuthError");
  assert.equal(bareUnauthorized.spanAttrs.runtime_error_http_status, 401);
  assert.equal(bareUnauthorized.spanAttrs.turn_reason, "auth_failed");
  assert.equal(bareUnauthorized.spanAttrs.runtime_error_action, "user_reauth");
  assert.equal(bareUnauthorized.spanAttrs.runtime_error_action_required, true);
});

test("buildRuntimeErrorDiagnosticEnvelope classifies provider connection failures", () => {
  const reset = buildRuntimeErrorDiagnosticEnvelope("API Error: Unable to connect to API (ECONNRESET)");
  assert.equal(reset.spanAttrs.runtime_error_class, "ProviderConnectionError");
  assert.equal(reset.spanAttrs.turn_outcome, "failed");
  assert.equal(reset.spanAttrs.turn_subtype, "runtime_error");
  assert.equal(reset.spanAttrs.turn_reason, "provider_connection_error");

  const refused = buildRuntimeErrorDiagnosticEnvelope("API Error: request failed with ECONNREFUSED");
  assert.equal(refused.spanAttrs.runtime_error_class, "ProviderConnectionError");
  assert.equal(refused.spanAttrs.turn_reason, "provider_connection_error");
});

// task #927: Grok CLI (reqwest) reports a request it could not send with no
// socket code. It is a connection error for diagnosis and delivery backoff;
// the process-close policy is unchanged (socket evidence only).
const REQWEST_SEND_FAILURE = "reqwest error stream: error sending request for url (https://cli-chat-proxy.grok.com/v1/responses)";

test("a reqwest request-send failure is a provider connection error, and more specific classes still win", () => {
  const sendFailure = buildRuntimeErrorDiagnosticEnvelope(REQWEST_SEND_FAILURE);
  assert.equal(sendFailure.spanAttrs.runtime_error_class, "ProviderConnectionError");
  assert.equal(sendFailure.spanAttrs.turn_reason, "provider_connection_error");
  assert.equal(sendFailure.spanAttrs.runtime_error_action ?? "none", "none", "no new recovery action");

  const cases: Array<[string, string]> = [
    [`${REQWEST_SEND_FAILURE}: operation timed out`, "TimeoutError"],
    [`${REQWEST_SEND_FAILURE}: HTTP 401 Unauthorized`, "AuthError"],
    [`${REQWEST_SEND_FAILURE}: HTTP 429 Too Many Requests`, "RateLimitError"],
    [`GrokApiError: ${REQWEST_SEND_FAILURE}`, "GrokApiError"],
    ["request failed", "RuntimeError"],
    ["error sending request", "RuntimeError"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(buildRuntimeErrorDiagnosticEnvelope(text).spanAttrs.runtime_error_class, expected, text);
  }
});

test("a reqwest request-send failure moves the delivery backoff reason but not the process-close policy", () => {
  assert.equal(recoverableRuntimeDeliveryBackoffReason(REQWEST_SEND_FAILURE, null, null), "provider_connection_error");
  assert.equal(recoverableRuntimeProcessCloseReason(REQWEST_SEND_FAILURE, null, null), null, "a close on this text alone is not recoverable, as before");
  assert.equal(
    recoverableRuntimeProcessCloseReason(`${REQWEST_SEND_FAILURE}: connection reset (ECONNRESET)`, null, null),
    "provider_connection_error",
    "socket evidence keeps its recoverable close",
  );
  assert.equal(recoverableRuntimeProcessCloseReason("API Error: Unable to connect to API (ECONNRESET)", null, null), "provider_connection_error");
  // Every earlier route into a recoverable connection close is kept, not only socket codes.
  assert.equal(recoverableRuntimeProcessCloseReason("ProviderConnectionError: transport unavailable", null, null), "provider_connection_error");
  assert.equal(
    recoverableRuntimeProcessCloseReason(`ProviderConnectionError: ${REQWEST_SEND_FAILURE}`, null, null),
    "provider_connection_error",
    "an explicit class name with the new phrase keeps its recoverable close",
  );
});

// agy (Go) reports a model request whose connection dropped as Go's url.Error
// around io.EOF; that close was a non-recoverable crash, dropping the inbox.
const GO_MODEL_REQUEST_EOF = 'Error: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF';

test("a Go HTTP request's EOF is a retryable provider connection error, also inside a process close", () => {
  const envelope = buildRuntimeErrorDiagnosticEnvelope(GO_MODEL_REQUEST_EOF);
  assert.equal(envelope.spanAttrs.runtime_error_class, "ProviderConnectionError");
  assert.equal(envelope.spanAttrs.turn_reason, "provider_connection_error");
  assert.equal(envelope.spanAttrs.runtime_error_action ?? "none", "none");
  assert.equal(recoverableRuntimeProcessCloseReason(GO_MODEL_REQUEST_EOF, null, null), "provider_connection_error");
  assert.equal(recoverableRuntimeDeliveryBackoffReason(GO_MODEL_REQUEST_EOF, null, null), "provider_connection_error");
  // The daemon's crash reason joins stderr lines with " | ".
  assert.equal(
    recoverableRuntimeProcessCloseReason(`exit code 1 | stderr: ${GO_MODEL_REQUEST_EOF} | retrying is up to the daemon`, null, null),
    "provider_connection_error",
  );
  assert.equal(
    recoverableRuntimeProcessCloseReason('Antigravity error: Get "https://example.test/v1/models": unexpected EOF', null, null),
    "provider_connection_error",
  );
  // A raw stdout JSON line quoted in the crash reason keeps its escaped quotes.
  const escaped = String.raw`exit code 1 | stdout: {"event":"result","result":{"status":"ERROR","error":"Post "https://example.test/v1:streamGenerateContent": EOF"}}`;
  assert.equal(buildRuntimeErrorDiagnosticEnvelope(escaped).spanAttrs.runtime_error_class, "ProviderConnectionError");
  assert.equal(recoverableRuntimeProcessCloseReason(escaped, null, null), "provider_connection_error");
});

test("text naming an EOF without a Go HTTP request is not a connection error", () => {
  const cases = [
    "Error: EOF",
    "unexpected EOF while parsing settings.json",
    "SyntaxError: Unexpected EOF in JSON input",
    "Reached EOF on the heredoc: EOF",
    'Post "not-a-url": EOF',
    'Post "https://example.test/upload": EOFError raised by the tool',
    String.raw`{"text":"Post "not-a-url": EOF"}`,
  ];
  for (const text of cases) {
    assert.notEqual(buildRuntimeErrorDiagnosticEnvelope(text).spanAttrs.runtime_error_class, "ProviderConnectionError", text);
    assert.equal(recoverableRuntimeProcessCloseReason(text, null, null), null, text);
  }
});

test("buildRuntimeErrorDiagnosticEnvelope classifies provider timeout codes", () => {
  const timeout = buildRuntimeErrorDiagnosticEnvelope("API Error: model request failed with ETIMEDOUT");
  assert.equal(timeout.spanAttrs.runtime_error_class, "TimeoutError");
  assert.equal(timeout.spanAttrs.turn_reason, "provider_timeout");
});

test("formatRuntimeLoginRequiredMessage gives action-oriented runtime copy", () => {
  assert.equal(
    formatRuntimeLoginRequiredMessage("antigravity"),
    "Antigravity CLI is not logged in on this machine. Please log in to Antigravity CLI locally, then retry starting this agent.",
  );
  assert.equal(
    formatRuntimeLoginRequiredMessage("claude"),
    "Claude Code is not logged in on this machine. Please log in to Claude Code locally, then retry starting this agent.",
  );
  assert.equal(
    formatRuntimeLoginRequiredMessage("pi"),
    "Pi's model provider rejected the API key, or no key is set for it on this machine. Check the API key for this agent's provider, then retry starting this agent.",
  );
  assert.equal(
    formatRuntimeLoginRequiredMessage("builtin"),
    "Built-in provider authentication failed. Check this agent's provider API key and region/provider selection, then retry starting this agent.",
  );
  // DeepSeek Harness has no login: the saved key (mode 600) first, then the provider's key variable; any provider dsh routes to.
  const dsh = formatRuntimeLoginRequiredMessage("dsh");
  assert.match(dsh, /saved in dsh's own settings comes first/);
  assert.match(dsh, /mode 600/);
  assert.match(dsh, /DEEPSEEK_API_KEY for DeepSeek/);
  assert.doesNotMatch(dsh, /not logged in|Settings/);
});

test("formatRuntimeStartTimeoutMessage names the provider as the likely cause, generic for most runtimes", () => {
  assert.equal(
    formatRuntimeStartTimeoutMessage("gemini", { timeoutMs: 120_000, model: "gemini-3.1-pro-preview" }),
    "Gemini CLI did not finish starting within 2 minutes. Its model provider may be slow or rate-limited; also check that Gemini CLI is installed, logged in, and can run non-interactively on this machine, then retry starting this agent.",
  );
  assert.equal(
    formatRuntimeStartTimeoutMessage("codex", { timeoutMs: 2_500 }),
    "Codex CLI did not finish starting within 3 seconds. Its model provider may be slow or rate-limited; also check that Codex CLI is installed, logged in, and can run non-interactively on this machine, then retry starting this agent.",
  );
});

test("formatRuntimeStartTimeoutMessage names an OpenCode model and its free tier", () => {
  assert.equal(
    formatRuntimeStartTimeoutMessage("opencode", { timeoutMs: 120_000, model: "opencode/mimo-v2.6-flash-free" }),
    "OpenCode did not finish starting within 2 minutes. The selected model (opencode/mimo-v2.6-flash-free, free tier) may be slow to respond, queued or rate-limited by its provider. Try again later, or switch to another model.",
  );
  assert.equal(
    formatRuntimeStartTimeoutMessage("opencode", { timeoutMs: 60_000, model: "anthropic/claude-sonnet-5" }),
    "OpenCode did not finish starting within 1 minute. The selected model (anthropic/claude-sonnet-5) may be slow to respond, queued or rate-limited by its provider. Try again later, or switch to another model.",
  );
});

const GROK_INPUT_TOO_LARGE_TEXT =
  "Grok Build reported input that is too large for the selected model. Restart keeps the existing session. "
  + "To start a new session, someone who can manage this agent can open Restart / Reset and choose Reset Session & Restart "
  + "(shown as Reset Model for members). This stops current work and clears the runtime conversation context, "
  + "while keeping Raft messages and workspace files, including MEMORY.md. "
  + "If the error persists in a new session, reduce the prompt or configured startup context.";

test("Grok's input-too-large message names the control that starts a new session", () => {
  const message = formatRuntimeInputTooLargeMessage("grok");
  assert.equal(message, GROK_INPUT_TOO_LARGE_TEXT, "the Grok text is unchanged");
  // No compaction exists for Grok and Restart reloads the same session, so the
  // text must point at the real control by its web labels, not "compact it".
  assert.doesNotMatch(message, /compact/i);
  assert.match(message, /^Grok Build reported input that is too large for the selected model\./);
  assert.match(message, /Restart keeps the existing session\./);
  assert.match(message, /open Restart \/ Reset and choose Reset Session & Restart \(shown as Reset Model for members\)/);
  assert.match(message, /keeping Raft messages and workspace files, including MEMORY\.md/);
  assert.match(message, /If the error persists in a new session, reduce the prompt or configured startup context\.$/);
});

test("Pi and Built-in name Reset Session & Restart too: Raft has no compact control and Restart resumes the session", () => {
  for (const [runtime, label] of [["pi", "Pi"], ["builtin", "Built-in Pi"]] as const) {
    const message = formatRuntimeInputTooLargeMessage(runtime);
    assert.doesNotMatch(message, /compact/i, runtime);
    assert.ok(message.startsWith(`${label} reported input that is too large for the selected model. Restart keeps the existing session. `), message);
    assert.match(message, /open Restart \/ Reset and choose Reset Session & Restart \(shown as Reset Model for members\)/, runtime);
  }
});

test("other runtimes keep the generic input-too-large text", () => {
  for (const runtime of ["claude", "codex", "kimi", "gemini", "opencode"]) {
    const message = formatRuntimeInputTooLargeMessage(runtime);
    assert.match(message, /For a resumed session, compact it or start a new session before retrying\.$/, runtime);
    assert.doesNotMatch(message, /Reset Session & Restart/, runtime);
  }
});

test("formatRuntimeInputTooLargeMessage gives bounded action guidance", () => {
  assert.equal(
    formatRuntimeInputTooLargeMessage("claude"),
    "Claude Code reported input that is too large for the selected model. Reduce the current prompt or injected startup context. For a resumed session, compact it or start a new session before retrying.",
  );
});

// task #917 — a Grok Build 402 "usage balance exhausted" was classified as a
// retryable ProviderApiError (or unclassified), so nothing ever stopped it.
test("buildRuntimeErrorDiagnosticEnvelope classifies billing exhaustion as BillingError", () => {
  for (const message of [
    "402 Grok Build usage balance exhausted",
    "HTTP 402: usage balance exhausted",
    "API Error: 402 Payment Required",
    "Request failed: insufficient credits for this request",
    "Your credit balance is too low to access the API",
  ]) {
    const envelope = buildRuntimeErrorDiagnosticEnvelope(message);
    assert.equal(envelope.spanAttrs.runtime_error_class, "BillingError", message);
    assert.equal(envelope.spanAttrs.turn_reason, "billing_exhausted", message);
    assert.equal(envelope.spanAttrs.runtime_error_action_required, false, message);
    assert.equal(buildRuntimeErrorActivityDiagnostic(message).errorReason, "billing_exhausted", message);
  }
});

test("billing classification leaves existing quota and rate-limit wording alone", () => {
  assert.notEqual(
    buildRuntimeErrorDiagnosticEnvelope("You've hit your usage limit. Upgrade your plan or try again later.").spanAttrs.runtime_error_class,
    "BillingError",
  );
  assert.equal(buildRuntimeErrorDiagnosticEnvelope("API Error: 429 Too Many Requests").spanAttrs.runtime_error_class, "RateLimitError");
  assert.equal(buildRuntimeErrorDiagnosticEnvelope("API Error: 400 Bad Request: bad input").spanAttrs.runtime_error_class, "ProviderApiError");
});

test("formatRuntimeBillingExhaustedMessage names billing, not input size, and says waiting messages are kept", () => {
  const message = formatRuntimeBillingExhaustedMessage("grok");
  assert.match(message, /billing or credit balance is exhausted/);
  assert.match(message, /kept and will be delivered/);
  assert.doesNotMatch(message, /too large/i);
});

test("task #352: provider plan-without-model is action-required; plain 429 and timeouts are not", () => {
  // Cell 1 — the field sample (z.ai code 1311) and two other provider phrasings.
  for (const message of [
    '429: {"code":"1311","message":"Your current subscription plan does not yet include access to GLM-5.3-Highspeed"}',
    "HTTP 403: Your plan does not include the model gpt-5-pro",
    "Model claude-opus-5-5 is not available on your current subscription tier",
  ]) {
    const envelope = buildRuntimeErrorDiagnosticEnvelope(message);
    assert.equal(isRuntimePlanAccessErrorText(message), true, message);
    assert.equal(envelope.spanAttrs.runtime_error_class, "ModelConfigError", message);
    assert.equal(envelope.spanAttrs.turn_reason, "model_config_error", message);
    assert.equal(envelope.spanAttrs.runtime_error_action, "user_model_access", message);
    assert.equal(envelope.spanAttrs.runtime_error_action_required, true, message);
    assert.equal(buildRuntimeErrorActivityDiagnostic(message).errorReason, "model_config_error", message);
  }
  assert.equal(
    buildRuntimeErrorDiagnosticEnvelope('429: {"code":"1311","message":"Your current subscription plan does not yet include access to GLM-5.3-Highspeed"}').spanAttrs.runtime_error_http_status,
    429,
  );

  // Cell 2 — ordinary rate limiting stays recoverable, never action-required.
  for (const message of [
    "API Error: 429 Too Many Requests",
    "429: rate limit exceeded, retry after 30s",
    '429: {"code":"1302","message":"High concurrency usage, please try again later"}',
    "The selected model is at capacity, please try again later",
  ]) {
    const envelope = buildRuntimeErrorDiagnosticEnvelope(message);
    assert.equal(isRuntimePlanAccessErrorText(message), false, message);
    assert.equal(envelope.spanAttrs.runtime_error_class, "RateLimitError", message);
    assert.equal(envelope.spanAttrs.runtime_error_action, "none", message);
    assert.equal(envelope.spanAttrs.runtime_error_action_required, false, message);
  }

  // Cell 2b — Stone's review (#proj-daemon:f7ef2e8b a262fe8c): limit wording
  // that also mentions plan/model is a transient limit, not missing access.
  for (const message of [
    "429 Your current plan does not support more requests to this model right now, please retry later",
    "429 Too many requests: concurrency for this model is not available on the free tier at the moment, retry in 30s",
    "Rate limit exceeded for model gpt-5: requests are not allowed on your plan until the window resets",
  ]) {
    const envelope = buildRuntimeErrorDiagnosticEnvelope(message);
    assert.equal(isRuntimePlanAccessErrorText(message), false, message);
    assert.notEqual(envelope.spanAttrs.runtime_error_class, "ModelConfigError", message);
    assert.equal(envelope.spanAttrs.runtime_error_action, "none", message);
    assert.equal(envelope.spanAttrs.runtime_error_action_required, false, message);
  }
  assert.equal(
    buildRuntimeErrorDiagnosticEnvelope("429 Too many requests: concurrency for this model is not available on the free tier at the moment, retry in 30s").spanAttrs.runtime_error_class,
    "RateLimitError",
  );

  // Cell 3 — timeouts stay recoverable, never action-required.
  for (const message of ["Request timed out.", "ETIMEDOUT", "request timeout after 60000ms"]) {
    const envelope = buildRuntimeErrorDiagnosticEnvelope(message);
    assert.equal(isRuntimePlanAccessErrorText(message), false, message);
    assert.equal(envelope.spanAttrs.runtime_error_class, "TimeoutError", message);
    assert.equal(envelope.spanAttrs.runtime_error_action, "none", message);
    assert.equal(envelope.spanAttrs.runtime_error_action_required, false, message);
  }

  // Neighbours keep their existing classification.
  assert.equal(buildRuntimeErrorDiagnosticEnvelope("Authentication failed: missing API token").spanAttrs.runtime_error_action, "user_reauth");
  assert.equal(
    buildRuntimeErrorDiagnosticEnvelope("You've hit your usage limit. Upgrade your plan or try again later.").spanAttrs.runtime_error_action_required,
    false,
  );
  const unsupported = buildRuntimeErrorDiagnosticEnvelope("model gpt-99 is not supported by this runtime");
  assert.equal(unsupported.spanAttrs.runtime_error_class, "ModelConfigError");
  assert.equal(unsupported.spanAttrs.runtime_error_action_required, false, "other ModelConfigError texts keep the sticky-terminal path");
});

test("formatRuntimePlanAccessMessage names the plan and the model, not a login", () => {
  const message = formatRuntimePlanAccessMessage("builtin", "glm-5.3-highspeed");
  assert.match(message, /provider plan for this agent does not include access to the configured model \(glm-5.3-highspeed\)/);
  assert.match(message, /Switch this agent to a model the plan includes, or upgrade the plan, then retry starting this agent\./);
  assert.doesNotMatch(message, /log in/i);
  assert.doesNotMatch(formatRuntimePlanAccessMessage("codex", null), /\(\)/);
});

// #proj-raft-computer:#46, reconciler step 4a: which runtime errors make the
// agent's credential invalid (the process is kept, deliveries wait for the
// credential). Exactly the existing classification; Codex's 403 "Usage not
// included in your plan" is the plan, so plan access (it used to be a
// non-sticky terminal failure, retried into the same 403).
test("credentialInvalidReasonOf: rejected sign-in, plan without the model, exhausted billing; nothing else", () => {
  assert.equal(credentialInvalidReasonOf("Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again."), "user_reauth");
  assert.equal(credentialInvalidReasonOf("API Error: 403 Forbidden: invalid api key"), "user_reauth");
  assert.equal(credentialInvalidReasonOf("HTTP 403: Your plan does not include the model gpt-5-pro"), "user_model_access");
  const codexPlan = "unexpected status 403 Forbidden: Usage not included in your plan";
  assert.equal(credentialInvalidReasonOf(codexPlan), "user_model_access");
  assert.equal(buildRuntimeErrorDiagnosticEnvelope(codexPlan).spanAttrs.runtime_error_action, "user_model_access");
  assert.equal(buildRuntimeErrorActivityDiagnostic(codexPlan).requiredAction, "user_model_access");
  assert.equal(credentialInvalidReasonOf("402 Grok Build usage balance exhausted"), "billing");
  assert.equal(credentialInvalidReasonOf("Your credit balance is too low to access the API"), "billing");
  for (const message of [
    "You've hit your usage limit. Upgrade your plan or try again later.",
    "API Error: 429 Too Many Requests",
    "API Error: 403 Request not allowed",
    "The requested model is not supported for this account.",
    "stream closed before response.completed",
  ]) {
    assert.equal(credentialInvalidReasonOf(message), null, message);
  }
});

test("#wg-rbac:#57: the daemon's scrubber and bound are shared's, and its fixed rewrites carry the server's codes", () => {
  assert.equal(scrubRuntimeErrorDiagnosticText, scrubRuntimeErrorText, "one scrubber for daemon and server");
  assert.equal(MAX_VISIBLE_CRASH_DETAIL_CHARS, MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS);
  assert.equal(buildBoundedVisibleCrashDetail(`${"x".repeat(600)}`), boundedRuntimeErrorDetail(`${"x".repeat(600)}`));
  for (const runtime of ["claude", "codex", "builtin", "pi", "qwen", "qoder", "gemini"]) {
    assert.equal(classifyRuntimeErrorCode({ message: formatRuntimeLoginRequiredMessage(runtime) }), "auth_required", runtime);
    assert.equal(classifyRuntimeErrorCode({ message: formatRuntimeInputTooLargeMessage(runtime) }), "input_too_large", runtime);
    assert.equal(classifyRuntimeErrorCode({ message: formatRuntimeBillingExhaustedMessage(runtime) }), "billing", runtime);
    assert.equal(classifyRuntimeErrorCode({ message: formatRuntimePlanAccessMessage(runtime, "glm-5") }), "model_unavailable", runtime);
  }
});

// AndyLok: Claude's limit errors alone had 102 fingerprints because the text
// carries the reset time. What changes between occurrences of one error
// (times, dates, waits, time zones, numbers) is not part of its fingerprint;
// its words are.
test("a runtime error's fingerprint ignores reset times, dates, durations and time zones, not its words", () => {
  const fingerprint = (text: string) => buildRuntimeErrorDiagnosticEnvelope(text).spanAttrs.runtime_error_fingerprint;
  const sameKind: Array<[string, string]> = [
    ["You've hit your weekly limit · resets 1pm (UTC)", "You've hit your weekly limit · resets 11:30 pm (America/New_York)"],
    ["Claude usage limit reached [01:24:56]", "Claude usage limit reached [23:05:01]"],
    ["5-hour limit reached ∙ resets Nov 14, 2026 3am (Europe/London)", "5-hour limit reached ∙ resets December 2 10pm (Asia/Shanghai)"],
    ["Rate limited, retry in 30s (resets 2026-11-12T11:04:02Z)", "Rate limited, retry in 2 minutes (resets 2026-11-13T00:00:00+08:00)"],
    ["Limit resets Monday at 9am PST", "Limit resets Friday at 17:00 GMT+8"],
  ];
  for (const [a, b] of sameKind) assert.equal(fingerprint(a), fingerprint(b), `${a} / ${b}`);

  const kinds = [
    "You've hit your weekly limit · resets 1pm (UTC)",
    "You've hit your session limit · resets 1pm (UTC)",
    "API Error: 529 Overloaded",
    "API Error: Connection error.",
    "Prompt is too long",
    "OAuth token has expired. Please run /login",
  ];
  assert.equal(new Set(kinds.map(fingerprint)).size, kinds.length, "different errors keep different fingerprints");
});

// AndyLok: one invalid-model error from a custom Codex provider (DeepSeek)
// had 3 fingerprints in 3 turns. Ids minted per request are not part of it.
test("a runtime error's fingerprint ignores request ids, uuids and hex ids, not its words", () => {
  const fingerprint = (text: string) => buildRuntimeErrorDiagnosticEnvelope(text).spanAttrs.runtime_error_fingerprint;
  const body = (model: string) => `unexpected status 400 Bad Request: {"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed ${model}.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}, url: https://api.deepseek.com/v1/chat/completions`;
  const variants = [
    `${body("deepseek-chat-does-not-exist")}, request id: 3f2a9c1e-7b4d-4e8a-9c1f-2d3e4f5a6b7c`,
    `${body("deepseek-chat-does-not-exist")}, request id: 0b7d14aa-2c3e-4f50-8a61-9d0e1f2a3b4c`,
    `${body("deepseek-chat-does-not-exist")}, request id: req_8Hk2LmQ9xZ4tR7vP1nB3`,
    `${body("deepseek-chat-does-not-exist")}, request id: 9a8b7c6d5e4f3a2b1c0d`,
  ];
  assert.equal(new Set(variants.map(fingerprint)).size, 1, "one error, one fingerprint");
  assert.equal(
    fingerprint(`${body("deepseek-chat-does-not-exist")}, cf-ray: 8f1a2b3c4d5e6f70-SJC`),
    fingerprint(`${body("deepseek-chat-does-not-exist")}, cf-ray: 90aa11bb22cc33dd-HKG`),
  );
  const bare = "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-chat-does-not-exist.";
  assert.equal(fingerprint(`${bare} (request id: a1b2c3d4)`), fingerprint(`${bare} (request id: 77e0ff12)`));
  assert.equal(fingerprint(`${bare} trace chatcmpl-9Zx81Kq2Lm`), fingerprint(`${bare} trace chatcmpl-4Ab7Cd9Ef0`));

  // A different model name, or a different error, keeps its own fingerprint.
  assert.notEqual(fingerprint(variants[0]!), fingerprint(`${body("gpt-oss-120b")}, request id: 3f2a9c1e-7b4d-4e8a-9c1f-2d3e4f5a6b7c`));
  assert.notEqual(fingerprint(variants[0]!), fingerprint("unexpected status 401 Unauthorized: invalid api key, request id: 3f2a9c1e-7b4d-4e8a-9c1f-2d3e4f5a6b7c"));
});

test("a runtime error's trace class comes from the typed provider error, then the text, then the reported status", () => {
  const traceClass = (message: string, providerError?: { codes?: string[]; httpStatus?: number }) =>
    runtimeErrorTraceClassAttrs(buildRuntimeErrorDiagnosticEnvelope(message), message, providerError);
  // Typed codes decide, whatever the wording.
  assert.deepEqual(traceClass("You've hit your limit · resets 1pm (UTC)", { codes: ["rate_limit"], httpStatus: 429 }), { runtime_error_class: "RateLimitError", turn_reason: "rate_limited", runtime_error_http_status: 429 });
  assert.equal(traceClass("Your credit balance is empty", { codes: ["billing_error"] }).runtime_error_class, "BillingError");
  assert.equal(traceClass("Account needs verifying", { codes: ["verification_required"], httpStatus: 403 }).runtime_error_class, "AuthError");
  assert.equal(traceClass("Overloaded", { codes: ["unknown_code", "server_error"], httpStatus: 529 }).runtime_error_class, "ProviderServerError");
  // No typed code: the text classifier, then the wording it does not know, then the status.
  assert.equal(traceClass("API Error: 502 Bad Gateway").runtime_error_class, "ProviderServerError");
  assert.equal(traceClass("OAuth token has expired. Please run /login", { httpStatus: 401 }).runtime_error_class, "AuthError");
  assert.equal(traceClass("Prompt is too long", { codes: ["invalid_request"], httpStatus: 400 }).runtime_error_class, "InputTooLargeError");
  assert.equal(traceClass("Auto-compact failed: conversation could not be summarized").runtime_error_class, "InputTooLargeError");
  assert.equal(traceClass("API Error: Connection error.").runtime_error_class, "ProviderConnectionError");
  assert.equal(traceClass("Claude AI usage limit reached|1731400000").runtime_error_class, "RateLimitError");
  assert.equal(traceClass("Something went wrong", { codes: ["unknown"], httpStatus: 503 }).runtime_error_class, "ProviderServerError");
  // Nothing typed or recognisable: RuntimeError, no status.
  assert.deepEqual(traceClass("Execution failed"), { runtime_error_class: "RuntimeError", turn_reason: "unclassified_runtime_error" });
});

// #proj-o11y:#42: Antigravity wording that ended as the generic RuntimeError.
// The texts are the ones agents showed in production (week to 2026-11-18).
test("Antigravity's model, capacity, network and cut-off-reply wording gets a class instead of RuntimeError", () => {
  const classOf = (message: string) => buildRuntimeErrorDiagnosticEnvelope(message).spanAttrs.runtime_error_class;

  // The agent's model setting: no retry fixes it.
  const notRecognized = 'Antigravity error: invalid model selection (--model "gemini-4-hydrogen" --effort ""): model gemini-4-hydrogen is not recognized as a known model or custom model in settings';
  assert.equal(classOf(notRecognized), "ModelConfigError");
  assert.equal(classOf('Antigravity CLI on this Computer no longer offers the model "gemini-pro-orchestrator-argon". Choose another model in the agent\'s settings.'), "ModelConfigError");
  assert.equal(classifyRuntimeErrorCode({ message: notRecognized, errorClass: String(classOf(notRecognized)) }), "model_unavailable");
  assert.equal(recoverableRuntimeProcessCloseReason(notRecognized, null, null), null, "a rejected model is not restarted");

  // A temporary limit on the provider's side: backed off and retried.
  const noCapacity = "Antigravity error: API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-4-hydrogen-medium on the server";
  assert.equal(classOf(noCapacity), "RateLimitError");
  assert.equal(classOf("Antigravity error: Our servers are experiencing high traffic right now, please try again in a minute."), "RateLimitError");
  assert.equal(classOf("Antigravity error: Resource exhausted. Please try again later."), "RateLimitError");
  assert.equal(recoverableRuntimeDeliveryBackoffReason(noCapacity, null, null), "rate_limited");

  // The connection to the provider.
  const networkIssue = "Antigravity error: There was a network issue connecting to the server, please try again.";
  assert.equal(classOf(networkIssue), "ProviderConnectionError");
  assert.equal(recoverableRuntimeProcessCloseReason(networkIssue, null, null), "provider_connection_error");

  // A reply cut off part-way.
  const interrupted = "Antigravity error: The stream was interrupted. Please continue the task you were working on.";
  assert.equal(classOf(interrupted), "ProviderStreamError");
  assert.equal(classOf("Antigravity: the reply ended before it was complete"), "ProviderStreamError");
  assert.equal(recoverableRuntimeProcessCloseReason(interrupted, null, null), "provider_stream_error");

  // A used-up quota stays with the provider-limit path, and an account Google disabled stays unclassified.
  assert.equal(classOf("Antigravity error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 160h1m46s."), "RuntimeError");
  assert.equal(classOf("Antigravity error: This service has been disabled in this account for violation of Terms of Service."), "RuntimeError");
});
