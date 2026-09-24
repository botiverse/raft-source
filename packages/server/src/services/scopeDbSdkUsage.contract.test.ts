import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { Client } from "scopedb";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACKAGE_SRC_ROOT = path.join(REPO_ROOT, "packages");
const APPROVED_SDK_ADAPTERS = new Set([
  "packages/server/src/services/agentO11yScopeDbWriter.ts",
  "packages/server/src/tracing/scopeDbTraceEventSink.ts",
  "packages/trace-upload-worker/src/traceEventProjector.ts",
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

test("ScopeDB SDK calls stay inside classified adapters with no buffered path", async () => {
  const violations: string[] = [];
  for (const file of await productionSourceFiles(PACKAGE_SRC_ROOT)) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    const importsScopeDb = /from\s+["']scopedb["']/.test(source);

    if (importsScopeDb && !APPROVED_SDK_ADAPTERS.has(relative)) {
      violations.push(`${relative}: direct scopedb import is not an approved adapter`);
    }
    if (/\.ingest\s*\(\s*\{[\s\S]{0,300}?type\s*:\s*["']buffered["']/.test(source)) {
      violations.push(`${relative}: buffered ingest has no production exception`);
    }
    if (/ingestStream\s*\(/.test(source) && relative.includes("/routes/")) {
      violations.push(`${relative}: request handlers must not own an ingest stream`);
    }
    if (importsScopeDb && /\.(?:intoObjects|intoValues|first)\s*\(/.test(source)) {
      const conversions = source.match(/\.(?:intoObjects|intoValues|first)\s*\([^)]*\)/gs) ?? [];
      for (const conversion of conversions) {
        if (!/integerMode\s*:/.test(conversion)) {
          violations.push(`${relative}: ScopeDB read conversion lacks explicit integerMode`);
        }
      }
    }
    if (
      relative !== "packages/daemon/src/agentO11yClient.ts"
      && /new\s+AgentO11yDaemonClient\s*\(/.test(source)
    ) {
      violations.push(`${relative}: wiring accepted-count consumption requires persistence-tier reclassification`);
    }
  }

  assert.deepEqual(violations, []);
});

test("approved ScopeDB adapters declare their decision-support tier", async () => {
  const [agentWriter, traceSink, traceProjector] = await Promise.all([
    readFile(path.join(REPO_ROOT, "packages/server/src/services/agentO11yScopeDbWriter.ts"), "utf8"),
    readFile(path.join(REPO_ROOT, "packages/server/src/tracing/scopeDbTraceEventSink.ts"), "utf8"),
    readFile(path.join(REPO_ROOT, "packages/trace-upload-worker/src/traceEventProjector.ts"), "utf8"),
  ]);

  assert.match(agentWriter, /AGENT_O11Y_SCOPEDB_PERSISTENCE_TIER[^=]*= "decision_support"/);
  assert.match(traceSink, /TRACE_EVENT_SCOPEDB_PERSISTENCE_TIER[^=]*= "decision_support"/);
  assert.match(traceProjector, /TRACE_UPLOAD_SCOPEDB_PERSISTENCE_TIER[^=]*= "decision_support"/);
});

test("approved ScopeDB adapters use the non-deprecated apiKey client option", async () => {
  for (const relative of APPROVED_SDK_ADAPTERS) {
    const source = await readFile(path.join(REPO_ROOT, relative), "utf8");
    assert.match(
      source,
      /new\s+Client\([^\n]+\{\s*apiKey\s*:/,
      `${relative}: ScopeDB Client must authenticate with apiKey`,
    );
    assert.doesNotMatch(
      source,
      /new\s+Client\([^\n]+\{\s*token\s*:/,
      `${relative}: deprecated ScopeDB Client token option must not return`,
    );
  }
});

test("ScopeDB 0.2 apiKey reaches the committed-ingest request boundary", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const client = new Client("https://scope.example/base", {
    apiKey: "test-write-key",
    fetch: async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return new Response(JSON.stringify({ num_rows_inserted: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.insert('{"event_kind":"test"}', "INTO raft.agent_events");

  assert.deepEqual(result, { num_rows_inserted: 1 });
  assert.equal(observedUrl, "https://scope.example/base/v1/ingest");
  assert.equal(observedInit?.method, "POST");
  assert.equal(new Headers(observedInit?.headers).get("authorization"), "Bearer test-write-key");
  const body = observedInit?.body;
  const encoded = body instanceof ArrayBuffer ? body : await new Response(body as BodyInit).arrayBuffer();
  const contentEncoding = new Headers(observedInit?.headers).get("content-encoding");
  const decoded = contentEncoding === "gzip"
    ? await new Response(encoded).arrayBuffer().then(async (bytes) => {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        return new Response(stream).text();
      })
    : new TextDecoder().decode(encoded);
  assert.deepEqual(JSON.parse(decoded), {
    type: "committed",
    data: { format: "json", rows: '{"event_kind":"test"}' },
    statement: "INTO raft.agent_events",
  });
});
