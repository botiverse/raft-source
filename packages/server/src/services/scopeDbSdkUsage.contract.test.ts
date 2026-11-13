import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "scopedb";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACKAGE_SRC_ROOT = path.join(REPO_ROOT, "packages");
const APPROVED_SDK_ADAPTERS = new Set([
  "packages/server/src/services/productEventScopeDbWriter.ts",
  "packages/server/src/tracing/scopeDbTraceEventSink.ts",
  "packages/server/src/tracing/traceExportSummary.ts",
  "packages/trace-upload-worker/src/traces/traceEventProjector.ts",
]);

async function productionSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...await productionSourceFiles(absolute));
      continue;
    }
    if (!/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    files.push(absolute);
  }
  return files;
}

test("ScopeDB SDK calls stay inside classified adapters and write only through Append", async () => {
  const violations: string[] = [];
  for (const file of await productionSourceFiles(PACKAGE_SRC_ROOT)) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    const importsScopeDb = /from\s+["']scopedb["']/.test(source);

    if (importsScopeDb && !APPROVED_SDK_ADAPTERS.has(relative)) {
      violations.push(`${relative}: direct scopedb import is not an approved adapter`);
    }
    // scopedb 0.3 removed legacy POST /v1/ingest (insert/ingest/ingestStream);
    // writes go through Table.append()/appendStream() with rows already
    // encoded for their column types (encodeScopeDbAppendLine).
    if (/\bingestStream\s*\(|\bIngestStream(?:Builder)?\b/.test(source)) {
      violations.push(`${relative}: legacy ScopeDB ingest stream; use table(...).appendStream()`);
    }
    if (importsScopeDb && /\.(?:insert|ingest)\s*\(/.test(source)) {
      violations.push(`${relative}: legacy ScopeDB insert/ingest; use table(...).append()`);
    }
    if (/["'`][^"'`\n]*\/v1\/ingest\b/.test(source)) {
      violations.push(`${relative}: legacy ScopeDB /v1/ingest endpoint`);
    }
    if (/appendStream\s*\(/.test(source) && relative.includes("/routes/")) {
      violations.push(`${relative}: request handlers must not own an append stream`);
    }
    if (importsScopeDb && /\.(?:intoObjects|intoValues|jsonRows)\s*\(/.test(source)) {
      violations.push(`${relative}: scopedb 0.2 result conversion; use toObjects/toValues/rawRows`);
    }
    if (importsScopeDb && /\.(?:toObjects|toValues|first)\s*\(/.test(source)) {
      const conversions = source.match(/\.(?:toObjects|toValues|first)\s*\([^)]*\)/gs) ?? [];
      for (const conversion of conversions) {
        if (!/integerMode\s*:/.test(conversion)) {
          violations.push(`${relative}: ScopeDB read conversion lacks explicit integerMode`);
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});

async function decodedBody(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  const encoded = body instanceof ArrayBuffer ? body : await new Response(body as BodyInit).arrayBuffer();
  if (new Headers(init?.headers).get("content-encoding") !== "gzip") return new TextDecoder().decode(encoded);
  const stream = new Blob([encoded]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

test("ScopeDB 0.4 Append reaches the table append endpoint with Bearer auth, never /v1/ingest", async () => {
  const observed: Array<{ url: string; init?: RequestInit }> = [];
  const client = new Client("https://scope.example/base", {
    apiKey: "test-write-key",
    fetch: async (input, init) => {
      observed.push({ url: String(input), init });
      return new Response(JSON.stringify({ status: "committed", num_rows_inserted: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.table("trace_events_v2", { schema: "raft" }).append('{"row_kind":"event"}');

  assert.deepEqual(result, { status: "succeeded", num_rows_inserted: 1 });
  assert.equal(observed.length, 1);
  const [{ url, init }] = observed as [{ url: string; init?: RequestInit }];
  assert.equal(url, "https://scope.example/base/v1/catalog/databases/scopedb/schemas/raft/tables/trace_events_v2/ingest");
  assert.equal(url.includes("/v1/ingest"), false);
  assert.equal(init?.method, "POST");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), "Bearer test-write-key");
  assert.equal(headers.get("content-type"), "application/x-ndjson");
  // The body is the NDJSON itself: no statement, no {type, data} envelope.
  assert.equal(await decodedBody(init), '{"row_kind":"event"}');
});
