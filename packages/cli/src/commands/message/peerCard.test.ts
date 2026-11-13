// The DM peer card (glimpse G1): the other side of a DM is the `sender`
// resource, so a read that already shows a message from them shows no card,
// and a send names the version its context has.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { peerCardRev, senderObservationId } from "@botiverse/raft-shared";
import { afterEach, beforeEach, test } from "vitest";

import { createCommandContext } from "../../core/context";
import { readObservation, recordObservation } from "../../state/agentLedger";
import { readPassiveRenderCountsForTest } from "../../state/passiveRenderCountsTestReader";
import { messageReadCommand } from "./read";
import { messageSendCommand } from "./send";

const AGENT = "agent-peer-card";
const ENV_KEYS = ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR", "SLOCK_CLI_TRANSPORT_DIR", "RAFT_HOME"] as const;
let prior: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let transportDir = "";

beforeEach(() => {
  prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-peer-card-"));
  transportDir = path.join(root, "transport");
  fs.mkdirSync(transportDir, { recursive: true, mode: 0o700 });
  for (const key of ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR"] as const) {
    process.env[key] = path.join(root, "state");
  }
  process.env.RAFT_HOME = root;
  process.env.SLOCK_CLI_TRANSPORT_DIR = transportDir;
  fs.writeFileSync(
    path.join(transportDir, "context-generation"),
    JSON.stringify({ contextId: "ctx-A", reason: "spawn", compactionReported: true, runtime: "claude", writtenAt: "t", passiveAx: true }),
    { mode: 0o600 },
  );
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

const richard = { kind: "human" as const, name: "richard", description: "Founder. Prefers short updates.", timezone: "Asia/Shanghai" };
const CARD = "DM peer @richard (human, Asia/Shanghai): Founder. Prefers short updates.\nEquivalent: raft user info @richard\n\n";
type Reply = { ok: boolean; status: number; error: string | null; data: unknown };

function harness(replies: Reply[], stdin: string[] = ["thanks\n"]) {
  const bodies: Array<Record<string, unknown>> = [];
  const stdout: string[] = [];
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(stdin),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({ agentId: AGENT, serverUrl: "http://stub.local", clientMode: "self-hosted-runner", profileSlug: "t", serverId: "s", token: "t" }) as never,
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

const history = (messages: unknown[]): Reply => ({
  ok: true, status: 200, error: null,
  data: { messages, has_more: false, has_older: false, has_newer: false, peer_card: richard },
});
const own = { seq: 1, id: "00000001-0000-0000-0000-000000000000", createdAt: "2026-10-15T00:00:00.000Z", senderType: "agent", senderName: "me", content: "ping" };
const fromPeer = { seq: 2, id: "00000002-0000-0000-0000-000000000000", createdAt: "2026-10-15T00:01:00.000Z", senderType: "human", senderName: "richard", senderDescription: richard.description, senderTimezone: richard.timezone, content: "pong" };

test("a DM read whose window has no message from the peer starts with their card, once", async () => {
  const first = harness([history([own])]);
  await messageReadCommand.handler(first.ctx, { target: "dm:@richard" });
  assert.ok(first.out().startsWith(CARD), first.out());
  assert.equal(readObservation(AGENT, "sender", senderObservationId("human", "richard"))?.rev, peerCardRev(richard));
  const second = harness([history([own])]);
  await messageReadCommand.handler(second.ctx, { target: "dm:@richard" });
  assert.ok(!second.out().includes("DM peer @richard"));
});

test("a message from the peer in the window carries the facts itself: no card", async () => {
  const run = harness([history([own, fromPeer])]);
  await messageReadCommand.handler(run.ctx, { target: "dm:@richard" });
  assert.ok(!run.out().includes("DM peer @richard"), run.out());
  assert.match(run.out(), /@richard \(Asia\/Shanghai\) — Founder\. Prefers short updates\./);
  // The message claimed the same ledger row, so a send now names that version.
  const send = harness([{ ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m-1" } }]);
  await messageSendCommand.handler(send.ctx, [], { target: "dm:@richard" });
  assert.deepEqual(send.bodies[0]!.seenCards, { peer: peerCardRev(richard) });
});

test("a send to a peer this context never saw is held once with their card", async () => {
  const run = harness([{
    ok: true, status: 200, error: null,
    data: { ok: true, state: "held", holdReasons: ["peer_card"], newMessageCount: 0, heldMessages: [], peerCard: richard },
  }]);
  await assert.rejects(async () => { await messageSendCommand.handler(run.ctx, [], { target: "dm:@richard" }); }, { code: "SEND_HELD_AS_DRAFT" });
  assert.deepEqual(run.bodies[0]!.seenCards, { peer: null });
  assert.ok(run.out().startsWith("Held — @richard's profile is not in your current context yet."), run.out());
  assert.match(run.out(), /\nDM peer @richard \(human, Asia\/Shanghai\): Founder\. Prefers short updates\.\nEquivalent: raft user info @richard\n/);
  assert.equal(readObservation(AGENT, "sender", senderObservationId("human", "richard"))?.rev, peerCardRev(richard));
});

test("a kind-suffixed target looks up that kind only; any version this context has counts as seen", async () => {
  recordObservation(AGENT, "sender", senderObservationId("agent", "richard"), "older", "ctx-A");
  const run = harness([{ ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m-2" } }]);
  await messageSendCommand.handler(run.ctx, [], { target: "dm:@richard~agent" });
  assert.deepEqual(run.bodies[0]!.seenCards, { peer: "older" });
  assert.ok(!run.out().includes("DM peer"));
});

test("a peer message that shows nothing about them (no description, no zone) does not count: the card comes", async () => {
  const bare = { ...fromPeer, senderDescription: null, senderTimezone: null };
  const run = harness([history([bare])]);
  await messageReadCommand.handler(run.ctx, { target: "dm:@richard" });
  assert.ok(run.out().startsWith(CARD), run.out());
});

test("a held send to a renamed peer through a thread is recorded under the name the target used too", async () => {
  const renamed = { ...richard, name: "rich" };
  const first = harness([{
    ok: true, status: 200, error: null,
    data: { ok: true, state: "held", holdReasons: ["peer_card"], newMessageCount: 0, heldMessages: [], peerCard: renamed },
  }]);
  await assert.rejects(async () => { await messageSendCommand.handler(first.ctx, [], { target: "dm:@richard:1a2b3c4d" }); }, { code: "SEND_HELD_AS_DRAFT" });
  assert.ok(first.out().startsWith("Held — @rich's profile is not in your current context yet."), first.out());
  const again = harness([{ ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m-3" } }], []);
  await messageSendCommand.handler(again.ctx, [], { target: "dm:@richard:1a2b3c4d", sendDraft: true });
  assert.deepEqual(again.bodies[0]!.seenCards, { peer: peerCardRev(renamed) });
});

test("a card that only reached JSON output is recorded, so JSON-mode sends are held once too", async () => {
  const run = harness([{
    ok: true, status: 200, error: null,
    data: { ok: true, state: "held", holdReasons: ["peer_card"], newMessageCount: 0, heldMessages: [], peerCard: richard },
  }]);
  await assert.rejects(async () => { await messageSendCommand.handler(run.ctx, [], { target: "dm:@richard", json: true }); }, { code: "SEND_HELD_AS_DRAFT" });
  assert.equal(readObservation(AGENT, "sender", senderObservationId("human", "richard"))?.rev, peerCardRev(richard));
});

test("the peer card on read and in a send's reply is counted for the daemon's turn report", async () => {
  const read = harness([history([own])]);
  await messageReadCommand.handler(read.ctx, { target: "dm:@richard" });
  assert.ok(read.out().startsWith(CARD), read.out());
  const send = harness([{ ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m-1", peerCard: richard } }]);
  await messageSendCommand.handler(send.ctx, [], { target: "dm:@richard" });
  const replyCard = "\nDM peer @richard (human, Asia/Shanghai): Founder. Prefers short updates.\nEquivalent: raft user info @richard\n";
  assert.ok(send.out().endsWith(replyCard), send.out());
  assert.deepEqual(readPassiveRenderCountsForTest(AGENT), [
    { contextId: "ctx-A", kind: "peer_card", renders: 2, chars: CARD.length + replyCard.length, bytes: CARD.length + replyCard.length },
  ]);
});
