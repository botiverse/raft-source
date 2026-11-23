// The agent's forwarded snapshot (formatForwardedBundleForAgent): each cut
// forwarded message names `raft message resolve <id> --forwarded <n>` once,
// and only for a client that declared FORWARDED_RESOLVE_CAPABILITY; the
// bundle cap names every message it cut or dropped. `agentFacingForwardedItem`
// is what that command prints.
import assert from "node:assert/strict";

import { test } from "vitest";

import { agentFacingForwardedItem, appendAgentFacingForwardedSnapshot } from "./messageService";

const FORWARD_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

function bundle(contents: readonly string[]) {
  return {
    kind: "forwarded-bundle",
    version: 1,
    forwardedItems: contents.map((contentSnapshot, index) => ({
      index,
      sourceServerId: "server-source",
      sourceTargetId: "channel-source",
      sourceMessageId: `source-message-${index}`,
      sourceTargetSnapshot: { id: "channel-source", type: "channel", label: "#design", labelVisibility: "public" },
      sourceAuthorSnapshot: { type: "user", id: "user-source", uniqueName: "alice" },
      sourceCreatedAt: "2026-11-01T10:00:00.000Z",
      contentSnapshot,
      attachmentSnapshots: index === 0 ? [{ filename: "plan.md", mimeType: "text/markdown" }] : [],
      provenanceState: "available",
    })),
  };
}

function readWholeNumbers(text: string): number[] {
  return [...text.matchAll(/^Read it whole: raft message resolve (\S+) --forwarded (\d+)$/gm)].map((match) => {
    assert.equal(match[1], FORWARD_ID, "the forward message's own full id");
    return Number(match[2]);
  });
}

test("a cut forwarded message names its read-whole command only for a declaring client", () => {
  const metadata = bundle(["short one", `${"x".repeat(20_000)}tail`]);

  const declared = appendAgentFacingForwardedSnapshot("Forwarded 2 messages", metadata, { readWholeMessageId: FORWARD_ID });
  assert.ok(declared.includes(
    `[forwarded message 2 cut: 18,004 chars omitted]\nRead it whole: raft message resolve ${FORWARD_ID} --forwarded 2`,
  ), declared);
  assert.deepEqual(readWholeNumbers(declared), [2], "one pair per cut message, none for the whole one");
  assert.doesNotMatch(declared, /truncated:/);
  assert.doesNotMatch(declared, /tail/);

  // No capability: today's note, no command.
  for (const options of [undefined, {}, { readWholeMessageId: null }]) {
    const plain = appendAgentFacingForwardedSnapshot("Forwarded 2 messages", metadata, options);
    assert.match(plain, /\n\[forwarded content truncated: 18004 chars omitted\]/);
    assert.doesNotMatch(plain, /Read it whole|--forwarded|cut:/);
  }

  // Nothing cut: nothing to point at, the same text either way.
  const small = bundle(["one", "two"]);
  assert.equal(
    appendAgentFacingForwardedSnapshot("Forwarded 2 messages", small, { readWholeMessageId: FORWARD_ID }),
    appendAgentFacingForwardedSnapshot("Forwarded 2 messages", small),
  );
});

test("the bundle cap names each forwarded message it cut or dropped, once", () => {
  // Twenty messages under the per-message limit: the 12,000-char cap cuts the bundle.
  const metadata = bundle(Array.from({ length: 20 }, (_, index) => `message ${index + 1} ${"m".repeat(1_500)}`));
  const declared = appendAgentFacingForwardedSnapshot("Forwarded 20 messages", metadata, { readWholeMessageId: FORWARD_ID });
  assert.match(declared, /\n\[forwarded snapshot cut: [\d,]+ chars omitted\]\n/);
  const pointed = readWholeNumbers(declared);
  assert.equal(new Set(pointed).size, pointed.length, "no message is pointed at twice");
  assert.equal(pointed.at(-1), 20, "a dropped message is pointed at");
  assert.ok(!pointed.includes(1), "a message shown whole is not");
  // Every message is either shown whole or pointed at.
  for (let number = 1; number <= 20; number += 1) {
    const shownWhole = declared.includes(`message ${number} ${"m".repeat(1_500)}`);
    assert.ok(shownWhole !== pointed.includes(number), `forwarded message ${number}`);
  }

  // Cut messages past the cap: those whose own note still shows aren't listed again.
  const long = bundle(Array.from({ length: 8 }, (_, index) => `long ${index + 1} ${"z".repeat(3_000)}`));
  const longDeclared = appendAgentFacingForwardedSnapshot("Forwarded 8 messages", long, { readWholeMessageId: FORWARD_ID });
  const longPointed = readWholeNumbers(longDeclared);
  assert.deepEqual([...longPointed].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);

  // No capability: today's bundle marker, no command.
  const plain = appendAgentFacingForwardedSnapshot("Forwarded 20 messages", metadata);
  assert.match(plain, /\n\[forwarded snapshot truncated: \d+ chars omitted\]$/);
  assert.doesNotMatch(plain, /Read it whole|--forwarded/);
});

test("one forwarded message whole: the snapshot's lines, its content not cut, never a source pointer", () => {
  const body = `${"w".repeat(30_000)} the end`;
  const metadata = bundle(["first", body, "third"]);

  const item = agentFacingForwardedItem(metadata, 2);
  assert.equal(item.ok, true);
  assert.equal(item.total, 3);
  assert.ok(item.ok && item.content === [
    "Forwarded message 2:",
    "From: @alice",
    "Source: #design",
    "Sent: 2026-11-01T10:00:00.000Z",
    "",
    body,
  ].join("\n"));

  const first = agentFacingForwardedItem(metadata, 1);
  assert.ok(first.ok && first.content.endsWith("first\n\nAttachments: plan.md (text/markdown)"));
  for (const number of [1, 2, 3]) {
    const shown = agentFacingForwardedItem(metadata, number);
    assert.ok(shown.ok);
    assert.doesNotMatch(shown.content, /source-message-|channel-source|server-source|user-source/);
  }

  assert.deepEqual(agentFacingForwardedItem(metadata, 4), { ok: false, total: 3 });
  assert.deepEqual(agentFacingForwardedItem(metadata, 0), { ok: false, total: 3 });
  assert.deepEqual(agentFacingForwardedItem(null, 1), { ok: false, total: 0 });
  assert.deepEqual(agentFacingForwardedItem({ kind: "card" }, 1), { ok: false, total: 0 });
});
