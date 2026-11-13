import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  assertSurfaceProducerFactLineage,
} from "@botiverse/raft-shared";

import {
  clearSavedDraft,
  clearSavedDraftIfIdempotencyKeyMatches,
  getSavedDraft,
  lookupSavedDraft,
  setSavedDraft,
} from "./_continueDraftState";
import {
  DRAFT_REPLACED_EXCERPT_LIMIT,
  classifyMessageSendOutcome,
  detectThreadContextParentSend,
  formatDraftReplacedWarning,
  formatThreadContextParentSendMessage,
  formatSendDraftStdinDeadlineDiagnostic,
  markSendFailureDraftSaved,
  parseMentionSelector,
  parseMentionSelectors,
  rejectArgContent,
  rejectSendDraftStdin,
  resolveOptionalSendContent,
  resolveSendContent,
  SEND_DRAFT_STDIN_OBSERVATION_MS,
  SendContentError,
  validateDraftSendFlags,
  formatDriveByJoinedToPostTip,
  formatHeldSendOutput,
  normalizeAttachmentIdFlags,
} from "./send";
import {
  formatFreshnessHoldOutput,
  redactFreshnessHoldForReviewerIsolation,
} from "../freshness/_format";
import { CliError } from "../../core/errors";
import {
  archiveReplacedDraft,
  REPLACED_DRAFT_HISTORY_LIMIT,
} from "./_replacedDraftHistory";

// Hermetic regardless of test order: anything that resolves through the Raft
// home (legacy import, the published read record) stays in a temp directory.
process.env.RAFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-test-home-"));

const draftLockChildMode = process.argv.find((arg) => arg.startsWith("--draft-lock-child="));
if (draftLockChildMode) {
  const mode = draftLockChildMode.slice("--draft-lock-child=".length);
  const stateDir = process.argv[process.argv.indexOf(draftLockChildMode) + 1];
  const releasePath = process.argv[process.argv.indexOf(draftLockChildMode) + 2];
  if (!stateDir) throw new Error("missing child draft state directory");
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = stateDir;
  if (mode === "clear-when-released") {
    if (!releasePath) throw new Error("missing child release path");
    const target = process.argv[process.argv.indexOf(draftLockChildMode) + 3] ?? "#room";
    // Wait until the parent says the interleaving point is reached, then
    // compare-and-clear: the ledger's single-statement delete must only
    // remove the draft when it still carries the expected idempotency key.
    while (!fs.existsSync(releasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const cleared = clearSavedDraftIfIdempotencyKeyMatches("agent-cross-process", target, "key-a");
    process.stdout.write(cleared ? "CLEARED\n" : "SKIPPED\n");
  } else if (mode === "writer") {
    const target = process.argv[process.argv.indexOf(draftLockChildMode) + 2];
    if (!target) throw new Error("missing child writer target");
    setSavedDraft("agent-cross-process", target, {
      content: `draft from writer ${target}`,
      attachmentIds: [],
      idempotencyKey: `key-${target}`,
      savedAt: Date.now(),
      reholdCount: 0,
    });
  } else {
    throw new Error(`unknown child mode ${mode}`);
  }
  process.exit(0);
}

const originalDraftStateDir = process.env.SLOCK_CLI_DRAFT_STATE_DIR;
const PENDING_ACTION_ID = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  if (originalDraftStateDir === undefined) {
    delete process.env.SLOCK_CLI_DRAFT_STATE_DIR;
  } else {
    process.env.SLOCK_CLI_DRAFT_STATE_DIR = originalDraftStateDir;
  }
});

test("resolveSendContent reads multiline content from stdin", async () => {
  const input = Readable.from([
    "long message with 'quotes', $vars, `backticks`\n",
    "and a second line\n",
  ]);

  assert.equal(
    await resolveSendContent(input),
    "long message with 'quotes', $vars, `backticks`\nand a second line\n",
  );
});

test("typed mention selectors bind one actor type and id per visible handle", () => {
  const human = "human:11111111-1111-4111-8111-111111111111:same_handle";
  const agent = "agent:22222222-2222-4222-8222-222222222222:same_handle";
  assert.deepEqual(parseMentionSelector(human), {
    type: "user",
    id: "11111111-1111-4111-8111-111111111111",
    name: "same_handle",
  });
  assert.deepEqual(parseMentionSelector(agent), {
    type: "agent",
    id: "22222222-2222-4222-8222-222222222222",
    name: "same_handle",
  });
  assert.throws(
    () => parseMentionSelectors([human, agent]),
    (error: unknown) => error instanceof SendContentError && error.code === "MENTION_BINDING_CONFLICT",
  );
  assert.throws(
    () => parseMentionSelector("agent:not-a-uuid:same_handle"),
    (error: unknown) => error instanceof SendContentError && error.code === "INVALID_MENTION_SELECTOR",
  );
});

test("an anonymous search sender cannot be bound as a structured mention", () => {
  for (const selector of ["human::Slack", "agent::Slack", "third_party_app::Slack"]) {
    assert.throws(() => parseMentionSelector(selector),
      (error: unknown) => error instanceof SendContentError && error.code === "INVALID_MENTION_SELECTOR");
  }
  assert.deepEqual(parseMentionSelectors(undefined), [], "a reply with no mention selector does not invent one");
});

test("resolveSendContent rejects empty stdin", async () => {
  await assert.rejects(
    () => resolveSendContent(Readable.from([])),
    (err) =>
      err instanceof SendContentError &&
      err.code === "MISSING_CONTENT" &&
      err.message.includes("<<'RAFTMSG'") &&
      !err.message.includes("<<'EOF'"),
  );
});

test("resolveSendContent rejects whitespace-only stdin", async () => {
  await assert.rejects(
    () => resolveSendContent(Readable.from(["\n\t  \n"])),
    (err) => err instanceof SendContentError && err.code === "MISSING_CONTENT",
  );
});

test("resolveSendContent rejects TTY stdin without waiting for input", async () => {
  const input = Readable.from(["this should not be read"]);
  Object.defineProperty(input, "isTTY", { value: true });

  await assert.rejects(
    () => resolveSendContent(input),
    (err) => err instanceof SendContentError && err.code === "MISSING_CONTENT",
  );
});

test("resolveOptionalSendContent reads non-empty stdin", async () => {
  const input = Readable.from(["updated draft\n"]);

  assert.equal(await resolveOptionalSendContent(input), "updated draft\n");
});

test("resolveOptionalSendContent treats empty stdin as absent", async () => {
  let deadlineExpired = false;
  assert.equal(
    await resolveOptionalSendContent(Readable.from([]), {
      observationWindowMs: 50,
      onNoBytesWithinWindow: () => {
        deadlineExpired = true;
      },
    }),
    undefined,
  );
  assert.equal(deadlineExpired, false, "immediate EOF must not be reported as a deadline");
});

test("resolveOptionalSendContent preserves whitespace bytes as unsupported stdin", async () => {
  assert.equal(
    await resolveOptionalSendContent(Readable.from(["\n\t  \n"])),
    "\n\t  \n",
  );
});

test("resolveOptionalSendContent treats TTY stdin as absent without waiting", async () => {
  const input = Readable.from(["this should not be read"]);
  Object.defineProperty(input, "isTTY", { value: true });

  assert.equal(await resolveOptionalSendContent(input), undefined);
});

test("resolveOptionalSendContent bounds open empty non-TTY stdin by its deadline", async () => {
  const input = new PassThrough();
  let deadlineExpired = false;
  const startedAt = performance.now();

  try {
    assert.equal(
      await resolveOptionalSendContent(input, {
        observationWindowMs: 20,
        onNoBytesWithinWindow: () => {
          deadlineExpired = true;
        },
      }),
      undefined,
    );
    assert.equal(deadlineExpired, true);
    assert.ok(performance.now() - startedAt >= 15);
  } finally {
    input.destroy();
  }
});

test("resolveOptionalSendContent reads an already-readable real child-process pipe", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('child body\\n')"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = once(child, "exit");

  assert.ok(child.stdout);
  await once(child.stdout, "readable");
  assert.ok(child.stdout.readableLength > 0);
  assert.equal(
    await resolveOptionalSendContent(child.stdout, { observationWindowMs: 1 }),
    "child body\n",
  );
  await exited;
});

test("resolveOptionalSendContent treats bytes after the deadline as absent", async () => {
  const input = new PassThrough();
  input.setEncoding("utf8");
  let deadlineExpired = false;
  let timer: NodeJS.Timeout | undefined;

  try {
    const pending = resolveOptionalSendContent(input, {
      observationWindowMs: 20,
      onNoBytesWithinWindow: () => {
        deadlineExpired = true;
      },
    });
    // Registered after the function's deadline timer at the same threshold:
    // this write occurs after the deadline callback has run and returned.
    timer = setTimeout(() => {
      input.end("late body\n");
    }, 20);
    assert.equal(await pending, undefined);
    assert.equal(deadlineExpired, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(input.read(), "late body\n");
  } finally {
    if (timer) clearTimeout(timer);
    input.destroy();
  }
});

test("resolveOptionalSendContent absorbs errors after the deadline", async () => {
  const input = new PassThrough();
  const closed = new Promise<void>((resolve) => input.once("close", resolve));

  assert.equal(
    await resolveOptionalSendContent(input, { observationWindowMs: 20 }),
    undefined,
  );
  input.destroy(new Error("late input failure"));
  await closed;
});

test("send-draft deadline diagnostic states both the boundary and effect", () => {
  assert.equal(SEND_DRAFT_STDIN_OBSERVATION_MS, 1_000);
  assert.equal(
    formatSendDraftStdinDeadlineDiagnostic(),
    "No stdin bytes were detected within 1000ms; the stored draft will now be sent.",
  );
});

test("rejectArgContent gives friendly errors for positional content", () => {
  assert.throws(
    () => rejectArgContent(["hello"], {}),
    (err) =>
      err instanceof SendContentError &&
      err.code === "POSITIONAL_CONTENT_UNSUPPORTED" &&
      err.message.includes("provided on stdin"),
  );
});

test("rejectArgContent gives friendly errors for the legacy --content flag", () => {
  assert.throws(
    () => rejectArgContent([], { content: "hello" }),
    (err) =>
      err instanceof SendContentError &&
      err.code === "CONTENT_FLAG_UNSUPPORTED" &&
      err.message.includes("--content is no longer supported"),
  );
});

test("validateDraftSendFlags rejects --anyway without --send-draft", () => {
  assert.throws(
    () => validateDraftSendFlags({ anyway: true }),
    (err) =>
      err instanceof SendContentError &&
      err.code === "SEND_DRAFT_ANYWAY_REQUIRES_SEND_DRAFT",
  );
});

test("validateDraftSendFlags allows --anyway with --send-draft", () => {
  assert.doesNotThrow(() => validateDraftSendFlags({ anyway: true, sendDraft: true }));
});

test("validateDraftSendFlags requires --send-draft for --expected-draft-key", () => {
  assert.throws(
    () => validateDraftSendFlags({ expectedDraftKey: "key-a" }),
    (err: unknown) => err instanceof SendContentError && err.code === "EXPECTED_DRAFT_KEY_REQUIRES_SEND_DRAFT",
  );
});

test("validateDraftSendFlags: --discard-draft takes --expected-draft-key but not --send-draft, attachments or mentions", () => {
  assert.doesNotThrow(() => validateDraftSendFlags({ discardDraft: true, expectedDraftKey: "key-a" }));
  assert.throws(
    () => validateDraftSendFlags({ discardDraft: true, sendDraft: true }),
    (err: unknown) => err instanceof SendContentError && err.code === "DISCARD_DRAFT_WITH_SEND_DRAFT",
  );
  for (const extra of [{ attachmentId: ["att-1"] }, { mention: ["agent:00000000-0000-4000-8000-000000000000:bot"] }]) {
    assert.throws(
      () => validateDraftSendFlags({ discardDraft: true, ...extra }),
      (err: unknown) => err instanceof SendContentError && err.code === "DISCARD_DRAFT_OPTIONS_UNSUPPORTED",
    );
  }
  assert.throws(
    () => validateDraftSendFlags({ discardDraft: true, anyway: true }),
    (err: unknown) => err instanceof SendContentError && err.code === "SEND_DRAFT_ANYWAY_REQUIRES_SEND_DRAFT",
  );
});

test("rejectSendDraftStdin fails loud and points agents to a normal send", () => {
  assert.throws(
    () => rejectSendDraftStdin("revised draft\n", "#room:abcd1234"),
    (err) =>
      err instanceof SendContentError &&
      err.code === "SEND_DRAFT_STDIN_UNSUPPORTED" &&
      err.message.includes("does not accept stdin") &&
      err.message.includes("without --send-draft") &&
      err.message.includes("raft message send --target"),
  );
});

test("rejectSendDraftStdin allows absent stdin", () => {
  assert.doesNotThrow(() => rejectSendDraftStdin(undefined, "#room"));
});

test("local draft state stores body and expires stale drafts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = tmp;

  setSavedDraft("agent-1", "#room:abcd1234", {
    content: "draft body",
    attachmentIds: ["att-1"],
    mentions: [{
      type: "agent",
      id: "22222222-2222-4222-8222-222222222222",
      name: "same_handle",
    }],
    savedAt: Date.now(),
    reholdCount: 2,
    seenUpToSeq: 42,
    seenExactSeqs: [44, 45],
  });

  const saved = getSavedDraft("agent-1", "#room:abcd1234");
  assert.ok(saved);
  assert.deepEqual(saved, {
    content: "draft body",
    attachmentIds: ["att-1"],
    mentions: [{
      type: "agent",
      id: "22222222-2222-4222-8222-222222222222",
      name: "same_handle",
    }],
    savedAt: saved.savedAt,
    reholdCount: 2,
    seenUpToSeq: 42,
    seenExactSeqs: [44, 45],
  });

  clearSavedDraft("agent-1", "#room:abcd1234");
  assert.equal(getSavedDraft("agent-1", "#room:abcd1234"), null);

  const expiredSavedAt = Date.now() - 11 * 60 * 1000;
  setSavedDraft("agent-1", "#room:abcd1234", {
    content: "expired body",
    attachmentIds: [],
    savedAt: expiredSavedAt,
    reholdCount: 1,
  });
  // The first touch reports the expiry (and discards the draft); afterwards it is simply missing.
  assert.deepEqual(lookupSavedDraft("agent-1", "#room:abcd1234"), { status: "expired", savedAt: expiredSavedAt, content: "expired body" });
  assert.deepEqual(lookupSavedDraft("agent-1", "#room:abcd1234"), { status: "missing" });
  assert.equal(getSavedDraft("agent-1", "#room:abcd1234"), null);
});

test("held send output states the draft lifetime and the expiry error code", () => {
  const out = formatHeldSendOutput("#room", {
    producerFactId: "freshness_decision_fact:cli-held-readout",
    newMessageCount: 1,
    shownMessageCount: 1,
    heldMessages: [{ seq: 10, id: "msg10", senderName: "alice", content: "context" }],
  });
  assert.match(out, /saved as a draft \(kept for 10 minutes\)/);
  assert.match(out, /within 10 minutes; after that the draft is discarded and --send-draft reports SEND_DRAFT_EXPIRED/);
  assert.match(out, /raft message send --send-draft --target "#room"/);
});

test("send-draft on an expired draft fails with SEND_DRAFT_EXPIRED, returns the last copy of the body, and sends nothing", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-expired-draft-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-expired-draft-"));
  const savedAt = Date.now() - 11 * 60 * 1000;
  setSavedDraft("agent-expired-draft", "#room", {
    content: "stale body\n",
    attachmentIds: [],
    savedAt,
    reholdCount: 1,
  });
  let sendCount = 0;
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from([]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-expired-draft",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => {
        sendCount += 1;
        return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "should-not-send" } };
      },
    }) as never,
  });

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#room", sendDraft: true }),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === "SEND_DRAFT_EXPIRED" &&
      /kept for 10 minutes/.test(err.message) &&
      err.message.includes(new Date(savedAt).toISOString()) &&
      /This command did not send anything/.test(err.message) &&
      /confirm before resending/.test(err.message) &&
      /this is its last copy:\n---\nstale body\n---/.test(err.message),
  );
  assert.equal(sendCount, 0, "an expired draft must never be sent");
  assert.deepEqual(lookupSavedDraft("agent-expired-draft", "#room"), { status: "missing" });
});

test("formatHeldSendOutput for a card alone offers sending nothing first, without the 'someone already answered' example", () => {
  const out = formatHeldSendOutput("#ops", {
    newMessageCount: 0,
    heldMessages: [],
    holdReasons: ["channel_card"],
    channelCard: { id: "c-ops", name: "ops", type: "channel", description: "Release coordination." },
  });
  assert.match(String(out), /choose one path\.\nIf what you just read already says what you meant to say, or makes your message unnecessary, send nothing\. Delete the draft:\n {2}raft message send --discard-draft --target "#ops"\n/);
  assert.doesNotMatch(String(out), /someone already answered/);
});

test("formatHeldSendOutput frames held context as bounded latest messages", () => {
  const out = formatHeldSendOutput("#room", {
    producerFactId: "freshness_decision_fact:cli-held-readout",
    newMessageCount: 46,
    shownMessageCount: 3,
    omittedMessageCount: 43,
    firstShownSeq: 4301,
    heldMessages: [
      { seq: 4301, id: "msg44", senderName: "alice", content: "forty four" },
      { seq: 4302, id: "msg45", senderName: "bob", content: "forty five" },
      { seq: 4303, id: "msg46", senderName: "charlie", content: "forty six" },
    ],
  });

  assert.match(out, /Held — 46 unread messages in #room\./);
  // Task #41 final shape: the skipped count is the true per-hold message count
  // (never a seq span — seqs are server-global), stated with the exact
  // recovery command; no release announcement, no debt bookkeeping.
  assert.match(out, /43 earlier messages skipped in this notice\./);
  assert.match(out, /Older: raft message read --target "#room" --before 4301 ⋯/);
  assert.doesNotMatch(out, /no longer block/);
  assert.doesNotMatch(out, /never shown to you/);
  assert.match(out, /├ Latest 3/);
  assert.match(out, /@alice.*forty four/);
  // Every preview fits: no full-text command (nothing more to read there), the window just closes.
  assert.doesNotMatch(out, /Previews are truncated/);
  assert.match(out, /└ ─{40}\n/);
  assert.match(out, /After reviewing the current state of this conversation/);
  // #wg-ax:#6: not sending comes first, with the command that deletes the draft.
  assert.match(
    out,
    /choose one path\.\nIf what you just read already says what you meant to say \(for example, someone already answered\), or makes your message unnecessary, send nothing\. Delete the draft:\n {2}raft message send --discard-draft --target "#room"\nOtherwise, to update the draft/,
  );
  assert.doesNotMatch(out, /dismiss-draft/);
  assert.doesNotMatch(out, /[一-鿿]/);
  // The lineage note is no longer rendered to the agent (task #263): it named the
  // freshness DECISION's input hash, no CLI verb consumes it, and an agent has no
  // return path for it. Reconciliation still binds producerFactId on the internal
  // envelope, which the daemon and server suites assert.
  assert.doesNotMatch(out, /Lineage: producerFactId=/);
  assertSurfaceProducerFactLineage(out, [], "CLI held output");
  assert.throws(
    () => assertSurfaceProducerFactLineage(
      out,
      ["freshness_decision_fact:cli-held-readout"],
      "CLI held output must not carry lineage",
    ),
    /producerFactId mismatch/,
  );
  assert.doesNotMatch(out, /Read the new messages below/);
});

test("reviewer-isolation formatter and JSON projector expose only the count, never legacy poison fields", () => {
  const poison = {
    body: "paired reviewer verdict: REQUEST CHANGES",
    sender: "peer-reviewer",
    id: "blind-message-id",
    timestamp: "2042-03-04T05:06:07.000Z",
    reason: "peer_rejected_the_change",
    error: "legacy hold copied the peer verdict",
    lineage: "freshness_decision_fact:legacy-poison",
  };
  const held = {
    state: "held" as const,
    producerFactId: poison.lineage,
    reason: poison.reason,
    error: poison.error,
    newMessageCount: 2,
    shownMessageCount: 1,
    omittedMessageCount: 1,
    seenUpToSeq: 99,
    seenUpToMessageId: poison.id,
    mentionAnnotation: { formalMentionCount: 1 },
    heldMessages: [{
      seq: 99,
      message_id: poison.id,
      sender_name: poison.sender,
      timestamp: poison.timestamp,
      content: poison.body,
    }],
  };

  const text = formatHeldSendOutput("#reviews:blind", held, true);
  assert.match(text, /Reviewer-isolation freshness hold: 2 newer messages withheld/);
  assert.doesNotMatch(text, /#reviews:blind|--send-draft|--anyway|model-seen|cursor/i);
  const json = redactFreshnessHoldForReviewerIsolation(held);
  assert.deepEqual(json, {
    state: "held",
    freshnessContextMode: "withheld",
    withheldMessageCount: 2,
  });

  for (const surface of [text, JSON.stringify(json)]) {
    for (const value of Object.values(poison)) {
      assert.doesNotMatch(surface, new RegExp(value));
    }
    assert.doesNotMatch(surface, /seenUpToSeq|seenUpToMessageId|producerFactId|formalMentionCount/);
  }
});

test("formatHeldSendOutput explains syncing holds as target context syncs", () => {
  const out = formatHeldSendOutput("#room:abcd1234", {
    producerFactId: "freshness_decision_fact:cli-syncing-context-readout",
    decision: "syncing_hold",
    newMessageCount: 5,
    shownMessageCount: 1,
    omittedMessageCount: 4,
    heldMessages: [
      { seq: 12, id: "msg12", senderName: "alice", content: "target context" },
    ],
  });

  // Task #41: syncing holds render the same state-map digest as local holds —
  // one format everywhere, decision framing identical.
  assert.match(out, /Held — 5 unread messages in #room:abcd1234\./);
  assert.match(out, /@alice.*target context/);
  assert.match(out, /After reviewing the current state of this conversation/);
  assert.doesNotMatch(out, /Reason:/);
  assert.doesNotMatch(out, /Action:/);
  assert.doesNotMatch(out, /newer messages?/);
  assert.doesNotMatch(out, /bounded context/);
});

test("formatHeldSendOutput teaches a Raft-specific heredoc delimiter instead of EOF", () => {
  const out = formatHeldSendOutput("#room", {
    newMessageCount: 1,
    shownMessageCount: 1,
    omittedMessageCount: 0,
    heldMessages: [
      { seq: 1, id: "msg1", senderName: "alice", content: "new context" },
    ],
  });

  assert.match(out, /<<'RAFTMSG'/);
  assert.match(out, /\n  RAFTMSG\n/);
  assert.doesNotMatch(out, /<<'EOF'/);
  assert.doesNotMatch(out, /\n  EOF\n/);
});

test("formatHeldSendOutput renders canonical agent-visible message fields", () => {
  const out = formatHeldSendOutput("dm:@tygg", {
    newMessageCount: 1,
    shownMessageCount: 1,
    omittedMessageCount: 0,
    heldMessages: [
      {
        seq: 241,
        message_id: "recent-241",
        timestamp: "2026-05-19T00:00:00.000Z",
        sender_type: "user",
        sender_name: "tygg",
        content: "recent context",
      },
    ],
  });

  // Task #41 digest: one preview line per message — sender + body head. A
  // short body is whole, so no read command follows (nothing left out).
  assert.match(out, /@tygg.*recent context/);
  assert.doesNotMatch(out, /Previews are truncated/);
  assert.doesNotMatch(out, /@unknown/);
});

test("formatFreshnessHoldOutput can block non-message side effects without draft copy", () => {
  const out = formatFreshnessHoldOutput("#proj-runtime", {
    newMessageCount: 1,
    shownMessageCount: 1,
    omittedMessageCount: 0,
    heldMessages: [
      { seq: 8, message_id: "msg8", sender_name: "tygg", content: "new context" },
    ],
  }, {
    heldAction: "Your task claim was not applied.",
    draftInstructions: "After reviewing the newer context, rerun the task claim command if it is still correct.\n",
  });

  assert.match(out, /Held — 1 unread message in #proj-runtime\./);
  assert.match(out, /Your task claim was not applied/);
  assert.match(out, /rerun the task claim command/);
  assert.doesNotMatch(out, /saved as a draft/);
  assert.doesNotMatch(out, /send-draft/);
});

// --- FH-EXT-001 send-side attestation gates (task #70): the send handler
// must auto-attest the local per-target consumed cursor when no hold-issued
// draft boundary exists, must NOT borrow another target's cursor, and must
// keep the draft boundary as the priority source. Handler-level (real
// command handler + captured request body), since the bug class lives in
// what the wire body actually carries. ---
import { createCommandContext } from "../../core/context";
import { registerCliCommand } from "../../core/command";
import { messageSendCommand } from "./send";
import { getConsumedSeq, recordConsumedExactSeqs, recordConsumedRead, recordConsumedSeqs } from "./_consumedSeqState";
import { messageReadCommand } from "./read";
import { DatabaseSync } from "node:sqlite";
import { resolveStateDbPath } from "../../state/agentLedger";

function sendHarness(stdin: NodeJS.ReadableStream = Readable.from(["hello from test\n"])) {
  const bodies: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdin,
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
  } as never;
  const ctx = createCommandContext({
    io,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-attest",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async (_m: string, path: string, body?: Record<string, unknown>) => {
        paths.push(path);
        bodies.push(body ?? {});
        return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m1" } };
      },
    }) as never,
  });
  return { ctx, bodies, paths, stdout, stderr };
}

function ambiguousSendHarness(
  responses: Array<Error | { ok: boolean; status: number; error: string | null; data: unknown }>,
) {
  const bodies: Array<Record<string, unknown>> = [];
  const stdout: string[] = [];
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["one logical send\n"]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-reconcile",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: Record<string, unknown>) => {
        bodies.push(body ?? {});
        const response = responses.shift();
        if (!response) throw new Error("missing test response");
        if (response instanceof Error) throw response;
        return response;
      },
    }) as never,
  });
  return { ctx, bodies, stdout };
}

function preResponseTimeout(): CliError {
  return new CliError({
    code: "PROXY_5XX",
    message: "message send timed out before a response",
    faultDomain: "agent_api_transport",
    proxyFailureClass: "pre_response_transport",
    proxyResponseStarted: false,
    proxyResponseComplete: false,
  });
}

const ATTACHMENT_A = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_B = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT_C = "33333333-3333-4333-8333-333333333333";

test("normalizeAttachmentIdFlags splits ids an agent put in one --attachment-id", () => {
  assert.deepEqual(normalizeAttachmentIdFlags([]), []);
  assert.deepEqual(normalizeAttachmentIdFlags([ATTACHMENT_A]), [ATTACHMENT_A]);
  assert.deepEqual(
    normalizeAttachmentIdFlags([`${ATTACHMENT_A} ${ATTACHMENT_B}`, `${ATTACHMENT_C},`]),
    [ATTACHMENT_A, ATTACHMENT_B, ATTACHMENT_C],
  );
  assert.deepEqual(normalizeAttachmentIdFlags([` ${ATTACHMENT_A},\n ${ATTACHMENT_B} `]), [ATTACHMENT_A, ATTACHMENT_B]);
  assert.deepEqual(normalizeAttachmentIdFlags([`${ATTACHMENT_A} ${ATTACHMENT_A}`, ATTACHMENT_B, ATTACHMENT_A]), [ATTACHMENT_A, ATTACHMENT_B]);
});

test("normalizeAttachmentIdFlags names a bad entry by position, never echoes it, and gives a runnable next step", () => {
  assert.throws(
    () => normalizeAttachmentIdFlags([`${ATTACHMENT_A} report.png`], "#design"),
    (err: unknown) =>
      err instanceof SendContentError
      && err.code === "ATTACHMENT_ID_INVALID"
      && err.message.startsWith("Not sent: --attachment-id entry 2 is not an attachment ID.")
      && err.message.includes('"Attachment ID:" line')
      && err.message.endsWith('Run: raft attachment upload --path <file> --target "#design"')
      && !err.message.includes("report.png"),
  );
});

test("normalizeAttachmentIdFlags rejects an empty value instead of sending without the attachment", () => {
  for (const values of [[""], [ATTACHMENT_A, "  "]]) {
    assert.throws(
      () => normalizeAttachmentIdFlags(values, "#room"),
      (err: unknown) =>
        err instanceof SendContentError
        && err.code === "ATTACHMENT_ID_INVALID"
        && err.message.startsWith(`Not sent: --attachment-id entry ${values.length} is empty.`),
    );
  }
});

test("message send sends split attachment ids, and sends nothing when one is malformed", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-attachment-split-"));
  const sent = ambiguousSendHarness([{ ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m-1" } }]);
  await messageSendCommand.handler(sent.ctx, [], { target: "#room", attachmentId: [`${ATTACHMENT_A} ${ATTACHMENT_B}`] });
  assert.deepEqual(sent.bodies[0]!.attachmentIds, [ATTACHMENT_A, ATTACHMENT_B]);

  // The bad id is reported before stdin is read, so the body is not consumed.
  const rejected = ambiguousSendHarness([]);
  let stdinRead = false;
  (rejected.ctx.io as unknown as { stdin: Readable }).stdin = new Readable({ read() { stdinRead = true; this.push(null); } });
  await assert.rejects(
    async () => messageSendCommand.handler(rejected.ctx, [], { target: "#room", attachmentId: ["att-1"] }),
    (err: unknown) => err instanceof CliError && err.code === "ATTACHMENT_ID_INVALID",
  );
  assert.equal(rejected.bodies.length, 0, "a malformed id is caught before any request");
  assert.equal(stdinRead, false, "stdin is left unread");
});

test("message send reconciles a timeout after commit without replaying content", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-reconcile-after-"));
  const { ctx, bodies, stdout } = ambiguousSendHarness([
    preResponseTimeout(),
    {
      ok: true,
      status: 200,
      error: null,
      data: {
        ok: true,
        state: "committed",
        messageId: "committed-1",
        reconciliation: true,
        receiptComplete: false,
      },
    },
  ]);

  await messageSendCommand.handler(ctx, [], { target: "#room" });

  assert.equal(bodies.length, 2);
  assert.equal(typeof bodies[0]!.idempotencyKey, "string");
  assert.equal(bodies[1]!.idempotencyKey, bodies[0]!.idempotencyKey);
  assert.equal(bodies[1]!.reconcileOnly, true);
  assert.equal(Object.hasOwn(bodies[1]!, "content"), false);
  assert.equal(getSavedDraft("agent-send-reconcile", "#room"), null);
  assert.match(stdout.join(""), /Message commit confirmed/);
  assert.match(stdout.join(""), /receipt details.*unavailable/);
});

test("a committed send still prints its receipt when the post-commit draft clear fails", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-clear-fails-"));
  const agentId = "agent-send-clear-fails";
  const stdout: string[] = [];
  let requests = 0;
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["delivered once\n"]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({ agentId, serverUrl: "http://stub.local", clientMode: "self-hosted-runner", profileSlug: "t" }) as never,
    createApiClient: () => ({
      request: async () => {
        requests += 1;
        // The server commits; meanwhile the ledger becomes unwritable for
        // this CLI (here: a newer CLI bumped the schema), so the clear throws.
        const db = new DatabaseSync(resolveStateDbPath(agentId));
        db.prepare("UPDATE meta SET value = '2' WHERE key = 'version'").run();
        db.close();
        return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "delivered-1" } };
      },
    }) as never,
  });

  await messageSendCommand.handler(ctx, [], { target: "#room" });

  assert.equal(requests, 1);
  assert.match(stdout.join(""), /delivered-1/, "the Message ID reaches the agent, so it has no reason to resend");
});

test("message send reconciles a timeout before commit then replays once with the same key", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-reconcile-before-"));
  const { ctx, bodies } = ambiguousSendHarness([
    preResponseTimeout(),
    { ok: true, status: 200, error: null, data: { ok: true, state: "not_found", reconciliation: true } },
    { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "replayed-1" } },
  ]);

  await messageSendCommand.handler(ctx, [], { target: "#room" });

  assert.equal(bodies.length, 3);
  assert.equal(bodies[1]!.reconcileOnly, true);
  assert.equal(bodies[2]!.content, "one logical send\n");
  assert.equal(bodies[1]!.idempotencyKey, bodies[0]!.idempotencyKey);
  assert.equal(bodies[2]!.idempotencyKey, bodies[0]!.idempotencyKey);
  assert.equal(getSavedDraft("agent-send-reconcile", "#room"), null);
});

test("message send does not offer same-key retry after another send replaces its draft", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-reconcile-replaced-"));
  const bodies: Array<Record<string, unknown>> = [];
  let requestCount = 0;
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["original logical send\n"]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-reconcile-replaced",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: Record<string, unknown>) => {
        bodies.push(body ?? {});
        requestCount += 1;
        if (requestCount === 1) throw preResponseTimeout();
        if (requestCount === 2) {
          return { ok: true, status: 200, error: null, data: { ok: true, state: "not_found", reconciliation: true } };
        }
        setSavedDraft("agent-send-reconcile-replaced", "#room", {
          content: "replacement send\n",
          attachmentIds: [],
          idempotencyKey: "replacement-key",
          savedAt: Date.now(),
          reholdCount: 0,
        });
        throw preResponseTimeout();
      },
    }) as never,
  });

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#room" }),
    (err: unknown) =>
      err instanceof CliError &&
      err.retryable === false &&
      err.draftSaved === false &&
      /CANNOT_CONFIRM/.test(err.suggestedNextAction ?? "") &&
      /different send/.test(err.suggestedNextAction ?? ""),
  );

  assert.equal(bodies.length, 3);
  assert.equal(bodies[2]!.idempotencyKey, bodies[0]!.idempotencyKey);
  const replacement = getSavedDraft("agent-send-reconcile-replaced", "#room");
  assert.equal(replacement?.content, "replacement send\n");
  assert.equal(replacement?.idempotencyKey, "replacement-key");
});

test("identity-bound retry command rejects a later replacement with zero requests", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-bound-retry-replaced-"));
  const { ctx, bodies } = ambiguousSendHarness([
    preResponseTimeout(),
    { ok: true, status: 200, error: null, data: { ok: true, state: "not_found", reconciliation: true } },
    preResponseTimeout(),
  ]);

  let initialFailure: CliError | undefined;
  try {
    await messageSendCommand.handler(ctx, [], { target: "#room" });
  } catch (err) {
    if (err instanceof CliError) initialFailure = err;
  }
  assert.ok(initialFailure);
  assert.equal(initialFailure.retryable, true);
  const keyMatch = initialFailure.suggestedNextAction?.match(/--expected-draft-key "([^"]+)"/);
  assert.ok(keyMatch, initialFailure.suggestedNextAction);
  const originalKey = keyMatch[1]!;
  assert.equal(originalKey, bodies[0]!.idempotencyKey);

  setSavedDraft("agent-send-reconcile", "#room", {
    content: "replacement B\n",
    attachmentIds: [],
    idempotencyKey: "replacement-key-b",
    savedAt: Date.now(),
    reholdCount: 0,
  });

  let retryRequests = 0;
  const stderr: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerCliCommand(program, messageSendCommand, {
    io: {
      stdin: Readable.from([]),
      stdout: { write: () => true },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-reconcile",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => {
        retryRequests += 1;
        throw new Error("identity guard should reject before this request");
      },
    }) as never,
  });

  await assert.rejects(
    () => program.parseAsync([
      "node",
      "raft",
      "send",
      "--send-draft",
      "--expected-draft-key",
      originalKey,
      "--target",
      "#room",
    ]),
    /CliExit\(1\)/,
  );
  assert.equal(retryRequests, 0);
  assert.match(stderr.join(""), /no longer matches the expected idempotency key/i);
  assert.equal(getSavedDraft("agent-send-reconcile", "#room")?.content, "replacement B\n");
  assert.equal(getSavedDraft("agent-send-reconcile", "#room")?.idempotencyKey, "replacement-key-b");
});

test("identity-bound retry command sends when the expected draft key still matches", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-bound-retry-match-"));
  setSavedDraft("agent-bound-retry", "#room", {
    content: "original A\n",
    attachmentIds: [],
    idempotencyKey: "expected-key-a",
    savedAt: Date.now(),
    reholdCount: 0,
  });
  const bodies: Array<Record<string, unknown>> = [];
  const program = new Command();
  program.exitOverride();
  registerCliCommand(program, messageSendCommand, {
    io: {
      stdin: Readable.from([]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-bound-retry",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: Record<string, unknown>) => {
        bodies.push(body ?? {});
        return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "sent-a" } };
      },
    }) as never,
  });

  await program.parseAsync([
    "node",
    "raft",
    "send",
    "--send-draft",
    "--expected-draft-key",
    "expected-key-a",
    "--target",
    "#room",
  ]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.content, "original A\n");
  assert.equal(bodies[0]!.idempotencyKey, "expected-key-a");
  assert.equal(getSavedDraft("agent-bound-retry", "#room"), null);
});

test("message send does not replay when authoritative reconciliation is unavailable", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-reconcile-unavailable-"));
  const { ctx, bodies } = ambiguousSendHarness([
    preResponseTimeout(),
    { ok: false, status: 400, error: "unsupported field", data: null },
  ]);

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#room" }),
    (err: unknown) => err instanceof CliError && err.retryable === false && /CANNOT_CONFIRM/.test(err.suggestedNextAction ?? ""),
  );

  assert.equal(bodies.length, 2);
  const draft = getSavedDraft("agent-send-reconcile", "#room");
  assert.equal(draft?.idempotencyKey, bodies[0]!.idempotencyKey);
});

test("message send fails closed when reconciliation returns a non-authoritative state", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-reconcile-thin-"));
  const { ctx, bodies } = ambiguousSendHarness([
    { ok: false, status: 500, error: "failed after commit", data: null },
    { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "thin-old-receipt" } },
  ]);

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#room" }),
    (err: unknown) =>
      err instanceof CliError &&
      err.retryable === false &&
      err.draftSaved === true &&
      /CANNOT_CONFIRM/.test(err.suggestedNextAction ?? ""),
  );

  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.reconcileOnly, true);
  assert.equal(getSavedDraft("agent-send-reconcile", "#room")?.idempotencyKey, bodies[0]!.idempotencyKey);
});

test("a completed send does not clear a newer concurrent draft for the same target", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-concurrent-send-"));
  let resolveFirst!: (value: unknown) => void;
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  let requestCount = 0;
  const makeContext = (content: string) => createCommandContext({
    io: {
      stdin: Readable.from([content]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-concurrent-send",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => {
        requestCount += 1;
        if (requestCount === 1) return firstResponse;
        if (requestCount === 2) throw preResponseTimeout();
        return { ok: false, status: 503, error: "reconciliation unavailable", data: null };
      },
    }) as never,
  });

  const firstSend = messageSendCommand.handler(makeContext("first send\n"), [], { target: "#room" });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    async () => { await messageSendCommand.handler(makeContext("second send\n"), [], { target: "#room" }); },
    (err: unknown) => err instanceof CliError && err.retryable === false,
  );
  const secondDraft = getSavedDraft("agent-concurrent-send", "#room");
  assert.equal(secondDraft?.content, "second send\n");

  resolveFirst({ ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "first-1" } });
  await firstSend;
  assert.deepEqual(getSavedDraft("agent-concurrent-send", "#room"), secondDraft);
});

test("compare-and-clear across processes only removes the draft that still carries the expected key", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-cross-process-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = stateDir;
  const childArgs = ["--import", "@oxc-node/core/register", fileURLToPath(import.meta.url)];
  const spawnClearer = (releasePath: string, target: string) => {
    const child = spawn(process.execPath, [...childArgs, "--draft-lock-child=clear-when-released", stateDir, releasePath, target], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SLOCK_CLI_DRAFT_STATE_DIR: stateDir },
    });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const output = once(child.stdout, "data") as Promise<[Buffer]>;
    return { child, exit: once(child, "exit"), output, errors };
  };

  // The draft is replaced (new idempotency key) before the other process
  // clears with the old key: the clear must be a no-op — the newer draft
  // survives. This is the lost-update the compare half exists to prevent.
  setSavedDraft("agent-cross-process", "#room", {
    content: "draft A", attachmentIds: [], idempotencyKey: "key-a", savedAt: Date.now(), reholdCount: 0,
  });
  const skippedRelease = path.join(stateDir, "release-skip");
  const skipped = spawnClearer(skippedRelease, "#room");
  setSavedDraft("agent-cross-process", "#room", {
    content: "draft B", attachmentIds: [], idempotencyKey: "key-b", savedAt: Date.now(), reholdCount: 0,
  });
  fs.writeFileSync(skippedRelease, "release");
  assert.match((await skipped.output)[0].toString(), /SKIPPED/);
  const [skippedCode] = await skipped.exit;
  assert.equal(skippedCode, 0, Buffer.concat(skipped.errors).toString());
  assert.equal(getSavedDraft("agent-cross-process", "#room")?.idempotencyKey, "key-b");

  // The matching direction still works from another process: a draft that
  // kept its key is cleared exactly once.
  setSavedDraft("agent-cross-process", "#room2", {
    content: "draft C", attachmentIds: [], idempotencyKey: "key-a", savedAt: Date.now(), reholdCount: 0,
  });
  const clearedRelease = path.join(stateDir, "release-clear");
  const cleared = spawnClearer(clearedRelease, "#room2");
  fs.writeFileSync(clearedRelease, "release");
  assert.match((await cleared.output)[0].toString(), /CLEARED/);
  const [clearedCode] = await cleared.exit;
  assert.equal(clearedCode, 0, Buffer.concat(cleared.errors).toString());
  assert.equal(getSavedDraft("agent-cross-process", "#room2"), null);
});

test("concurrent cross-process writers all land in the ledger without corruption", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-concurrent-writers-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = stateDir;
  const childArgs = ["--import", "@oxc-node/core/register", fileURLToPath(import.meta.url)];
  const targets = ["#w1", "#w2", "#w3"];
  const writers = targets.map((target) => {
    const child = spawn(process.execPath, [...childArgs, "--draft-lock-child=writer", stateDir, target], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, SLOCK_CLI_DRAFT_STATE_DIR: stateDir },
    });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    return { target, exit: once(child, "exit"), errors };
  });
  setSavedDraft("agent-cross-process", "#w0", {
    content: "draft from writer #w0", attachmentIds: [], idempotencyKey: "key-#w0", savedAt: Date.now(), reholdCount: 0,
  });
  for (const writer of writers) {
    const [code] = await writer.exit;
    assert.equal(code, 0, Buffer.concat(writer.errors).toString());
  }
  for (const target of ["#w0", ...targets]) {
    const draft = getSavedDraft("agent-cross-process", target);
    assert.equal(draft?.content, `draft from writer ${target}`);
    assert.equal(draft?.idempotencyKey, `key-${target}`);
  }
});

test("message send forwards typed mention identity on the Agent API body", async () => {
  const { ctx, bodies, paths } = sendHarness(Readable.from(["hello @same_handle\n"]));
  await messageSendCommand.handler(ctx, [], {
    target: "#quiet",
    mention: ["agent:22222222-2222-4222-8222-222222222222:same_handle"],
  });
  assert.deepEqual(bodies[0]?.mentions, [{
    type: "agent",
    id: "22222222-2222-4222-8222-222222222222",
    name: "same_handle",
  }]);
  assert.equal(paths[0], "/internal/agent-api/v2/send");
});

function assertHeldDraftError(
  err: unknown,
  expected: { effect?: "draft_saved"; json?: boolean } = {},
): err is CliError {
  assert.ok(err instanceof CliError);
  assert.equal(err.code, "SEND_HELD_AS_DRAFT");
  assert.equal(err.effect, expected.effect ?? "draft_saved");
  assert.equal(err.retryable, false);
  assert.equal(err.draftSaved, true);
  if (expected.json) assert.equal(err.outputMode, "json");
  assert.match(err.suggestedNextAction ?? "", /Review the held context/);
  return true;
}

test("classifyMessageSendOutcome fails closed on unsupported send states", () => {
  assert.equal(classifyMessageSendOutcome({ state: "sent", ok: true, messageId: "m1" }).kind, "sent");
  assert.equal(classifyMessageSendOutcome({ state: "held", newMessageCount: 1 }).kind, "held");
  assert.throws(
    () => classifyMessageSendOutcome({ state: "queued_for_review", messageId: "m2" }),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === "INVALID_JSON_RESPONSE" &&
      err.message.includes("queued_for_review"),
  );
});

test("message send failure draft wrapper preserves existing CliError fields", () => {
  const details = { status: 503, route: "/internal/agent-api/messages" };
  const effectState = {
    targetPath: "/tmp/raft-draft",
    targetCommitted: false,
    tempFileCreated: true,
  };
  const original = new CliError({
    code: "PROXY_5XX",
    message: "daemon proxy failed",
    exitCode: 7,
    suggestedNextAction: "Check the local daemon health.",
    textDetailMode: "omit_restated_lines",
    effect: "message_queued",
    layer: "local_daemon_proxy",
    correlationId: "corr-123",
    proxyFailureClass: "pre_response_transport",
    proxyCauseCode: "UND_ERR_CONNECT_TIMEOUT",
    proxyRouteFamily: "agent-api/send",
    proxyUpstreamLayer: "tcp",
    proxyUpstreamStatus: 502,
    proxyResponseStarted: false,
    proxyResponseComplete: false,
    retryable: false,
    faultDomain: "proxy:send",
    effectState,
    details,
    outputMode: "json",
  });

  const wrapped = markSendFailureDraftSaved(original, true);

  assert.ok(wrapped instanceof CliError);
  assert.notEqual(wrapped, original);
  assert.equal(wrapped.code, "PROXY_5XX");
  assert.equal(wrapped.message, "daemon proxy failed");
  assert.equal(wrapped.exitCode, 7);
  assert.equal(wrapped.suggestedNextAction, "Check the local daemon health.");
  // Pins the rebuild branch's textDetailMode forwarding (send.ts). Without this the
  // field is the one entry the enumeration omits: deleting the forwarding line stays
  // green. @Kaiming flagged the missing tooth on PR #7028; the branch is reached, not
  // dead (forcing the early return turns 5 tests red), so the drop would be silent.
  assert.equal(wrapped.textDetailMode, "omit_restated_lines");
  assert.equal(wrapped.draftSaved, true);
  assert.equal(wrapped.effect, "message_queued");
  assert.equal(wrapped.layer, "local_daemon_proxy");
  assert.equal(wrapped.correlationId, "corr-123");
  assert.equal(wrapped.proxyFailureClass, "pre_response_transport");
  assert.equal(wrapped.proxyCauseCode, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(wrapped.proxyRouteFamily, "agent-api/send");
  assert.equal(wrapped.proxyUpstreamLayer, "tcp");
  assert.equal(wrapped.proxyUpstreamStatus, 502);
  assert.equal(wrapped.proxyResponseStarted, false);
  assert.equal(wrapped.proxyResponseComplete, false);
  assert.equal(wrapped.retryable, false);
  assert.equal(wrapped.fault_domain, "proxy:send");
  assert.deepEqual(wrapped.effect_state, effectState);
  assert.deepEqual(wrapped.details, details);
  assert.equal(wrapped.outputMode, "json");
});

test("message send received 5xx keeps the draft and reports unknown when reconciliation is unavailable", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-5xx-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-5xx-"));
  recordConsumedSeqs("agent-send-5xx", { "#room": 77 });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdin: Readable.from(["send body\n"]),
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
  } as never;

  const program = new Command();
  program.exitOverride();
  registerCliCommand(program, messageSendCommand, {
    io,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-5xx",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => ({
        ok: false,
        status: 502,
        error: "failed to proxy local agent request",
        data: null,
      }),
    }) as never,
  });

  await assert.rejects(
    () => program.parseAsync(["node", "raft", "send", "--target", "#room"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.match(rendered, /Error: failed to proxy local agent request/);
  assert.match(rendered, /Code: SERVER_5XX/);
  assert.match(rendered, /Draft saved: yes/);
  assert.match(rendered, /UNKNOWN/);
  assert.match(rendered, /CANNOT_CONFIRM/);
  assert.match(rendered, /Do not resend/);
  const draft = getSavedDraft("agent-send-5xx", "#room");
  assert.equal(draft?.content, "send body\n");
  assert.deepEqual(draft?.attachmentIds, []);
  assert.equal(draft?.seenUpToSeq, 77);
});

test("message send transport ambiguity keeps the draft and fails closed as not retryable", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-transport-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-transport-"));
  recordConsumedSeqs("agent-send-transport", { "#room": 77 });

  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["send body\n"]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-transport",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => {
        throw new Error("socket closed before an authoritative response");
      },
    }) as never,
  });

  await assert.rejects(
    async () => { await messageSendCommand.handler(ctx, [], { target: "#room" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CHECK_FAILED");
      assert.equal(err.fault_domain, "agent_api_transport");
      assert.equal(err.draftSaved, true);
      assert.equal(err.retryable, false);
      assert.match(err.suggestedNextAction ?? "", /UNKNOWN/);
      assert.match(err.suggestedNextAction ?? "", /CANNOT_CONFIRM/);
      assert.match(err.suggestedNextAction ?? "", /Do not resend/);
      return true;
    },
  );
  assert.equal(getSavedDraft("agent-send-transport", "#room")?.content, "send body\n");
});

test("message send-draft received 5xx retains the draft and reports unknown when reconciliation is unavailable", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-draft-5xx-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-draft-5xx-"));
  setSavedDraft("agent-send-draft-5xx", "#room", {
    content: "saved body\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
    seenUpToSeq: 77,
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdin: Readable.from([]),
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
  } as never;

  const program = new Command();
  program.exitOverride();
  registerCliCommand(program, messageSendCommand, {
    io,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-draft-5xx",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => ({
        ok: false,
        status: 502,
        error: "failed to proxy local agent request",
        data: null,
      }),
    }) as never,
  });

  await assert.rejects(
    () => program.parseAsync(["node", "raft", "send", "--send-draft", "--target", "#room"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.match(rendered, /Error: failed to proxy local agent request/);
  assert.match(rendered, /Code: SERVER_5XX/);
  assert.match(rendered, /Draft saved: yes/);
  assert.match(rendered, /UNKNOWN/);
  assert.match(rendered, /CANNOT_CONFIRM/);
  assert.match(rendered, /Do not resend/);
  assert.equal(getSavedDraft("agent-send-draft-5xx", "#room")?.content, "saved body\n");
});

test("freshness hold recovery sends the saved draft with open empty non-TTY stdin", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-draft-open-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-draft-open-"));
  recordConsumedSeqs("agent-send-draft-open", { "#room": 77 });

  const bodies: Array<Record<string, unknown>> = [];
  const effects: string[] = [];
  let sendCount = 0;
  let recoveryStdin: PassThrough | undefined;
  const createApiClient = () => ({
    request: async (_method: string, path: string, body?: Record<string, unknown>) => {
      // The held send reads the agent context for the continuation pilot flag; this Server has none.
      if (path === "/internal/agent-api/context") return { ok: false, status: 404, error: "not found", data: null };
      effects.push("api");
      bodies.push(body ?? {});
      sendCount += 1;
      if (sendCount === 1) {
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            state: "held",
            newMessageCount: 1,
            shownMessageCount: 1,
            omittedMessageCount: 0,
            seenUpToSeq: 78,
            heldMessages: [{ seq: 78, id: "msg78", senderName: "alice", content: "new context" }],
          },
        };
      }
      assert.ok(recoveryStdin);
      recoveryStdin.destroy(new Error("late input failure during send"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        ok: true,
        status: 200,
        error: null,
        data: { ok: true, state: "sent", messageId: "message-1" },
      };
    },
  }) as never;
  const agentContext = {
    agentId: "agent-send-draft-open",
    serverUrl: "http://stub.local",
    clientMode: "self-hosted-runner",
    profileSlug: "t",
  } as never;

  const firstCtx = createCommandContext({
    io: {
      stdin: Readable.from(["saved body\n"]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient,
  });
  await assert.rejects(
    async () => messageSendCommand.handler(firstCtx, [], { target: "#room" }),
    assertHeldDraftError,
  );
  assert.equal(getSavedDraft("agent-send-draft-open", "#room")?.content, "saved body\n");
  effects.length = 0;

  const openEmptyStdin = new PassThrough();
  recoveryStdin = openEmptyStdin;
  const stderr: string[] = [];
  const startedAt = performance.now();
  try {
    const secondCtx = createCommandContext({
      io: {
        stdin: openEmptyStdin,
        stdout: { write: () => true },
        stderr: {
          write: (chunk: string | Uint8Array) => {
            const rendered = String(chunk);
            stderr.push(rendered);
            effects.push(`stderr:${rendered}`);
            return true;
          },
        },
      } as never,
      env: {},
      loadAgentContext: () => agentContext,
      createApiClient,
    });
    await messageSendCommand.handler(secondCtx, [], { target: "#room", sendDraft: true });
  } finally {
    openEmptyStdin.destroy();
  }

  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 900, `send-draft returned before the 1000ms observation window: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 5_000, `send-draft exceeded its bounded observation window: ${elapsedMs}ms`);
  assert.deepEqual(stderr, [
    "No stdin bytes were detected within 1000ms; the stored draft will now be sent.\n",
  ]);
  assert.deepEqual(effects, [
    "stderr:No stdin bytes were detected within 1000ms; the stored draft will now be sent.\n",
    "api",
  ]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]!.content, "saved body\n");
  assert.equal(bodies[1]!.content, "saved body\n");
  assert.equal(bodies[1]!.sendDraft, true);
  assert.equal(bodies[1]!.seenUpToSeq, 78);
  assert.equal(getSavedDraft("agent-send-draft-open", "#room"), null);
});

test("message send-draft re-hold exits nonzero and retains the draft without target effect", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-draft-rehold-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-draft-rehold-"));
  setSavedDraft("agent-send-draft-rehold", "#room", {
    content: "saved body\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
    seenUpToSeq: 77,
  });

  const bodies: Array<Record<string, unknown>> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerCliCommand(program, messageSendCommand, {
    io: {
      stdin: Readable.from([]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-draft-rehold",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: Record<string, unknown>) => {
        bodies.push(body ?? {});
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            state: "held",
            newMessageCount: 1,
            shownMessageCount: 1,
            omittedMessageCount: 0,
            seenUpToSeq: 78,
            heldMessages: [{ seq: 78, id: "msg78", senderName: "alice", content: "new context" }],
          },
        };
      },
    }) as never,
  });

  await assert.rejects(
    () => program.parseAsync(["node", "raft", "send", "--send-draft", "--target", "#room"]),
    /CliExit\(1\)/,
  );

  assert.equal(typeof bodies[0]!.idempotencyKey, "string");
  const { idempotencyKey: _idempotencyKey, ...sentBody } = bodies[0]!;
  assert.deepEqual(sentBody, {
    target: "#room",
    content: "saved body\n",
    draftReholdCount: 1,
    seenUpToSeq: 77,
    sendDraft: true,
  });
  assert.match(stdout.join(""), /Held — /);
  assert.match(stdout.join(""), /Your message has been saved as a draft/);
  assert.doesNotMatch(stdout.join(""), /Message sent|Message queued/);
  const rendered = stderr.join("");
  assert.match(rendered, /Code: SEND_HELD_AS_DRAFT/);
  assert.match(rendered, /Retryable: no/);
  // task #264: the held text above already states the effect and lists both
  // recovery commands, so these labelled restatements are omitted from TEXT.
  // The fields themselves are unchanged, so JSON still carries them.
  assert.doesNotMatch(rendered, /Effect: draft_saved/);
  assert.doesNotMatch(rendered, /Draft saved:/);
  assert.doesNotMatch(rendered, /Next action:/);
  assert.equal(getSavedDraft("agent-send-draft-rehold", "#room")?.content, "saved body\n");
  assert.equal(getSavedDraft("agent-send-draft-rehold", "#room")?.reholdCount, 2);
});

test("message send-draft rejects a genuinely non-empty stdin pipe before sending", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-draft-pipe-"));
  setSavedDraft("agent-send-draft-pipe", "#room", {
    content: "saved body\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
    seenUpToSeq: 77,
  });

  let requestCount = 0;
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["replacement body\n"]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-draft-pipe",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => {
        requestCount += 1;
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true, state: "sent", messageId: "message-1" },
        };
      },
    }) as never,
  });

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#room", sendDraft: true }),
    (err: unknown) =>
      err instanceof CliError &&
      (err as unknown as { code: string }).code === "SEND_DRAFT_STDIN_UNSUPPORTED",
  );
  assert.equal(requestCount, 0);
  assert.equal(getSavedDraft("agent-send-draft-pipe", "#room")?.content, "saved body\n");
});

test("message send-draft rejects delayed stdin bytes before the deadline with zero API calls", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-draft-delayed-pipe-"));
  setSavedDraft("agent-send-draft-delayed-pipe", "#room", {
    content: "saved body\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
    seenUpToSeq: 77,
  });

  const input = new PassThrough();
  const timer = setTimeout(() => input.end("replacement body\n"), 25);
  let requestCount = 0;
  const ctx = createCommandContext({
    io: {
      stdin: input,
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-draft-delayed-pipe",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => {
        requestCount += 1;
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true, state: "sent", messageId: "message-1" },
        };
      },
    }) as never,
  });

  try {
    await assert.rejects(
      async () => messageSendCommand.handler(ctx, [], { target: "#room", sendDraft: true }),
      (err: unknown) =>
        err instanceof CliError &&
        (err as unknown as { code: string }).code === "SEND_DRAFT_STDIN_UNSUPPORTED",
    );
  } finally {
    clearTimeout(timer);
    input.destroy();
  }
  assert.equal(requestCount, 0);
  assert.equal(
    getSavedDraft("agent-send-draft-delayed-pipe", "#room")?.content,
    "saved body\n",
  );
});

test("message send-draft rejects stdin errors before the deadline with zero API calls", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-draft-input-error-"));
  setSavedDraft("agent-send-draft-input-error", "#room", {
    content: "saved body\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
    seenUpToSeq: 77,
  });

  const input = new PassThrough();
  const timer = setTimeout(() => input.destroy(new Error("early input failure")), 25);
  let requestCount = 0;
  const ctx = createCommandContext({
    io: {
      stdin: input,
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-draft-input-error",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => {
        requestCount += 1;
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true, state: "sent", messageId: "message-1" },
        };
      },
    }) as never,
  });

  try {
    await assert.rejects(
      async () => messageSendCommand.handler(ctx, [], { target: "#room", sendDraft: true }),
      (err: unknown) =>
        err instanceof CliError &&
        (err as unknown as { code: string }).code === "INTERNAL_BUG" &&
        err.message.includes("early input failure"),
    );
  } finally {
    clearTimeout(timer);
    input.destroy();
  }
  assert.equal(requestCount, 0);
  assert.equal(
    getSavedDraft("agent-send-draft-input-error", "#room")?.content,
    "saved body\n",
  );
});

test("send auto-attests the per-target consumed cursor (gate 1, client side)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = tmp;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet": 77 });

  const { ctx, bodies } = sendHarness();
  await messageSendCommand.handler(ctx, [], { target: "#quiet" });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.seenUpToSeq, 77);
});

test("send trims the target before looking up the consumed cursor", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-trim-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = tmp;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-trim-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet": 77 });

  const { ctx, bodies, stdout } = sendHarness();
  await messageSendCommand.handler(ctx, [], { target: "  #quiet  " });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.target, "#quiet");
  assert.equal(bodies[0]!.seenUpToSeq, 77);
  const output = stdout.join("");
  assert.match(output, /Message sent to #quiet/);
  assert.doesNotMatch(output, /Undelivered mentions|status=not_queued|unresolved_or_not_visible/);
});

test("read→send handoff attests the returned history boundary", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-read-send-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-read-send-"));
  const agentContext = {
    agentId: "agent-send-attest",
    serverUrl: "http://stub.local",
    clientMode: "self-hosted-runner",
    profileSlug: "t",
  } as never;

  const readCtx = createCommandContext({
    io: { stdout: { write: () => true }, stderr: { write: () => true } } as never,
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async () => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          messages: [
            { seq: 101, id: "message-101", senderName: "tygg", content: "older" },
            { seq: 105, id: "message-105", senderName: "tygg", content: "latest body handed to the agent" },
          ],
          has_more: false,
          has_older: false,
          has_newer: false,
          last_read_seq: 100,
          model_seen_up_to_seq: 105,
        },
      }),
    }) as never,
  });
  await messageReadCommand.handler(readCtx, { channel: "#quiet", after: "100" });

  const bodies: Array<Record<string, unknown>> = [];
  const sendCtx = createCommandContext({
    io: {
      stdin: Readable.from(["reply after reading\n"]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_m: string, _p: string, body?: Record<string, unknown>) => {
        bodies.push(body ?? {});
        return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m1" } };
      },
    }) as never,
  });
  await messageSendCommand.handler(sendCtx, [], { target: "#quiet" });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.seenUpToSeq, 105);
});

test("read B → read higher seq in A → send B keeps B's own boundary", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-read-cross-target-send-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-read-cross-target-send-"));
  const agentContext = {
    agentId: "agent-send-attest",
    serverUrl: "http://stub.local",
    clientMode: "self-hosted-runner",
    profileSlug: "t",
  } as never;

  const readTarget = async (target: string, seq: number) => {
    const readCtx = createCommandContext({
      io: { stdout: { write: () => true }, stderr: { write: () => true } } as never,
      env: {},
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async () => ({
          ok: true,
          status: 200,
          error: null,
          data: {
            target,
            // Real history rows do not carry channel identity. The resolver's
            // top-level target is the only authority for this evidence key.
            messages: [{ seq, id: `message-${seq}`, content: `body ${seq}` }],
            has_more: false,
            has_older: false,
            has_newer: false,
            model_seen_up_to_seq: seq,
          },
        }),
      }) as never,
    });
    await messageReadCommand.handler(readCtx, { target });
  };

  // B was read at 100. A later message can arrive in B server-side without
  // changing this local evidence; reading globally newer A at 500 must not
  // upgrade B's attestation and let that stale send bypass the server hold.
  await readTarget("#beta", 100);
  await readTarget("#alpha", 500);

  const { ctx, bodies } = sendHarness();
  await messageSendCommand.handler(ctx, [], { target: "#beta" });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.seenUpToSeq, 100, "target A's seq 500 must prove nothing about target B");
});

test("read→send handoff isolates parent channel and thread targets", async () => {
  const threadTarget = "#quiet:abcd1234";

  {
    process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-parent-"));
    process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-thread-parent-"));
    recordConsumedSeqs("agent-send-attest", { [threadTarget]: 105 });

    const { ctx, bodies } = sendHarness();
    await assert.rejects(
      async () => messageSendCommand.handler(ctx, [], { target: "#quiet" }),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED" &&
        err.draftSaved === true,
    );
    assert.equal(bodies.length, 0);
    assert.equal(
      getSavedDraft("agent-send-attest", "#quiet")?.seenUpToSeq,
      undefined,
      "reading a thread must not be persisted as the parent channel's freshness boundary",
    );
  }

  {
    process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-parent-thread-"));
    process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-parent-thread-"));
    recordConsumedSeqs("agent-send-attest", { "#quiet": 205 });

    const { ctx, bodies } = sendHarness();
    await messageSendCommand.handler(ctx, [], { target: threadTarget });
    assert.equal(bodies.length, 1);
    assert.equal(
      "seenUpToSeq" in bodies[0]!,
      false,
      "reading a parent channel must not satisfy a thread target's freshness boundary",
    );
  }
});

test("thread-context parent send asks for confirmation and saves a draft without posting", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-confirm-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-thread-confirm-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:abcd1234": 105 });

  const { ctx, bodies } = sendHarness();
  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#quiet" }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED");
      assert.match(err.message, /Possible thread target mismatch/);
      assert.match(err.message, /latest read context under #quiet is #quiet:abcd1234/);
      assert.match(err.message, /top-level channel message is intentional/);
      assert.match(err.message, /raft message send --send-draft --target "#quiet"/);
      assert.equal(err.draftSaved, true, "handler-level error is decorated by command wrapper");
      return true;
    },
  );

  assert.equal(bodies.length, 0, "confirmation must stop before the send API call");
  const draft = getSavedDraft("agent-send-attest", "#quiet");
  assert.equal(draft?.content, "hello from test\n");
});

test("thread-context parent send allows explicit target confirmation without sending a draft", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-target-confirmed-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-thread-target-confirmed-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:abcd1234": 105 });

  const { ctx, bodies } = sendHarness();
  await messageSendCommand.handler(ctx, [], { target: "#quiet", targetConfirmed: true });

  assert.equal(bodies.length, 1, "explicit target confirmation is the audited non-interactive escape");
  assert.equal(bodies[0]!.target, "#quiet");
  assert.equal(bodies[0]!.content, "hello from test\n");
  assert.equal(
    getSavedDraft("agent-send-attest", "#quiet"),
    null,
    "target-confirmed sends directly and must not rely on saved-draft replay",
  );
});

test("thread-context parent send parses --target-confirmed from cron-shaped argv", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-target-confirmed-argv-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-thread-target-confirmed-argv-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:abcd1234": 105 });

  const bodies: Array<Record<string, unknown>> = [];
  const program = new Command();
  program.exitOverride();
  registerCliCommand(program, messageSendCommand, {
    io: {
      stdin: Readable.from(["cron body\n"]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-attest",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async (_m: string, _p: string, body?: Record<string, unknown>) => {
        bodies.push(body ?? {});
        return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m1" } };
      },
    }) as never,
  });

  await program.parseAsync(["node", "raft", "send", "--target", "#quiet", "--target-confirmed"]);

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.target, "#quiet");
  assert.equal(bodies[0]!.content, "cron body\n");
});

test("thread-context parent send confirmation preempts server freshness holds", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-before-hold-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-thread-before-hold-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:abcd1234": 105 });

  const { ctx, bodies } = sendHarness();
  ctx.createApiClient = () => ({
    request: async (_m: string, _p: string, body?: Record<string, unknown>) => {
      bodies.push(body ?? {});
      return {
        ok: true,
        status: 200,
        error: null,
        data: {
          ok: true,
          state: "held",
          seenUpToSeq: 200,
          freshnessHold: {
            reason: "stale_model_seen",
            target: "#quiet",
            latestMessages: [],
            latestCount: 0,
          },
        },
      };
    },
  }) as never;

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#quiet" }),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
  );

  assert.equal(bodies.length, 0, "thread confirmation must stop before the server can issue a freshness hold");
  const draft = getSavedDraft("agent-send-attest", "#quiet");
  assert.equal(draft?.content, "hello from test\n");
  assert.equal(draft?.reholdCount, 0);
});

test("thread-context parent send confirmation is bypassed only by sending the saved draft", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-confirm-send-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-thread-confirm-send-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:abcd1234": 105 });
  setSavedDraft("agent-send-attest", "#quiet", {
    content: "top-level summary\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 0,
  });

  const { ctx, bodies } = sendHarness(Readable.from([]));
  await messageSendCommand.handler(ctx, [], { target: "#quiet", sendDraft: true });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.target, "#quiet");
  assert.equal(bodies[0]!.content, "top-level summary\n");
  assert.equal(bodies[0]!.sendDraft, true);
});

test("thread-context parent send confirmation uses the existing single target draft slot", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-single-draft-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-thread-single-draft-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:abcd1234": 105 });
  setSavedDraft("agent-send-attest", "#quiet", {
    content: "previous held draft\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 2,
    seenUpToSeq: 77,
  });

  const { ctx } = sendHarness(Readable.from(["new confirmed draft\n"]));
  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#quiet" }),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
  );

  const draft = getSavedDraft("agent-send-attest", "#quiet");
  assert.equal(draft?.content, "new confirmed draft\n");
  assert.equal(draft?.reholdCount, 2, "the existing draft slot is replaced, while its hold count is retained");
  assert.equal(draft?.seenUpToSeq, 77, "the prior draft boundary still wins over a thread cursor");
});

test("thread-context parent send confirmation warns before replacing an existing draft", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-draft-warning-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-thread-warning-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:abcd1234": 105 });
  setSavedDraft("agent-send-attest", "#quiet", {
    content: "previous held draft\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 0,
    seenUpToSeq: 77,
  });

  const { ctx, bodies, stderr } = sendHarness(Readable.from(["new confirmed draft\n"]));
  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#quiet" }),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
  );

  assert.equal(bodies.length, 0, "confirmation must still stop before the send API call");
  assert.match(stderr.join(""), /Warning: replacing an unsent draft for #quiet/);
  assert.match(stderr.join(""), /previous held draft/);
  assert.match(stderr.join(""), /Recovery file:/);
});

test("replacing a >400-character draft preserves the exact body in a private recovery file", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-replaced-draft-recovery-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = stateDirectory;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = stateDirectory;
  const previousBody = `first line\n${"x".repeat(640)}\n最後の行\n`;
  setSavedDraft("agent-send-attest", "#recovery", {
    content: previousBody,
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
  });

  const { ctx, bodies, stdout, stderr } = sendHarness(Readable.from(["replacement body\n"]));
  await messageSendCommand.handler(ctx, [], { target: "#recovery" });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.content, "replacement body\n");
  const diagnostic = stderr.join("");
  const recoveryMatch = diagnostic.match(/^Recovery file: (.+)$/mu);
  assert.ok(recoveryMatch, diagnostic);
  const recoveryPath = JSON.parse(recoveryMatch[1]!) as string;
  assert.equal(fs.readFileSync(recoveryPath, "utf8"), previousBody);
  assert.equal(fs.statSync(recoveryPath).mode & 0o077, 0, "recovery body must be user-private");
  assert.match(diagnostic, new RegExp(`Previous draft excerpt \\(${previousBody.length} chars\\):`));
  assert.doesNotMatch(diagnostic, /x{400}/u, "stderr must remain a bounded excerpt");
  assert.match(stdout.join(""), /Replaced an unsent draft/);
  assert.match(stdout.join(""), new RegExp(`Recovery file: ${JSON.stringify(recoveryPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a recovery write failure does not block the replacement send", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-replaced-draft-unwritable-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = stateDirectory;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = stateDirectory;
  const agentId = "agent-send-attest";
  setSavedDraft(agentId, "#recovery-fails", {
    content: "body whose recovery write will fail\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
  });
  const ledgerDirectory = path.dirname(resolveStateDbPath(agentId));
  fs.writeFileSync(path.join(ledgerDirectory, "replaced-drafts"), "blocks the history directory", { mode: 0o600 });

  const { ctx, bodies, stdout, stderr } = sendHarness(Readable.from(["replacement still sends\n"]));
  await messageSendCommand.handler(ctx, [], { target: "#recovery-fails" });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.content, "replacement still sends\n");
  assert.match(stderr.join(""), /Recovery copy: unavailable .*sending continued/u);
  assert.match(stdout.join(""), /Replaced an unsent draft\. Recovery copy: unavailable/u);
});

test("JSON success reports the replaced draft and recovery file structurally", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-replaced-draft-json-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = stateDirectory;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = stateDirectory;
  setSavedDraft("agent-send-attest", "#recovery-json", {
    content: "body archived for a JSON caller\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
  });

  const { ctx, stdout } = sendHarness(Readable.from(["replacement body\n"]));
  await messageSendCommand.handler(ctx, [], { target: "#recovery-json", json: true });

  const payload = JSON.parse(stdout.join("")) as {
    replacedDraft?: { replaced?: boolean; recoverySaved?: boolean; recoveryFile?: string };
  };
  assert.equal(payload.replacedDraft?.replaced, true);
  assert.equal(payload.replacedDraft?.recoverySaved, true);
  assert.equal(typeof payload.replacedDraft?.recoveryFile, "string");
  assert.equal(fs.readFileSync(payload.replacedDraft!.recoveryFile!, "utf8"), "body archived for a JSON caller\n");
});

test("replaced-draft recovery keeps a bounded history per target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-replaced-draft-retention-"));
  const env = { ...process.env, SLOCK_CLI_STATE_DIR: root };
  let newestPath = "";
  for (let index = 0; index < REPLACED_DRAFT_HISTORY_LIMIT + 3; index += 1) {
    newestPath = archiveReplacedDraft("agent-history", "#same-target", `body-${index}\n`, env);
  }

  const retained = fs.readdirSync(path.dirname(newestPath)).filter((name) => name.endsWith(".txt"));
  assert.equal(retained.length, REPLACED_DRAFT_HISTORY_LIMIT);
  assert.equal(fs.readFileSync(newestPath, "utf8"), `body-${REPLACED_DRAFT_HISTORY_LIMIT + 2}\n`);
});

test("thread-context parent send guard stays narrow around stale or exact thread targets", () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-narrow-"));
  recordConsumedSeqs("agent-send-attest", {
    "#quiet:abcd1234": 105,
    "#quiet": 120,
    "dm:@peer:thread1": 80,
    "dm:@peer": 90,
  });

  assert.equal(
    detectThreadContextParentSend("agent-send-attest", "#quiet"),
    null,
    "a newer parent-channel read means the thread context is no longer the latest known context",
  );
  assert.equal(
    detectThreadContextParentSend("agent-send-attest", "#quiet:abcd1234"),
    null,
    "sending to a thread is normal thread usage, not the covered parent-channel mismatch",
  );
  assert.equal(
    detectThreadContextParentSend("agent-send-attest", "dm:@peer"),
    null,
    "DM parent sends also avoid stale thread confirmations once the DM itself was read later",
  );
});

test("thread-context parent send guard clears after an explicit parent read with a lower seq", () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-parent-order-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:thread-a": 200 });
  recordConsumedSeqs("agent-send-attest", { "#quiet": 100 });

  assert.equal(
    detectThreadContextParentSend("agent-send-attest", "#quiet"),
    null,
    "latest local read target is parent even when its server seq is lower than the thread",
  );
});

test("thread-context parent send guard migrates legacy numeric state without treating seq as chronology", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-legacy-order-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = tmp;
  const statePath = path.join(
    tmp,
    "slock-cli-consumed-seq",
    "agent-send-attest",
    "consumed-seqs.json",
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      targets: {
        "#quiet": 150,
        "#quiet:legacy-thread": 200,
        "#other:legacy-thread": 300,
      },
    }),
    { mode: 0o600 },
  );

  assert.equal(getConsumedSeq("agent-send-attest", "#quiet"), 150);
  assert.equal(getConsumedSeq("agent-send-attest", "#quiet:legacy-thread"), 200);
  assert.equal(getConsumedSeq("agent-send-attest", "#other:legacy-thread"), 300);
  assert.equal(getConsumedSeq("agent-send-attest", "#missing"), undefined);
  assert.deepEqual(
    detectThreadContextParentSend("agent-send-attest", "#quiet"),
    {
      parentTarget: "#quiet",
      threadTarget: "#quiet:legacy-thread",
      threadSeq: 200,
    },
    "legacy numeric records fall back to seq ordering before any new read-order marker exists",
  );

  recordConsumedRead("agent-send-attest", "#quiet", 100);

  assert.equal(getConsumedSeq("agent-send-attest", "#quiet"), 150);
  assert.equal(
    detectThreadContextParentSend("agent-send-attest", "#quiet"),
    null,
    "a later low-seq parent read clears legacy thread context without regressing seenUpToSeq",
  );
});

test("thread-context parent send guard chooses the last-read sibling thread, not the highest-seq thread", () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-sibling-order-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:thread-a": 200 });
  recordConsumedSeqs("agent-send-attest", { "#quiet:thread-b": 150 });

  assert.deepEqual(
    detectThreadContextParentSend("agent-send-attest", "#quiet"),
    {
      parentTarget: "#quiet",
      threadTarget: "#quiet:thread-b",
      threadSeq: 150,
    },
    "latest local read thread must win even when an older-read sibling has a higher server seq",
  );
});

test("thread-context parent send guard clears after an explicit empty parent read", () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-thread-empty-parent-"));
  recordConsumedSeqs("agent-send-attest", { "#quiet:thread-a": 200 });
  recordConsumedRead("agent-send-attest", "#quiet");

  assert.equal(getConsumedSeq("agent-send-attest", "#quiet"), undefined);
  assert.equal(
    detectThreadContextParentSend("agent-send-attest", "#quiet"),
    null,
    "empty parent reads still make the parent the latest local context without fabricating seenUpToSeq",
  );
});

test("thread-context parent send message states the intentional top-level escape", () => {
  assert.equal(
    formatThreadContextParentSendMessage("#quiet", { target: "#quiet:abcd1234", seq: 105 }),
    [
      "Possible thread target mismatch: your latest read context under #quiet is #quiet:abcd1234, but this send targets #quiet top-level.",
      "This guard is intentionally narrow: moving a thread conclusion to the parent channel can be correct, but it is uncommon enough to confirm once.",
      "",
      "If this reply belongs in the thread, send the message to the thread target instead:",
      "  raft message send --target \"#quiet:abcd1234\" <<'RAFTMSG'",
      "  message body",
      "  RAFTMSG",
      "",
      "If the top-level channel message is intentional, send the saved draft unchanged:",
      "  raft message send --send-draft --target \"#quiet\"",
    ].join("\n"),
  );
});

test("send never borrows a different target's cursor (gate 3, client side)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = tmp;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-"));
  recordConsumedSeqs("agent-send-attest", { "#busy": 500 });

  const { ctx, bodies } = sendHarness();
  await messageSendCommand.handler(ctx, [], { target: "#never-read" });
  assert.equal(bodies.length, 1);
  assert.equal("seenUpToSeq" in bodies[0]!, false, "unconsumed target must omit seenUpToSeq (fail-closed)");
});

test("send ignores legacy #undefined alias collapse instead of borrowing another target's cursor", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-poisoned-send-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = tmp;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-poisoned-send-"));
  const statePath = path.join(
    tmp,
    "slock-cli-consumed-seq",
    "agent-send-attest",
    "consumed-seqs.json",
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    targets: { "#undefined": { seq: 900, readOrder: 20 } },
    aliases: { "#busy": "#undefined", "#never-read": "#undefined" },
    nextReadOrder: 21,
  }), { mode: 0o600 });

  const { ctx, bodies } = sendHarness();
  await messageSendCommand.handler(ctx, [], { target: "#never-read" });

  assert.equal(bodies.length, 1);
  assert.equal(
    "seenUpToSeq" in bodies[0]!,
    false,
    "a poisoned cross-target alias must fail closed instead of attesting seq 900",
  );
});

test("hold-issued draft boundary takes priority over the local cursor (gate 4)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = tmp;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-"));
  recordConsumedSeqs("agent-send-attest", { "#room": 50 });
  setSavedDraft("agent-send-attest", "#room", {
    content: "draft body",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
    seenUpToSeq: 60,
  });

  const { ctx, bodies } = sendHarness();
  await messageSendCommand.handler(ctx, [], { target: "#room" });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.seenUpToSeq, 60, "draft boundary (from the hold response) must win");
});

test("a hold-issued draft boundary is a floor: reads after the hold that move the cursor past it still count", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-"));
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = tmp;
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-"));
  // Held at 60; the draft keeps that boundary.
  recordConsumedSeqs("agent-send-attest", { "#room": 60 });
  setSavedDraft("agent-send-attest", "#room", {
    content: "draft body",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
    seenUpToSeq: 60,
  });
  // A sparse read sees 75 and 80, then a contiguous read moves the cursor to
  // 80, folding those exact seqs into the cursor.
  recordConsumedExactSeqs("agent-send-attest", { "#room": [75, 80] });
  recordConsumedSeqs("agent-send-attest", { "#room": 80 });

  for (const sendDraft of [false, true]) {
    const { ctx, bodies } = sendHarness(sendDraft ? Readable.from([]) : undefined);
    await messageSendCommand.handler(ctx, [], sendDraft ? { target: "#room", sendDraft: true } : { target: "#room" });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.seenUpToSeq, 80, `sendDraft=${sendDraft}: the read after the hold must be attested`);
    setSavedDraft("agent-send-attest", "#room", {
      content: "draft body",
      attachmentIds: [],
      savedAt: Date.now(),
      reholdCount: 1,
      seenUpToSeq: 60,
    });
  }
});

// --- model-seen boundary note: `message check` can return a sparse event
// batch, especially around @mention/wake delivery. A high seq in that batch
// must not become a per-target `seenUpToSeq` boundary; otherwise older unseen
// messages in the same target can be buried as model-seen. ---
import { messageCheckCommand } from "./check";

test("check→send attests sparse event-drain seqs exactly, never as a high-water boundary", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-align-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-align-"));

  const agentContext = {
    agentId: "agent-key-align",
    serverUrl: "http://stub.local",
    clientMode: "self-hosted-runner",
    profileSlug: "t",
  } as never;

  // 1. check: inbox returns a DM message and a thread message.
  const checkCtx = createCommandContext({
    io: { stdout: { write: () => true }, stderr: { write: () => true } } as never,
    env: {},
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string) => ({
        ok: true,
        status: 200,
        error: null,
        data: method === "GET" ? {
          events: [
            {
              channel_type: "dm",
              channel_name: "peer",
              content: "dm body",
              seq: 101,
              message_id: "m-dm",
              timestamp: new Date(0).toISOString(),
              sender_type: "human",
              sender_name: "peer",
            },
            {
              channel_type: "thread",
              channel_name: "thread-abcd1234",
              parent_channel_type: "channel",
              parent_channel_name: "general",
              content: "thread body",
              seq: 202,
              message_id: "m-th",
              timestamp: new Date(0).toISOString(),
              sender_type: "human",
              sender_name: "peer",
            },
          ],
          last_seen_msgId: "m-th",
          last_seen_seq: 202,
          reply_target: null,
          pending_notice_ids: [],
          wake_reason: null,
          has_more: false,
        } : {},
      }),
    }) as never,
  });
  await messageCheckCommand.handler(checkCtx, {});

  // 2. send to the exact targets an agent would copy from the check output.
  for (const [target, expectedSeq] of [["dm:@peer", 101], ["#general:abcd1234", 202]] as const) {
    const bodies: Array<Record<string, unknown>> = [];
    const sendCtx = createCommandContext({
      io: {
        stdin: Readable.from(["reply body\n"]),
        stdout: { write: () => true },
        stderr: { write: () => true },
      } as never,
      env: {},
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (_m: string, _p: string, body?: Record<string, unknown>) => {
          bodies.push(body ?? {});
          return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "m1" } };
        },
      }) as never,
    });
    await messageSendCommand.handler(sendCtx, [], { target });
    assert.equal(bodies.length, 1, `${target}: send should hit the API once`);
    assert.equal(
      "seenUpToSeq" in bodies[0]!,
      false,
      `${target}: sparse check seq ${expectedSeq} must not be attested as a high-water model-seen boundary`,
    );
    assert.deepEqual(
      bodies[0]!.seenExactSeqs,
      [expectedSeq],
      `${target}: send must identify only the sparse body that check actually rendered`,
    );
  }
});

test("send renders pending mention actions only on sent responses", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-mention-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-mention-"));
  recordConsumedSeqs("agent-send-attest", { "#room": 77 });

  const { ctx, stdout, stderr } = sendHarness();
  ctx.createApiClient = () => ({
    request: async () => ({
      ok: true,
      status: 200,
      error: null,
      data: {
        ok: true,
        state: "sent",
        messageId: "message-1",
        pendingMentionActions: [{
          resolutionId: PENDING_ACTION_ID,
          messageId: "message-1",
          targetType: "agent",
          targetHandle: "xxchan",
          targetDisplayName: "我是笑笑",
          reason: "Target is not in #room and was not notified.",
          availableActions: ["notify"],
          expiresAt: "2026-07-29T05:13:06.368Z",
        }],
      },
    }),
  }) as never;

  // The message is committed, so a partial result exits 0.
  await messageSendCommand.handler(ctx, [], { target: "#room" });

  const out = stdout.join("");
  assert.equal(stdout.length, 1, "the partial result and queued receipt must use one deterministic buffer");
  assert.equal(out.indexOf("Undelivered mentions"), 0, "partial warning must lead the deterministic stdout result");
  assert.match(out, /Message effect: status=queued/);
  assert.match(out, /Do not rerun `raft message send`/);
  assert.match(out, /@xxchan — status=not_queued/);
  assert.doesNotMatch(out, /我是笑笑/);
  assert.match(out, /reason: not_in_conversation/);
  assert.match(out, /consequence: This @mention did not notify anyone\./);
  assert.match(out, new RegExp(`pending action: ${PENDING_ACTION_ID}`));
  assert.match(out, /expires: 2026-07-29T05:13:06\.368Z/);
  assert.match(out, new RegExp(`recovery: raft mention notify ${PENDING_ACTION_ID}`));
  assert.match(out, /Message queued to #room\. Message ID: message-1/);
  assert.doesNotMatch(out, /Message sent|message status=(?:delivered|acked|seen|read)/);
  assert.doesNotMatch(out, /Target is not in #room/);
  assert.match(out, /does not prove the person left the server/);
  assert.match(out, /notify exits nonzero unless the target queue accepts/);
  assert.doesNotMatch(out, /raft mention add/);
  assert.equal(stderr.join(""), "");
  assert.equal(
    getSavedDraft("agent-send-attest", "#room"),
    null,
    "mention partials are reported after the queued send clears the draft",
  );

  let duplicateSendCount = 0;
  const resendCtx = createCommandContext({
    io: {
      stdin: Readable.from([]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-attest",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => {
        duplicateSendCount += 1;
        return { ok: true, status: 200, error: null, data: { ok: true, state: "sent", messageId: "duplicate" } };
      },
    }) as never,
  });

  await assert.rejects(
    async () => messageSendCommand.handler(resendCtx, [], { target: "#room", sendDraft: true }),
    (err: unknown) =>
      err instanceof CliError &&
      err.code === "SEND_DRAFT_NOT_FOUND",
  );
  assert.equal(duplicateSendCount, 0, "send-draft after a mention partial must not resend the queued message");
});

test("send-draft mention partial reports queued effect and no retained draft", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-mention-draft-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-mention-draft-"));
  setSavedDraft("agent-send-attest", "#room", {
    content: "saved body with @xxchan\n",
    attachmentIds: [],
    savedAt: Date.now(),
    reholdCount: 1,
    seenUpToSeq: 77,
  });

  const bodies: Array<Record<string, unknown>> = [];
  const { ctx, stdout, stderr } = sendHarness(Readable.from([]));
  ctx.createApiClient = () => ({
    request: async (_method: string, _path: string, body?: Record<string, unknown>) => {
      bodies.push(body ?? {});
      return {
        ok: true,
        status: 200,
        error: null,
        data: {
          ok: true,
          state: "sent",
          messageId: "message-draft-partial",
          pendingMentionActions: [{
            resolutionId: PENDING_ACTION_ID,
            messageId: "message-draft-partial",
            targetType: "agent",
            targetHandle: "xxchan",
            reason: "Target is not in #room and was not notified.",
            availableActions: ["notify"],
            expiresAt: "2026-07-29T05:13:06.368Z",
          }],
        },
      };
    },
  }) as never;

  // The message is committed, so a partial result exits 0.
  await messageSendCommand.handler(ctx, [], { target: "#room", sendDraft: true });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.sendDraft, true);
  assert.equal(bodies[0]?.content, "saved body with @xxchan\n");
  assert.match(stdout.join(""), /Message effect: status=queued/);
  assert.equal(stderr.join(""), "");
  assert.equal(getSavedDraft("agent-send-attest", "#room"), null);
});

test("send warns when an authored mention resolved to no visible target", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-unresolved-mention-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-unresolved-mention-"));
  recordConsumedSeqs("agent-send-attest", { "#room": 77 });

  const { ctx, stdout, stderr } = sendHarness();
  ctx.createApiClient = () => ({
    request: async () => ({
      ok: true,
      status: 200,
      error: null,
      data: {
        ok: true,
        state: "sent",
        messageId: "message-unresolved",
        unresolvedMentionHandles: ["@wenyi"],
      },
    }),
  }) as never;

  // The message is committed, so a partial result exits 0.
  await messageSendCommand.handler(ctx, [], { target: "#room" });

  const out = stdout.join("");
  assert.equal(stdout.length, 1);
  assert.equal(out.indexOf("Undelivered mentions"), 0);
  assert.match(out, /@wenyi — status=not_queued/);
  assert.match(out, /reason: unknown_or_not_visible/);
  assert.match(out, /consequence: This @mention did not notify anyone\./);
  assert.match(out, /pending action: none; no visible target resolved/);
  assert.match(out, /literal name or prose/);
  assert.match(out, /Message queued to #room\. Message ID: message-unresolved/);
  assert.doesNotMatch(out, /Message sent|raft mention notify/);
  assert.equal(stderr.join(""), "");
});

test("send names the agents the message was delivered to, under the sent line", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-delivered-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-delivered-"));
  recordConsumedSeqs("agent-send-attest", { "#room": 77 });

  const { ctx, stdout, stderr } = sendHarness();
  ctx.createApiClient = () => ({
    request: async () => ({
      ok: true,
      status: 200,
      error: null,
      data: { ok: true, state: "sent", messageId: "message-delivered-1", deliveredToAgents: ["Archer", "Otter"] },
    }),
  }) as never;

  await messageSendCommand.handler(ctx, [], { target: "#room" });

  assert.match(stdout.join(""), /^Message sent to #room\. Message ID: message-delivered-1\. Thread: "#room:message-"\nDelivered to 2 agents: Archer, Otter\.\n/);
  assert.doesNotMatch(stdout.join(""), /@Archer|@Otter/);
  assert.equal(stderr.join(""), "");
});

test("send --json exposes layered message and mention effects without an extra warning stream", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-mention-json-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-mention-json-"));
  recordConsumedSeqs("agent-send-attest", { "#room": 77 });

  const { ctx, stdout, stderr } = sendHarness();
  ctx.createApiClient = () => ({
    request: async () => ({
      ok: true,
      status: 200,
      error: null,
      data: {
        ok: true,
        state: "sent",
        messageId: "message-json",
        pendingMentionActions: [{
          resolutionId: PENDING_ACTION_ID,
          messageId: "message-json",
          targetType: "agent",
          targetHandle: "Noel",
          reason: "not_member",
          availableActions: ["notify"],
          expiresAt: "2026-07-29T05:13:06.368Z",
        }],
      },
    }),
  }) as never;

  // A partial result exits 0 with the partial payload on stdout.
  await messageSendCommand.handler(ctx, [], { target: "#room", json: true });
  assert.deepEqual(JSON.parse(stdout.join("")), {
    ok: true,
    state: "partial",
    messageId: "message-json",
    message: {
      status: "queued",
      id: "message-json",
    },
    pendingMentionActions: [{
      resolutionId: PENDING_ACTION_ID,
      messageId: "message-json",
      targetHandle: "@Noel",
      status: "not_queued",
      reason: "not_in_conversation",
      consequence: "This @mention did not notify anyone.",
      expiresAt: "2026-07-29T05:13:06.368Z",
      recoveryCommand: `raft mention notify ${PENDING_ACTION_ID}`,
    }],
  });

  assert.equal(stderr.join(""), "");
});

test("send --json mention partial exits 0 with one partial-result document", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-mention-json-envelope-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-mention-json-envelope-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerCliCommand(program, messageSendCommand, {
    io: {
      stdin: Readable.from(["body with @Noel\n"]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-json-partial-envelope",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          ok: true,
          state: "sent",
          messageId: "message-json-envelope",
          pendingMentionActions: [{
            resolutionId: PENDING_ACTION_ID,
            messageId: "message-json-envelope",
            targetType: "agent",
            targetHandle: "Noel",
            reason: "not_member",
            availableActions: ["notify"],
            expiresAt: "2026-07-29T05:13:06.368Z",
          }],
        },
      }),
    }) as never,
  });

  await program.parseAsync(["node", "raft", "send", "--json", "--target", "#room"]);

  assert.equal(stderr.join(""), "");
  const rendered = stdout.join("");
  assert.equal(rendered.trim().split("\n").length, 1, "JSON mode must render one document");
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.state, "partial");
  assert.deepEqual(parsed.message, {
    status: "queued",
    id: "message-json-envelope",
  });
  assert.equal(parsed.pendingMentionActions[0].reason, "not_in_conversation");
  assert.equal(parsed.pendingMentionActions[0].recoveryCommand, `raft mention notify ${PENDING_ACTION_ID}`);
});

test("send --json exposes unresolved mention warnings as a partial result", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-unresolved-mention-json-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-unresolved-mention-json-"));
  recordConsumedSeqs("agent-send-attest", { "#room": 77 });

  const { ctx, stdout, stderr } = sendHarness();
  ctx.createApiClient = () => ({
    request: async () => ({
      ok: true,
      status: 200,
      error: null,
      data: {
        ok: true,
        state: "sent",
        messageId: "message-unresolved-json",
        unresolvedMentionHandles: ["@wenyi"],
      },
    }),
  }) as never;

  // A partial result exits 0 with the partial payload on stdout.
  await messageSendCommand.handler(ctx, [], { target: "#room", json: true });
  assert.deepEqual(JSON.parse(stdout.join("")), {
    ok: true,
    state: "partial",
    messageId: "message-unresolved-json",
    unresolvedMentionHandles: ["@wenyi"],
    message: {
      status: "queued",
      id: "message-unresolved-json",
    },
    pendingMentionActions: [],
    unresolvedMentionWarnings: [{
      targetHandle: "@wenyi",
      status: "not_queued",
      reason: "unknown_or_not_visible",
      consequence: "This @mention did not notify anyone.",
      expiresAt: null,
      recoveryCommand: null,
    }],
  });

  assert.equal(stderr.join(""), "");
});

test("send renders recent-join first-post mute tip on sent responses", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-drive-by-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-drive-by-"));
  recordConsumedSeqs("agent-send-attest", { "#ops": 77 });

  const { ctx, stdout } = sendHarness();
  ctx.createApiClient = () => ({
    request: async () => ({
      ok: true,
      status: 200,
      error: null,
      data: {
        ok: true,
        state: "sent",
        messageId: "message-1",
        attention: {
          driveByJoinedToPost: {
            muteCommand: 'raft channel mute "#ops"',
            stillArrives: ["@mentions still reach you, and threads you started stay followed."],
          },
        },
      },
    }),
  }) as never;

  await messageSendCommand.handler(ctx, [], { target: "#ops" });

  const out = stdout.join("");
  assert.match(out, /Message sent to #ops/);
  assert.match(out, /Tip: you joined this channel to post this message/);
  assert.match(out, /  raft channel mute "#ops"/);
  assert.match(out, /@mentions still reach you, and threads you started stay followed\./);
});

test("formatDriveByJoinedToPostTip falls back to target mute command", () => {
  assert.equal(
    formatDriveByJoinedToPostTip("#ops", {
      ok: true,
      state: "sent",
      messageId: "message-1",
      attention: {
        driveByJoinedToPost: {},
      },
    }),
    [
      "Tip: you joined this channel to post this message. If you don't need its ordinary updates:",
      '  raft channel mute "#ops"',
      "@mentions still reach you, and threads you started stay followed.",
    ].join("\n"),
  );
});

test("freshness held sends save a draft and exit nonzero without target effect", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-held-exit-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-held-exit-"));
  recordConsumedSeqs("agent-send-attest", { "#room": 77 });

  const { ctx, stdout, stderr } = sendHarness();
  ctx.createApiClient = () => ({
    request: async () => ({
      ok: true,
      status: 200,
      error: null,
      data: {
        state: "held",
        newMessageCount: 1,
        shownMessageCount: 1,
        omittedMessageCount: 0,
        seenUpToSeq: 78,
        heldMessages: [{ seq: 78, id: "msg78", senderName: "alice", content: "new context" }],
      },
    }),
  }) as never;

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#room" }),
    assertHeldDraftError,
  );

  const out = stdout.join("");
  assert.match(out, /Held — /);
  assert.match(out, /Your message has been saved as a draft/);
  assert.doesNotMatch(out, /Message sent|Message queued/);
  assert.equal(stderr.join(""), "");
  assert.equal(getSavedDraft("agent-send-attest", "#room")?.content, "hello from test\n");
});

test("held send output does not render pending mention action fields", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-held-mention-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-held-mention-"));
  recordConsumedSeqs("agent-send-attest", { "#room": 77 });

  const { ctx, stdout } = sendHarness();
  ctx.createApiClient = () => ({
    request: async () => ({
      ok: true,
      status: 200,
      error: null,
      data: {
        state: "held",
        newMessageCount: 1,
        shownMessageCount: 1,
        omittedMessageCount: 0,
        seenUpToSeq: 78,
        heldMessages: [{ seq: 78, id: "msg78", senderName: "alice", content: "new context" }],
        pendingMentionActions: [{
          resolutionId: "resolution-should-not-render",
          targetHandle: "@Noel",
          availableActions: ["notify"],
        }],
      },
    }),
  }) as never;

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#room" }),
    assertHeldDraftError,
  );

  const out = stdout.join("");
  assert.match(out, /Held — /);
  assert.doesNotMatch(out, /Tip: you joined this channel to post this message/);
  assert.doesNotMatch(out, /Undelivered mentions/);
  assert.doesNotMatch(out, /resolution-should-not-render/);
});

test("reviewer-isolation send reprojects a poisoned legacy hold and preserves the prior model-seen boundary", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-reviewer-isolation-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-reviewer-isolation-"));
  recordConsumedSeqs("agent-reviewer-isolation", { "#reviews:blind": 77 });
  const poison = {
    body: "other reviewer says APPROVE",
    sender: "other-reviewer",
    id: "blind-99",
    timestamp: "2042-04-05T06:07:08.000Z",
    reason: "other_reviewer_approved",
    error: "legacy hold included another verdict",
    lineage: "freshness_decision_fact:blind-legacy-poison",
  };
  const bodies: Array<Record<string, unknown>> = [];
  const stdout: string[] = [];
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["my independent verdict\n"]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    } as never,
    env: { RAFT_REVIEWER_ISOLATION: "1" },
    loadAgentContext: () => ({
      agentId: "agent-reviewer-isolation",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: Record<string, unknown>) => {
        bodies.push(body ?? {});
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            state: "held",
            producerFactId: poison.lineage,
            reason: poison.reason,
            error: poison.error,
            newMessageCount: 1,
            shownMessageCount: 1,
            omittedMessageCount: 0,
            seenUpToSeq: 99,
            seenUpToMessageId: poison.id,
            mentionAnnotation: { formalMentionCount: 1 },
            heldMessages: [{
              seq: 99,
              id: poison.id,
              senderName: poison.sender,
              timestamp: poison.timestamp,
              content: poison.body,
            }],
          },
        };
      },
    }) as never,
  });

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], { target: "#reviews:blind" }),
    assertHeldDraftError,
  );

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.freshnessContextMode, "withheld");
  assert.equal(bodies[0]?.seenUpToSeq, 77);
  assert.equal(getConsumedSeq("agent-reviewer-isolation", "#reviews:blind"), 77);
  assert.equal(getSavedDraft("agent-reviewer-isolation", "#reviews:blind")?.seenUpToSeq, 77);
  const surface = stdout.join("");
  assert.match(surface, /Reviewer-isolation freshness hold: 1 newer message withheld/);
  for (const value of Object.values(poison)) {
    assert.doesNotMatch(surface, new RegExp(value));
  }
});

test("reviewer-isolation JSON send uses the strict allowlist against a poisoned legacy hold", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-reviewer-json-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-reviewer-json-"));
  const stdout: string[] = [];
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["independent JSON verdict\n"]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-reviewer-json",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          state: "held",
          producerFactId: "freshness_decision_fact:poison-json",
          reason: "poison-reason",
          error: "poison-error",
          newMessageCount: 3,
          seenUpToSeq: 123,
          heldMessages: [{
            seq: 123,
            id: "poison-id",
            senderName: "poison-sender",
            timestamp: "2042-05-06T07:08:09.000Z",
            content: "poison-body",
          }],
        },
      }),
    }) as never,
  });

  await assert.rejects(
    async () => messageSendCommand.handler(ctx, [], {
      target: "#reviews:blind",
      reviewerIsolation: true,
      json: true,
    }),
    (err: unknown) => {
      assertHeldDraftError(err, { json: true });
      assert.deepEqual((err as CliError).details, {
        held: {
          state: "held",
          freshnessContextMode: "withheld",
          withheldMessageCount: 3,
        },
      });
      return true;
    },
  );

  assert.equal(stdout.join(""), "");
});

test("held JSON send renders one error envelope with redacted held context", async () => {
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-held-json-envelope-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerCliCommand(program, messageSendCommand, {
    io: {
      stdin: Readable.from(["independent JSON verdict\n"]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-reviewer-json-envelope",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          state: "held",
          producerFactId: "freshness_decision_fact:poison-json",
          reason: "poison-reason",
          error: "poison-error",
          newMessageCount: 3,
          seenUpToSeq: 123,
          heldMessages: [{
            seq: 123,
            id: "poison-id",
            senderName: "poison-sender",
            timestamp: "2042-05-06T07:08:09.000Z",
            content: "poison-body",
          }],
        },
      }),
    }) as never,
  });

  await assert.rejects(
    () => program.parseAsync(["node", "raft", "send", "--reviewer-isolation", "--json", "--target", "#reviews:blind"]),
    /CliExit\(1\)/,
  );

  assert.equal(stdout.join(""), "");
  const rendered = stderr.join("");
  assert.equal(rendered.trim().split("\n").length, 1, "JSON error mode must render one document");
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "SEND_HELD_AS_DRAFT");
  assert.equal(parsed.error.effect, "draft_saved");
  assert.equal(parsed.error.retryable, false);
  assert.deepEqual(parsed.details, {
    held: {
      state: "held",
      freshnessContextMode: "withheld",
      withheldMessageCount: 3,
    },
  });
  assert.doesNotMatch(rendered, /poison|seenUpToSeq|producerFactId/);
});

test("reviewer-isolation send error output never forwards upstream poison text", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-reviewer-error-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-reviewer-error-"));
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["independent verdict\n"]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-reviewer-error",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async () => ({
        ok: false,
        status: 409,
        error: "POISON: peer reviewer rejected this exact change",
        data: null,
      }),
    }) as never,
  });

  await assert.rejects(
    async () => {
      await Promise.resolve(
        messageSendCommand.handler(ctx, [], { target: "#reviews:blind", reviewerIsolation: true }),
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "SEND_FAILED");
      assert.match(err.message, /upstream error detail was withheld/);
      assert.doesNotMatch(err.message, /POISON|rejected this exact change/);
      return true;
    },
  );
});

// Task #149: replacing a non-empty draft must produce visible output.
// Before this, the replacement was silent -- "content was destroyed" and
// "nothing was there" printed identically, and the only record was a telemetry
// field the sender never sees.

test("replacing a non-empty draft names the target, excerpt, and recovery file", () => {
  const out = formatDraftReplacedWarning(
    "#proj-dx",
    "the body that is about to be archived",
    "/tmp/replaced-draft.txt",
  );
  assert.match(out, /replacing an unsent draft for #proj-dx/i);
  assert.match(out, /the body that is about to be archived/);
  assert.match(out, /Recovery file: "\/tmp\/replaced-draft\.txt"/);
});

test("the warning does not offer --send-draft, which would send the replacement", () => {
  const out = formatDraftReplacedWarning("#proj-dx", "old body", "/tmp/replaced-draft.txt");
  // By the time this prints the slot already holds the new content, so
  // `--send-draft` would send the thing that replaced it. A confident wrong
  // next action is worse than none.
  assert.doesNotMatch(out, /--send-draft/);
});

test("a long replaced draft is excerpted but reports its true length", () => {
  const body = "x".repeat(DRAFT_REPLACED_EXCERPT_LIMIT + 250);
  const out = formatDraftReplacedWarning("#proj-dx", body, "/tmp/replaced-draft.txt");
  assert.match(out, new RegExp(`${DRAFT_REPLACED_EXCERPT_LIMIT + 250} chars`));
  // Bounded: a huge draft must not flood the terminal it is being reported to.
  assert.ok(out.length < DRAFT_REPLACED_EXCERPT_LIMIT + 400, `warning was ${out.length} chars`);
});

test("a short draft is printed whole, with no truncation notice", () => {
  const out = formatDraftReplacedWarning("#proj-dx", "short body", "/tmp/replaced-draft.txt");
  assert.match(out, /Previous draft excerpt \(10 chars\): short body/);
  assert.doesNotMatch(out, /…/u);
});

test("a failed local archive is explicit and never invents a recovery path", () => {
  const out = formatDraftReplacedWarning("#proj-dx", "short body", null);
  assert.match(out, /Recovery copy: unavailable/);
  assert.doesNotMatch(out, /Recovery file:/);
});

// task #111 — the SERVER_5XX saved-draft recovery guidance, under the task #115 v1
// frozen UNKNOWN contract. @XX's closure is FOUR right-cause teeth (@Hipp's false
// positive is tooth 3, not a fifth — accounting corrected by him 2026-08-13). Tooth 5
// below is an ADDITION of mine and is not part of that closure.
// Each is one way this text has actually been got wrong by a real operator today:
//
//   Hipp  — resent after "readback + grep, zero hits"; no duplicate purely by luck
//   Hipp  — grepped a SHA to confirm his own message landed: 2 hits, both OTHER people
//           quoting that SHA  ⇒ content matching fails as a FALSE POSITIVE too
//   Dian  — measured the 60-90s lag himself, then still used an immediate zero-hit read
//           to release a draft; his own tool printed a window warning that was half right
//   this file's first draft — encoded "absent in both reads ⇒ resend" as executable steps
//
// ⭐ Three independent operators invented the same unsound inference. That is why the
//    criterion has to come from the platform, and why this copy must stop at
//    CANNOT_CONFIRM whenever keyed reconciliation is unavailable or non-authoritative.
//
// ⛔ Deliberately NOT asserting the sentence verbatim — that pins wording, every copy edit
//    turns red for no safety reason, and the next author deletes the test.
test("5xx guidance never lets reading authorise a resend", () => {
  // ⛔ narrow before reading: the public return type is Error, and tsx runs green either
  //    way, so only the package typecheck catches this.
  const wrapped = markSendFailureDraftSaved(new Error("boom"), true);
  assert.ok(wrapped instanceof CliError);
  const g = wrapped.suggestedNextAction ?? "";

  // tooth 1 — two negative reads must not authorise a resend
  assert.doesNotMatch(g, /means it did not/i);
  assert.match(g, /Not seeing it proves nothing/i);
  // tooth 2 — the unknown/never-resend state must survive absent identity reconciliation
  assert.match(g, /UNKNOWN/);
  assert.match(g, /CANNOT_CONFIRM/);
  assert.match(g, /not retryable/i);
  assert.match(g, /Do not resend on this evidence/i);
  // tooth 3 — a content hit is not identity evidence that the original send committed
  assert.match(g, /Matching your own text is not identity/i);
  assert.match(g, /someone else quoting the same string/i);
  // tooth 4 — 90s is a hint against looking too early, never a lift condition or SLA
  assert.match(g, /not a bound on visibility and not a safety gate/i);
  // tooth 5 — only authoritative identity reconciliation settles it, and a resend is
  // framed as a decision to duplicate, never as a finding that the original failed
  assert.match(g, /authoritative identity reconciliation|identity bound by the failed request/i);
  assert.match(g, /a decision by a person to accept a duplicate, not a finding that the original failed/i);
  // @XX 2026-08-13: the guidance must not DIRECT the operator to --send-draft at all.
  assert.doesNotMatch(g, /--send-draft/);
  // @XX 2026-08-13 spot-check: presence must NOT be stated as proof of commit either.
  // Unqualified, it contradicts tooth 3 and re-enables exactly @Hipp's false positive.
  assert.doesNotMatch(g, /that proves it was committed/i);
  assert.match(g, /not the same as YOUR send having been committed/i);
});

test("5xx guidance is only attached when a draft was actually saved", () => {
  const notSaved = markSendFailureDraftSaved(new Error("boom"), false);
  assert.ok(notSaved instanceof CliError);
  assert.equal(notSaved.suggestedNextAction, undefined);
});

test("a send over the message budget (429 RATE_LIMITED): nothing sent, the draft kept, how long to wait and the command that sends it", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-rate-limited-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-rate-limited-"));
  const body = {
    error: "This agent sent too many messages: the limit is 60 a minute. Retry in 23 seconds.",
    code: "RATE_LIMITED",
    details: { operation: "messages.sendV2", limit: 60, windowSeconds: 60, retryAfterSeconds: 23 },
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdin: Readable.from(["send body\n"]),
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
  } as never;
  const program = new Command();
  program.exitOverride();
  registerCliCommand(program, messageSendCommand, {
    io,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-send-rate-limited",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string) => {
        if (requestPath === "/internal/agent-api/context") return { ok: false, status: 404, error: "not found", data: null };
        return { ok: false, status: 429, error: body.error, errorCode: "RATE_LIMITED", data: null, errorBody: body };
      },
    }) as never,
  });

  await assert.rejects(
    () => program.parseAsync(["node", "raft", "send", "--target", "#room"]),
    /CliExit\(1\)/,
  );

  assert.deepEqual(stdout, []);
  const rendered = stderr.join("");
  assert.match(rendered, /Error: This agent sent too many messages: the limit is 60 a minute\. Retry in 23 seconds\./);
  assert.match(rendered, /Code: RATE_LIMITED/);
  assert.match(rendered, /Retryable: yes/);
  assert.match(rendered, /Draft saved: yes/);
  assert.match(rendered, /Nothing was sent; your message is saved as a draft\. Wait 23 seconds, then send it:\nraft message send --send-draft --target "#room"/);
  assert.doesNotMatch(rendered, /UNKNOWN/);
  assert.equal(getSavedDraft("agent-send-rate-limited", "#room")?.content, "send body\n");
});

test("a reviewer-isolation send over the message budget: the draft kept, and the send-draft command bound to this send's key", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-send-rate-limited-ri-"));
  process.env.SLOCK_CLI_DRAFT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-drafts-send-rate-limited-ri-"));
  const body = {
    error: "This agent sent too many messages: the limit is 60 a minute. Retry in 7 seconds.",
    code: "RATE_LIMITED",
    details: { operation: "messages.sendV2", limit: 60, windowSeconds: 60, retryAfterSeconds: 7 },
  };
  const ctx = createCommandContext({
    io: {
      stdin: Readable.from(["independent verdict\n"]),
      stdout: { write: () => true },
      stderr: { write: () => true },
    } as never,
    env: {},
    loadAgentContext: () => ({
      agentId: "agent-reviewer-rate-limited",
      serverUrl: "http://stub.local",
      clientMode: "self-hosted-runner",
      profileSlug: "t",
    }) as never,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string) => {
        if (requestPath === "/internal/agent-api/context") return { ok: false, status: 404, error: "not found", data: null };
        return { ok: false, status: 429, error: body.error, errorCode: "RATE_LIMITED", data: null, errorBody: body };
      },
    }) as never,
  });

  await assert.rejects(
    async () => {
      await Promise.resolve(messageSendCommand.handler(ctx, [], { target: "#reviews:blind", reviewerIsolation: true }));
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "RATE_LIMITED");
      assert.equal(err.retryable, true);
      assert.equal(err.draftSaved, true);
      const key = getSavedDraft("agent-reviewer-rate-limited", "#reviews:blind")?.idempotencyKey;
      assert.ok(key);
      assert.equal(
        err.suggestedNextAction,
        `Nothing was sent; your message is saved as a draft. Wait 7 seconds, then send it:\nraft message send --reviewer-isolation --send-draft --expected-draft-key "${key}" --target "#reviews:blind"`,
      );
      return true;
    },
  );
});
