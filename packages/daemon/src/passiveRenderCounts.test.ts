// Glimpse layer 2, daemon side: take the CLI's passive render counts out of
// the agent ledger when a turn ends (passiveRenderCounts.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, test } from "vitest";

import { BasicTracer, PASSIVE_RENDER_COUNTS_DDL, PASSIVE_RENDER_COUNTS_UPSERT } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";

import { passiveRenderTraceAttrs, takePassiveRenderCounts } from "./passiveRenderCounts";
import { senderLedgerPath } from "./senderLedger";

let dbPath = "";

/** The CLI ledger's version-1 meta, plus the counts table exactly as the CLI creates it. */
function createCliLedger(opts: { version?: string; withCounts?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(opts.version ?? "1");
  if (opts.withCounts !== false) db.exec(PASSIVE_RENDER_COUNTS_DDL);
  db.close();
}

/** One print, booked with the CLI's own statement. */
function count(contextId: string, kind: string, chars: number, bytes: number): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(PASSIVE_RENDER_COUNTS_UPSERT).run(contextId, kind, chars, bytes);
  db.close();
}

function remaining(): number {
  const db = new DatabaseSync(dbPath);
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM passive_render_counts").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dbPath = senderLedgerPath(fs.mkdtempSync(path.join(os.tmpdir(), "daemon-render-counts-")), "agent-1")!;
});

test("takes every counted row and leaves the table empty", () => {
  createCliLedger();
  count("ctx-1", "channel_card", 320, 350);
  count("ctx-1", "channel_card", 320, 350);
  count("ctx-1", "freshness_hold", 1200, 1500);
  const take = takePassiveRenderCounts(dbPath);
  assert.equal(take.outcome, "taken");
  assert.deepEqual(
    take.counts.sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { contextId: "ctx-1", kind: "channel_card", renders: 2, chars: 640, bytes: 700 },
      { contextId: "ctx-1", kind: "freshness_hold", renders: 1, chars: 1200, bytes: 1500 },
    ],
  );
  assert.equal(remaining(), 0);
  assert.deepEqual(takePassiveRenderCounts(dbPath), { outcome: "empty", counts: [] });
});

test("no ledger or no counts table is no_counter (a CLI that predates the counts); the daemon creates neither", () => {
  assert.deepEqual(takePassiveRenderCounts(dbPath), { outcome: "no_counter", counts: [] });
  assert.equal(fs.existsSync(dbPath), false, "never creates the ledger");
  createCliLedger({ withCounts: false });
  assert.deepEqual(takePassiveRenderCounts(dbPath), { outcome: "no_counter", counts: [] });
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'passive_render_counts'").get(), undefined, "no DDL from the daemon");
  db.close();
});

test("a counts table with nothing in it is empty: the CLI counts and printed nothing", () => {
  createCliLedger();
  assert.deepEqual(takePassiveRenderCounts(dbPath), { outcome: "empty", counts: [] });
});

test("a newer ledger version is neither read nor cleared", () => {
  createCliLedger({ version: "2" });
  count("ctx-1", "freshness_hold", 10, 10);
  assert.deepEqual(takePassiveRenderCounts(dbPath), { outcome: "unknown_version", counts: [] });
  assert.equal(remaining(), 1);
});

test("no ledger path, or a ledger that cannot be opened: unavailable, and nothing is cleared", () => {
  assert.equal(takePassiveRenderCounts(undefined).outcome, "unavailable");
  createCliLedger();
  count("ctx-1", "freshness_hold", 10, 10);
  const broken = { DatabaseSync: class { constructor() { throw Object.assign(new Error("disk I/O error"), { errcode: 10 }); } } };
  assert.deepEqual(takePassiveRenderCounts(dbPath, { sqlite: broken as never }), { outcome: "unavailable", counts: [] });
  assert.equal(remaining(), 1);
});

test("a ledger the CLI is writing right now is not waited for: the counts stay for the next turn end", () => {
  createCliLedger();
  count("ctx-1", "peer_card", 80, 90);
  const writer = new DatabaseSync(dbPath);
  writer.exec("BEGIN IMMEDIATE");
  try {
    const startedAt = performance.now();
    assert.deepEqual(takePassiveRenderCounts(dbPath), { outcome: "ledger_busy", counts: [] });
    assert.ok(performance.now() - startedAt < 250, "returned without waiting for the lock");
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  assert.equal(remaining(), 1);
  assert.equal(takePassiveRenderCounts(dbPath).counts.length, 1);
});

test("span attributes: the ending context's counts by kind, other contexts apart, unknown kinds in the totals", () => {
  const attrs = passiveRenderTraceAttrs({
    outcome: "taken",
    counts: [
      { contextId: "ctx-2", kind: "channel_card", renders: 2, chars: 600, bytes: 650 },
      { contextId: "ctx-2", kind: "send_attachment", renders: 1, chars: 1800, bytes: 2400 },
      { contextId: "ctx-1", kind: "freshness_hold", renders: 1, chars: 900, bytes: 950 },
      { contextId: "ctx-2", kind: "from_a_newer_cli", renders: 3, chars: 30, bytes: 30 },
    ],
  }, "ctx-2", true);
  assert.deepEqual(attrs, {
    passive_render_outcome: "taken",
    passive_render_carried_over: true,
    model_context_id: "ctx-2",
    passive_render_count: 6,
    passive_render_char_count: 2430,
    passive_render_byte_count: 3080,
    passive_render_channel_card_render_count: 2,
    passive_render_channel_card_byte_count: 650,
    passive_render_peer_card_render_count: 0,
    passive_render_peer_card_byte_count: 0,
    passive_render_card_hold_render_count: 0,
    passive_render_card_hold_byte_count: 0,
    passive_render_freshness_hold_render_count: 0,
    passive_render_freshness_hold_byte_count: 0,
    passive_render_freshness_attached_render_count: 0,
    passive_render_freshness_attached_byte_count: 0,
    passive_render_send_attachment_render_count: 1,
    passive_render_send_attachment_byte_count: 2400,
    passive_render_command_guidance_render_count: 0,
    passive_render_command_guidance_byte_count: 0,
    passive_render_unknown_kind_render_count: 3,
    passive_render_other_context_render_count: 1,
    passive_render_other_context_char_count: 900,
    passive_render_other_context_byte_count: 950,
  });
});

test("every span attribute, model_context_id included, survives the daemon's local trace sink, which drops unlisted id-like keys", () => {
  const machineDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-render-counts-sink-"));
  const tracer = new BasicTracer({ sink: new LocalRotatingTraceSink({ machineDir }) });
  const attrs = passiveRenderTraceAttrs({ outcome: "taken", counts: [{ contextId: "ctx-1", kind: "channel_card", renders: 1, chars: 10, bytes: 10 }] }, "ctx-1", false);
  tracer.startSpan("daemon.runtime.turn", { surface: "daemon", kind: "internal", attrs: {} }).end("ok", { attrs });
  const traceDir = path.join(machineDir, "traces");
  const written = fs.readdirSync(traceDir)
    .flatMap((file) => fs.readFileSync(path.join(traceDir, file), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as { name: string; attrs?: Record<string, unknown> })
    .find((record) => record.name === "daemon.runtime.turn");
  assert.equal(attrs.model_context_id, "ctx-1");
  assert.deepEqual(written?.attrs, attrs);
});
