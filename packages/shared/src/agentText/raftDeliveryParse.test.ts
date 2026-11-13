import assert from "node:assert/strict";
import { parseRaftDelivery, raftSegmentAt } from "./raftDeliveryParse";
import type { RaftNoticeSegment } from "./raftDeliveryParse";

// The View Context timeline reads what Raft put into a user message back
// into notices. The samples are the daemon's own output (agentRuntimeInput's
// snapshots, formatIdleTaskReminderNotice's doc, formatIncomingMessage).

const INBOX = [
  "[Raft inbox notice:",
  "Inbox update: 3 messages pending your read across all conversations; 2 changed targets",
  "#general  pending: 2 messages · first msg=00000000 · latest sender @richard · latest msg=00000000 · you were mentioned",
  "  latest @richard: \"hello, can you look at [this]?\" (preview; still unread, full text: raft message read --target \"#general\" --unread)",
  "dm:@bob  pending: 1 message · latest sender @bob",
  "]",
  "These messages have not been read. Choose when to read them: `raft message read --target <target> --unread` reads one conversation's unread messages; `raft message check` reads all of them.",
].join("\n");

const TASK = [
  "[Raft task notice: 2 tasks are waiting on you.",
  "#wg-task-v2:#9 [in_progress] Idle nudge [draft — untouched for 2h",
  "#proj:#4 [todo] Rollout checklist — newly yours (assigned by @stdrc)",
  "For each task:",
  "- A todo you can work on now: start it.",
  "No change → no reply needed.]",
].join("\n");

const HEADER = "[target=#proj-web msg=3f2a91c0 time=2026-11-06 09:41:00Z type=human] @mira (Asia/Shanghai) — designer: Can you check why the invite email still says \"workspace\"?\n  │ A screenshot of the welcome step would help too. [1 attachment: shot.png (id:aaaa1111) — use raft attachment view to download]";

function kinds(segments: readonly RaftNoticeSegment[]) {
  return segments.map((segment) => segment.kind);
}

test("plain human text has no notices", () => {
  assert.equal(parseRaftDelivery("Fix the onboarding strings. See [the docs](https://x.example) and [Raft] later."), null);
  assert.equal(parseRaftDelivery("I typed [target=nothing] mid-line and [Raft is great] mid-line too."), null, "only at a line's start");
});

test("an inbox notice: the total, each target with its pending count, latest sender, mention and unquoted preview; the guidance line is the notice's", () => {
  const delivery = parseRaftDelivery(INBOX)!;
  assert.equal(delivery.notices, 1);
  const [notice] = delivery.segments;
  assert.equal(notice!.kind, "inbox");
  if (notice!.kind !== "inbox") return;
  assert.equal(notice.pendingTotal, 3);
  assert.deepEqual(notice.targets, [
    { target: "#general", pending: 2, latestSender: "richard", preview: "hello, can you look at [this]?", mentioned: true },
    { target: "dm:@bob", pending: 1, latestSender: "bob", preview: null, mentioned: false },
  ]);
  assert.equal(INBOX.slice(notice.start, notice.end), INBOX, "the whole text, the guidance included");
});

test("a task notice: the count and each task's ref, status, title and why, an unpaired bracket in a title included", () => {
  const delivery = parseRaftDelivery(TASK)!;
  assert.deepEqual(kinds(delivery.segments), ["task"]);
  const notice = delivery.segments[0]!;
  if (notice.kind !== "task") throw new Error(notice.kind);
  assert.equal(notice.count, 2);
  assert.deepEqual(notice.tasks, [
    { ref: "#wg-task-v2:#9", status: "in_progress", title: "Idle nudge [draft", why: "untouched for 2h" },
    { ref: "#proj:#4", status: "todo", title: "Rollout checklist", why: "newly yours (assigned by @stdrc)" },
  ]);
  assert.equal(notice.end, TASK.length);
});

test("a message header: its fields, the sender, and the body as written (continuation prefixes removed, suffixes kept)", () => {
  const delivery = parseRaftDelivery(HEADER)!;
  const notice = delivery.segments[0]!;
  if (notice.kind !== "message") throw new Error(notice.kind);
  assert.deepEqual(notice.fields, [
    { key: "target", value: "#proj-web" },
    { key: "msg", value: "3f2a91c0" },
    { key: "time", value: "2026-11-06 09:41:00Z" },
    { key: "type", value: "human" },
  ]);
  assert.equal(notice.target, "#proj-web");
  assert.equal(notice.time, "2026-11-06 09:41:00Z");
  assert.equal(notice.sender, "mira");
  // A description is free text (it may hold ": "), so the body keeps it rather than guessing where it ends.
  assert.equal(notice.body, "designer: Can you check why the invite email still says \"workspace\"?\nA screenshot of the welcome step would help too. [1 attachment: shot.png (id:aaaa1111) — use raft attachment view to download]");
});

test("a sender's handle: without a description the body follows the first \": \"; with one, the body is the rest of the line, description included", () => {
  const plain = parseRaftDelivery("[target=#ops msg=aaaaaaaa time=2026-11-03 06:00:00Z type=human] @bob (Asia/Shanghai): deploy at 10:00: ok?")!.segments[0]!;
  assert.equal(plain.kind === "message" && plain.sender, "bob");
  assert.equal(plain.kind === "message" && plain.body, "deploy at 10:00: ok?");
  const described = parseRaftDelivery("[target=#ops msg=aaaaaaaa time=2026-11-03 06:00:00Z type=human] @bob (Asia/Shanghai) — Lead: infra, oncall: hello there")!.segments[0]!;
  assert.equal(described.kind === "message" && described.sender, "bob");
  assert.equal(described.kind === "message" && described.body, "Lead: infra, oncall: hello there", "never split inside the description");
});

test("unclosed openers cost a bounded scan each: thousands of them and a megabyte of text parse quickly, each a one-line generic notice", () => {
  const unclosed = Array.from({ length: 5_000 }, (_, index) => `[Raft inbox notice: never closed ${index}`).join("\n");
  const tasks = Array.from({ length: 3_000 }, (_, index) => `[Raft task notice: ${index} [open`).join("\n");
  const text = `${unclosed}\n${tasks}\n${"x".repeat(1_000_000)}`;
  const started = performance.now();
  const delivery = parseRaftDelivery(text)!;
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `parsed in ${Math.round(elapsed)}ms`);
  assert.equal(delivery.notices, 8_000);
  assert.deepEqual(new Set(delivery.segments.slice(0, 8_000).map((segment) => segment.kind)), new Set(["generic"]));
  const first = delivery.segments[0]!;
  assert.equal(text.slice(first.start, first.end), "[Raft inbox notice: never closed 0", "ends on its own line");
  // One opener before a long unclosed run reads no further than its bound.
  const long = parseRaftDelivery(`[Raft future notice: [\n${"line\n".repeat(50_000)}`)!;
  assert.equal(long.segments[0]!.kind, "generic");
  assert.equal(long.segments[0]!.end, "[Raft future notice: [".length);
});

test("several notices in one delivery, the envelope between them as text", () => {
  const second = "[target=dm:@bob msg=bbbbbbbb time=2026-11-06 09:42:00Z type=agent] @bob: done";
  const text = `New messages received:\n\n${HEADER}\n${second}\n\n${INBOX}\n\n${TASK}\n\nRespond as appropriate. Complete all your work before stopping.`;
  const delivery = parseRaftDelivery(text)!;
  assert.deepEqual(kinds(delivery.segments), ["text", "message", "message", "inbox", "task", "text"]);
  assert.equal(delivery.notices, 4);
  const [envelope, , bob] = delivery.segments;
  assert.equal(text.slice(envelope!.start, envelope!.end), "New messages received:", "text segments are trimmed");
  assert.equal(text.slice(bob!.start, bob!.end), second);
  assert.equal(text.slice(delivery.segments[5]!.start), "Respond as appropriate. Complete all your work before stopping.");
  assert.equal(raftSegmentAt(delivery.segments, text.indexOf("Rollout")), 4);
  assert.equal(raftSegmentAt(delivery.segments, text.indexOf("\n\n")), -1, "between segments");
});

test("an unknown bracketed Raft notice, or a known one that doesn't read as its format, is a generic notice with its original text", () => {
  const thread = "[Raft thread context: you were mentioned in a thread without model-visible context.]\nparent: #general";
  const delivery = parseRaftDelivery(thread)!;
  assert.deepEqual(kinds(delivery.segments), ["generic", "text"]);
  const notice = delivery.segments[0]!;
  assert.equal(notice.kind === "generic" && notice.label, "thread context");
  assert.equal(thread.slice(notice.start, notice.end), "[Raft thread context: you were mentioned in a thread without model-visible context.]");

  const multiLine = "[Raft future notice: something\nnew [nested] here]\nafter";
  const future = parseRaftDelivery(multiLine)!;
  assert.deepEqual(kinds(future.segments), ["generic", "text"]);
  assert.equal(multiLine.slice(future.segments[0]!.start, future.segments[0]!.end), "[Raft future notice: something\nnew [nested] here]");

  const odd = parseRaftDelivery("[Raft inbox notice: a new shape we don't know]")!;
  assert.deepEqual(kinds(odd.segments), ["generic"], "an inbox notice without its rows");
  const oddTask = parseRaftDelivery("[Raft task notice: …]")!;
  assert.deepEqual(kinds(oddTask.segments), ["generic"], "the guide's short form");
});

// RFC 081 (#13788, behind its flag) rewrites the inbox rows; contexts recorded
// before keep the old ones, so both read. Lines as Archer listed them (#wg-ax:#19).
const INBOX_RFC081 = [
  "[Raft inbox notice:",
  "Inbox update: 4 messages pending your read across all conversations; 3 changed targets",
  "#general · first msg=00000000 · mentions you · 1 new, not yet delivered · latest @richard · attention_hint={\"kind\":\"mention\"}",
  "  [Raft notice: You were notified as a non-member, so you can read and reply in this thread but not in the channel.]",
  "  \"hey, can you look?\" (preview)",
  "  read: raft inbox read --target \"#general\"",
  "task #proj:#7 · 2 unread · mentions you 2x · latest @mira",
  "  \"a long message…\" (truncated preview)",
  "Third-party app events · 1 pending · latest @stamp · fetch with raft message check",
  "]",
  "Read one item at a time with `raft inbox read --target <item>`; `raft inbox check` lists them all.",
].join("\n");

test("RFC 081 inbox rows read: target (task label dropped), count, mention, latest sender and preview", () => {
  const delivery = parseRaftDelivery(INBOX_RFC081);
  assert.ok(delivery);
  assert.deepEqual(kinds(delivery.segments), ["inbox"], "one notice, its guidance line included");
  const inbox = delivery.segments[0]!;
  assert.ok(inbox.kind === "inbox");
  assert.equal(inbox.pendingTotal, 4);
  assert.deepEqual(inbox.targets, [
    { target: "#general", pending: 1, latestSender: "richard", preview: "hey, can you look?", mentioned: true },
    { target: "#proj:#7", pending: 2, latestSender: "mira", preview: "a long message…", mentioned: true },
    { target: "Third-party app events", pending: 1, latestSender: "stamp", preview: null, mentioned: false },
  ]);
});

test("the old inbox rows still read after RFC 081 (recorded contexts keep them)", () => {
  const delivery = parseRaftDelivery(INBOX);
  assert.ok(delivery);
  const inbox = delivery.segments.find((segment) => segment.kind === "inbox");
  assert.ok(inbox && inbox.kind === "inbox");
  assert.deepEqual(inbox.targets.map((t) => [t.target, t.pending, t.mentioned]), [["#general", 2, true], ["dm:@bob", 1, false]]);
});

test("with inbox items on, the grouped third-party row's count reads `N not in this list` (#13807)", () => {
  const text = [
    "[Raft inbox notice:",
    "Inbox update: 3 messages pending your read across all conversations; 1 changed target",
    "Third-party app events · 3 not in this list · latest @stamp · fetch with raft message check",
    "]",
  ].join("\n");
  const delivery = parseRaftDelivery(text);
  assert.ok(delivery);
  const inbox = delivery.segments.find((segment) => segment.kind === "inbox");
  assert.ok(inbox && inbox.kind === "inbox");
  assert.deepEqual(inbox.targets, [{ target: "Third-party app events", pending: 3, latestSender: "stamp", preview: null, mentioned: false }]);
});
