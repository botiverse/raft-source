import assert from "node:assert/strict";

import {
  GENERIC_RUNTIME_ERROR_MESSAGE,
  MAX_SCRUBBED_RUNTIME_ERROR_INPUT_CHARS,
  MAX_START_FAILURE_MESSAGE_CHARS,
  MAX_VISIBLE_RUNTIME_ERROR_DETAIL_CHARS,
  RUNTIME_ERROR_CODES,
  RUNTIME_ERROR_CODE_SENTENCES,
  boundedRuntimeErrorDetail,
  boundedStartFailureMessage,
  classifyRuntimeErrorCode,
  isRuntimeErrorCode,
  isRuntimeErrorDetailActivity,
  memberRuntimeErrorMessage,
  scrubRuntimeErrorText,
} from "./runtimeErrorVisibility";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES } from "./test/diagnosticRedactionCredentialSamples";

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
    "--a-".repeat(30_000),
    "Basic ".repeat(20_000),
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

// Security review (2026-11): the telemetry excerpt and the manager-visible
// detail both come from this scrubber, which let these shapes through. One
// case per shape: the value goes, the status code / key / scheme / flag stays.
const AKIA_ID = "AK" + "IA" + "IOSFODNN7EXAMPLE";
const ASIA_ID = "AS" + "IA" + "IOSFODNN7EXAMPLEABCD";
const GOOGLE_KEY = "AI" + "za" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
const GOOGLE_OAUTH = "ya" + "29." + "a0AfB_byC1d2E3f4G5h6I7j8K9";
const BARE_JWT = "ey" + "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.c2ln";
const RUNTIME_SHAPES: readonly { shape: string; input: string; secret: string; scrubbed: string }[] = [
  {
    shape: "JSON-quoted api_key",
    input: 'Error: 401 from https://api.example.test/v1/messages {"type":"error","api_key": "Zq81mNw2Lp0x"}',
    secret: "Zq81mNw2Lp0x",
    scrubbed: 'Error: 401 from https://api.example.test/v1/messages {"type":"error","api_key": "[REDACTED_TOKEN]"}',
  },
  { shape: "JSON-quoted token, no space", input: '400 {"token":"tq.82Hd-1x"}', secret: "tq.82Hd-1x", scrubbed: '400 {"token":"[REDACTED_TOKEN]"}' },
  { shape: "JSON-quoted password with spaces", input: '{"password": "correct horse battery", "user": "x"}', secret: "horse", scrubbed: '{"password": "[REDACTED_TOKEN]", "user": "x"}' },
  { shape: "JSON-quoted secret", input: '{"secret": "s3cr3tValue"} rejected', secret: "s3cr3tValue", scrubbed: '{"secret": "[REDACTED_TOKEN]"} rejected' },
  { shape: "JSON-quoted access_token", input: '{"access_token": "at-9f8e7d6c"}', secret: "at-9f8e7d6c", scrubbed: '{"access_token": "[REDACTED_TOKEN]"}' },
  { shape: "JSON-quoted refresh_token", input: '{"refresh_token": "rt-1a2b3c4d"}', secret: "rt-1a2b3c4d", scrubbed: '{"refresh_token": "[REDACTED_TOKEN]"}' },
  { shape: "JSON-escaped client_secret", input: String.raw`{\"client_secret\":\"cs-5e6f7a8b\"}`, secret: "cs-5e6f7a8b", scrubbed: String.raw`{\"client_secret\":\"[REDACTED_TOKEN]\"}` },
  { shape: "Authorization: Basic", input: "401 Unauthorized; Authorization: Basic dXNlcjpodW50ZXIy", secret: "dXNlcjpodW50ZXIy", scrubbed: "401 Unauthorized; Authorization: Basic [REDACTED_TOKEN]" },
  { shape: "Basic outside a header", input: "curl: (22) 401 with Basic dXNlcjpwYXNz", secret: "dXNlcjpwYXNz", scrubbed: "curl: (22) 401 with Basic [REDACTED_TOKEN]" },
  { shape: "bare JWT", input: `401: jwt ${BARE_JWT} expired`, secret: BARE_JWT, scrubbed: "401: jwt [REDACTED_TOKEN] expired" },
  { shape: "AWS access key id", input: `403 InvalidClientTokenId for ${AKIA_ID}`, secret: AKIA_ID, scrubbed: "403 InvalidClientTokenId for [REDACTED_TOKEN]" },
  { shape: "AWS STS key id", input: `403 for ${ASIA_ID}`, secret: ASIA_ID, scrubbed: "403 for [REDACTED_TOKEN]" },
  { shape: "AWS secret access key, JSON", input: '403 {"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}', secret: "wJalrXUtnFEMI", scrubbed: '403 {"SecretAccessKey": "[REDACTED_TOKEN]"}' },
  { shape: "Google API key", input: `400 API key not valid: ${GOOGLE_KEY}.`, secret: GOOGLE_KEY, scrubbed: "400 API key not valid: [REDACTED_TOKEN]." },
  { shape: "Google OAuth token", input: `401 token ${GOOGLE_OAUTH} rejected`, secret: GOOGLE_OAUTH, scrubbed: "401 token [REDACTED_TOKEN] rejected" },
  { shape: "--api-key <v>", input: "exit 1: claude --api-key Zq81mNw2Lp0x --verbose", secret: "Zq81mNw2Lp0x", scrubbed: "exit 1: claude --api-key [REDACTED_TOKEN] --verbose" },
  { shape: "--token <v>", input: "gh --token abcdEFGH1234 failed", secret: "abcdEFGH1234", scrubbed: "gh --token [REDACTED_TOKEN] failed" },
  { shape: "--password \"<v>\"", input: 'db --password "correct horse" refused', secret: "horse", scrubbed: "db --password [REDACTED_TOKEN] refused" },
  { shape: "--secret <v>", input: "run --secret s3c --x", secret: "s3c", scrubbed: "run --secret [REDACTED_TOKEN] --x" },
  { shape: "--auth <v>", input: "proxy --auth u1:p2 up", secret: "u1:p2", scrubbed: "proxy --auth [REDACTED_TOKEN] up" },
];

for (const { shape, input, secret, scrubbed } of RUNTIME_SHAPES) {
  test(`runtime error text, ${shape}: the value goes, the text around it stays`, () => {
    assert.equal(scrubRuntimeErrorText(input), scrubbed);
    assert.ok(!scrubbed.includes(secret));
    assert.equal(scrubRuntimeErrorText(scrubbed), scrubbed, "idempotent");
  });
}

test("runtime error text masks every shared credential sample (one catalogue with the feedback log tail)", () => {
  for (const { label, sample, mustNotContain } of DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES) {
    const once = scrubRuntimeErrorText(sample);
    assert.ok(!once.includes(mustNotContain), `${label} leaked: ${once}`);
    assert.equal(scrubRuntimeErrorText(once), once, `${label} not idempotent`);
  }
});

test("runtime error text: ordinary text, commit SHAs included, is not masked", () => {
  for (const line of [
    "model claude-sonnet-4-5-20250929 not found; try gpt-5.1-codex or gemini-2.5-pro",
    "request 123e4567-e89b-12d3-a456-426614174000 failed",
    "ENOENT: no such file or directory, open 'src/tokenizer.ts' (secret_store.json)",
    "claude --verbose --model opus --max-tokens 4096 --token-budget 2000 --output-format stream-json --secret-file x",
    "raft-daemon 0.98.1 on node v22.11.0",
    "fatal: bad object 3c0f7bab8e1d2f3a4b5c6d7e8f90123456789abc",
    "Basic Authentication failed; Authorization header missing; password reset required",
    "disk_usage_bytes=1234 task_list_x",
  ]) {
    assert.equal(scrubRuntimeErrorText(line), line);
  }
});

// Adversarial review of #14933: the escape, quoting and prose cases on the
// runtime surface (every new sample is also in the shared-sample test above).
test("runtime error text: keys after escapes and quoted values with escapes are masked, labels kept", () => {
  assert.equal(scrubRuntimeErrorText(String.raw`{"msg":"line1\nsk_agent_ABCDEF123456"}`), String.raw`{"msg":"line1\n[REDACTED_TOKEN]"}`);
  assert.equal(scrubRuntimeErrorText("key%3Dsk_agent_ABCDEF123456"), "key%3D[REDACTED_TOKEN]");
  assert.equal(scrubRuntimeErrorText(String.raw`\n--password hunter2!`), String.raw`\n--password [REDACTED_TOKEN]`);
  assert.equal(scrubRuntimeErrorText(`{"password": "it's secret value", "user": "bob"}`), `{"password": "[REDACTED_TOKEN]", "user": "bob"}`);
  assert.equal(scrubRuntimeErrorText(String.raw`{"password":"p\"ass", "user": "bob"}`), `{"password":"[REDACTED_TOKEN]", "user": "bob"}`);
  assert.equal(scrubRuntimeErrorText('{"api_key":"xxxxx\\u0022SECRETAFTERESCAPE"}'), '{"api_key":"[REDACTED_TOKEN]"}');
  assert.equal(scrubRuntimeErrorText(`{"password": 1234, "pin": 482913}`), `{"password": [REDACTED_TOKEN], "pin": [REDACTED_TOKEN]}`);
  assert.equal(scrubRuntimeErrorText(String.raw`{"client_secret":"ab\/cd\\ef\/SECRETTAIL"}`), '{"client_secret":"[REDACTED_TOKEN]"}');
});

test("runtime error text: prose after secret flags and Authorization, JSON literals and in-word lookalikes stay readable", () => {
  for (const line of [
    "missing --token flag; use --api-key or set X; pass --token to cli",
    "Authorization: required; authorization: denied; Authorization=none",
    `{"secret": true, "api_key": null, "has_secret": false}`,
    "pin: 3.11 spin=1234",
    "auth: login required; oauth: refresh failed",
    "disk_usage_bytes task_sk_test_1",
  ]) {
    assert.equal(scrubRuntimeErrorText(line), line);
  }
});

test("runtime error text: connection-string passwords are masked", () => {
  for (const [input, password] of [
    ["connect ECONNREFUSED postgres://app:hunter2@db:5432/x", "hunter2"], ["mysql://root:s3cret@127.0.0.1:3306/db", "s3cret"],
    ["redis://:pw42@host:6379", "pw42"], ["mongodb+srv://u:p4ss@cluster0.example.net/db", "p4ss"], ["amqps://u:pa55@mq:5671", "pa55"],
  ] as const) {
    const scrubbed = scrubRuntimeErrorText(input);
    assert.ok(!scrubbed.includes(password), scrubbed);
    assert.equal(scrubRuntimeErrorText(scrubbed), scrubbed);
  }
  assert.equal(scrubRuntimeErrorText("connect ECONNREFUSED postgres://app:hunter2@db:5432/x"), "connect ECONNREFUSED postgres://app:[REDACTED_TOKEN]@db:5432/x");
  for (const line of ["http://host:8080/path", "ssh://git@host/x", "postgres://db:5432/x"]) assert.equal(scrubRuntimeErrorText(line), line);
});

// Tenny's review of #14933: cookies, more token prefixes, YAML block values and
// passwords with an unencoded `/`, on the runtime surface. The connection
// string and the YAML block are read before this scrubber's own passes, which
// would otherwise mask `cd@db.example.com` as an email (leaving `ab/`) and
// rewrite `password: |` before the block under it is seen.
test("runtime error text: cookies, hf/glpat/npm/rk tokens, YAML block secrets and slash passwords are masked", () => {
  const cases: readonly [string, string][] = [
    ["401 Cookie: session=abc123; theme=dark", "401 Cookie: [REDACTED_TOKEN]"],
    ["Set-Cookie: sid=zz9; Path=/; HttpOnly", "Set-Cookie: [REDACTED_TOKEN]"],
    [`{"cookie": "sid=abc123", "set-cookie": ["a=b", "c=d"]}`, `{"cookie": "[REDACTED_TOKEN]", "set-cookie": [[REDACTED_TOKEN]]}`],
    [`pull ${"h" + "f_"}AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh failed`, "pull [REDACTED_TOKEN] failed"],
    [`remote: ${"gl" + "pat-"}AbCdEf0123456789_-xy rejected`, "remote: [REDACTED_TOKEN] rejected"],
    [`using ${"np" + "m_"}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`, "using [REDACTED_TOKEN]"],
    [`stripe ${"r" + "k_live_"}51HqAbCdEfGhIjKlMnOpQrStUv`, "stripe [REDACTED_TOKEN]"],
    ["connect postgres://app:ab/cd@db.example.com:5432/x", "connect postgres://app:[REDACTED_TOKEN]@db.example.com:5432/x"],
    ["postgres://u:ab/cd@host:5432/db", "postgres://u:[REDACTED_TOKEN]@host:5432/db"],
    ["config:\n  private_key: |\n    line1\n    line2\n  user: bob", "config:\n  private_key=[REDACTED_TOKEN]\n    [REDACTED_TOKEN]\n  user: bob"],
    ["db:\n  password: >-\n    pw1\n  host: db", "db:\n  password: [REDACTED_TOKEN]\n    [REDACTED_TOKEN]\n  host: db"],
    // Adversarial review of #14963.
    ["postgres://u:pw@db/x?notify=alice@corp.example.com", "postgres://u:[REDACTED_TOKEN]@db/x?notify=[REDACTED_EMAIL]"],
    ["postgres://u:pw@db/x,alice@corp.example.com", "postgres://u:[REDACTED_TOKEN]@db/x,[REDACTED_EMAIL]"],
    ["http://u:SECRET/WITHSLASH@10.0.0.1/x", "http://%5BREDACTED_USER%5D:%5BREDACTED_PASSWORD%5D@10.0.0.1/x"],
    ["https://u:ab/cd@db/x", "https://%5BREDACTED_USER%5D:%5BREDACTED_PASSWORD%5D@db/x"],
    ["https://u:ab/cd@host.example.com/x", "https://%5BREDACTED_USER%5D:%5BREDACTED_PASSWORD%5D@host.example.com/x"],
    ["Cookie: sid=abc123", "Cookie: [REDACTED_TOKEN]"],
    ["users:\n- password: |\n    LIST1\n  name: bob", "users:\n- password=[REDACTED_TOKEN]\n    [REDACTED_TOKEN]\n  name: bob"],
    [`deploy ${"gl" + "dt-"}AbCdEf0123456789_-xy`, "deploy [REDACTED_TOKEN]"],
  ];
  for (const [input, scrubbed] of cases) {
    assert.equal(scrubRuntimeErrorText(input), scrubbed);
    assert.equal(scrubRuntimeErrorText(scrubbed), scrubbed, "idempotent");
  }
  for (const line of [
    "Set-Cookie: header missing; cookie: none",
    "hf_hub_download npm_config_cache rk_test",
    "description: |\n  not a secret\nnext: 1",
    "http://host:8080/path ssh://git@host/x postgres://db:5432/x",
  ]) {
    assert.equal(scrubRuntimeErrorText(line), line);
  }
});

test("runtime error text: a value the generic pass masked reads back unchanged", () => {
  const once = scrubRuntimeErrorText("password: <hunter2> next");
  assert.equal(once, "password: [REDACTED_TOKEN] next");
  assert.equal(scrubRuntimeErrorText(once), once);
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

// A failed start's own error text (SpawnFailureActivityDiagnostic.message):
// what a thrown start error typically names, each shape redacted.
test("a failed start's message has home paths, API keys and emails redacted", () => {
  const cases: Array<{ raw: string; secret: string; marker: string }> = [
    { raw: "spawn failed: C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd not found", secret: "alice", marker: "[REDACTED_PATH]" },
    { raw: "ENOENT: no such file or directory, open '/home/bob/.kimi-code/config.toml'", secret: "bob", marker: "[REDACTED_PATH]" },
    { raw: "cannot read /Users/carol/Library/Application Support/x", secret: "carol", marker: "[REDACTED_PATH]" },
    { raw: "401 Unauthorized: invalid key sk-proj-AbCdEfGh12345678ZyXw", secret: "AbCdEfGh12345678", marker: "[REDACTED_TOKEN]" },
    { raw: "401: key sk-AbCdEfGh12345678ZyXw rejected", secret: "AbCdEfGh12345678", marker: "[REDACTED_TOKEN]" },
    { raw: "account dave.smith@example.org is not signed in", secret: "dave.smith@example.org", marker: "[REDACTED_EMAIL]" },
  ];
  for (const { raw, secret, marker } of cases) {
    const message = boundedStartFailureMessage(raw);
    assert.ok(!message.includes(secret), `${secret} must be gone: ${message}`);
    assert.ok(message.includes(marker), `${marker} expected: ${message}`);
  }
});

test("a failed start's message is capped at 300 characters after scrubbing", () => {
  assert.equal(MAX_START_FAILURE_MESSAGE_CHARS, 300);
  // Long home paths shrink to a marker each: the error's words after them are
  // within the cap once scrubbed, though far past 300 raw characters.
  const longPath = `/home/erin/${"deep/".repeat(80)}file.ts`;
  const raw = `failed at ${longPath} with key sk-ant-api03-SECRETSECRET1234 and tail words`;
  assert.ok(raw.length > 400);
  const message = boundedStartFailureMessage(raw);
  assert.equal(message, "failed at [REDACTED_PATH] with key [REDACTED_TOKEN] and tail words");
  // Over the cap after scrubbing: cut to 300, never showing a secret near the cut.
  const filler = "x ".repeat(146);
  const overCap = `${filler}jane.doe@example.com sk-AbCdEfGh12345678ZyXw ${"y".repeat(400)}`;
  const capped = boundedStartFailureMessage(overCap);
  assert.equal(capped.length, MAX_START_FAILURE_MESSAGE_CHARS);
  assert.equal(capped, boundedRuntimeErrorDetail(overCap).slice(0, MAX_START_FAILURE_MESSAGE_CHARS));
  for (const secret of ["jane", "doe@example", "AbCdEfGh"]) assert.ok(!capped.includes(secret), `${secret} must be gone: ${capped}`);
  assert.equal(boundedStartFailureMessage(capped), capped, "idempotent");
  assert.equal(boundedStartFailureMessage("   "), "");
});

test("Windows profile paths are redacted in any case, with either separator, and through a user name with spaces", () => {
  const cases: Array<[string, string]> = [
    ["open c:\\users\\alice\\AppData\\x.json failed", "open [REDACTED_PATH] failed"],
    ["open C:/Users/alice/AppData/x.json failed", "open [REDACTED_PATH] failed"],
    ["open D:\\USERS\\bob failed", "open [REDACTED_PATH] failed"],
    ["open C:\\Users\\John Smith\\AppData\\Roaming\\npm\\codex.cmd failed", "open [REDACTED_PATH] failed"],
    ["open C:/Users/Mary Ann Lee/.codex/auth.json failed", "open [REDACTED_PATH] failed"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(scrubRuntimeErrorText(raw), expected, raw);
    assert.equal(scrubRuntimeErrorText(expected), expected, "idempotent");
  }
  for (const secret of ["alice", "bob", "John", "Smith", "Mary", "Lee"]) {
    assert.ok(!cases.map(([raw]) => scrubRuntimeErrorText(raw)).join(" ").includes(secret), secret);
  }
  const started = performance.now();
  scrubRuntimeErrorText(`C:\\Users\\${"a ".repeat(60_000)}`);
  scrubRuntimeErrorText("c:/users/".repeat(20_000));
  assert.ok(performance.now() - started < 1_000);
});
