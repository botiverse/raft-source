import assert from "node:assert/strict";
import {
  addDiagnosticRedactionCounts,
  DIAGNOSTIC_REDACTION_KINDS,
  diagnosticRedactionMarker,
  redactDiagnosticCredentialLines,
  redactDiagnosticCredentials,
  redactDiagnosticSecrets,
  redactDiagnosticText,
} from "./diagnosticRedaction";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES, PEM_PRIVATE_KEY_BEGIN } from "./test/diagnosticRedactionCredentialSamples";

describe("redactDiagnosticText", () => {
  test("masks every known credential sample in both URL modes", () => {
    for (const { label, sample, mustNotContain } of DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES) {
      for (const urls of ["query", "drop"] as const) {
        const out = redactDiagnosticText(sample, { urls });
        assert.ok(!out.includes(mustNotContain), `${label} (${urls}) leaked: ${out}`);
      }
    }
  });

  test("keeps the URL origin and path in query mode and drops the whole URL in drop mode", () => {
    const line = "fetch https://api.example.test/v1/thing?token=abc failed";
    assert.equal(redactDiagnosticText(line), "fetch https://api.example.test/v1/thing?[REDACTED_QUERY] failed");
    assert.equal(redactDiagnosticText(line, { urls: "drop" }), "fetch [url] failed");
  });

  test("leaves ordinary log text untouched", () => {
    const line = "2026-09-15T04:00:00.000Z [INFO] [Daemon] agent agent-1 started (pid 4242) in 130ms";
    assert.equal(redactDiagnosticText(line), line);
  });

  test("masks home-directory paths and emails as identity, not as secrets", () => {
    const out = redactDiagnosticText("cwd /Users/alice/work/repo reported by alice@example.test");
    assert.ok(!out.includes("/Users/alice"));
    assert.ok(!out.includes("alice@example.test"));
  });

  test("masks an orphan PEM BEGIN with no END (file read while being written)", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    // Built at runtime so secret scanners don't flag this test sample.
    const out = redactDiagnosticText(["ok line", PEM_PRIVATE_KEY_BEGIN, body].join("\n"));
    assert.ok(!out.includes(body), "unpaired BEGIN must still mask the key body");
  });

  test("masks an orphan PEM END with no BEGIN (rotation cut the block head)", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const out = redactDiagnosticText([body, "-----END PRIVATE KEY-----", "later line"].join("\n"));
    assert.ok(!out.includes(body), "unpaired END must still mask the key body before it");
  });

  test("a complete PEM block does not swallow surrounding log text", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const out = redactDiagnosticText([
      "before line",
      PEM_PRIVATE_KEY_BEGIN,
      body,
      "-----END PRIVATE KEY-----",
      "after line",
    ].join("\n"));
    assert.ok(!out.includes(body));
    assert.ok(out.includes("before line"), "text before a complete block must survive");
    assert.ok(out.includes("after line"), "text after a complete block must survive");
  });
});

// Assembled at runtime so secret scanners don't flag these samples.
const ENV_TOKEN_SAMPLE = `HF_${"TOKEN"}=hf${"_"}AbCdEfGhIjKlMnOpQrSt`;
const ENV_KEY_SAMPLE = `"STRIPE_${"KEY"}": "rk${"_"}live_0123456789abcdef"`;

describe("environment-style _TOKEN / _KEY assignments", () => {
  test("are masked in both modes", () => {
    for (const sample of [ENV_TOKEN_SAMPLE, ENV_KEY_SAMPLE]) {
      const value = sample.includes("hf_") ? "AbCdEfGhIjKlMnOpQrSt" : "0123456789abcdef";
      assert.ok(!redactDiagnosticText(sample).includes(value), sample);
      assert.ok(!redactDiagnosticSecrets(sample).text.includes(value), sample);
    }
  });

  test("lower-case data names ending in _key are left alone", () => {
    const line = 'sort_key: "created_at", cache_key = users';
    assert.equal(redactDiagnosticText(line), line);
    assert.deepEqual(redactDiagnosticSecrets(line), { text: line, counts: {} });
  });
});

describe("redactDiagnosticSecrets (counted mode)", () => {
  test("masks every known credential sample and reports at least one hit for each", () => {
    for (const { label, sample, mustNotContain } of DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES) {
      const { text, counts } = redactDiagnosticSecrets(sample);
      assert.ok(!text.includes(mustNotContain), `${label} leaked: ${text}`);
      assert.ok(Object.keys(counts).length > 0, `${label} reported no redaction`);
    }
  });

  test("replaces with «redacted:<kind>» markers and the counts equal the markers left", () => {
    const text = [
      "Authorization: Bearer abcDEF123456_secret-token",
      "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.dGVzdHNpZ25hdHVyZQ",
      "using sk_agent_9f7c12d7abcdef0123456789 and sk_agent_00000000aaaaaaaa",
      PEM_PRIVATE_KEY_BEGIN,
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactDiagnosticSecrets(text);
    assert.deepEqual(out.counts, { authorization: 1, jwt: 1, raft_key: 2, private_key: 1 });
    const markers = [...out.text.matchAll(/«redacted:([a-z_]+)»/g)].map((m) => m[1]);
    assert.equal(markers.length, 5);
    for (const [kind, count] of Object.entries(out.counts)) {
      assert.equal(markers.filter((m) => m === kind).length, count, kind);
    }
    assert.equal(diagnosticRedactionMarker("jwt"), "«redacted:jwt»");
    assert.ok(out.text.includes("token «redacted:jwt»"));
  });

  test("keeps paths and emails readable, masks URL queries and credentials", () => {
    const text = "read /home/alice/repo/a.ts for alice@example.test via https://user:pw@api.example.test/v1/x?sig=abc#top";
    const out = redactDiagnosticSecrets(text);
    assert.equal(
      out.text,
      "read /home/alice/repo/a.ts for alice@example.test via https://«redacted:url_credentials»@api.example.test/v1/x?«redacted:url_query»#top",
    );
    assert.deepEqual(out.counts, { url_credentials: 1, url_query: 1 });
  });

  test("leaves ordinary text untouched with no counts", () => {
    const line = "2026-09-15T04:00:00.000Z [INFO] agent agent-1 ran `raft message send` (pid 4242)";
    assert.deepEqual(redactDiagnosticSecrets(line), { text: line, counts: {} });
  });

  test("addDiagnosticRedactionCounts sums per kind without changing its inputs", () => {
    const a = { jwt: 1 } as const;
    const b = { jwt: 2, bearer: 1 } as const;
    assert.deepEqual(addDiagnosticRedactionCounts(a, b), { jwt: 3, bearer: 1 });
    assert.deepEqual(a, { jwt: 1 });
  });

  test("every kind is a marker-safe identifier", () => {
    for (const kind of DIAGNOSTIC_REDACTION_KINDS) {
      assert.match(kind, /^[a-z_]+$/);
      // A marker on its own is never caught again by a rule.
      const marker = diagnosticRedactionMarker(kind);
      assert.deepEqual(redactDiagnosticSecrets(marker), { text: marker, counts: {} });
    }
  });
});

// Security review of the runtime error excerpt (2026-11): one case per shape
// its scrubber let through. Each pins the secret gone AND the text around it
// (status code, key name, scheme, flag) still readable.
const AKIA_ID = "AK" + "IA" + "IOSFODNN7EXAMPLE";
const ASIA_ID = "AS" + "IA" + "IOSFODNN7EXAMPLEABCD";
const GOOGLE_KEY = "AI" + "za" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
const GOOGLE_OAUTH = "ya" + "29." + "a0AfB_byC1d2E3f4G5h6I7j8K9";
const BARE_JWT = "ey" + "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.c2ln";
const WIDENED_SHAPES: readonly { shape: string; input: string; secret: string; text: string; counted: string }[] = [
  {
    shape: "JSON-quoted api_key",
    input: 'Error: 401 from https://api.example.test/v1/messages {"type":"error","api_key": "Zq81mNw2Lp0x"}',
    secret: "Zq81mNw2Lp0x",
    text: 'Error: 401 from https://api.example.test/v1/messages {"type":"error","api_key": "***REDACTED***"}',
    counted: 'Error: 401 from https://api.example.test/v1/messages {"type":"error","api_key": "«redacted:secret_assignment»"}',
  },
  { shape: "JSON-quoted token, no space", input: '400 {"token":"tq.82Hd-1x"}', secret: "tq.82Hd-1x", text: '400 {"token":"***REDACTED***"}', counted: '400 {"token":"«redacted:secret_assignment»"}' },
  { shape: "JSON-quoted password with spaces", input: '{"password": "correct horse battery", "user": "x"}', secret: "horse", text: '{"password": "***REDACTED***", "user": "x"}', counted: '{"password": "«redacted:secret_assignment»", "user": "x"}' },
  { shape: "JSON-quoted secret", input: '{"secret": "s3cr3tValue"} rejected', secret: "s3cr3tValue", text: '{"secret": "***REDACTED***"} rejected', counted: '{"secret": "«redacted:secret_assignment»"} rejected' },
  { shape: "JSON-quoted access_token", input: '{"access_token": "at-9f8e7d6c"}', secret: "at-9f8e7d6c", text: '{"access_token": "***REDACTED***"}', counted: '{"access_token": "«redacted:secret_assignment»"}' },
  { shape: "JSON-quoted refresh_token", input: '{"refresh_token": "rt-1a2b3c4d"}', secret: "rt-1a2b3c4d", text: '{"refresh_token": "***REDACTED***"}', counted: '{"refresh_token": "«redacted:secret_assignment»"}' },
  { shape: "JSON-escaped client_secret", input: String.raw`{\"client_secret\":\"cs-5e6f7a8b\"}`, secret: "cs-5e6f7a8b", text: String.raw`{\"client_secret\":\"***REDACTED***\"}`, counted: String.raw`{\"client_secret\":\"«redacted:secret_assignment»\"}` },
  { shape: "Authorization: Basic", input: "401 Unauthorized; Authorization: Basic dXNlcjpodW50ZXIy", secret: "dXNlcjpodW50ZXIy", text: "401 Unauthorized; Authorization: Basic ***REDACTED***", counted: "401 Unauthorized; Authorization: Basic «redacted:authorization»" },
  { shape: "Basic outside a header", input: "curl: (22) 401 with Basic dXNlcjpwYXNz", secret: "dXNlcjpwYXNz", text: "curl: (22) 401 with Basic ***REDACTED***", counted: "curl: (22) 401 with Basic «redacted:authorization»" },
  { shape: "bare JWT", input: `401: jwt ${BARE_JWT} expired`, secret: BARE_JWT, text: "401: jwt ***REDACTED*** expired", counted: "401: jwt «redacted:jwt» expired" },
  { shape: "AWS access key id", input: `403 InvalidClientTokenId for ${AKIA_ID}`, secret: AKIA_ID, text: "403 InvalidClientTokenId for ***REDACTED***", counted: "403 InvalidClientTokenId for «redacted:aws_key»" },
  { shape: "AWS STS key id", input: `403 for ${ASIA_ID}`, secret: ASIA_ID, text: "403 for ***REDACTED***", counted: "403 for «redacted:aws_key»" },
  { shape: "AWS secret access key, JSON", input: '403 {"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}', secret: "wJalrXUtnFEMI", text: '403 {"SecretAccessKey": "***REDACTED***"}', counted: '403 {"SecretAccessKey": "«redacted:secret_assignment»"}' },
  { shape: "Google API key", input: `400 API key not valid: ${GOOGLE_KEY}.`, secret: GOOGLE_KEY, text: "400 API key not valid: ***REDACTED***.", counted: "400 API key not valid: «redacted:google_api_key»." },
  { shape: "Google OAuth token", input: `401 token ${GOOGLE_OAUTH} rejected`, secret: GOOGLE_OAUTH, text: "401 token ***REDACTED*** rejected", counted: "401 token «redacted:bearer» rejected" },
  { shape: "--api-key <v>", input: "exit 1: claude --api-key Zq81mNw2Lp0x --verbose", secret: "Zq81mNw2Lp0x", text: "exit 1: claude --api-key ***REDACTED*** --verbose", counted: "exit 1: claude --api-key «redacted:secret_assignment» --verbose" },
  { shape: "--api-key=<v>", input: "exit 1: claude --api-key=Zq81mNw2Lp0x", secret: "Zq81mNw2Lp0x", text: "exit 1: claude --api-key=***REDACTED***", counted: "exit 1: claude --api-key=«redacted:secret_assignment»" },
  { shape: "--token <v>", input: "gh --token abcdEFGH1234 failed", secret: "abcdEFGH1234", text: "gh --token ***REDACTED*** failed", counted: "gh --token «redacted:secret_assignment» failed" },
  { shape: "--password \"<v>\"", input: 'db --password "correct horse" refused', secret: "horse", text: "db --password ***REDACTED*** refused", counted: "db --password «redacted:secret_assignment» refused" },
  { shape: "--secret <v>", input: "run --secret s3c --x", secret: "s3c", text: "run --secret ***REDACTED*** --x", counted: "run --secret «redacted:secret_assignment» --x" },
  { shape: "--auth <v>", input: "proxy --auth u1:p2 up", secret: "u1:p2", text: "proxy --auth ***REDACTED*** up", counted: "proxy --auth «redacted:secret_assignment» up" },
];

describe("widened credential shapes (runtime error excerpt review)", () => {
  for (const { shape, input, secret, text, counted } of WIDENED_SHAPES) {
    test(`${shape}: the value goes, the text around it stays`, () => {
      assert.equal(redactDiagnosticText(input), text);
      assert.ok(!text.includes(secret));
      assert.equal(redactDiagnosticSecrets(input).text, counted);
      // Idempotent: a masked value meets its own rule again unchanged.
      assert.equal(redactDiagnosticText(text), text);
    });
  }

  test("ordinary error text is not masked", () => {
    for (const line of [
      "model claude-sonnet-4-5-20250929 not found; try gpt-5.1-codex or gemini-2.5-pro",
      "request 123e4567-e89b-12d3-a456-426614174000 failed",
      "ENOENT: no such file or directory, open 'src/tokenizer.ts' (secret_store.json)",
      "claude --verbose --model opus --max-tokens 4096 --token-budget 2000 --output-format stream-json --secret-file x",
      "raft-daemon 0.98.1 on node v22.11.0",
      "max_tokens: 4096 token_count = 1234 oauth_flow=device input_tokens=5120",
      "Basic Authentication failed; Authorization header missing; password reset required",
      "disk_usage_bytes=1234 task_list_x",
    ]) {
      assert.equal(redactDiagnosticText(line), line);
      assert.deepEqual(redactDiagnosticSecrets(line), { text: line, counts: {} });
    }
  });

  test("redactDiagnosticCredentials applies the same rules with the caller's mask, hex runs optional", () => {
    const sha = "3c0f7bab8e1d2f3a4b5c6d7e8f90123456789abc";
    assert.equal(redactDiagnosticCredentials(`at ${sha} ${AKIA_ID}`, { mask: "[X]" }), "at [X] [X]");
    assert.equal(redactDiagnosticCredentials(`at ${sha} ${AKIA_ID}`, { mask: "[X]", hexBlobs: false }), `at ${sha} [X]`);
    assert.equal(redactDiagnosticCredentials("/home/alice a@b.test", { mask: "[X]" }), "/home/alice a@b.test");
  });

  test("the name rules are linear: hostile runs with nothing to redact return at once", () => {
    for (const hostile of ["TOKEN-".repeat(20_000), "API_KEY.SECRET-".repeat(8_000), "--a-".repeat(30_000), "Basic ".repeat(20_000)]) {
      const started = performance.now();
      redactDiagnosticText(hostile);
      redactDiagnosticSecrets(hostile);
      const took = performance.now() - started;
      assert.ok(took < 1_000, `${hostile.slice(0, 16)}… took ${Math.round(took)} ms`);
    }
  });
});

// Adversarial review of #14933: escapes in front of a key, quoted values with
// escapes inside, more Google shapes, and prose that must stay readable.
describe("review of #14933", () => {
  const AKIA = "AK" + "IA" + "IOSFODNN7EXAMPLE";
  const masked: readonly [string, string, string][] = [
    // [shape, input, redactDiagnosticText output]
    ["Raft key after a JSON-escaped newline", String.raw`{"msg":"line1\nsk_agent_ABCDEF123456"}`, String.raw`{"msg":"line1\n***REDACTED***"}`],
    ["Raft key after a URL escape", "key%3Dsk_agent_ABCDEF123456", "key%3D***REDACTED***"],
    ["Raft sap key after an escaped newline", String.raw`\nsap_ABCDEFGH1234`, String.raw`\n***REDACTED***`],
    ["Raft key inside a word, issued-looking tail", "Xsk_machine_ABCDEF123456", "X***REDACTED***"],
    ["AWS key id after an escaped newline", String.raw`"\n${AKIA}"`, String.raw`"\n***REDACTED***"`],
    ["Bearer after an escaped newline", String.raw`\nBearer abcdEFGH12345678`, String.raw`\n***REDACTED***`],
    ["vendor key after an escaped tab", String.raw`\tsk-ant-api03-abcdefghijk`, String.raw`\t***REDACTED***`],
    ["--password after an escaped newline", String.raw`\n--password hunter2!`, String.raw`\n--password ***REDACTED***`],
    ["quoted value with an apostrophe", `{"password": "it's secret value", "user": "bob"}`, `{"password": "***REDACTED***", "user": "bob"}`],
    ["quoted value with an escaped quote", String.raw`{"password":"p\"ass", "user": "bob"}`, `{"password":"***REDACTED***", "user": "bob"}`],
    ["quoted value with a \\u0022 escape", '{"api_key":"xxxxx\\u0022SECRETAFTERESCAPE", "user": "bob"}', `{"api_key":"***REDACTED***", "user": "bob"}`],
    ["quoted value with a stray raw quote", '{"api_key":"xxxxx"SECRETAFTERQUOTE", "user": "bob"}', `{"api_key":"***REDACTED***", "user": "bob"}`],
    ["quoted value with escaped slashes", String.raw`{"client_secret":"ab\/cd\\ef\/SECRETTAIL", "user": "bob"}`, `{"client_secret":"***REDACTED***", "user": "bob"}`],
    ["single-quoted value with an escaped quote", String.raw`{'password': 'it\'s mine', 'user': 'bob'}`, `{'password': '***REDACTED***', 'user': 'bob'}`],
    ["inner JSON value with an escaped quote", String.raw`{\"password\":\"p\\\"ASSTAIL\",\"user\":\"bob\"}`, String.raw`{\"password\":\"***REDACTED***\",\"user\":\"bob\"}`],
    ["credentials / credential names", `{"credentials": "c9-SECRETVAL"} credential=abcd1234`, `{"credentials": "***REDACTED***"} credential=***REDACTED***`],
    ["Google OAuth client secret", `client ${"GOC" + "SPX-"}AbCdEfGhIjKlMnOpQrStUv12 rejected`, "client ***REDACTED*** rejected"],
    ["Google OAuth refresh token", `refresh ${"1/" + "/0g"}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-x failed`, "refresh ***REDACTED*** failed"],
    ["secret flags with value-shaped values", "--token abcdEFGH1234 --password hunter2! --api-key=abc", "--token ***REDACTED*** --password ***REDACTED*** --api-key=***REDACTED***"],
    ["Authorization values that look like credentials", "Authorization: abc123 | Authorization: Token abcd | Authorization: dXNlcjpwYXNz", "Authorization: ***REDACTED*** | Authorization: Token ***REDACTED*** | Authorization: ***REDACTED***"],
    ["auth as a quoted key or before =", `HTTP_AUTH=abcd1234; {"auth": "abcd1234"}`, `HTTP_AUTH=***REDACTED***; {"auth": "***REDACTED***"}`],
    ["a number after a secret name", `{"password": 1234, "client_secret": 98765 }`, `{"password": ***REDACTED***, "client_secret": ***REDACTED*** }`],
    ["a PIN", `{"pin": 482913} pin=482913 user_pin: 1234 "PIN":"0042"`, `{"pin": ***REDACTED***} pin=***REDACTED*** user_pin: ***REDACTED*** "PIN":"***REDACTED***"`],
    ["a value behind a literal \\n escape", String.raw`PASSWORD=\nSECRETVAL`, "PASSWORD=***REDACTED***"],
  ];
  for (const [shape, input, text] of masked) {
    test(`${shape}: masked, the text around it kept`, () => {
      assert.equal(redactDiagnosticText(input), text);
      assert.equal(redactDiagnosticText(text), text, "idempotent");
      assert.ok(Object.keys(redactDiagnosticSecrets(input).counts).length > 0);
    });
  }

  test("prose, JSON literals and in-word lookalikes stay readable", () => {
    for (const line of [
      "missing --token flag; use --api-key or set X; pass --token to cli; --password hunter",
      "Authorization: required; authorization: denied; Authorization=none",
      `{"secret": true, "api_key": null, "has_secret": false, "token_ttl": 3600}`,
      "pin: 3.11 spin=1234 pinned=123456",
      "auth: login required; oauth: refresh failed",
      "on 2024/1//0 date 1//0",
      "disk_usage_bytes task_sk_test_1 whatsap_x",
    ]) {
      assert.equal(redactDiagnosticText(line), line);
      assert.deepEqual(redactDiagnosticSecrets(line), { text: line, counts: {} });
    }
  });

  test("new rules stay linear on 100 KB hostile runs", () => {
    const rep = (s: string) => s.repeat(Math.ceil(100_000 / s.length)).slice(0, 100_000);
    for (const hostile of [
      rep("\\n"), rep("%3D"), `"password":"${rep("\\\\")}`, `'password':'${rep("\\'")}`, rep('password:\\"'),
      rep("xsk_a_"), rep("xsap_"), rep("1//0"), rep("a_pin"), rep("pin: "), `Authorization: ${rep("a")}`, rep("--token a "), rep('"secret": true '),
      `"api_key":${" ".repeat(100_000)}1`, `password:\\\"${rep("\\\\a")}`,
    ]) {
      const started = performance.now();
      redactDiagnosticText(hostile);
      redactDiagnosticSecrets(hostile);
      const took = performance.now() - started;
      assert.ok(took < 1_000, `${hostile.slice(0, 16)}… took ${Math.round(took)} ms`);
    }
  });
});

// Passwords in non-HTTP connection strings: scheme, user, `:` and `@` kept.
describe("connection-string passwords", () => {
  const cases: readonly [string, string, string][] = [
    ["postgres", "connect ECONNREFUSED postgres://app:hunter2@db:5432/x (retry)", "connect ECONNREFUSED postgres://app:***REDACTED***@db:5432/x (retry)"],
    ["postgresql", "postgresql://app:hunter2@db/x", "postgresql://app:***REDACTED***@db/x"],
    ["mysql", "mysql://root:s3cret@127.0.0.1:3306/db", "mysql://root:***REDACTED***@127.0.0.1:3306/db"],
    ["redis, empty user", "redis://:pw@host:6379", "redis://:***REDACTED***@host:6379"],
    ["rediss", "rediss://default:pw9@cache:6380", "rediss://default:***REDACTED***@cache:6380"],
    ["mongodb+srv", "mongodb+srv://u:p@cluster0/db", "mongodb+srv://u:***REDACTED***@cluster0/db"],
    ["mongodb", "mongodb://admin:Adm1n@localhost:27017", "mongodb://admin:***REDACTED***@localhost:27017"],
    ["amqp", "amqp://guest:guest1@rabbit:5672", "amqp://guest:***REDACTED***@rabbit:5672"],
    ["amqps", "amqps://u:pa55@mq:5671", "amqps://u:***REDACTED***@mq:5671"],
    ["password with %40", "postgres://app:p%40ss@db/x", "postgres://app:***REDACTED***@db/x"],
    ["password with :", "postgres://app:pa:ss@db/x", "postgres://app:***REDACTED***@db/x"],
    ["after an escaped newline", String.raw`\npostgres://app:hunter2@db/x`, String.raw`\npostgres://app:***REDACTED***@db/x`],
    // An unencoded `/` or `@` in the password: it runs to the last `@` of the URL.
    ["password with /", "postgres://u:ab/cd@host:5432/db", "postgres://u:***REDACTED***@host:5432/db"],
    ["password with / and a dotted host", "connect postgres://app:ab/cd@db.example.com:5432/x (retry)", "connect postgres://app:***REDACTED***@db.example.com:5432/x (retry)"],
    ["password with / and @", "mongodb://u:a/b@c@cluster0/db", "mongodb://u:***REDACTED***@cluster0/db"],
    ["password with //", "redis://:a//b@cache:6379", "redis://:***REDACTED***@cache:6379"],
    ["password with / in JSON", `{"url":"postgres://u:ab/cd@db/x","pool":5}`, `{"url":"postgres://u:***REDACTED***@db/x","pool":5}`],
    ["password with ? (as before)", "postgres://u:SEC?RET@host/db", "postgres://u:***REDACTED***@host/db"],
    ["password with #", "postgres://u:SEC#RET@host/db", "postgres://u:***REDACTED***@host/db"],
    ["git+https, password with /", "git+ssh://u:ab/cd@host/x", "git+ssh://u:***REDACTED***@host/x"],
  ];
  for (const [scheme, input, text] of cases) {
    test(`${scheme}: the password goes, scheme/user/host stay`, () => {
      assert.equal(redactDiagnosticText(input), text);
      assert.equal(redactDiagnosticText(text), text, "idempotent");
      assert.equal(redactDiagnosticCredentials(input, { mask: "***REDACTED***" }), text);
      assert.deepEqual(redactDiagnosticSecrets(input).counts, { url_credentials: 1 });
    });
  }

  test("URLs without a password, http(s) ports, scp-style git remotes and emails are not touched by the rule", () => {
    for (const line of [
      "http://host:8080/path", "git@github.com:org/repo", "ssh://git@host/x", "user@example.com", "postgres://db:5432/x",
      "redis://host:6379/0 for user@example.com", "ssh://git@host:22/x@y", "postgres://db:5432/x postgres://db2:5432/y user@example.com",
      "postgres://db:5432/x?to=a@b", "postgres://db:5432/x?to=alice@corp.example.com",
    ]) {
      assert.equal(redactDiagnosticCredentials(line, { mask: "***REDACTED***" }), line);
      assert.deepEqual(redactDiagnosticSecrets(line), { text: line, counts: {} });
    }
    // http(s) keeps its own handling.
    assert.equal(redactDiagnosticText("https://user:pw@host/x"), "https://%5BREDACTED_USER%5D:%5BREDACTED_PASSWORD%5D@host/x");
    assert.equal(redactDiagnosticSecrets("https://user:pw@host/x").text, "https://«redacted:url_credentials»@host/x");
  });

  // An `@` in the path, query or after a `,` is not the end of the password:
  // after its first `@`, a `/`, `?` or `#` ends the authority.
  test("the password ends at the authority: an address later in the URL keeps its own masking", () => {
    for (const [input, text, credentials] of [
      ["postgres://u:pw@db/x?notify=alice@corp.example.com", "postgres://u:***REDACTED***@db/x?notify=***REDACTED***", "postgres://u:***REDACTED***@db/x?notify=alice@corp.example.com"],
      ["postgres://u:pw@db/x,alice@corp.example.com", "postgres://u:***REDACTED***@db/x,***REDACTED***", "postgres://u:***REDACTED***@db/x,alice@corp.example.com"],
      ["postgres://u:ab/cd@db/x#to=alice@corp.example.com", "postgres://u:***REDACTED***@db/x#to=***REDACTED***", "postgres://u:***REDACTED***@db/x#to=alice@corp.example.com"],
    ] as const) {
      assert.equal(redactDiagnosticText(input), text);
      assert.equal(redactDiagnosticText(text), text, "idempotent");
      assert.equal(redactDiagnosticCredentials(input, { mask: "***REDACTED***" }), credentials);
      assert.deepEqual(redactDiagnosticSecrets(input).counts, { url_credentials: 1 });
    }
  });

  // http(s): a password with a `/` is read by a URL parser as host and port; it
  // is masked in the shape a well-formed URL gets.
  test("http(s) passwords with a / are masked like well-formed ones", () => {
    for (const [input, text, counted] of [
      ["http://u:SECRET/WITHSLASH@10.0.0.1/x", "http://%5BREDACTED_USER%5D:%5BREDACTED_PASSWORD%5D@10.0.0.1/x", "http://«redacted:url_credentials»@10.0.0.1/x"],
      ["https://u:ab/cd@db/x", "https://%5BREDACTED_USER%5D:%5BREDACTED_PASSWORD%5D@db/x", "https://«redacted:url_credentials»@db/x"],
      ["https://u:ab/cd@host.example.com/x?a=1", "https://%5BREDACTED_USER%5D:***REDACTED***/x?[REDACTED_QUERY]", "https://«redacted:url_credentials»@host.example.com/x?«redacted:url_query»"],
      ["git+https://u:ab/cd@host.example.com/x", "git+https://%5BREDACTED_USER%5D:***REDACTED***@host.example.com/x", "git+https://«redacted:url_credentials»@host.example.com/x"],
    ] as const) {
      assert.equal(redactDiagnosticText(input), text);
      assert.equal(redactDiagnosticText(text), text, "idempotent");
      const once = redactDiagnosticSecrets(input);
      assert.equal(once.text, counted);
      assert.equal(redactDiagnosticSecrets(once.text).text, counted, "counted mode idempotent");
    }
    // The same shape as a well-formed URL.
    assert.equal(redactDiagnosticText("https://u:abcd@db/x"), "https://%5BREDACTED_USER%5D:%5BREDACTED_PASSWORD%5D@db/x");
    // `raft-computer logs` / `doctor` show URL credentials by design.
    assert.equal(redactDiagnosticCredentials("https://u:ab/cd@db/x", { mask: "***" }), "https://u:ab/cd@db/x");
    // A git+https URL masked once is not read again as `user «redacted`.
    const gitHttps = redactDiagnosticSecrets("git+https://u:abcd@host.example.com/x");
    assert.deepEqual(gitHttps, { text: "git+https://«redacted:url_credentials»@host.example.com/x", counts: { url_credentials: 1 } });
  });

  test("the rule is linear on 100 KB hostile runs", () => {
    const rep = (s: string) => s.repeat(Math.ceil(100_000 / s.length)).slice(0, 100_000);
    for (const hostile of [
      rep("https://u:"), rep("https://u:a/"), `https://u:${rep("a/")}`, `https://u:a/${rep("@b")}`, `postgres://u:a${rep("@b:")}`, rep("x://u:a@b/"),
      rep("a."), rep("a://"), rep("postgres://a:"), `postgres://a:${rep("b")}`, `postgres://${rep("a")}`, rep("x+"),
      rep("a://a:"), rep("postgres://a:b/"), `postgres://a:${rep("b/")}`, `postgres://u:${rep("@")}`, rep("x://:@"), `postgres://u:${rep(":/")}`,
    ]) {
      const started = performance.now();
      redactDiagnosticText(hostile);
      redactDiagnosticSecrets(hostile);
      assert.ok(performance.now() - started < 1_000, `${hostile.slice(0, 16)}…`);
    }
  });
});

// Tenny's review of #14933: cookies, more token prefixes and YAML block values.
// Exact output in every mode, the labels kept, and each output stable when
// redacted again.
describe("cookies, token prefixes and YAML block secrets", () => {
  const HF_TOKEN = "h" + "f_" + "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh";
  const GLPAT = "gl" + "pat-" + "AbCdEf0123456789_-xy";
  const NPM_TOKEN = "np" + "m_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const RK_LIVE = "r" + "k_live_" + "51HqAbCdEfGhIjKlMnOpQrStUv";
  const RK_TEST = "r" + "k_test_" + "51HqAbCdEfGhIjKlMnOpQrStUv";
  // [shape, input, redactDiagnosticText output, counted output]
  const masked: readonly [string, string, string, string][] = [
    ["Cookie header", "GET /x Cookie: session=abc123; theme=dark", "GET /x Cookie: ***REDACTED***", "GET /x Cookie: «redacted:authorization»"],
    ["Set-Cookie header, attributes and next line", "Set-Cookie: id=a3fWa; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Secure\nnext line", "Set-Cookie: ***REDACTED***\nnext line", "Set-Cookie: «redacted:authorization»\nnext line"],
    ["header after an escaped newline, up to the next one", String.raw`{"h":"Host: x\ncookie: sid=zz9\nAccept: */*"}`, String.raw`{"h":"Host: x\ncookie: ***REDACTED***\nAccept: */*"}`, String.raw`{"h":"Host: x\ncookie: «redacted:authorization»\nAccept: */*"}`],
    ["JSON cookie", `{"cookie": "sid=abc123; theme=dark", "x": 1}`, `{"cookie": "***REDACTED***", "x": 1}`, `{"cookie": "«redacted:authorization»", "x": 1}`],
    ["JSON set-cookie list", `{"set-cookie": ["a=b; Path=/", "c=d"], "x": 1}`, `{"set-cookie": [***REDACTED***], "x": 1}`, `{"set-cookie": [«redacted:authorization»], "x": 1}`],
    ["Node-inspected headers", "headers: { 'set-cookie': [ 'a=b; Path=/', 'c=d' ], cookie: 'sid=zz' }", "headers: { 'set-cookie': [ ***REDACTED*** ], cookie: '***REDACTED***' }", "headers: { 'set-cookie': [ «redacted:authorization» ], cookie: '«redacted:authorization»' }"],
    ["JSON-escaped cookie headers", String.raw`{\"cookie\":\"sid=zz\",\"set-cookie\":[\"a=b\",\"c=d\"]}`, String.raw`{\"cookie\":\"***REDACTED***\",\"set-cookie\":[***REDACTED***]}`, String.raw`{\"cookie\":\"«redacted:authorization»\",\"set-cookie\":[«redacted:authorization»]}`],
    ["Hugging Face token", `pull ${HF_TOKEN} failed`, "pull ***REDACTED*** failed", "pull «redacted:vendor_key» failed"],
    ["GitLab token", `remote: ${GLPAT} rejected`, "remote: ***REDACTED*** rejected", "remote: «redacted:vendor_key» rejected"],
    ["GitLab token with dotted parts", `token ${GLPAT}.01.0a1b2c3d4`, "token ***REDACTED***", "token «redacted:vendor_key»"],
    ["npm token in .npmrc", `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`, "//registry.npmjs.org/:_authToken=***REDACTED***", "//registry.npmjs.org/:_authToken=«redacted:secret_assignment»"],
    ["npm token bare", `using ${NPM_TOKEN}`, "using ***REDACTED***", "using «redacted:vendor_key»"],
    ["Stripe restricted keys", `${RK_LIVE} and ${RK_TEST}`, "***REDACTED*** and ***REDACTED***", "«redacted:vendor_key» and «redacted:vendor_key»"],
    ["Stripe secret key, as before", "sk" + "_live_51HqABCDEF", "***REDACTED***", "«redacted:raft_key»"],
    ["GitLab deploy and runner tokens", `${"gl" + "dt-"}AbCdEf0123456789_-xy ${"gl" + "rt-"}AbCdEf0123456789_-xy ${"gl" + "ptt-"}0123456789abcdefghij`, "***REDACTED*** ***REDACTED*** ***REDACTED***", "«redacted:vendor_key» «redacted:vendor_key» «redacted:vendor_key»"],
    ["doubly escaped JSON cookie", String.raw`{\"cookie\":\"sid=zz9\"}`, String.raw`{\"cookie\":\"***REDACTED***\"}`, String.raw`{\"cookie\":\"«redacted:authorization»\"}`],
    ["set-cookie list with a bare scalar inside", `{"set-cookie": ["a=X", 42, "c=SECRET"], "x": 1}`, `{"set-cookie": [***REDACTED***], "x": 1}`, `{"set-cookie": [«redacted:authorization»], "x": 1}`],
    ["YAML sequence item", "users:\n- password: |\n    LIST1\n    LIST2\n  name: bob\n- name: eve", "users:\n- password: |\n    ***REDACTED***\n  name: bob\n- name: eve", "users:\n- password: |\n    «redacted:secret_assignment»\n  name: bob\n- name: eve"],
    ["YAML anchor before the indicator", "password: &pw |\n  ANCH\nnext: 1", "password: &pw |\n  ***REDACTED***\nnext: 1", "password: &pw |\n  «redacted:secret_assignment»\nnext: 1"],
    ["YAML sequence item inside a JSON string", String.raw`{"cfg":"- token: |\n    T1\n  name: x"}`, String.raw`{"cfg":"- token: |\n    ***REDACTED***\n  name: x"}`, String.raw`{"cfg":"- token: |\n    «redacted:secret_assignment»\n  name: x"}`],
    [
      "YAML literal block under a nested secret key, blank line inside",
      "config:\n  private_key: |\n    line1\n\n    line2\n  user: bob\nother: 1",
      "config:\n  private_key: |\n    ***REDACTED***\n  user: bob\nother: 1",
      "config:\n  private_key: |\n    «redacted:secret_assignment»\n  user: bob\nother: 1",
    ],
    ["YAML folded block with chomping", "secret_key: >-\n  aaa\n  bbb\nnext: x", "secret_key: >-\n  ***REDACTED***\nnext: x", "secret_key: >-\n  «redacted:secret_assignment»\nnext: x"],
    ["YAML keep chomping, indent indicator and comment", "password: |2+ # pw\n   aaa\r\n   bbb\r\nnext", "password: |2+ # pw\n   ***REDACTED***\r\nnext", "password: |2+ # pw\n   «redacted:secret_assignment»\r\nnext"],
    ["YAML quoted key, block to the end of the text", `"api_key": >\n  k1\n  k2`, `"api_key": >\n  ***REDACTED***`, `"api_key": >\n  «redacted:secret_assignment»`],
    [
      "YAML block inside a JSON string",
      String.raw`{"cfg":"db:\n  password: |\n    s3cr3t\n    more\n  host: x"}`,
      String.raw`{"cfg":"db:\n  password: |\n    ***REDACTED***\n  host: x"}`,
      String.raw`{"cfg":"db:\n  password: |\n    «redacted:secret_assignment»\n  host: x"}`,
    ],
  ];
  for (const [shape, input, text, counted] of masked) {
    test(`${shape}: masked, the labels kept`, () => {
      assert.equal(redactDiagnosticText(input), text);
      assert.equal(redactDiagnosticText(text), text, "idempotent");
      assert.equal(redactDiagnosticCredentials(input, { mask: "***REDACTED***" }), text);
      const once = redactDiagnosticSecrets(input);
      assert.equal(once.text, counted);
      assert.ok(Object.keys(once.counts).length > 0);
      assert.equal(redactDiagnosticSecrets(once.text).text, once.text, "counted mode idempotent");
    });
  }

  test("prose, ordinary names and non-secret YAML blocks stay readable", () => {
    for (const line of [
      "Set-Cookie: header missing; cookie: none; Cookie: required",
      "cookie: http://example.test/a=b",
      "cookies are disabled; cookie_jar=memory",
      "hf_hub_download hf_token npm_config_cache npm_package_name rk_test rk_live_x hf_abc123 glpat-short npm_1234",
      "global-settings-for-the-application glance-at-the-dashboard-today",
      "description: |\n  not a secret\n  at all\nnext: 1",
      "secret: true\nname: x",
      "token: |\nnot indented, so no block",
      "  private_key: |\n  sibling: at the same indentation\n",
    ]) {
      assert.equal(redactDiagnosticText(line), line);
      assert.deepEqual(redactDiagnosticSecrets(line), { text: line, counts: {} });
    }
  });

  test("the new rules stay linear on 100 KB hostile runs", () => {
    const rep = (s: string) => s.repeat(Math.ceil(100_000 / s.length)).slice(0, 100_000);
    for (const hostile of [
      rep("cookie:"), rep("set-cookie:"), rep("Cookie: a"), `Cookie: ${rep("a")}`, `Cookie: a=${rep("\\")}`, rep("cookie: a=b; "), rep("cookie:\\n"),
      rep('"cookie": ["a", '), `"cookie": [${rep('"a",')}`, rep("'set-cookie': [ '"), rep('\\"cookie\\":[\\"'), `cookie: "${rep("\\")}`, `cookie: [${rep(" ")}`,
      rep("glxx-"), `gldt-${rep("a")}`, rep("- password: |\n"), `- password: |\n${rep("    a\n")}`, rep("password: !!a "), rep("password: &a &b "), `password: !${rep("!")}`,
      rep('\\\"cookie\\\":\\\"'), `\\\"cookie\\\":\\\"${rep("\\")}`, `cookie: ["a", ${rep("1, ")}`, rep('"cookie": [""'),
      rep("hf_"), rep("xhf_aaaa"), `hf_${rep("a")}`, rep("npm_a"), rep("glpat-"), `glpat-${rep("a.")}`, `glpat-aaaaaaaaaaaaaaaaaaaa${rep(".a")}`, rep("rk_live_"),
      rep("secret: |\n"), `secret: |\n${rep("  a\n")}`, `secret: |\n  a\n${rep("\n")}`, `secret: |\n  a${rep("\n  ")}`, `secret: |\n${rep(" \n")}`,
      rep("password: >-\n  "), `${rep(" ")}secret: |`, rep("secret: |  "), `secret: | #${rep("#")}`,
      rep("secret: |\\n"), `secret: |\\n${rep("  a\\n")}`, `"secret: |\\n  a${rep("\\n  ")}`, `secret: |\\n${rep(" \\n")}`, rep('"password: |'), `"secret: |\\n  ${rep("\\\\")}`,
    ]) {
      const started = performance.now();
      redactDiagnosticText(hostile);
      redactDiagnosticSecrets(hostile);
      const took = performance.now() - started;
      assert.ok(took < 1_000, `${JSON.stringify(hostile.slice(0, 16))}… took ${Math.round(took)} ms`);
    }
  });
});

// `raft-computer logs` output: as many lines as were read, a multi-line secret
// masked across its lines, an orphan PEM marker only on its own line.
describe("redactDiagnosticCredentialLines", () => {
  const mask = { mask: "***REDACTED***" };
  const BEGIN = PEM_PRIVATE_KEY_BEGIN;
  const END = "-----END " + "PRIVATE KEY-----";
  const tick = (i: number) => `2026-11-14T10:00:00Z [info] tick ${i}`;

  test("a complete PEM block and a YAML block are masked line for line", () => {
    const lines = ["start", `key ${BEGIN}`, "MIIEvQIBADANBg", END, "config:", "  password: |", "    s3cret", "    more", "  user: bob", "end"];
    assert.deepEqual(redactDiagnosticCredentialLines(lines, mask), [
      "start", "key ***REDACTED***", "***REDACTED***", "***REDACTED***", "config:", "  password: |", "    ***REDACTED***", "    ***REDACTED***", "  user: bob", "end",
    ]);
  });

  test("an orphan BEGIN or END masks its own line, not the rest or the start of the tail", () => {
    const withBegin = Array.from({ length: 206 }, (_, i) => tick(i));
    withBegin[5] = `error: expected ${BEGIN} in /etc/key.pem`;
    const afterBegin = redactDiagnosticCredentialLines(withBegin, mask);
    assert.equal(afterBegin.length, 206);
    assert.equal(afterBegin[5], "error: expected ***REDACTED***");
    assert.deepEqual(afterBegin.slice(6), withBegin.slice(6));
    const withEnd = Array.from({ length: 206 }, (_, i) => tick(i));
    withEnd[200] = `error: no ${END} marker`;
    const afterEnd = redactDiagnosticCredentialLines(withEnd, mask);
    assert.equal(afterEnd.length, 206);
    assert.equal(afterEnd[200], "***REDACTED*** marker");
    assert.deepEqual(afterEnd.slice(0, 200), withEnd.slice(0, 200));
  });

  test("an empty tail stays empty; 20k lines of BEGIN without END stay fast", () => {
    assert.deepEqual(redactDiagnosticCredentialLines([], mask), []);
    const begins = Array.from({ length: 20_000 }, (_, i) => `[warn] ${BEGIN} line ${i}`);
    const started = performance.now();
    const out = redactDiagnosticCredentialLines(begins, mask);
    assert.ok(performance.now() - started < 2_000);
    assert.equal(out.length, 20_000);
    assert.equal(out[19_999], "[warn] ***REDACTED***");
  });

  test("a whole-text PEM BEGIN does not run across a second BEGIN, and stays linear", () => {
    assert.equal(redactDiagnosticText(`${BEGIN}\nA\n${BEGIN}\nB\n${END}\nafter`), "***REDACTED***");
    const begins = `${BEGIN}\n`.repeat(20_000);
    const started = performance.now();
    redactDiagnosticText(begins);
    redactDiagnosticSecrets(begins);
    assert.ok(performance.now() - started < 1_000);
  });
});
