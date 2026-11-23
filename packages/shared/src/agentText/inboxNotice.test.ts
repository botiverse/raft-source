import assert from "node:assert/strict";

import type { AgentApiInboxRowsResponse } from "../agentApiContract";
import { formatAgentReplyAffordance } from "../agentInbox";
import { formatAgentInboxItemRow, type AgentInboxItemRow } from "../agentInboxItemRow";
import { ATTENTION_HINT_COPY_VERSION, ATTENTION_HINT_SCHEMA, type AttentionHint } from "../attentionDependencyOracle";
import { formatAgentInboxNotice, mergeAgentInboxNoticeRows, type AgentInboxNoticeInput } from "./inboxNotice";
import { parseRaftDelivery } from "./raftDeliveryParse";

const PROJ = "11111111-aaaa-4bbb-8ccc-000000000001";
const BOB = "11111111-aaaa-4bbb-8ccc-000000000002";
const OPS = "11111111-aaaa-4bbb-8ccc-000000000003";

function row(fields: Partial<AgentInboxItemRow> & Pick<AgentInboxItemRow, "target">): AgentInboxItemRow {
  return { kind: "conversation", unread: 1, latestSender: null, preview: null, previewTruncated: false, firstUnreadAt: null, latestAt: null, preLaunch: false, ...fields };
}

type ServerRow = AgentApiInboxRowsResponse["rows"][number];
const serverRow = (channelId: string, fields: Partial<AgentInboxItemRow> & Pick<AgentInboxItemRow, "target">): ServerRow => ({ ...row(fields), channelId });

const other = (conversations: number, messages: number, mentions = 0, dms = 0) => ({ conversations, messages, mentions, dms });
const answer = (rows: ServerRow[], otherUnread = other(0, 0)): AgentApiInboxRowsResponse => ({ rows, behind: 0, otherUnread });

const HINT: AttentionHint = {
  schema: ATTENTION_HINT_SCHEMA,
  trigger: "M2",
  scope: "#proj-x",
  suggested_command: "raft channel mute \"#proj-x\"",
  copy: "You've received 12 updates from #proj-x with no action taken.",
  copy_version: ATTENTION_HINT_COPY_VERSION,
  epoch_ms: 123,
  thresholds: { K: 12, window_ms: 604800000 },
};

const PROJ_ROW = row({ target: "#proj-x", unread: 3, mentions: 1, latestSender: { name: "alice", type: "user" }, preview: "@Sage can you check section 3?" });
const BOB_ROW = row({ target: "dm:@bob", latestSender: { name: "bob", type: "user" }, preview: "hi" });
const ROW_OPTIONS = { inboxRead: true };

function notice(input: Partial<AgentInboxNoticeInput>) {
  return formatAgentInboxNotice({ reason: "new", rows: [], rowOptions: ROW_OPTIONS, older: null, previousOlderMessages: null, ...input });
}

test("a row the Server gave no number for prints no count; without the mark a row prints as before", () => {
  const options = { inboxRead: true };
  assert.deepEqual(formatAgentInboxItemRow({ ...BOB_ROW, unread: 0, unreadUnknown: true }, options), [
    "dm:@bob · latest @bob",
    "  \"hi\" (preview)",
    "  read: raft inbox read --target \"dm:@bob\"",
  ]);
  assert.deepEqual(
    formatAgentInboxItemRow(row({ target: "#proj-x", unread: 4, notDelivered: 2, mentions: 2, unreadUnknown: true }), options)[0],
    "#proj-x · mentions you 2x",
    "neither count; the rest stays",
  );
  assert.deepEqual(formatAgentInboxItemRow(row({ target: "#proj-x", unread: 0, unreadUnknown: true }), options), [
    "#proj-x",
    "  read: raft inbox read --target \"#proj-x\"",
  ], "no parts at all: the label alone");
  assert.equal(formatAgentInboxItemRow(row({ target: "#proj-x", unread: 0 }), options)[0], "#proj-x · 0 unread");
  assert.equal(formatAgentInboxItemRow(row({ target: "#proj-x", unread: 0, notDelivered: 2 }), options)[0], "#proj-x · 2 new, not yet delivered");
});

test("merge: the Server's row by channel id whatever the letter case, in the Computer's order, with the Computer's own details kept", () => {
  const local = [
    { channelId: PROJ.toUpperCase(), row: row({ target: "#proj-x:local", unread: 1, attentionHint: HINT, nonMemberMention: true }) },
    { channelId: null, row: row({ target: "reminder:76d9397d", kind: "reminder" }) },
    { channelId: BOB, row: row({ target: "dm:@bob-local", unread: 1 }) },
  ];
  // The Server answers newest first and builds its own target strings.
  const merged = mergeAgentInboxNoticeRows(local, answer([serverRow(BOB, BOB_ROW), serverRow(PROJ, PROJ_ROW)]));
  assert.deepEqual(merged, [
    { ...PROJ_ROW, channelId: PROJ, attentionHint: HINT, nonMemberMention: true },
    local[1]!.row,
    { ...BOB_ROW, channelId: BOB },
  ]);
  assert.equal("attentionHint" in merged[2]!, false);
  const lines = formatAgentInboxItemRow(merged[0]!, ROW_OPTIONS);
  assert.equal(lines[0], "#proj-x · 3 unread · mentions you · latest @alice");
  assert.equal(lines[1], `  ${formatAgentReplyAffordance({ non_member_mention: true })}`);
  assert.equal(lines.at(-1), "  hint: You've received 12 updates from #proj-x with no action taken. Run: raft channel mute \"#proj-x\"");
});

test("merge: no answer, or a named conversation the answer has no row for, keeps the Computer's row without a number, never as nothing unread", () => {
  const pending = row({ target: "#ops", unread: 2, notDelivered: 2, mentions: 1, attentionHint: HINT });
  const app = row({ target: "app:stamp/pr-1", kind: "app", unread: 2 });
  const local = [{ channelId: PROJ, row: PROJ_ROW }, { channelId: OPS, row: pending }, { channelId: null, row: app }];
  const numberless = { target: "#ops", kind: "conversation", unread: 0, mentions: 1, unreadUnknown: true, attentionHint: HINT, latestSender: null, preview: null, previewTruncated: false, firstUnreadAt: null, latestAt: null, preLaunch: false };

  const failed = mergeAgentInboxNoticeRows(local, null);
  assert.deepEqual(failed, [{ ...PROJ_ROW, unread: 0, unreadUnknown: true }, numberless, app]);
  assert.equal("notDelivered" in failed[1]!, false);
  assert.equal(formatAgentInboxItemRow(failed[0]!, ROW_OPTIONS)[0], "#proj-x · mentions you · latest @alice");

  const missing = mergeAgentInboxNoticeRows(local, answer([serverRow(PROJ, PROJ_ROW)]));
  assert.deepEqual(missing, [{ ...PROJ_ROW, channelId: PROJ }, numberless, app]);
  assert.equal(formatAgentInboxItemRow(missing[1]!, ROW_OPTIONS)[0], "#ops · mentions you");
  assert.equal(local[1]!.row.notDelivered, 2, "the Computer's row is not changed");
});

test("the notice: header, rows, the older unread line, the bracket and nothing after it", () => {
  const rows = mergeAgentInboxNoticeRows(
    [{ channelId: PROJ, row: row({ target: "#proj-x" }) }, { channelId: BOB, row: BOB_ROW }],
    answer([serverRow(PROJ, PROJ_ROW)], other(2, 4)),
  );
  assert.deepEqual(notice({ rows, older: other(2, 4) }), {
    text: [
      "[Raft inbox notice: new since your last notice, in 2 targets",
      "#proj-x · 3 unread · mentions you · latest @alice",
      "  \"@Sage can you check section 3?\" (preview)",
      "  read: raft inbox read --target \"#proj-x\"",
      "dm:@bob · latest @bob",
      "  \"hi\" (preview)",
      "  read: raft inbox read --target \"dm:@bob\"",
      "Older unread: 4 messages in 2 targets. List everything: raft inbox check",
      "]",
    ].join("\n"),
    olderMessages: 4,
  });
});

test("each header, one target and many", () => {
  const first = (input: Partial<AgentInboxNoticeInput>) => notice(input).text.split("\n")[0];
  assert.equal(first({ rows: [PROJ_ROW] }), "[Raft inbox notice: new since your last notice, in 1 target");
  assert.equal(first({ reason: "away", rows: [PROJ_ROW] }), "[Raft inbox notice: unread from while you were away, in 1 target");
  assert.equal(first({ reason: "away", rows: [PROJ_ROW, BOB_ROW, PROJ_ROW] }), "[Raft inbox notice: unread from while you were away, in 3 targets");
  assert.equal(first({ rows: [PROJ_ROW], extraTargets: 1, localSection: "App items: 1" }), "[Raft inbox notice: new since your last notice, in 2 targets");
});

test("the older unread line: only with older unread, and only when the number changed or a mention or a DM is in it", () => {
  const older = (input: Partial<AgentInboxNoticeInput>) => {
    const { text, olderMessages } = notice({ rows: [PROJ_ROW], ...input });
    return [text.split("\n").find((line) => line.startsWith("Older unread:")) ?? null, olderMessages];
  };
  assert.deepEqual(older({ older: null, previousOlderMessages: 4 }), [null, null], "the Server was not reached");
  assert.deepEqual(older({ older: other(0, 0, 0, 0) }), [null, 0], "nothing older");
  assert.deepEqual(older({ older: other(2, 4) }), ["Older unread: 4 messages in 2 targets. List everything: raft inbox check", 4], "first time");
  assert.deepEqual(older({ older: other(2, 4), previousOlderMessages: 4 }), [null, 4], "the same number as last time");
  assert.deepEqual(older({ older: other(2, 5), previousOlderMessages: 4 })[0], "Older unread: 5 messages in 2 targets. List everything: raft inbox check", "changed");
  assert.deepEqual(older({ older: other(2, 4, 1, 0), previousOlderMessages: 4 })[0], "Older unread: 4 messages in 2 targets. List everything: raft inbox check", "a mention");
  assert.deepEqual(older({ older: other(2, 4, 0, 1), previousOlderMessages: 4 })[0], "Older unread: 4 messages in 2 targets. List everything: raft inbox check", "a DM");
  assert.deepEqual(older({ older: other(1, 1) }), ["Older unread: 1 message in 1 target. List everything: raft inbox check", 1]);
  assert.deepEqual(older({ older: other(1, 0, 1, 1) }), [null, 0], "a mention with no message counted prints nothing");
  assert.equal(
    older({ older: other(1, 1), rowOptions: { inboxRead: true, hints: "tool" } })[0],
    "Older unread: 1 message in 1 target. List everything: inbox_list({})",
    "the tool style names the tool",
  );
});

const LOCAL_SECTION = ["App items: 1", "", "idle task reminder · 2 tasks", "  do: raft task list --mine"].join("\n");

test("the local section sits after the rows, a blank line before it, and before the older unread line", () => {
  assert.equal(notice({ rows: [BOB_ROW], localSection: LOCAL_SECTION, extraTargets: 1, older: other(1, 2) }).text, [
    "[Raft inbox notice: new since your last notice, in 2 targets",
    "dm:@bob · 1 unread · latest @bob",
    "  \"hi\" (preview)",
    "  read: raft inbox read --target \"dm:@bob\"",
    "",
    LOCAL_SECTION,
    "Older unread: 2 messages in 1 target. List everything: raft inbox check",
    "]",
  ].join("\n"));
  assert.equal(notice({ rows: [BOB_ROW], localSection: "" }).text.includes("\n\n"), false, "no section, no blank line");
});

// The View Context parser reads what this formatter writes; a format change it does not follow fails here.
function inboxSegment(text: string) {
  const delivery = parseRaftDelivery(text);
  assert.ok(delivery, "parsed as a Raft delivery");
  assert.deepEqual(delivery.segments.map((segment) => segment.kind), ["inbox"], "one inbox notice, never a generic fallback");
  const [segment] = delivery.segments;
  assert.ok(segment?.kind === "inbox");
  assert.deepEqual([segment.start, segment.end], [0, text.length], "the whole notice");
  return segment;
}

test("the notice parses back: the same targets, counts (none for a numberless row), reason and older numbers", () => {
  const rows = mergeAgentInboxNoticeRows(
    [
      { channelId: PROJ, row: row({ target: "#proj-x", attentionHint: HINT, nonMemberMention: true }) },
      { channelId: BOB, row: BOB_ROW },
      { channelId: OPS, row: row({ target: "#ops", unread: 2 }) },
      { channelId: null, row: row({ target: "#proj-x:#7", title: "Ship it", unread: 2 }) },
    ],
    answer([serverRow(PROJ, PROJ_ROW)], other(2, 4)),
  );
  const segment = inboxSegment(notice({ rows, older: other(2, 4), localSection: LOCAL_SECTION, extraTargets: 1 }).text);
  assert.equal(segment.reason, "new");
  assert.equal(segment.pendingTotal, null);
  assert.deepEqual(segment.older, { messages: 4, targets: 2 });
  assert.deepEqual(segment.targets, [
    { target: "#proj-x", pending: 3, latestSender: "alice", preview: "@Sage can you check section 3?", mentioned: true },
    { target: "dm:@bob", pending: null, latestSender: "bob", preview: "hi", mentioned: false },
    { target: "#ops", pending: null, latestSender: null, preview: null, mentioned: false },
    { target: "#proj-x:#7 \"Ship it\"", pending: 2, latestSender: null, preview: null, mentioned: false },
    // The local section's line reads as it does in today's notice.
    { target: "idle task reminder", pending: null, latestSender: null, preview: null, mentioned: false },
  ]);

  const away = inboxSegment(notice({ reason: "away", rows: [PROJ_ROW] }).text);
  assert.equal(away.reason, "away");
  assert.equal(away.older, null);
  assert.deepEqual(away.targets.map((target) => [target.target, target.pending]), [["#proj-x", 3]]);
});

test("merge with rows that may be behind: the Server's number plus what the Computer holds after the row's activitySeq", () => {
  const adds = (rows: ServerRow[]): AgentApiInboxRowsResponse => ({ ...answer(rows), withBehind: true });
  const localProj = row({ target: "#proj-x:local", unread: 2, mentions: 1, latestSender: { name: "carol", type: "user" }, preview: "newest, held here" });
  const localBob = row({ target: "dm:@bob-local", unread: 1, latestSender: { name: "bob", type: "user" }, preview: "hello" });
  const localOps = row({ target: "#ops-local", unread: 3 });
  const merged = mergeAgentInboxNoticeRows([
    // The view has seen seq 40 and counts 3 unread up to it; the Computer holds 40 (already counted) and 41, 42.
    { channelId: PROJ, row: localProj, heldSeqs: [40, 41, 42] },
    // Fully read before: the view has no row, so the Computer's own count stands.
    { channelId: BOB, row: localBob, heldSeqs: [50] },
    // Not asked about: no row says nothing.
    { channelId: OPS, row: localOps, heldSeqs: [60, 61, 62], asked: false },
  ], adds([serverRow(PROJ, { ...PROJ_ROW, activitySeq: 40 })]));
  assert.deepEqual(merged, [
    { ...PROJ_ROW, channelId: PROJ, activitySeq: 40, unread: 5, mentions: 1, latestSender: localProj.latestSender, preview: "newest, held here", previewTruncated: false, latestAt: null },
    localBob,
    { ...localOps, unread: 0, unreadUnknown: true },
  ]);

  // A row that already includes everything held is the Server's row untouched; a held message with no seq counts as newer.
  const caughtUp = serverRow(PROJ, { ...PROJ_ROW, activitySeq: 42 });
  assert.deepEqual(mergeAgentInboxNoticeRows([{ channelId: PROJ, row: localProj, heldSeqs: [41, 42] }], adds([caughtUp])), [caughtUp]);
  assert.equal(mergeAgentInboxNoticeRows([{ channelId: PROJ, row: localProj, heldSeqs: [42, Number.NaN] }], adds([caughtUp]))[0]!.unread, 4);

  // An answer from a Server that does not add (no `withBehind`): a missing row is still "no number".
  assert.deepEqual(mergeAgentInboxNoticeRows([{ channelId: BOB, row: localBob, heldSeqs: [50] }], answer([])), [{ ...localBob, unread: 0, unreadUnknown: true }]);
});
