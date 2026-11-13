// Attached on every send (glimpse G1-13): a runtime that does not report
// compaction gets the conversation's cards and latest messages after every
// send, without moving its read position.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, test } from "vitest";

import { createCommandContext } from "../../core/context";
import { readPassiveRenderCountsForTest } from "../../state/passiveRenderCountsTestReader";
import { messageSendCommand } from "./send";

const AGENT = "agent-send-attachment";
const ENV_KEYS = ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR", "SLOCK_CLI_TRANSPORT_DIR", "RAFT_HOME"] as const;
let prior: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let transportDir = "";

beforeEach(() => {
  prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-send-attachment-"));
  transportDir = path.join(root, "transport");
  fs.mkdirSync(transportDir, { recursive: true, mode: 0o700 });
  for (const key of ["SLOCK_CLI_STATE_DIR", "SLOCK_CLI_CONSUMED_SEQ_STATE_DIR", "SLOCK_CLI_DRAFT_STATE_DIR"] as const) {
    process.env[key] = path.join(root, "state");
  }
  process.env.RAFT_HOME = root;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

function context(opts: { passiveAx?: boolean; compactionReported?: boolean }): void {
  process.env.SLOCK_CLI_TRANSPORT_DIR = transportDir;
  fs.writeFileSync(
    path.join(transportDir, "context-generation"),
    JSON.stringify({ contextId: "ctx-A", reason: "spawn", compactionReported: opts.compactionReported ?? false, runtime: "gemini", writtenAt: "t", passiveAx: opts.passiveAx ?? true }),
    { mode: 0o600 },
  );
}

type Reply = { ok: boolean; status: number; error: string | null; data: unknown } | Error;

function harness(replies: Reply[]) {
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const stdout: string[] = [];
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["shipping now\n"]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({ agentId: AGENT, serverUrl: "http://stub.local", clientMode: "self-hosted-runner", profileSlug: "t" }) as never,
    createApiClient: () => ({
      request: async (method: string, requestPath: string, body?: Record<string, unknown>) => {
        requests.push({ method, path: requestPath, body });
        const reply = replies.shift();
        if (!reply) throw new Error("missing test response");
        if (reply instanceof Error) throw reply;
        return reply;
      },
    }) as never,
  });
  return { ctx, requests, out: () => stdout.join("") };
}

const sent: Reply = { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m-9", messageSeq: 42 } };
const history: Reply = {
  ok: true, status: 200, error: null,
  data: {
    messages: [
      { seq: 40, sender_name: "richard", timestamp: "2026-10-15T09:00:00.000Z", content: "deploy at 5?" },
      { seq: 41, sender_name: "scout", timestamp: "2026-10-15T09:02:00.000Z", content: "canary is green" },
    ],
    has_more: false, has_older: false, has_newer: false,
    channel_card: { id: "c-ops", name: "ops", type: "channel", description: "Release coordination." },
  },
};

test("a runtime that does not report compaction gets the cards and latest messages after every send", async () => {
  context({});
  const run = harness([sent, history]);
  await messageSendCommand.handler(run.ctx, [], { target: "#ops" });
  assert.equal(run.requests.length, 2);
  const read = run.requests[1]!;
  assert.equal(read.method, "GET");
  assert.match(read.path, /consume=false/);
  assert.match(read.path, /before=m-9/);
  assert.match(read.path, /limit=3/);
  assert.match(run.out(), /Message sent to #ops\. Message ID: m-9.*\n\nNot part of your message: the latest in #ops before it \(shown after every send because this runtime does not report context compaction\):\nChannel #ops \(public\): Release coordination\.\nEquivalent: raft channel info "#ops"\n  ├ Latest 2 ─+\n  │ @richard 09:00  deploy at 5\?\n  │ @scout 09:02  canary is green\n  └ ─{40}\n$/s);
  // Counted for the daemon's turn report: the attachment as printed, from its leading blank line.
  const attached = run.out().slice(run.out().indexOf("\nNot part of your message"));
  assert.deepEqual(readPassiveRenderCountsForTest(AGENT), [
    { contextId: "ctx-A", kind: "send_attachment", renders: 1, chars: Array.from(attached).length, bytes: Buffer.byteLength(attached, "utf8") },
  ]);
});

test("no attachment for a runtime that reports compaction, with passive AX off, or when the read fails", async () => {
  for (const opts of [{ compactionReported: true }, { passiveAx: false }]) {
    context(opts);
    const run = harness([sent]);
    await messageSendCommand.handler(run.ctx, [], { target: "#ops" });
    assert.equal(run.requests.length, 1, JSON.stringify(opts));
    assert.ok(!run.out().includes("Not part of your message"));
  }
  context({});
  const failing = harness([sent, new Error("network down")]);
  await messageSendCommand.handler(failing.ctx, [], { target: "#ops" });
  assert.match(failing.out(), /Message sent to #ops/);
  assert.ok(!failing.out().includes("Not part of your message"));
});

test("a DM send shows the peer's card and the latest messages", async () => {
  context({});
  const dmHistory: Reply = {
    ok: true, status: 200, error: null,
    data: {
      messages: [{ seq: 7, sender_name: "richard", timestamp: "2026-10-15T09:00:00.000Z", content: "ping" }],
      has_more: false, has_older: false, has_newer: false,
      peer_card: { kind: "human", name: "richard", description: "Founder.", timezone: "Asia/Shanghai" },
    },
  };
  const run = harness([{ ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m-10", messageSeq: 8 } }, dmHistory]);
  await messageSendCommand.handler(run.ctx, [], { target: "dm:@richard" });
  assert.match(run.out(), /\nNot part of your message: the latest in dm:@richard before it .*\nDM peer @richard \(human, Asia\/Shanghai\): Founder\.\nEquivalent: raft user info @richard\n  ├ Latest 1 /s);
});
