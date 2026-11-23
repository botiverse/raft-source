// Daemon side of "sender description once per context": a foreign writer on
// the CLI's agent ledger (senderLedger.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, test } from "vitest";

import type { AgentMessage } from "@botiverse/raft-shared";

import { elideSeenSendersInMessages, openSenderLedger, senderLedgerPath } from "./senderLedger";

let root = "";
let dbPath = "";

/** The CLI ledger's version-1 shape, as packages/cli/src/state/agentLedger.ts creates it. */
function createCliLedger(opts: { version?: string; withContextId?: boolean } = {}): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(opts.version ?? "1");
  db.exec(opts.withContextId === false
    ? "CREATE TABLE observations (type TEXT NOT NULL, id TEXT NOT NULL, rev TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (type, id))"
    : "CREATE TABLE observations (type TEXT NOT NULL, id TEXT NOT NULL, rev TEXT NOT NULL, context_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (type, id))");
  db.close();
}

function rows(): Array<{ type: string; id: string; rev: string; context_id: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT type, id, rev, context_id FROM observations ORDER BY id").all() as never;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-sender-ledger-"));
  dbPath = senderLedgerPath(root, "agent-1")!;
});

const message = (over: Partial<AgentMessage> = {}): AgentMessage => ({
  channel_id: "c1",
  channel_name: "general",
  channel_type: "channel",
  sender_id: "s1",
  sender_name: "Maggie",
  sender_description: "Writer. Long profile description.",
  sender_type: "agent",
  content: "hi",
  timestamp: "2026-10-08T00:00:00.000Z",
  ...over,
});

test("the ledger path matches the CLI's default layout and rejects unsafe ids", () => {
  assert.equal(senderLedgerPath("/r", "agent-1"), path.join("/r", "agent-state", "agent-1", "state.db"));
  assert.equal(senderLedgerPath("/r", "../x"), undefined);
});

test("a foreign writer never creates the ledger or writes to one it does not know", () => {
  assert.equal(openSenderLedger(dbPath, "ctx-A"), undefined);
  assert.equal(fs.existsSync(dbPath), false);
  createCliLedger({ version: "2" });
  assert.equal(openSenderLedger(dbPath, "ctx-A"), undefined);
  fs.rmSync(path.dirname(dbPath), { recursive: true });
  createCliLedger({ withContextId: false });
  assert.equal(openSenderLedger(dbPath, "ctx-A"), undefined);
});

test("claim is one-shot per (rev, context) and release removes only its own row", () => {
  createCliLedger();
  const a = openSenderLedger(dbPath, "ctx-A")!;
  assert.equal(a.claim("agent:Maggie", "r1"), true);
  assert.equal(a.claim("agent:Maggie", "r1"), false);
  a.close();
  // A CLI read in another context, then the daemon in this one again.
  const b = openSenderLedger(dbPath, "ctx-B")!;
  assert.equal(b.claim("agent:Maggie", "r1"), true);
  b.release([{ id: "agent:Maggie", rev: "r1" }]);
  b.close();
  assert.deepEqual(rows(), []);
});

test("elision follows render order: thread-join parent and replies before the message", () => {
  createCliLedger();
  const ledger = openSenderLedger(dbPath, "ctx-A")!;
  const input = [message({
    thread_join_context: {
      reason: "mentioned",
      parent_target: "#general",
      thread_target: "#general:aaaabbbb",
      suggested_read_history_target: "#general:aaaabbbb",
      parent_message: { message_id: "p", sender_name: "Maggie", sender_type: "agent", sender_description: "Writer. Long profile description.", content: "top", timestamp: "t" },
      recent_messages: [
        { message_id: "r1", sender_name: "cindyz", sender_type: "human", sender_description: "Founder", content: "a", timestamp: "t" },
        { message_id: "r2", sender_name: "Maggie", sender_type: "agent", sender_description: "Writer. Long profile description.", content: "b", timestamp: "t" },
      ],
      history_truncated: false,
    },
  }), message({ sender_name: "cindyz", sender_type: "human", sender_description: "Founder" })];
  const { messages, claimed } = elideSeenSendersInMessages(input, ledger.claim);
  const join = messages[0].thread_join_context!;
  assert.equal(join.parent_message.sender_description, "Writer. Long profile description.");
  assert.equal(join.recent_messages[0].sender_description, "Founder");
  assert.equal(join.recent_messages[1].sender_description, null);
  assert.equal(messages[0].sender_description, null);
  assert.equal(messages[1].sender_description, null);
  assert.deepEqual(claimed.map((c) => c.id), ["agent:Maggie", "human:cindyz"]);
  // The queued originals are untouched, so a failed write can re-render them in full.
  assert.equal(input[0].sender_description, "Writer. Long profile description.");
  assert.equal(input[0].thread_join_context!.recent_messages[1].sender_description, "Writer. Long profile description.");
  // A later delivery in the same context shows names only.
  const later = elideSeenSendersInMessages([message()], ledger.claim);
  assert.equal(later.messages[0].sender_description, null);
  ledger.close();
});

test("a ledger error answers 'show it in full'", () => {
  createCliLedger();
  const ledger = openSenderLedger(dbPath, "ctx-A")!;
  ledger.close();
  // Closed handle: every statement throws.
  assert.equal(ledger.claim("agent:Maggie", "r1"), true);
});

test("a write lock held by the agent's CLI never makes delivery wait: full description, nothing recorded", () => {
  createCliLedger();
  const cli = new DatabaseSync(dbPath);
  cli.exec("PRAGMA busy_timeout = 0");
  cli.exec("BEGIN IMMEDIATE");
  try {
    const started = performance.now();
    const ledger = openSenderLedger(dbPath, "ctx-A")!;
    const { messages } = elideSeenSendersInMessages([message(), message()], ledger.claim);
    ledger.close();
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 200, `delivery waited ${elapsedMs}ms on a held lock`);
    assert.equal(messages[0].sender_description, "Writer. Long profile description.");
  } finally {
    cli.exec("ROLLBACK");
    cli.close();
  }
  assert.deepEqual(rows(), []);
});

test("task #266: the time zone drops with the description on a sender's second appearance", () => {
  createCliLedger();
  const ledger = openSenderLedger(dbPath, "ctx-A")!;
  const human = (content: string) => message({ sender_name: "cindyz", sender_type: "human", sender_description: "Founder", sender_timezone: "Asia/Seoul", content });
  const { messages } = elideSeenSendersInMessages([human("a"), human("b")], ledger.claim);
  assert.equal(messages[0].sender_timezone, "Asia/Seoul");
  assert.equal(messages[0].sender_description, "Founder");
  assert.equal(messages[1].sender_timezone, null);
  assert.equal(messages[1].sender_description, null);
  // A zone-only sender (no description) is shown once too.
  const zoneOnly = (content: string) => message({ sender_name: "dozy", sender_type: "human", sender_description: null, sender_timezone: "Europe/Berlin", content });
  const second = elideSeenSendersInMessages([zoneOnly("c"), zoneOnly("d")], ledger.claim);
  assert.deepEqual(second.messages.map((m) => m.sender_timezone), ["Europe/Berlin", null]);
  ledger.close();
});

test("an outside sender's origin is printed every time; a description beside it still elides", () => {
  createCliLedger();
  const ledger = openSenderLedger(dbPath, "ctx-A")!;
  const outside = (id: string) => message({ message_id: id, sender_name: "Ada", sender_description: null, sender_origin: { kind: "other_server", server_slug: "acme" } });
  const { messages } = elideSeenSendersInMessages([outside("a"), message(), outside("b"), message()], ledger.claim);
  assert.deepEqual(messages.map((m) => m.sender_origin ?? null), [
    { kind: "other_server", server_slug: "acme" }, null, { kind: "other_server", server_slug: "acme" }, null,
  ]);
  assert.deepEqual(messages.map((m) => m.sender_description ?? null), [null, "Writer. Long profile description.", null, null]);
  ledger.close();
});
