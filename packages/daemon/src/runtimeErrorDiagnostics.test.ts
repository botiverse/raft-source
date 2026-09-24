import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildRuntimeErrorActivityDiagnostic,
  buildRuntimeErrorDiagnosticEnvelope,
  formatRuntimeInputTooLargeMessage,
  formatRuntimeLoginRequiredMessage,
  formatRuntimeStartTimeoutMessage,
} from "./runtimeErrorDiagnostics.js";

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

test("buildRuntimeErrorDiagnosticEnvelope detoxes poisoned stderr (env-assignment + GitHub tokens + trace-no-raw)", () => {
  // #688 load-bearing poisoned specimen: secrets that the old scrubber (Bearer/sk-*/email/url/path)
  // did NOT cover. They must not appear in the user-visible excerpt, yet the original must still
  // drive internal classification (not fake-green by dropping the whole detail).
  const poisoned = [
    "Error: ANTHROPIC_API_KEY=sk-ant-api03-this-is-a-long-secret-value-1234567890",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "OPENAI_API_KEY=sk-abcdef0123456789abcdef0123456789",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmNO",
    "connection password=hunter2 sentinel",
    "NODE_ENV=production must survive",
    "API Error: 500 Internal Server Error upstream",
  ].join("\n");

  const envelope = buildRuntimeErrorDiagnosticEnvelope(poisoned);
  const excerpt = String(envelope.eventAttrs.runtime_error_message_excerpt);

  assert.equal(excerpt.includes("sk-ant-api03-this-is-a-long-secret-value-1234567890"), false, "anthropic value leaks");
  assert.equal(excerpt.includes("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"), false, "aws secret leaks");
  assert.equal(excerpt.includes("sk-abcdef0123456789abcdef0123456789"), false, "openai value leaks");
  assert.equal(excerpt.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), false, "ghp token leaks");
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
    "Pi is not logged in on this machine. Please log in to Pi locally, then retry starting this agent.",
  );
  assert.equal(
    formatRuntimeLoginRequiredMessage("builtin"),
    "Built-in provider authentication failed. Check this agent's provider API key and region/provider selection, then retry starting this agent.",
  );
});

test("formatRuntimeStartTimeoutMessage gives bounded-startup guidance", () => {
  assert.equal(
    formatRuntimeStartTimeoutMessage("gemini"),
    "Gemini CLI did not finish starting on this machine. Check that Gemini CLI is installed, logged in, and can run non-interactively, then retry starting this agent.",
  );
});

test("formatRuntimeInputTooLargeMessage gives bounded action guidance", () => {
  assert.equal(
    formatRuntimeInputTooLargeMessage("claude"),
    "Claude Code reported input that is too large for the selected model. Reduce the current prompt or injected startup context. For a resumed session, compact it or start a new session before retrying.",
  );
});
