import assert from "node:assert/strict";

import {
  GENERIC_RUNTIME_ERROR_MESSAGE,
  MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS,
  MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS,
  RUNTIME_ERROR_CODES,
  RUNTIME_ERROR_CODE_SENTENCES,
  boundedRuntimeErrorDetail,
  classifyRuntimeErrorCode,
  isRuntimeErrorCode,
  isRuntimeErrorDetailActivity,
  memberRuntimeErrorMessage,
  scrubRuntimeErrorText,
} from "./runtimeErrorVisibility";

const POISONED = [
  "Request failed: Authorization: Bearer abcdefghijklmnop1234",
  "key sk-ant-api03-abcdefghijklmnop and xoxb-1234567890-abcdef",
  "contact jane.doe@example.com",
  "url https://user:pw@api.example.com/v1/x?token=secret123&a=b",
  "at /Users/jane/projects/raft/index.ts:12 and /home/bob/.config/x and C:\\Users\\Bob\\AppData\\x",
  "ANTHROPIC_API_KEY=sk-live-XYZ1234567 NODE_ENV=production password: hunter22",
  "gh token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 github_pat_11ABCDEF_xyz",
].join("\n");

test("the scrubber removes tokens, emails, URL queries and credentials, home paths, secret assignments and GitHub tokens", () => {
  const scrubbed = scrubRuntimeErrorText(POISONED);
  for (const secret of [
    "abcdefghijklmnop1234", "sk-ant-api03", "xoxb-1234567890", "jane.doe@example.com", "secret123", "user:pw",
    "/Users/jane", "/home/bob", "C:\\Users\\Bob", "sk-live-XYZ1234567", "hunter22", "ghp_ABCDEFGHIJ", "github_pat_11ABCDEF",
  ]) {
    assert.ok(!scrubbed.includes(secret), `${secret} must be gone: ${scrubbed}`);
  }
  assert.match(scrubbed, /Bearer \[REDACTED_TOKEN\]/);
  assert.match(scrubbed, /\[REDACTED_EMAIL\]/);
  assert.match(scrubbed, /\[REDACTED_PATH\]/);
  assert.match(scrubbed, /ANTHROPIC_API_KEY=\[REDACTED_TOKEN\]/);
  assert.match(scrubbed, /NODE_ENV=production/, "a benign assignment survives");
});

test("scrubbing is idempotent, so a stored scrubbed row reads back unchanged", () => {
  const once = scrubRuntimeErrorText(POISONED);
  assert.equal(scrubRuntimeErrorText(once), once);
  assert.equal(boundedRuntimeErrorDetail(boundedRuntimeErrorDetail(POISONED)), boundedRuntimeErrorDetail(POISONED));
});

test("the bounded detail is scrubbed and at most 512 characters", () => {
  assert.equal(MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS, 512);
  const long = `${"x".repeat(600)} /Users/jane/secret`;
  assert.equal(boundedRuntimeErrorDetail(long).length, 512);
  const tail = `${"y".repeat(100)} sk-abcdefghijklmnop`;
  assert.ok(!boundedRuntimeErrorDetail(tail).includes("sk-abcdefghijklmnop"));
  assert.equal(boundedRuntimeErrorDetail("short"), "short");
});

// A Computer sends this text, so its length and shape are the sender's. The
// earlier patterns took seconds for 10 KB of these (cubic for the assignment
// key, quadratic for the address) and blocked the server while they ran.
test("the scrubber's work grows with the text, not its square: hostile runs with nothing to redact return at once", () => {
  for (const hostile of [
    "TOKEN-".repeat(20_000),
    "API_KEY.SECRET-".repeat(8_000),
    "a.".repeat(60_000),
    `x@${"a.".repeat(60_000)}`,
    `${"/home/".repeat(20_000)}`,
  ]) {
    const started = performance.now();
    scrubRuntimeErrorText(hostile);
    const took = performance.now() - started;
    assert.ok(took < 1_000, `${hostile.slice(0, 16)}… (${hostile.length} chars) took ${Math.round(took)} ms`);
  }
});

test("a secret-shaped key is found wherever its run starts, and a benign assignment does not hide the one after it", () => {
  assert.equal(scrubRuntimeErrorText("--api_key=abc123"), "--api_key=[REDACTED_TOKEN]");
  assert.equal(scrubRuntimeErrorText('my.API_KEY : "v a l"'), "my.API_KEY=[REDACTED_TOKEN]");
  assert.equal(scrubRuntimeErrorText("NODE_ENV=API_KEY=abc123"), "NODE_ENV=API_KEY=[REDACTED_TOKEN]");
  assert.equal(scrubRuntimeErrorText("x-TOKEN-y z"), "x-TOKEN-y z", "no assignment, nothing redacted");
  assert.equal(scrubRuntimeErrorText("..jane.doe@example.com."), "[REDACTED_EMAIL].");
});

test("the bounded detail reads a bounded part of the raw text and drops the word the cut split", () => {
  // The cut falls inside the second credential, leaving `sk-abcde`: too short for a pattern to recognise.
  const raw = `Bearer ${"A".repeat(MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS - 16)} sk-abcdefghijklmnop`;
  assert.equal(raw.slice(0, MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS).slice(-8), "sk-abcde");
  assert.ok(scrubRuntimeErrorText(raw.slice(0, MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS)).includes("sk-abcde"), "cut alone, the piece would be shown");
  assert.equal(boundedRuntimeErrorDetail(raw).trim(), "Bearer [REDACTED_TOKEN]");
  // One unbroken word longer than the cap is still read (and cut to what is shown).
  assert.equal(boundedRuntimeErrorDetail("z".repeat(10_000)).length, MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS);
  const started = performance.now();
  boundedRuntimeErrorDetail("TOKEN-".repeat(200_000));
  assert.ok(performance.now() - started < 1_000);
});

// Warden's case (#14122): long paths before the cut shrink to little, so what follows the cut is shown.
test("a quoted secret the cut ends inside is redacted to the end of the text", () => {
  const path = `/Users/alice/${"x".repeat(180)}`;
  let raw = "";
  while (raw.length < MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS - 40) raw += `${path} `;
  raw = `${raw.slice(0, MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS - 22)} password: "correct horse battery staple" tail`;
  const shown = boundedRuntimeErrorDetail(raw);
  for (const word of ["correct", "horse", "battery", "staple"]) assert.ok(!shown.includes(word), `${word} must be gone: ${shown.slice(-80)}`);
  assert.match(shown, /password=\[REDACTED_TOKEN\]\s*$/);
});

test("a value with no closing quote, or one the bare form excludes, is redacted and its key kept", () => {
  assert.equal(scrubRuntimeErrorText('token="abc def'), "token=[REDACTED_TOKEN]");
  assert.equal(scrubRuntimeErrorText("API_KEY='p q r"), "API_KEY=[REDACTED_TOKEN]");
  assert.equal(scrubRuntimeErrorText("password: <hunter2> next"), "password: [REDACTED_TOKEN] next");
  assert.equal(scrubRuntimeErrorText("password: hunter22"), "password=[REDACTED_TOKEN]");
  assert.equal(scrubRuntimeErrorText('say "hello world'), 'say "hello world', "a stray quote outside an assignment is left alone");
  assert.equal(scrubRuntimeErrorText('key: "x"; other'), 'key: "x"; other');
});

test("a typed class or required action decides the code", () => {
  assert.equal(classifyRuntimeErrorCode({ errorClass: "BillingError", message: "x" }), "billing");
  assert.equal(classifyRuntimeErrorCode({ errorClass: "AuthError", message: "x" }), "auth_required");
  assert.equal(classifyRuntimeErrorCode({ requiredAction: "user_reauth", message: "x" }), "auth_required");
  assert.equal(classifyRuntimeErrorCode({ errorClass: "ModelConfigError", message: "x" }), "model_unavailable");
  assert.equal(classifyRuntimeErrorCode({ requiredAction: "user_model_access", message: "x" }), "model_unavailable");
  assert.equal(classifyRuntimeErrorCode({ errorClass: "InputTooLargeError", message: "x" }), "input_too_large");
  assert.equal(classifyRuntimeErrorCode({ errorClass: "MessageTooLargeError", message: "x" }), "message_too_large");
  assert.equal(classifyRuntimeErrorCode({ errorClass: "TimeoutError", message: "x" }), "network_timeout");
  assert.equal(classifyRuntimeErrorCode({ errorClass: "ProviderConnectionError", message: "x" }), "network_timeout");
  assert.equal(classifyRuntimeErrorCode({ errorClass: "RateLimitError", message: "You have hit your usage limit" }), "usage_limit", "a quota reported as a 429");
});

test("without a class that names a code, the text decides; unknown text has no code", () => {
  const cases: Array<[string, string | null]> = [
    ["You've hit your usage limit. Try again at 5pm.", "usage_limit"],
    ["Quota exceeded for this project", "usage_limit"],
    ["API Error: 402 Payment Required", "billing"],
    ["Codex reported that the provider's billing or credit balance is exhausted.", "billing"],
    ["Codex reported that the provider plan for this agent does not include access to the configured model (gpt-9).", "model_unavailable"],
    ["Claude Code is not logged in on this machine. Please log in to Claude Code locally", "auth_required"],
    ["Pi's model provider rejected the API key, or no key is set for it", "auth_required"],
    ["Codex reported input that is too large for the selected model.", "input_too_large"],
    ["This message is too long for Antigravity to take in one message (over about 185 KB), so it was not delivered.", "message_too_large"],
    ["connect ETIMEDOUT 10.0.0.1:443", "network_timeout"],
    ["Unable to connect to API (ECONNRESET)", "network_timeout"],
    ["TypeError: Cannot read properties of undefined (reading 'foo')", null],
    ["", null],
  ];
  for (const [message, code] of cases) {
    assert.equal(classifyRuntimeErrorCode({ message, errorClass: "RuntimeError" }), code, message);
    assert.equal(classifyRuntimeErrorCode({ message }), code, message);
  }
});

test("a member's text is the code's fixed sentence or the generic message, never the error", () => {
  assert.equal(memberRuntimeErrorMessage(null), GENERIC_RUNTIME_ERROR_MESSAGE);
  assert.equal(GENERIC_RUNTIME_ERROR_MESSAGE, "Agent encountered an error");
  for (const code of RUNTIME_ERROR_CODES) {
    assert.ok(isRuntimeErrorCode(code));
    assert.equal(memberRuntimeErrorMessage(code), RUNTIME_ERROR_CODE_SENTENCES[code]);
    assert.ok(RUNTIME_ERROR_CODE_SENTENCES[code].length > 20);
  }
  assert.equal(isRuntimeErrorCode("rate_limited"), false);
});

test("a runtime error detail is an error activity, or a runtime-error / crash detail kind on any activity", () => {
  assert.equal(isRuntimeErrorDetailActivity({ activity: "error" }), true);
  assert.equal(isRuntimeErrorDetailActivity({ activity: "offline", detailKind: "runtime_crashed" }), true);
  assert.equal(isRuntimeErrorDetailActivity({ activity: "online", detailKind: "runtime_error" }), true);
  assert.equal(isRuntimeErrorDetailActivity({ activity: "offline", detailKind: "stopped" }), false);
  assert.equal(isRuntimeErrorDetailActivity({ activity: "working", detailKind: null }), false);
});
