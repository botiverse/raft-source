import assert from "node:assert/strict";
import { handleRequest, type TraceUploadWorkerEnv } from "../index";
import { resetDevEventsDedupeForTests, type DevEventsScopeDbClient } from "./devEvents";

const CI_TOKEN = "dev-trace-ci-token-for-tests";
const DEV_TOKEN = "dev-trace-dev-token-for-tests";

function env(overrides: Partial<TraceUploadWorkerEnv> = {}) {
  const appends: Array<{ table: string; database: string; schema: string; rows: Record<string, unknown>[] }> = [];
  const client: DevEventsScopeDbClient = {
    table: (name, options) => ({
      append: async (ndjson: string) => {
        appends.push({ table: name, ...options, rows: ndjson.trim().split("\n").map((line) => JSON.parse(line)) });
        return {};
      },
    }),
  };
  const value: TraceUploadWorkerEnv = {
    SCOPE_ATTESTATION_SECRET: "unused",
    TRACE_BUNDLES: { put: async () => ({}) },
    DEV_TRACE_CI_TOKEN: CI_TOKEN,
    DEV_TRACE_DEV_TOKEN: DEV_TOKEN,
    DEV_TRACE_SCOPEDB_CLIENT: client,
    ...overrides,
  };
  return { env: value, appends };
}

const recent = () => new Date(Date.now() - 60_000).toISOString();

function run(overrides: Record<string, unknown> = {}) {
  return { table: "runs", schema_v: 1, run_id: "01a1f4a6-8cd4-70c1-9e5f-68fc374ebd16", package: "@botiverse/raft-server", started_at: recent(), result: "fail", where: "local", actor: "agent-1", ...overrides };
}

function testCase(overrides: Record<string, unknown> = {}) {
  return { table: "cases", schema_v: 1, run_id: "01a1f4a6-8cd4-70c1-9e5f-68fc374ebd16", case_id: "abcdef0123456789", started_at: recent(), state: "failed", name: "does a thing", ...overrides };
}

function post(rows: unknown[], token: string | null = CI_TOKEN) {
  return new Request("https://trace-worker.test/api/dev-events", {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n") + "\n",
  });
}

beforeEach(() => resetDevEventsDedupeForTests());

test("writes runs and cases to the fixed dev tables, stamping source and received_at", async () => {
  const { env: e, appends } = env();
  const res = await handleRequest(post([run(), testCase(), testCase({ case_id: "1111111111111111", state: "passed" })]), e);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, source: "ci", accepted: 3, duplicates: 0, refused: {} });
  assert.deepEqual(appends.map((a) => [a.table, a.database, a.schema, a.rows.length]), [["runs", "dev", "public", 1], ["cases", "dev", "public", 2]]);
  const [runRow] = appends[0].rows;
  assert.equal(runRow.source, "ci");
  assert.ok(typeof runRow.received_at === "string");
  assert.equal(runRow.package, "@botiverse/raft-server");
  assert.equal("table" in runRow, false);
});

test("the token decides source; a client-reported source is ignored", async () => {
  const { env: e, appends } = env();
  const res = await handleRequest(post([run({ source: "ci", where: "ci" })], DEV_TOKEN), e);
  assert.equal(res.status, 202);
  assert.equal(appends[0].rows[0].source, "dev");
  assert.equal(appends[0].rows[0].where, "ci");
});

test("refuses unknown tokens, and is off (404) with no token configured", async () => {
  const { env: e } = env();
  assert.equal((await handleRequest(post([run()], "nope"), e)).status, 401);
  assert.equal((await handleRequest(post([run()], null), e)).status, 401);
  const off = env({ DEV_TRACE_CI_TOKEN: undefined, DEV_TRACE_DEV_TOKEN: undefined });
  assert.equal((await handleRequest(post([run()]), off.env)).status, 404);
});

test("asks the uploader to retry (503) when no ScopeDB sink is configured", async () => {
  const { env: e } = env({ DEV_TRACE_SCOPEDB_CLIENT: undefined, SCOPEDB_TRACE_EVENTS_ENDPOINT: undefined, SCOPEDB_TRACE_EVENTS_WRITE_KEY: undefined });
  assert.equal((await handleRequest(post([run()]), e)).status, 503);
});

test("drops other tables, unknown fields, stale or future rows and bad lines", async () => {
  const { env: e, appends } = env();
  const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
  const future = new Date(Date.now() + 2 * 3600_000).toISOString();
  const res = await handleRequest(
    post([
      { ...run(), table: "otel.traces" },
      run({ run_id: "a", started_at: old }),
      run({ run_id: "b", started_at: future }),
      testCase({ case_id: undefined }),
      "{not json",
      run({ run_id: "c", secret_field: "x", argv: "y".repeat(5000) }),
    ]),
    e,
  );
  const body = await res.json();
  assert.equal(res.status, 202);
  assert.equal(body.accepted, 1);
  assert.deepEqual(body.refused, { table_not_allowed: 1, too_old: 1, in_future: 1, case_id_missing: 1, not_json: 1 });
  const [only] = appends[0].rows;
  assert.equal(only.run_id, "c");
  assert.equal("secret_field" in only, false);
  assert.equal((only.argv as string).length, 1024);
});

test("dedupes by run_id and run_id + case_id within and across batches", async () => {
  const { env: e, appends } = env();
  await handleRequest(post([run(), run(), testCase(), testCase()]), e);
  const second = await handleRequest(post([run(), testCase()]), e);
  assert.deepEqual(await second.json(), { ok: true, source: "ci", accepted: 0, duplicates: 2, refused: {} });
  assert.deepEqual(appends.map((a) => a.rows.length), [1, 1]);
});

test("refuses more than 500 lines in one request", async () => {
  const { env: e } = env();
  const rows = Array.from({ length: 501 }, (_, i) => testCase({ case_id: `case${i}` }));
  assert.equal((await handleRequest(post(rows), e)).status, 413);
});

test("redacts credential-shaped free text server-side, whatever the client sent", async () => {
  const { env: e, appends } = env();
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const res = await handleRequest(
    post([
      run({ argv: `run --token=${secret}`, branch: "agent/x" }),
      testCase({ error_text: `Error: Authorization: Bearer ${secret} for alice.real@corp.com`, name: `sends ${secret}` }),
    ]),
    e,
  );
  assert.equal(res.status, 202);
  const written = JSON.stringify(appends.flatMap((a) => a.rows));
  assert.equal(written.includes(secret), false);
  assert.equal(written.includes("alice.real@corp.com"), false);
  assert.equal(appends[0].rows[0].branch, "agent/x");
});
