/** Focused contract tests for the local OTLP JSONL trace reader. */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decodeAnyValue,
  flattenOtlpDocument,
  isDotFamily,
  parseDurationMs,
  parseReaderStartedAtMs,
  parseSinceMs,
  projectAttributes,
  readTraceFile,
  renderTrace,
  runTraceCli,
  traceBannerLines,
} from "./raftdev-trace.ts";

const TRACE_A = "1".repeat(32);
const TRACE_B = "2".repeat(32);
const TRACE_C = "3".repeat(32);
const ROOT = "a".repeat(16);
const CHILD = "b".repeat(16);
const WEB = "c".repeat(16);
const NOW_MS = Date.parse("2026-07-11T03:00:00.000Z");

function anyValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  throw new Error(`unsupported fixture value: ${String(value)}`);
}

function attrs(values: Record<string, unknown>): Array<Record<string, unknown>> {
  return Object.entries(values).map(([key, value]) => ({ key, value: anyValue(value) }));
}

interface SpanFixture {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  durationMs?: number;
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; offsetMs?: number; attributes?: Record<string, unknown> }>;
}

function otlpSpan(fixture: SpanFixture): Record<string, unknown> {
  const start = BigInt(fixture.startMs) * 1_000_000n;
  const end = start + BigInt(fixture.durationMs ?? 5) * 1_000_000n;
  return {
    traceId: fixture.traceId ?? TRACE_A,
    spanId: fixture.spanId ?? ROOT,
    ...(fixture.parentSpanId ? { parentSpanId: fixture.parentSpanId } : {}),
    name: fixture.name,
    kind: 2,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    attributes: attrs(fixture.attributes ?? {}),
    events: (fixture.events ?? []).map((event) => ({
      name: event.name,
      timeUnixNano: (start + BigInt(event.offsetMs ?? 1) * 1_000_000n).toString(),
      attributes: attrs(event.attributes ?? {}),
    })),
    status: { code: 1 },
  };
}

function otlpDocument(groups: Array<{ service: string; spans: SpanFixture[] }>): Record<string, unknown> {
  return {
    resourceSpans: groups.map((group) => ({
      resource: {
        attributes: attrs({
          "service.name": group.service,
          "service.revision": "abc123",
          "deployment.environment": "dev",
          "slock.user_id": "private-user-id",
        }),
      },
      scopeSpans: [{ scope: { name: "test" }, spans: group.spans.map(otlpSpan) }],
    })),
  };
}

function makeTraceSource(projectDir: string, envName: string, lines: string): string {
  const directory = join(projectDir, ".slockdev", envName, "traces");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "otlp.json");
  writeFileSync(path, lines);
  return path;
}

function writeReaderState(
  projectDir: string,
  envName: string,
  overrides: Partial<{ mode: "local" | "remote" | "worker-disabled" | "observe-disabled"; status: "starting" | "ready" | "failed" | "stopped"; startedAt: string }> = {},
): string {
  const directory = join(projectDir, ".slockdev", envName, "traces");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "reader-state.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    mode: "local",
    status: "ready",
    startedAt: "2026-07-11T02:00:00.000Z",
    ...overrides,
  }));
  return path;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      now: () => NOW_MS,
    },
  };
}

test("recursive AnyValue decoding covers arrays and kvlists", () => {
  assert.deepEqual(decodeAnyValue({
    kvlistValue: {
      values: [
        { key: "name", value: { stringValue: "raft" } },
        { key: "flags", value: { arrayValue: { values: [{ boolValue: true }, { intValue: "7" }] } } },
      ],
    },
  }), Object.assign(Object.create(null), { name: "raft", flags: [true, "7"] }));
});

test("duration/RFC3339 parsing and anchored dot families are strict", () => {
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs("1.5s"), 1_500);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseSinceMs("15m", NOW_MS), NOW_MS - 900_000);
  assert.equal(parseSinceMs("2026-07-11T02:59:00Z", NOW_MS), NOW_MS - 60_000);
  assert.equal(parseReaderStartedAtMs("2026-07-11T02:59:00.123456789Z"), Date.parse("2026-07-11T02:59:00.123Z"));
  assert.equal(parseReaderStartedAtMs("2026-07-11T10:59:00.123456+08:00"), Date.parse("2026-07-11T10:59:00.123+08:00"));
  assert.equal(parseReaderStartedAtMs("2026-07-11T02:59:00"), undefined);
  assert.throws(() => parseSinceMs("2026-07-11T02:59:00", NOW_MS), /RFC3339/);
  assert.throws(() => parseDurationMs("15"), /duration must look/);
  assert.equal(isDotFamily("server.http", "server.http"), true);
  assert.equal(isDotFamily("server.http.request", "server.http"), true);
  assert.equal(isDotFamily("server.httpx", "server.http"), false);
});

test("flattening preserves BigInt nanos, service classification, and span events", () => {
  const document = otlpDocument([{
    service: "slock-server",
    spans: [{
      name: "server.http.request",
      startMs: NOW_MS,
      attributes: { "http.route": "/api/messages" },
      events: [{ name: "server.http.authorized", attributes: { decision: "allow" } }],
    }],
  }]);
  const [span] = flattenOtlpDocument(document);
  assert.equal(span?.segment, "server");
  assert.equal(span?.startTimeUnixNano, BigInt(NOW_MS) * 1_000_000n);
  assert.equal(span?.events[0]?.name, "server.http.authorized");
  assert.equal(span?.attributes["http.route"], "/api/messages");
});

test("slock.surface takes classification precedence over a misleading service name", () => {
  const [span] = flattenOtlpDocument(otlpDocument([{
    service: "odd-server-wrapper",
    spans: [{ name: "web.send", startMs: NOW_MS, attributes: { "slock.surface": "web" } }],
  }]));
  assert.equal(span?.segment, "web");
});

test("attribute maps reject prototype keys and duplicate keys instead of forging service evidence", () => {
  const prototypeValue = {
    kvlistValue: {
      values: [
        { key: "service.name", value: { stringValue: "slock-web" } },
        { key: "slock.surface", value: { stringValue: "web" } },
      ],
    },
  };
  assert.throws(
    () => decodeAnyValue({ ["__proto__"]: prototypeValue }),
    /forbidden object key/,
  );
  assert.throws(
    () => flattenOtlpDocument({
      resourceSpans: [{
        resource: { attributes: [{ key: "__proto__", value: prototypeValue }] },
        scopeSpans: [{ spans: [otlpSpan({ name: "server.http.request", startMs: NOW_MS })] }],
      }],
    }),
    /forbidden key/,
  );
  assert.throws(
    () => flattenOtlpDocument({
      resourceSpans: [{
        resource: { attributes: [
          { key: "service.name", value: { stringValue: "slock-server" } },
          { key: "service.name", value: { stringValue: "slock-web" } },
        ] },
        scopeSpans: [{ spans: [otlpSpan({ name: "server.http.request", startMs: NOW_MS })] }],
      }],
    }),
    /duplicate key/,
  );
});

test("JSONL reader deduplicates exact spans and tolerates only a final partial fragment", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([{
    service: "slock-server",
    spans: [{ name: "server.http.request", startMs: NOW_MS }],
  }]);
  const path = makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n${JSON.stringify(document)}\n{\"resourceSpans\":`);
  const result = await readTraceFile(path);
  assert.equal(result.spans.length, 1);
  assert.equal(result.exactDuplicates, 1);
  assert.equal(result.errors.length, 0);
  assert.match(result.warnings.join("\n"), /unterminated final JSON fragment/);
});

test("newline-terminated malformed JSON and conflicting duplicates are hard diagnostics", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const first = otlpDocument([{
    service: "slock-server",
    spans: [{ name: "server.http.request", startMs: NOW_MS }],
  }]);
  const conflict = otlpDocument([{
    service: "slock-daemon",
    spans: [{ name: "server.http.changed", startMs: NOW_MS }],
  }]);
  const path = makeTraceSource(
    projectDir,
    "demo",
    `${JSON.stringify(first)}\n{bad json}\n${JSON.stringify(conflict)}\n`,
  );
  const result = await readTraceFile(path);
  assert.match(result.errors.join("\n"), /malformed complete JSONL line 2/);
  assert.match(result.errors.join("\n"), /conflicting duplicate span/);
});

test("default attribute rendering is closed/redacted while raw is explicit", () => {
  const safe = projectAttributes({
    "http.route": "/api/messages",
    "http.request.method": "POST",
    "http.url": "https://example.invalid/?token=secret",
    "authorization": "Bearer secret",
    "payload.count": 3,
    nested: { secret: "value" },
    reason: "Bearer token-that-must-never-print",
    message: "private message canary",
    "file.path": "/home/alice/private/canary.txt",
    "slock.user_id": "raw-user-id-canary",
    revision: "f".repeat(40),
    status: "customer secret phrase",
    outcome: "correct horse battery staple",
    route: "/users/alice/private",
  }, false);
  assert.deepEqual(safe.visible, {
    "http.route": "/api/messages",
    "http.request.method": "POST",
    "payload.count": 3,
    revision: "f".repeat(40),
  });
  assert.equal(safe.redacted, 10);
  const raw = projectAttributes({ authorization: "Bearer secret" }, true);
  assert.deepEqual(raw.visible, { authorization: "Bearer secret" });
  assert.equal(raw.redacted, 0);
});

test("default span/event labels are token-only while raw labels escape controls", () => {
  const spans = flattenOtlpDocument(otlpDocument([{
    service: "slock-server",
    spans: [{
      name: "server.http\nINJECTED-LINE",
      startMs: NOW_MS,
      events: [{ name: "server.event\rINJECTED-EVENT" }],
    }],
  }]));
  const output = renderTrace(spans).join("\n");
  assert.doesNotMatch(output, /server\.http\nINJECTED-LINE/);
  assert.doesNotMatch(output, /server\.event\rINJECTED-EVENT/);
  assert.match(output, /\[redacted-sensitive-label\]/);
  assert.doesNotMatch(output, /INJECTED-LINE|INJECTED-EVENT/);
  const rawOutput = renderTrace(spans, true).join("\n");
  assert.doesNotMatch(rawOutput, /server\.http\nINJECTED-LINE/);
  assert.match(rawOutput, /server\.http\\u000aINJECTED-LINE/);
});

test("renderTrace emits a complete forest, events, orphans, and explicit missing segments", () => {
  const spans = flattenOtlpDocument(otlpDocument([
    {
      service: "slock-server",
      spans: [{
        name: "server.http.request",
        spanId: ROOT,
        startMs: NOW_MS,
        attributes: { "http.route": "/api/messages", authorization: "private" },
        events: [{ name: "server.http.authorized" }],
      }],
    },
    {
      service: "slock-daemon",
      spans: [{ name: "daemon.deliver", spanId: CHILD, parentSpanId: ROOT, startMs: NOW_MS + 1 }],
    },
    {
      service: "custom-worker",
      spans: [{ name: "worker.orphan", spanId: WEB, parentSpanId: "d".repeat(16), startMs: NOW_MS + 2 }],
    },
  ]));
  const output = renderTrace(spans).join("\n");
  assert.match(output, /segments: web=missing server=present daemon=present/);
  assert.match(output, /missing segments: web/);
  assert.match(output, /server\.http\.authorized/);
  assert.match(output, /orphan: parent d{16} not recorded/);
  assert.match(output, /attributes? redacted/);
  assert.doesNotMatch(output, /private-user-id|authorization="private"/);
});

test("trace last skips health roots, selects newest request, and prints its whole trace", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([
    {
      service: "slock-server",
      spans: [
        { traceId: TRACE_A, spanId: ROOT, name: "server.http.request", startMs: NOW_MS - 3_000, attributes: { "http.route": "/api/old" } },
        { traceId: TRACE_B, spanId: ROOT, name: "server.http.request", startMs: NOW_MS - 2_000, attributes: { "http.route": "/api/messages" } },
        { traceId: TRACE_C, spanId: ROOT, name: "server.http.request", startMs: NOW_MS - 1_000, attributes: { "http.route": "/healthz" } },
      ],
    },
    {
      service: "slock-daemon",
      spans: [{ traceId: TRACE_B, spanId: CHILD, parentSpanId: ROOT, name: "daemon.delivery", startMs: NOW_MS - 1_900 }],
    },
  ]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);
  const output = capture();
  const code = await runTraceCli(["last", "--env", "demo", "--wait", "0s"], {
    projectDir,
    defaultEnvName: "fallback",
    ...output.options,
  });
  assert.equal(code, 0);
  assert.match(output.stdout.join("\n"), new RegExp(`trace ${TRACE_B}`));
  assert.match(output.stdout.join("\n"), /daemon\.delivery/);
  assert.doesNotMatch(output.stdout.join("\n"), new RegExp(`trace ${TRACE_C}`));
  assert.match(output.stdout.join("\n"), /mtime=.*Z, tail=newline-terminated, snapshot=stable/);
  assert.match(output.stdout.join("\n"), new RegExp(`next: \\.\\/raftdev trace show ${TRACE_B} --env demo`));
});

test("trace last selects a server HTTP request that has a recorded web parent", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([
    {
      service: "slock-web",
      spans: [{ traceId: TRACE_A, spanId: WEB, name: "web.interaction", startMs: NOW_MS - 20 }],
    },
    {
      service: "slock-server",
      spans: [{
        traceId: TRACE_A,
        spanId: ROOT,
        parentSpanId: WEB,
        name: "server.http.request",
        startMs: NOW_MS - 10,
        attributes: { "http.route": "/api/messages" },
      }],
    },
  ]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);
  const output = capture();
  assert.equal(await runTraceCli(["last", "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...output.options,
  }), 0);
  const text = output.stdout.join("\n");
  assert.match(text, /latest persisted HTTP request/);
  assert.match(text, /segments: web=present server=present/);
  assert.match(text, /web\.interaction/);
});

test("trace last settles briefly so an appended just-finished root beats an old persisted root", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const oldDocument = otlpDocument([{
    service: "slock-server",
    spans: [{ traceId: TRACE_A, name: "server.http.request", startMs: NOW_MS - 5_000, attributes: { "http.route": "/api/old" } }],
  }]);
  const newDocument = otlpDocument([{
    service: "slock-server",
    spans: [{ traceId: TRACE_B, name: "server.http.request", startMs: NOW_MS - 100, attributes: { "http.route": "/api/new" } }],
  }]);
  const path = makeTraceSource(projectDir, "demo", `${JSON.stringify(oldDocument)}\n`);
  const timer = setTimeout(() => appendFileSync(path, `${JSON.stringify(newDocument)}\n`), 100);
  t.after(() => clearTimeout(timer));

  const output = capture();
  const code = await runTraceCli(["last", "--env", "demo", "--wait", "1500ms"], {
    projectDir, defaultEnvName: "fallback", ...output.options,
  });
  assert.equal(code, 0);
  assert.match(output.stdout.join("\n"), /latest persisted HTTP request/);
  assert.match(output.stdout.join("\n"), new RegExp(`trace ${TRACE_B}`));
  assert.doesNotMatch(output.stdout.join("\n"), new RegExp(`trace ${TRACE_A}`));
});

test("trace find searches span and event dot-families and honors a bounded limit", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([{
    service: "slock-server",
    spans: [
      {
        name: "server.query",
        spanId: ROOT,
        startMs: NOW_MS - 500,
        events: [
          { name: "server.query.cache_hit", offsetMs: 1 },
          { name: "server.queryish", offsetMs: 2 },
        ],
      },
      { name: "server.query.sql", spanId: CHILD, startMs: NOW_MS - 400 },
    ],
  }]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);
  const output = capture();
  const code = await runTraceCli([
    "find", "--name", "server.query", "--env", "demo", "--since", "1m", "--limit", "2", "--wait", "0s",
  ], { projectDir, defaultEnvName: "fallback", ...output.options });
  assert.equal(code, 0);
  const text = output.stdout.join("\n");
  assert.match(text, /showing 2 of 3/);
  assert.match(text, /truncated/);
  assert.doesNotMatch(text, /server\.queryish/);
});

test("freshness is per actual service with safe replica aliases by default", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([
    {
      service: "slock-server-secret-env-server",
      spans: [{ traceId: TRACE_A, spanId: ROOT, name: "server.query", startMs: NOW_MS - 200 }],
    },
    {
      service: "slock-server-secret-env-server-2",
      spans: [{ traceId: TRACE_B, spanId: CHILD, name: "server.query", startMs: NOW_MS - 100 }],
    },
  ]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);

  const safe = capture();
  assert.equal(await runTraceCli(["find", "--name", "server.query", "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...safe.options,
  }), 0);
  const safeFreshness = safe.stdout.find((line) => line.startsWith("recorded-span freshness")) ?? "";
  assert.match(safeFreshness, /server=.*Z server-2=.*Z/);
  assert.doesNotMatch(safeFreshness, /secret-env|slock-server/);

  const raw = capture();
  assert.equal(await runTraceCli(["find", "--name", "server.query", "--env", "demo", "--wait", "0s", "--raw"], {
    projectDir, defaultEnvName: "fallback", ...raw.options,
  }), 0);
  const rawFreshness = raw.stdout.find((line) => line.startsWith("recorded-span freshness")) ?? "";
  assert.match(rawFreshness, /slock-server-secret-env-server/);
  assert.match(rawFreshness, /slock-server-secret-env-server-2/);

  const rawMiss = capture();
  assert.equal(await runTraceCli(["find", "--name", "missing.family", "--env", "demo", "--wait", "0s", "--raw"], {
    projectDir, defaultEnvName: "fallback", ...rawMiss.options,
  }), 1);
  const warningIndex = rawMiss.stderr.findIndex((line) => line.includes("WARNING: --raw"));
  const rawNameIndex = rawMiss.stderr.findIndex((line) => line.includes("slock-server-secret-env"));
  assert.ok(warningIndex >= 0 && rawNameIndex > warningIndex, "raw warning must precede service-name exposure on no-match paths");
});

test("freshness collision aliases retain slock.surface classification", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([
    {
      service: "opaque-private-a",
      spans: [{ traceId: TRACE_A, spanId: ROOT, name: "server.query", startMs: NOW_MS - 200, attributes: { "slock.surface": "server" } }],
    },
    {
      service: "opaque-private-b",
      spans: [{ traceId: TRACE_B, spanId: CHILD, name: "server.query", startMs: NOW_MS - 100, attributes: { "slock.surface": "server" } }],
    },
  ]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);
  const output = capture();
  assert.equal(await runTraceCli(["find", "--name", "server.query", "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...output.options,
  }), 0);
  const freshness = output.stdout.find((line) => line.startsWith("recorded-span freshness")) ?? "";
  assert.match(freshness, /server#1=.*Z server#2=.*Z/);
  assert.doesNotMatch(freshness, /opaque-private|other#/);
});

test("trace show validates IDs and reports missing service segments without false zero", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([{
    service: "slock-web",
    spans: [{ traceId: TRACE_A, name: "web.send", startMs: NOW_MS }],
  }]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);

  const invalid = capture();
  assert.equal(await runTraceCli(["show", "not-a-trace", "--wait", "0s"], {
    projectDir, defaultEnvName: "demo", ...invalid.options,
  }), 2);
  assert.match(invalid.stderr.join("\n"), /32 non-zero hex/);

  const valid = capture();
  assert.equal(await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...valid.options,
  }), 0);
  assert.match(valid.stdout.join("\n"), /segments: web=present server=missing daemon=missing/);

  const missing = capture();
  assert.equal(await runTraceCli(["show", TRACE_B, "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...missing.options,
  }), 1);
  assert.match(missing.stderr.join("\n"), /was not recorded|1 unique span/);
});

test("trace show re-polls a partial collector tail before returning an already-matched root", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const rootDocument = otlpDocument([{
    service: "slock-server",
    spans: [{ traceId: TRACE_A, spanId: ROOT, name: "server.http.request", startMs: NOW_MS }],
  }]);
  const childDocumentText = JSON.stringify(otlpDocument([{
    service: "slock-daemon",
    spans: [{ traceId: TRACE_A, spanId: CHILD, parentSpanId: ROOT, name: "daemon.late-child", startMs: NOW_MS + 1 }],
  }]));
  const path = makeTraceSource(
    projectDir,
    "demo",
    `${JSON.stringify(rootDocument)}\n${childDocumentText.slice(0, -1)}`,
  );
  const timer = setTimeout(() => appendFileSync(path, `${childDocumentText.slice(-1)}\n`), 100);
  t.after(() => clearTimeout(timer));

  const output = capture();
  const code = await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "750ms"], {
    projectDir, defaultEnvName: "fallback", ...output.options,
  });
  assert.equal(code, 0);
  assert.match(output.stdout.join("\n"), /daemon\.late-child/);
  assert.match(output.stderr.join("\n"), /unterminated final JSON fragment/);
});

test("trace show waits through a complete-line inter-batch child append", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const rootDocument = otlpDocument([{
    service: "slock-server",
    spans: [{ traceId: TRACE_A, spanId: ROOT, name: "server.http.request", startMs: NOW_MS }],
  }]);
  const childDocument = otlpDocument([{
    service: "slock-daemon",
    spans: [{ traceId: TRACE_A, spanId: CHILD, parentSpanId: ROOT, name: "daemon.complete-line-child", startMs: NOW_MS + 1 }],
  }]);
  const path = makeTraceSource(projectDir, "demo", `${JSON.stringify(rootDocument)}\n`);
  const timer = setTimeout(() => appendFileSync(path, `${JSON.stringify(childDocument)}\n`), 100);
  t.after(() => clearTimeout(timer));

  const output = capture();
  const started = Date.now();
  assert.equal(await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "900ms"], {
    projectDir, defaultEnvName: "fallback", ...output.options,
  }), 0);
  assert.ok(Date.now() - started >= 500, "matched snapshots must remain source-quiet before success");
  assert.match(output.stdout.join("\n"), /daemon\.complete-line-child/);
  assert.doesNotMatch(output.stderr.join("\n"), /partial observation/);
});

test("reader state rejects remote, disabled, and failed modes even with a retained artifact", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([{
    service: "slock-server",
    spans: [{ traceId: TRACE_A, name: "server.http.request", startMs: NOW_MS }],
  }]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);
  const cases = [
    { mode: "remote" as const, status: "ready" as const, pattern: /remote trace mode.*stale by contract/ },
    { mode: "worker-disabled" as const, status: "stopped" as const, pattern: /trace Worker is disabled.*SLOCKDEV_TRACE_WORKER=0/ },
    { mode: "observe-disabled" as const, status: "stopped" as const, pattern: /trace observation is disabled.*SLOCKDEV_TRACE_OBSERVE=0/ },
    { mode: "local" as const, status: "failed" as const, pattern: /collector failed to start.*\.\/raftdev logs demo/ },
  ];
  for (const fixture of cases) {
    writeReaderState(projectDir, "demo", { mode: fixture.mode, status: fixture.status });
    const output = capture();
    assert.equal(await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "0s"], {
      projectDir, defaultEnvName: "fallback", ...output.options,
    }), 2);
    assert.match(output.stderr.join("\n"), fixture.pattern);
    assert.equal(output.stdout.length, 0, "a stale artifact must not be rendered for a rejected reader mode");
  }
});

test("reader state waits for starting to become ready and labels stopped artifacts archived", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([{
    service: "slock-server",
    spans: [{ traceId: TRACE_A, name: "server.http.request", startMs: NOW_MS }],
  }]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);
  writeReaderState(projectDir, "demo", { status: "starting" });
  const timer = setTimeout(() => writeReaderState(projectDir, "demo", { status: "ready" }), 100);
  t.after(() => clearTimeout(timer));

  const ready = capture();
  assert.equal(await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "1s"], {
    projectDir, defaultEnvName: "fallback", ...ready.options,
  }), 0);
  assert.match(ready.stdout.join("\n"), new RegExp(`trace ${TRACE_A}`));

  writeReaderState(projectDir, "demo", { status: "stopped" });
  const stopped = capture();
  assert.equal(await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...stopped.options,
  }), 0);
  assert.match(stopped.stdout.join("\n"), /reader state: archived local artifact \(environment stopped/);
});

test("an unresolved starting state and a pre-run artifact are actionable non-successes", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([{
    service: "slock-server",
    spans: [{ traceId: TRACE_A, name: "server.http.request", startMs: NOW_MS }],
  }]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);
  writeReaderState(projectDir, "demo", { status: "starting" });
  const starting = capture();
  assert.equal(await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...starting.options,
  }), 1);
  assert.match(starting.stderr.join("\n"), /still starting.*\.\/raftdev logs demo/);

  writeReaderState(projectDir, "demo", {
    status: "ready",
    startedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const stale = capture();
  assert.equal(await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...stale.options,
  }), 1);
  assert.match(stale.stderr.join("\n"), /artifact predates the current reader run/);
  assert.doesNotMatch(stale.stdout.join("\n"), new RegExp(`trace ${TRACE_A}`));

  writeReaderState(projectDir, "demo", {
    status: "ready",
    startedAt: "2026-07-11T02:00:00.123456Z",
  });
  const nanosecondPrecision = capture();
  assert.equal(await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...nanosecondPrecision.options,
  }), 0);
  assert.match(nanosecondPrecision.stdout.join("\n"), new RegExp(`trace ${TRACE_A}`));

  writeReaderState(projectDir, "demo", {
    status: "ready",
    startedAt: "2026-07-11T02:00:00",
  });
  const invalidTime = capture();
  assert.equal(await runTraceCli(["show", TRACE_A, "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...invalidTime.options,
  }), 2);
  assert.match(invalidTime.stderr.join("\n"), /reader-state\.json does not match schemaVersion 1/);
});

test("missing/empty sources are actionable nonzero results, never an empty success", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const missing = capture();
  assert.equal(await runTraceCli(["last", "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...missing.options,
  }), 1);
  assert.match(missing.stderr.join("\n"), /trace source is missing|Start it with/);
  assert.doesNotMatch(missing.stderr.join("\n"), new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  makeTraceSource(projectDir, "demo", "");
  const empty = capture();
  assert.equal(await runTraceCli(["find", "--name", "server", "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...empty.options,
  }), 1);
  assert.match(empty.stderr.join("\n"), /trace source is empty|Send a dev request/);
});

test("read failures report only a safe code beside a project-relative source path", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  mkdirSync(join(projectDir, ".slockdev", "demo", "traces", "otlp.json"), { recursive: true });
  const output = capture();
  assert.equal(await runTraceCli(["last", "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...output.options,
  }), 2);
  const text = output.stderr.join("\n");
  assert.match(text, /cannot read trace source \.slockdev\/demo\/traces\/otlp\.json: (?:EISDIR|READ_FAILED)/);
  assert.doesNotMatch(text, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("raw mode warns before exposing attributes; data errors exit 2", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const document = otlpDocument([{
    service: "slock-server",
    spans: [{
      name: "server.http.request",
      startMs: NOW_MS,
      attributes: {
        "http.route": "/api",
        authorization: "Bearer private",
        reason: "Bearer hidden-reason-token",
        message: "private message canary",
        "file.path": "/home/alice/private/canary.txt",
        "slock.user_id": "raw-user-id-canary",
      },
    }],
  }]);
  makeTraceSource(projectDir, "demo", `${JSON.stringify(document)}\n`);
  const raw = capture();
  assert.equal(await runTraceCli(["last", "--env", "demo", "--wait", "0s", "--raw"], {
    projectDir, defaultEnvName: "fallback", ...raw.options,
  }), 0);
  assert.match(raw.stderr.join("\n"), /WARNING: --raw/);
  assert.match(raw.stdout.join("\n"), /Bearer private/);

  const safe = capture();
  assert.equal(await runTraceCli(["last", "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...safe.options,
  }), 0);
  const safeText = safe.stdout.join("\n");
  assert.doesNotMatch(safeText, /hidden-reason-token|private message canary|alice\/private|raw-user-id-canary|Bearer private/);
  assert.match(safeText, /attribute[s]? redacted/);

  makeTraceSource(projectDir, "broken", "{\"authorization\":\"Bearer source-canary\"\n");
  const broken = capture();
  assert.equal(await runTraceCli(["last", "--env", "broken", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...broken.options,
  }), 2);
  assert.match(broken.stderr.join("\n"), /malformed complete JSONL line 1/);
  assert.doesNotMatch(broken.stderr.join("\n"), /source-canary|authorization|Bearer/);
});

test("a line above the 16 MiB cap is a data error, not a false empty result", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const path = makeTraceSource(projectDir, "demo", "x".repeat(16 * 1024 * 1024 + 1));
  const result = await readTraceFile(path);
  assert.match(result.errors.join("\n"), /exceeds the 16777216 byte safety cap/);
  assert.equal(result.tailState, "oversize");

  const output = capture();
  assert.equal(await runTraceCli(["last", "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...output.options,
  }), 2);
  assert.match(output.stderr.join("\n"), /exceeds the 16777216 byte safety cap/);
});

test("a sparse snapshot above 256 MiB fails before reading with an actionable error", async (t) => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const path = makeTraceSource(projectDir, "demo", "");
  truncateSync(path, 256 * 1024 * 1024 + 1);
  const result = await readTraceFile(path);
  assert.equal(result.spans.length, 0);
  assert.match(result.errors.join("\n"), /above the 268435456 byte read cap/);
  assert.match(result.errors.join("\n"), /archive or remove/);

  const output = capture();
  assert.equal(await runTraceCli(["last", "--env", "demo", "--wait", "0s"], {
    projectDir, defaultEnvName: "fallback", ...output.options,
  }), 2);
  assert.match(output.stderr.join("\n"), /above the 268435456 byte read cap/);
});

test("argument grammar, subcommand help, and canonical environment names are explicit", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "raftdev-trace-"));
  try {
    const output = capture();
    assert.equal(await runTraceCli(["find", "--name", "server", "--limit", "501"], {
      projectDir, defaultEnvName: "demo", ...output.options,
    }), 2);
    assert.match(output.stderr.join("\n"), /between 1 and 500/);
    const irrelevantLimit = capture();
    assert.equal(await runTraceCli(["last", "--limit", "1"], {
      projectDir, defaultEnvName: "demo", ...irrelevantLimit.options,
    }), 2);
    assert.match(irrelevantLimit.stderr.join("\n"), /--limit is only valid with trace find/);
    const irrelevantSince = capture();
    assert.equal(await runTraceCli(["show", TRACE_A, "--since", "1m"], {
      projectDir, defaultEnvName: "demo", ...irrelevantSince.options,
    }), 2);
    assert.match(irrelevantSince.stderr.join("\n"), /--since is only valid with trace last or trace find/);
    const help = capture();
    assert.equal(await runTraceCli(["show", "--help"], {
      projectDir, defaultEnvName: "demo", ...help.options,
    }), 0);
    assert.match(help.stdout.join("\n"), /trace show/);
    for (const envName of ["_demo", "-demo", ".demo", "--demo"]) {
      const canonical = capture();
      assert.equal(await runTraceCli(["last", "--env", envName, "--wait", "0s"], {
        projectDir, defaultEnvName: "fallback", ...canonical.options,
      }), 1, `${envName} should parse as a canonical environment name`);
      assert.doesNotMatch(canonical.stderr.join("\n"), /--env must be/);
    }
    for (const envName of [".", "..", "space name", "slash/name", "é"]) {
      const invalid = capture();
      assert.equal(await runTraceCli(["last", "--env", envName, "--wait", "0s"], {
        projectDir, defaultEnvName: "fallback", ...invalid.options,
      }), 2);
      assert.match(invalid.stderr.join("\n"), /--env must be/);
    }
    assert.throws(() => parseDurationMs("31fortnights"));
    assert.deepEqual(traceBannerLines("_demo"), [
      "  Inspect received traces:",
      "    ./raftdev trace last --env _demo",
      "    ./raftdev trace find --name server.http --since 15m --env _demo",
      "    ./raftdev trace show <trace-id> --env _demo",
    ]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
