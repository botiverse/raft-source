import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  classifyCandidate,
  parseArgs,
  type EmptyThreadCandidate,
} from "../../scripts/cleanup-empty-thread-channels.js";

const cleanupSource = readFileSync(
  fileURLToPath(new URL("../../scripts/cleanup-empty-thread-channels.ts", import.meta.url)),
  "utf8",
);

const emptyCandidate: EmptyThreadCandidate = {
  threadChannelId: "00000000-0000-4000-8000-000000000001",
  serverId: "00000000-0000-4000-8000-000000000002",
  parentMessageId: "00000000-0000-4000-8000-000000000003",
  createdAt: "2026-07-23T00:00:00.000Z",
  replyCount: 0,
  parentPointerCount: 1,
  otherPointerCount: 0,
};

test("empty-thread cleanup defaults to dry-run and apply requires the exact confirmation token", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "dry-run",
    serverId: null,
    limit: null,
    confirm: null,
    json: false,
  });
  assert.throws(() => parseArgs(["--apply"]), /requires --confirm task180-empty-thread-cleanup/);
  assert.equal(parseArgs(["--apply", "--confirm", "task180-empty-thread-cleanup"]).mode, "apply");
});

test("a zero-reply thread with only its exact parent anchor is deletable", () => {
  assert.deepEqual(classifyCandidate(emptyCandidate, []), {
    ...emptyCandidate,
    disposition: "delete",
    reasons: [],
    foreignKeyRefs: [],
  });
});

test("a durable foreign-key reference alone quarantines instead of cascading", () => {
  const decision = classifyCandidate(
    emptyCandidate,
    [{ table: "public.thread_follows", column: "thread_channel_id", count: 1 }],
  );
  assert.equal(decision.disposition, "quarantine");
  assert.deepEqual(decision.reasons, ["durable_foreign_key_reference"]);
});

test("an unexpected messages.thread_id pointer quarantines the channel", () => {
  const decision = classifyCandidate({ ...emptyCandidate, otherPointerCount: 1 }, []);
  assert.equal(decision.disposition, "quarantine");
  assert.deepEqual(decision.reasons, ["unexpected_thread_pointer"]);
});

test("reply-bearing channels can never enter the destructive disposition", () => {
  const decision = classifyCandidate({ ...emptyCandidate, replyCount: 1 }, []);
  assert.equal(decision.disposition, "quarantine");
  assert.deepEqual(decision.reasons, ["has_reply_messages"]);
});

test("apply minimizes and bounds the message-write lock window before reinspection", () => {
  const discovery = cleanupSource.indexOf("const initial = await discoverCandidates(client, options);");
  const lock = cleanupSource.indexOf('await client.query("LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE");');
  const reinspection = cleanupSource.indexOf("const decisions = await inspect(");
  assert.ok(discovery >= 0 && lock > discovery && reinspection > lock);
  assert.match(cleanupSource, /SET LOCAL lock_timeout = '5s'/);
  assert.match(cleanupSource, /SET LOCAL statement_timeout = '5min'/);
});
