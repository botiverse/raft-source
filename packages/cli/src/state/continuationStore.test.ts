// The agent ledger as a ContinuationStore: the shared store contract, the
// ledger's own rules (additive tables, failures that throw), and the owner
// boundary between two agents on one machine.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  defineCommand,
  resume,
  start,
  type ContinuationOutcome,
  type ResumeOutcome,
} from "@botiverse/raft-shared/src/continuations/index";
import { continuationStoreContract, sampleContinuationRecord } from "@botiverse/raft-shared/src/continuations/store.testkit";

import { readDraftEntry, readMeta, resolveStateDbPath, writeDraftEntry } from "./agentLedger";
import { createCliContinuationStore } from "./continuationStore";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-continuation-store-"));
const env: NodeJS.ProcessEnv = { SLOCK_CLI_STATE_DIR: path.join(root, "state"), RAFT_HOME: path.join(root, "home") };
let agents = 0;
const freshAgent = () => `agent-continuations-${++agents}`;

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

continuationStoreContract("agent ledger", () => createCliContinuationStore(freshAgent(), env));

test("the continuation tables are additive: the ledger stays at version 1 and its other books are untouched", () => {
  const agentId = freshAgent();
  writeDraftEntry(agentId, "#ops", { content: "held text", attachmentIds: [], savedAt: 5, reholdCount: 1 }, env);
  const store = createCliContinuationStore(agentId, env);
  assert.equal(store.put(sampleContinuationRecord()), true);

  assert.equal(readMeta(agentId, "version", env), "1");
  assert.equal(readDraftEntry(agentId, "#ops", env)?.content, "held text");
  const db = new DatabaseSync(resolveStateDbPath(agentId, env), { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'continuation%' ORDER BY name").all();
    assert.deepEqual(tables.map((row) => (row as { name: string }).name), ["continuation_tombstones", "continuations"]);
  } finally {
    db.close();
  }
});

test("a ledger the store cannot use throws instead of answering that nothing is stored", () => {
  const agentId = freshAgent();
  const store = createCliContinuationStore(agentId, env);
  const record = sampleContinuationRecord();
  store.put(record);
  // A newer CLI's ledger: neither read nor written by this one.
  const db = new DatabaseSync(resolveStateDbPath(agentId, env));
  db.prepare("UPDATE meta SET value = '99' WHERE key = 'version'").run();
  db.close();

  assert.throws(() => store.get(record.id), /newer raft CLI/);
  assert.throws(() => store.put(sampleContinuationRecord({ id: record.id })), /newer raft CLI/);
  assert.throws(() => store.deleteExpired(Date.now()), /newer raft CLI/);
});

type Args = { target: string };
const confirm = defineCommand<Args, string>("demo confirm", async (ctx, args) => {
  const answer = await ctx.ask("go", { question: `Post to ${args.target}?`, options: { y: "Yes", n: "No" } });
  return answer.choice === "y" ? "posted" : "cancelled";
});
const program = { name: "raft", version: "0.0.0-test" };

function pausedIdOf(outcome: ContinuationOutcome<string>) {
  assert.equal(outcome.kind, "paused");
  return outcome.kind === "paused" ? outcome.continuation.id : assert.fail("not paused");
}

const errorCode = (outcome: ResumeOutcome) => (outcome.kind === "error" ? outcome.error.code : outcome.kind);

test("another agent on the same machine cannot answer a continuation: its ledger has none, and a shared store refuses it", async () => {
  const agentA = freshAgent();
  const agentB = freshAgent();
  const ledgerA = createCliContinuationStore(agentA, env);
  const ledgerB = createCliContinuationStore(agentB, env);
  const id = pausedIdOf(await start(confirm, { store: ledgerA, ownerAgentId: agentA, program, args: { target: "#ops" } }));

  // B's CLI opens B's ledger: there is no such continuation there.
  assert.equal(errorCode(await resume(id, { choice: "y" }, { store: ledgerB, ownerAgentId: agentB, program, commands: [confirm] })), "UNKNOWN");
  // Even reading A's ledger, B is refused by the owner the record carries, and A's answer still stands open.
  assert.equal(errorCode(await resume(id, { choice: "y" }, { store: ledgerA, ownerAgentId: agentB, program, commands: [confirm] })), "NOT_YOURS");
  assert.equal(ledgerA.get(id)?.status, "pending");
  assert.deepEqual(await resume(id, { choice: "y" }, { store: ledgerA, ownerAgentId: agentA, program, commands: [confirm] }), { kind: "done", result: "posted" });
});
