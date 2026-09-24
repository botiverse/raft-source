import assert from "node:assert/strict";
import test from "node:test";
import { extractRaftMentionHandles } from "@botiverse/raft-shared";

import {
  formatMentionActionResults,
  formatMentionNotifyRecoveryCommand,
  formatPendingMentionActions,
  normalizeMentionActionResults,
  normalizePendingMentionActions,
  normalizeUnresolvedMentionHandles,
} from "./_format.js";

const ACTION_A = "11111111-1111-4111-8111-111111111111";
const ACTION_B = "22222222-2222-4222-8222-222222222222";

function assertSenderPartialEnvelope(
  output: string,
  actionIds: string[],
): void {
  assert.ok(output.startsWith("Undelivered mentions — partial result\n"), "partial warning must lead");
  assert.match(output, /Message effect: status=queued/);
  assert.doesNotMatch(output, /Message effect: status=(?:delivered|acked|seen|read)/);
  assert.match(output, /Do not rerun `raft message send`/);
  assert.equal(output.match(/ — status=not_queued/g)?.length, actionIds.length);
  for (const actionId of actionIds) {
    assert.match(output, new RegExp(`pending action: ${actionId}`));
    assert.match(output, new RegExp(`recovery: raft mention notify ${actionId}(?:\\n|$)`));
  }
  assert.doesNotMatch(output, /recovery: .*raft message send/);
}

function assertSenderReferents(
  output: string,
  rows: Array<{ authoredToken: string; actionId: string }>,
): void {
  let cursor = 0;
  for (const row of rows) {
    const rowHeader = `- ${row.authoredToken} — status=not_queued`;
    const rowStart = output.indexOf(rowHeader, cursor);
    assert.ok(rowStart >= cursor, `missing referent-bound row for ${row.authoredToken}`);
    const nextRow = output.indexOf("\n- @", rowStart + rowHeader.length);
    const rowOutput = output.slice(rowStart, nextRow === -1 ? output.length : nextRow);
    assert.match(rowOutput, /reason: not_in_conversation/);
    assert.match(rowOutput, /consequence: This @mention did not notify anyone\./);
    cursor = rowStart + rowHeader.length;
  }
}

function assertSenderPartialContract(
  output: string,
  rows: Array<{ authoredToken: string; actionId: string }>,
): void {
  assertSenderPartialEnvelope(output, rows.map((row) => row.actionId));
  assertSenderReferents(output, rows);
}

test("send mention partial result is referent-bound, privacy-safe, and copyable", () => {
  const out = formatPendingMentionActions([
    {
      resolutionId: "f00dbabe-0000-4000-8000-000000000001",
      messageId: "msg-1",
      targetType: "agent",
      targetHandle: "Noel",
      reason: "Target is not in #proj-aiax and was not notified.",
      availableActions: ["notify", "add"],
      expiresAt: "2026-06-12T00:00:00.000Z",
    },
  ], { source: "send" });

  assert.match(out, /^Undelivered mentions/);
  assert.match(out, /Message effect: status=queued/);
  assert.match(out, /Do not rerun `raft message send`/);
  assert.match(out, /literal name.*inline or fenced code/);
  assert.match(out, /@Noel — status=not_queued/);
  assert.match(out, /reason: not_in_conversation/);
  assert.match(out, /consequence: This @mention did not notify anyone\./);
  assert.match(out, /pending action: f00dbabe-0000-4000-8000-000000000001/);
  assert.match(out, /expires: 2026-06-12T00:00:00\.000Z/);
  assert.match(out, /recovery: raft mention notify f00dbabe-0000-4000-8000-000000000001/);
  assert.doesNotMatch(out, /Target is not in #proj-aiax/);
  assert.match(out, /does not prove the person left the server/);
  assert.match(out, /notify exits nonzero unless the target queue accepts/);
  assert.doesNotMatch(out, /raft mention notify @Noel/);
  assert.doesNotMatch(out, /raft mention add/);
});

test("send mention partial result keeps every token bound to its own action", () => {
  const fixture = {
    content: "Please loop in @xxchan and @Noel.",
    conversationMembers: ["sender", "Noel"],
    outsider: { handle: "xxchan", displayName: "我是笑笑" },
  };
  const tokenStart = fixture.content.indexOf("@xxchan");
  const authoredXxchan = fixture.content.slice(tokenStart, fixture.content.indexOf(" and", tokenStart));
  assert.equal(fixture.conversationMembers.includes(fixture.outsider.handle), false);

  const out = formatPendingMentionActions([
    {
      resolutionId: ACTION_A,
      messageId: "msg-1",
      targetType: "agent",
      targetHandle: fixture.outsider.handle,
      reason: "not_member",
      availableActions: ["notify"],
      expiresAt: "2026-06-12T00:00:00.000Z",
    },
    {
      resolutionId: ACTION_B,
      messageId: "msg-1",
      targetType: "user",
      targetHandle: "Noel",
      reason: "target_missing",
      availableActions: ["notify", "add"],
      expiresAt: "2026-06-13T00:00:00.000Z",
    },
  ], { source: "send" });

  assertSenderPartialContract(out, [
    { authoredToken: authoredXxchan, actionId: ACTION_A },
    { authoredToken: "@Noel", actionId: ACTION_B },
  ]);
  const renderedXxchan = out.match(/^- (@[^ ]+) — status=not_queued/m)?.[1];
  assert.ok(renderedXxchan);
  assert.equal(Buffer.from(renderedXxchan).equals(Buffer.from(authoredXxchan)), true, "rendered token bytes must equal the authored substring");
  assert.doesNotMatch(out, new RegExp(fixture.outsider.displayName));
  assert.equal(out.match(/reason: not_in_conversation/g)?.length, 2);
  assert.equal(out.match(/consequence: This @mention did not notify anyone\./g)?.length, 2);
  assert.doesNotMatch(out, /not_member|target_missing/);
});

test("send mention partial result warns when an authored token resolved to no visible target", () => {
  const out = formatPendingMentionActions([], {
    source: "send",
    unresolvedMentionHandles: ["@wenyi"],
  });

  assert.match(out, /^Undelivered mentions/);
  assert.match(out, /Message effect: status=queued/);
  assert.match(out, /@wenyi — status=not_queued/);
  assert.match(out, /reason: unknown_or_not_visible/);
  assert.match(out, /consequence: This @mention did not notify anyone\./);
  assert.match(out, /pending action: none; no visible target resolved/);
  assert.match(out, /literal name or prose/);
  assert.match(out, /verify the exact handle and send only a corrected follow-up mention/);
  assert.match(out, /do not resend this message/);
  assert.doesNotMatch(out, /raft mention notify|pending action: [0-9a-f-]{36}/);
});

test("send partial contract rejects ordering, referent, proof, retry, and shell mutants", () => {
  const baseline = formatPendingMentionActions([{
    resolutionId: ACTION_A,
    messageId: "msg-1",
    targetType: "agent",
    targetHandle: "xxchan",
    reason: "not_member",
    availableActions: ["notify"],
  }], { source: "send" });
  const expected = [{ authoredToken: "@xxchan", actionId: ACTION_A }];
  assert.doesNotThrow(() => assertSenderPartialContract(baseline, expected));
  assert.throws(
    () => assertSenderPartialContract(`Message queued to #room.\n${baseline}`, expected),
    /partial warning must lead/,
  );
  const genericReferentMutant = baseline.replace(
    "- @xxchan — status=not_queued",
    "- 1 @mention was not delivered — status=not_queued",
  );
  assert.doesNotThrow(() => assertSenderPartialEnvelope(genericReferentMutant, [ACTION_A]));
  assert.throws(
    () => assertSenderReferents(genericReferentMutant, expected),
    /referent-bound row/,
  );
  assert.throws(
    () => assertSenderPartialContract(baseline.replace("Message effect: status=queued", "Message effect: status=delivered"), expected),
    /status=queued/,
  );
  assert.throws(
    () => assertSenderPartialContract(baseline.replace(`raft mention notify ${ACTION_A}`, "raft message send --target #room"), expected),
    /recovery/,
  );
  for (const unsafe of ["<id>", `${ACTION_A};echo`, `${ACTION_A}\necho injected`]) {
    assert.equal(formatMentionNotifyRecoveryCommand(unsafe), null);
  }
  assert.equal(formatMentionNotifyRecoveryCommand(ACTION_A), `raft mention notify ${ACTION_A}`);
  assert.equal(formatMentionNotifyRecoveryCommand(ACTION_A)?.includes("\n"), false);

  const malformed = formatPendingMentionActions([{
    resolutionId: `${ACTION_A}\necho injected`,
    messageId: "msg-1",
    targetType: "agent",
    targetHandle: "xxchan",
    reason: "not_member",
    availableActions: ["notify"],
  }], { source: "send" });
  assert.match(malformed, /pending action: \[invalid pending action id\]/);
  assert.match(malformed, /recovery: unavailable because the pending action id is invalid/);
  assert.doesNotMatch(malformed, /echo injected/);
});

test("mention parser keeps the current NFC/NFD boundary explicit", () => {
  assert.deepEqual(extractRaftMentionHandles("notify @é"), ["é"]);
  assert.deepEqual(extractRaftMentionHandles("notify @e\u0301"), ["e"]);
});

test("sender formatter preserves a legal non-ASCII authored token byte-for-byte", () => {
  const content = "notify @苹果派 now";
  const tokenStart = content.indexOf("@");
  const authoredToken = content.slice(tokenStart, content.indexOf(" ", tokenStart));
  assert.deepEqual(extractRaftMentionHandles(content), ["苹果派"]);

  const out = formatPendingMentionActions([{
    resolutionId: ACTION_B,
    messageId: "msg-1",
    targetType: "agent",
    targetHandle: "苹果派",
    reason: "not_member",
    availableActions: ["notify"],
  }], { source: "send" });
  const renderedToken = out.match(/^- (@[^ ]+) — status=not_queued/m)?.[1];
  assert.ok(renderedToken);
  assert.equal(Buffer.from(renderedToken).equals(Buffer.from(authoredToken)), true);
});

test("formatPendingMentionActions names empty pending state", () => {
  assert.equal(
    formatPendingMentionActions([], { source: "pending" }),
    "Pending mention actions\n\nNo pending mention actions.\n",
  );
});

test("normalizers accept server response aliases without leaking malformed rows", () => {
  const pending = normalizePendingMentionActions({
    actions: [
      { id: "r-1", messageId: "m-1", targetHandle: "@a", availableActions: ["notify_only"] },
      { messageId: "missing-id" },
    ],
  });
  assert.deepEqual(pending.map((item) => ({
    id: item.resolutionId,
    command: item.availableActions[0],
  })), [{ id: "r-1", command: "notify_only" }]);
  assert.deepEqual(
    normalizeUnresolvedMentionHandles({
      unresolvedMentionHandles: ["@wenyi", " @wenyi ", "", null, "@huxijin"],
    }),
    ["@wenyi", "@huxijin"],
  );

  const results = normalizeMentionActionResults({
    actionResults: [
      { id: "r-1", status: "delivered", targetHandle: "@a" },
      { status: "stale" },
    ],
  });
  assert.deepEqual(results, [
    {
      resolutionId: "r-1",
      status: "delivered",
      action: null,
      messageId: null,
      channelId: null,
      targetType: null,
      targetId: null,
      targetHandle: "@a",
      message: null,
      reason: null,
      dedupedResolutionIds: [],
    },
  ]);
});

test("formatMentionActionResults renders per-id typed statuses from the server execute shape", () => {
  const out = formatMentionActionResults("notify", [
    {
      resolutionId: "r-1",
      status: "queued",
      targetHandle: "@a",
      dedupedResolutionIds: ["r-1", "r-duplicate"],
    },
    { resolutionId: "r-2", status: "no_permission", reason: "sender_lacks_channel_access" },
  ]);

  assert.match(out, /Mention notify results/);
  assert.match(out, /r-1 @a: queued/);
  assert.match(out, /deduped: r-1, r-duplicate/);
  assert.match(out, /r-2: no_permission — sender_lacks_channel_access/);
  assert.match(out, /Recipient guidance: .*If no reply is needed, no action is required\. Otherwise, DM the person who mentioned you or join the channel to participate/);
});

test("formatMentionActionResults does not claim a fresh recipient notice for replayed notify", () => {
  const out = formatMentionActionResults("notify", [
    { resolutionId: "r-1", status: "queued", reason: "already_queued" },
  ]);

  assert.doesNotMatch(out, /Recipient guidance/);
});

test("formatMentionActionResults makes dropped notify delivery failure explicit", () => {
  const out = formatMentionActionResults("notify", [
    { resolutionId: "r-2", status: "dropped", reason: "delivery_unavailable" },
  ]);

  assert.match(out, /r-2: dropped — not delivered: delivery_unavailable/);
});
