import assert from "node:assert/strict";
import {
  addDiagnosticRedactionCounts,
  DIAGNOSTIC_REDACTION_KINDS,
  diagnosticRedactionMarker,
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
