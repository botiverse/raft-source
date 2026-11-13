// The channel card on `message send` (passive resource "channel"; glimpse
// G1, design A agreed in #wg-ax): a send names the card version its model
// context has; the Server holds a send whose context never saw the card, and
// returns a changed card with the reply.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { channelCardRev } from "@botiverse/raft-shared";
import { afterEach, beforeEach, test } from "vitest";

import { createCommandContext } from "../../core/context";
import { readObservation, recordObservation, resolveStateDbPath } from "../../state/agentLedger";
import { readPassiveRenderCountsForTest } from "../../state/passiveRenderCountsTestReader";
import { messageSendCommand } from "./send";
import { DatabaseSync } from "node:sqlite";

const AGENT = "agent-send-card";
const ENV_KEYS = ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR", "SLOCK_CLI_TRANSPORT_DIR", "RAFT_HOME"] as const;
let prior: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let transportDir = "";

beforeEach(() => {
  prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-send-card-"));
  transportDir = path.join(root, "transport");
  fs.mkdirSync(transportDir, { recursive: true, mode: 0o700 });
  for (const key of ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR"] as const) {
    process.env[key] = path.join(root, "state");
  }
  process.env.RAFT_HOME = root;
  delete process.env.SLOCK_CLI_TRANSPORT_DIR;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

function context(contextId: string, opts: { passiveAx?: boolean; compactionReported?: boolean } = {}): void {
  process.env.SLOCK_CLI_TRANSPORT_DIR = transportDir;
  fs.writeFileSync(
    path.join(transportDir, "context-generation"),
    JSON.stringify({ contextId, reason: "spawn", compactionReported: opts.compactionReported ?? true, runtime: "claude", writtenAt: "t", passiveAx: opts.passiveAx ?? true }),
    { mode: 0o600 },
  );
}

const card = { id: "c-ops", name: "ops", type: "channel", description: "Release coordination. Post go/no-go here." };

type Reply = { ok: boolean; status: number; error: string | null; data: unknown };

function harness(replies: Reply[], stdin: string[] = ["go for 5pm\n"]) {
  const bodies: Array<Record<string, unknown>> = [];
  const stdout: string[] = [];
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(stdin),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({ agentId: AGENT, serverUrl: "http://stub.local", clientMode: "self-hosted-runner", profileSlug: "t" }) as never,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: Record<string, unknown>) => {
        bodies.push(body ?? {});
        const reply = replies.shift();
        if (!reply) throw new Error("missing test response");
        return reply;
      },
    }) as never,
  });
  return { ctx, bodies, out: () => stdout.join("") };
}

const sent = (extra: Record<string, unknown> = {}): Reply => ({ ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m-1", ...extra } });

test("a context that never saw the card is held once with it; the unchanged draft then goes through", async () => {
  context("ctx-A");
  const first = harness([{
    ok: true,
    status: 200,
    error: null,
    data: { ok: true, state: "held", holdReasons: ["channel_card"], newMessageCount: 0, heldMessages: [], channelCard: card },
  }]);
  await assert.rejects(async () => { await messageSendCommand.handler(first.ctx, [], { target: "#ops:1a2b3c4d" }); }, { code: "SEND_HELD_AS_DRAFT" });
  assert.deepEqual(first.bodies[0]!.seenCards, { channel: null });
  const held = first.out();
  assert.ok(held.startsWith("Held — the description of #ops is not in your current context yet. Your message has been saved as a draft"), held);
  assert.match(held, /\nChannel #ops \(public\): Release coordination\. Post go\/no-go here\.\nEquivalent: raft channel info "#ops"\n\nAfter reading it, choose one path\.\n/);
  assert.match(held, /raft message send --send-draft --target "#ops:1a2b3c4d"/);
  assert.equal(readObservation(AGENT, "channel", "#ops")?.rev, channelCardRev(card));

  const again = harness([sent()], []);
  await messageSendCommand.handler(again.ctx, [], { target: "#ops:1a2b3c4d", sendDraft: true });
  assert.deepEqual(again.bodies[0]!.seenCards, { channel: channelCardRev(card) });
  assert.ok(!again.out().includes("Channel #ops"));
});

test("a changed card comes back with the reply and is recorded", async () => {
  context("ctx-A");
  recordObservation(AGENT, "channel", "#ops", "v1:older", "ctx-A");
  const run = harness([sent({ channelCard: card, channelCardChanged: true })]);
  await messageSendCommand.handler(run.ctx, [], { target: "#ops" });
  assert.deepEqual(run.bodies[0]!.seenCards, { channel: "v1:older" });
  assert.match(run.out(), /Message sent to #ops\. Message ID: m-1.*\n\nChannel #ops \(public\), changed since you last saw it: Release coordination\. Post go\/no-go here\.\nEquivalent: raft channel info "#ops"\n$/s);
  assert.equal(readObservation(AGENT, "channel", "#ops")?.rev, channelCardRev(card));
});

test("an older context's record counts as not seen", async () => {
  context("ctx-B");
  recordObservation(AGENT, "channel", "#ops", channelCardRev(card), "ctx-A");
  const run = harness([sent()]);
  await messageSendCommand.handler(run.ctx, [], { target: "#ops" });
  assert.deepEqual(run.bodies[0]!.seenCards, { channel: null });
});

test("no channel card check: passive AX off, a runtime without compaction reports, a DM, or a ledger that cannot record", async () => {
  for (const [setup, target] of [
    [() => context("ctx-A", { passiveAx: false }), "#ops"],
    [() => context("ctx-A", { compactionReported: false }), "#ops"],
  ] as const) {
    setup();
    const run = harness([sent()]);
    await messageSendCommand.handler(run.ctx, [], { target });
    assert.equal(Object.hasOwn(run.bodies[0]!, "seenCards"), false, target);
  }
  // A DM has no channel card (its peer card is checked instead).
  context("ctx-A");
  const dm = harness([sent()]);
  await messageSendCommand.handler(dm.ctx, [], { target: "dm:@richard" });
  assert.equal(Object.hasOwn(dm.bodies[0]!.seenCards as object, "channel"), false);
  // A ledger that cannot be written: a hold for the card could never be
  // released, so the send says nothing about it.
  context("ctx-A");
  recordObservation(AGENT, "channel", "#other", "v1:x", "ctx-A");
  const dbPath = resolveStateDbPath(AGENT);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE");
  db.close();
  fs.chmodSync(dbPath, 0o400);
  try {
    const run = harness([sent()]);
    await messageSendCommand.handler(run.ctx, [], { target: "#ops" });
    assert.equal(Object.hasOwn(run.bodies[0]!, "seenCards"), false);
  } finally {
    fs.chmodSync(dbPath, 0o600);
  }
});

const cardHold = (extra: Record<string, unknown> = {}): Reply => ({
  ok: true,
  status: 200,
  error: null,
  data: { ok: true, state: "held", holdReasons: ["channel_card"], newMessageCount: 0, heldMessages: [], channelCard: card, ...extra },
});

test("a target that spells the channel differently is recorded under that spelling too, so it is held only once", async () => {
  context("ctx-A");
  // A thread short id resolves whatever channel part it carries.
  const first = harness([cardHold()]);
  await assert.rejects(async () => { await messageSendCommand.handler(first.ctx, [], { target: "#Ops:1a2b3c4d" }); }, { code: "SEND_HELD_AS_DRAFT" });
  assert.equal(readObservation(AGENT, "channel", "#ops")?.rev, channelCardRev(card));
  assert.equal(readObservation(AGENT, "channel", "#Ops")?.rev, channelCardRev(card));
  const again = harness([sent()], []);
  await messageSendCommand.handler(again.ctx, [], { target: "#Ops:1a2b3c4d", sendDraft: true });
  assert.deepEqual(again.bodies[0]!.seenCards, { channel: channelCardRev(card) });
});

test("unread messages and an unseen card come in one hold, card first", async () => {
  context("ctx-A");
  const run = harness([{
    ok: true,
    status: 200,
    error: null,
    data: {
      ok: true,
      state: "held",
      holdReasons: ["unread_messages", "channel_card"],
      newMessageCount: 1,
      shownMessageCount: 1,
      seenUpToSeq: 41,
      heldMessages: [{ seq: 41, sender_name: "richard", timestamp: "2026-10-15T09:00:00.000Z", content: "deploy at 5?" }],
      channelCard: card,
    },
  }]);
  await assert.rejects(async () => { await messageSendCommand.handler(run.ctx, [], { target: "#ops" }); }, { code: "SEND_HELD_AS_DRAFT" });
  const out = run.out();
  assert.ok(out.startsWith("Held — 1 unread message in #ops."), out);
  assert.ok(out.indexOf("Channel #ops (public): Release") < out.indexOf("@richard 09:00  deploy at 5?"), out);
  assert.equal(readObservation(AGENT, "channel", "#ops")?.rev, channelCardRev(card));
  // A hold for unread messages counts as a freshness hold, card included.
  assert.deepEqual(readPassiveRenderCountsForTest(AGENT).map(({ kind, renders }) => ({ kind, renders })), [{ kind: "freshness_hold", renders: 1 }]);
});

test("a card that only reached JSON output is recorded, so a JSON-mode send is held once, not forever", async () => {
  context("ctx-A");
  const run = harness([cardHold()]);
  await assert.rejects(async () => { await messageSendCommand.handler(run.ctx, [], { target: "#ops", json: true }); }, { code: "SEND_HELD_AS_DRAFT" });
  assert.equal(readObservation(AGENT, "channel", "#ops")?.rev, channelCardRev(card));
});

test("the hold and a card in the reply are counted for the daemon's turn report", async () => {
  context("ctx-A");
  const first = harness([{
    ok: true,
    status: 200,
    error: null,
    data: { ok: true, state: "held", holdReasons: ["channel_card"], newMessageCount: 0, heldMessages: [], channelCard: card },
  }]);
  await assert.rejects(async () => { await messageSendCommand.handler(first.ctx, [], { target: "#ops" }); }, { code: "SEND_HELD_AS_DRAFT" });
  const held = first.out();
  recordObservation(AGENT, "channel", "#ops", "v1:older", "ctx-A");
  const run = harness([sent({ channelCard: card, channelCardChanged: true })]);
  await messageSendCommand.handler(run.ctx, [], { target: "#ops" });
  const cardText = "\nChannel #ops (public), changed since you last saw it: Release coordination. Post go/no-go here.\nEquivalent: raft channel info \"#ops\"\n";
  assert.ok(run.out().endsWith(cardText), run.out());
  assert.deepEqual(readPassiveRenderCountsForTest(AGENT), [
    { contextId: "ctx-A", kind: "card_hold", renders: 1, chars: Array.from(held).length, bytes: Buffer.byteLength(held, "utf8") },
    { contextId: "ctx-A", kind: "channel_card", renders: 1, chars: cardText.length, bytes: cardText.length },
  ]);
});
