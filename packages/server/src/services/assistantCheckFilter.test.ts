import assert from "node:assert/strict";

import { inQuietHours, needsOwner, rowTarget, winningRule, type CheckRow, type MatchRule } from "./assistantCheckFilter";

const now = new Date("2026-10-21T10:00:00Z");
const row = (over: Partial<CheckRow>): CheckRow => ({
  kind: "channel", channelId: "c-room", channelName: "room", channelType: "channel", parentChannelId: null, parentMessageId: null,
  unread: 1, hasMention: false, latestAt: "2026-10-21T09:59:00Z", latestSenderName: "ana", latestSenderId: "u-ana", latestSenderType: "human",
  latestPreview: "hello", latestSeq: 5, firstUnreadMessageId: "m-1", peer: null, ...over,
});
const rule = (over: Partial<MatchRule>): MatchRule => ({
  id: "r", effect: "mute", subjectKind: "channel", subjectId: "c-room", anytime: false, until: null, createdAt: new Date("2026-10-01T00:00:00Z"), ...over,
});
const run = (rows: CheckRow[], rules: MatchRule[] = [], extra: Partial<Parameters<typeof needsOwner>[0]> = {}) =>
  needsOwner({ rows, rules, now, mode: "day", toldSeq: new Map(), skippedSeq: new Map(), ownerNames: ["owen", "Owen Smith"], ...extra });
const whys = (f: ReturnType<typeof needsOwner>) => f.items.map((c) => `${c.row.channelId}:${c.why}`);

test("defaults: DMs and @mentions need the owner now; their threads and chat that names them wait for the brief", () => {
  const rows = [
    row({ channelId: "dm", channelType: "dm", peer: { id: "u-bo", type: "human" } }),
    row({ channelId: "mention", hasMention: true }),
    row({ channelId: "thread", kind: "thread", parentChannelId: "c-room", ownerParticipated: true }),
    row({ channelId: "followed-only", kind: "thread", parentChannelId: "c-room", ownerParticipated: false }),
    row({ channelId: "named", latestPreview: "can owen look at this?" }),
    row({ channelId: "named-display", latestPreview: "Owen Smith, thoughts?" }),
    row({ channelId: "not-named", latestPreview: "the owenbot deployed" }),
    row({ channelId: "chatter", latestPreview: "lunch?" }),
  ];
  const f = run(rows);
  assert.deepEqual(whys(f), ["dm:dm", "mention:mention"]);
  assert.deepEqual([f.counts.conversations, f.counts.default_out, f.counts.digest, f.counts.dm], [8, 3, 3, 1]);
  const brief = run(rows, [], { mode: "brief" });
  assert.deepEqual(whys(brief), ["dm:dm", "mention:mention", "thread:thread", "named:named", "named-display:named"]);
  assert.deepEqual([brief.counts.default_out, brief.counts.named], [3, 2]);
});

test("told by seq: covered until the conversation moves; skipped covers only named chatter", () => {
  const f = run([
    row({ channelId: "told", hasMention: true, latestSeq: 5 }),
    row({ channelId: "moved", hasMention: true, latestSeq: 9 }),
    row({ channelId: "named-skipped", latestPreview: "owen?", latestSeq: 3 }),
    row({ channelId: "named-moved", latestPreview: "owen?", latestSeq: 4 }),
    row({ channelId: "mention-skipped", hasMention: true, latestSeq: 3 }),
  ], [], {
    toldSeq: new Map([["told", 5], ["moved", 5]]),
    skippedSeq: new Map([["named-skipped", 3], ["named-moved", 3], ["mention-skipped", 3]]),
    mode: "brief",
  });
  assert.deepEqual(whys(f), ["moved:mention", "named-moved:named", "mention-skipped:mention"]);
  assert.deepEqual([f.counts.told, f.counts.skipped], [1, 1]);
});

test("rules: most specific wins, newer on a tie; channel mute keeps @mentions; digest waits for the brief", () => {
  const rules = [
    rule({ id: "mute-room", effect: "mute", subjectKind: "channel", subjectId: "c-room" }),
    rule({ id: "always-thread", effect: "always", subjectKind: "thread", subjectId: "t-1" }),
    rule({ id: "digest-ana", effect: "digest", subjectKind: "person", subjectId: "u-ana", createdAt: new Date("2026-10-02T00:00:00Z") }),
  ];
  assert.equal(winningRule(rules, { channelId: "c-room", parentChannelId: null, thread: false, dm: false, mention: false, senderId: "u-ana" }, now)?.id, "digest-ana");
  const f = run([
    row({ channelId: "c-room", latestSenderId: "u-bo" }),
    row({ channelId: "c-room-mention", hasMention: true, latestSenderId: "u-bo" }),
    row({ channelId: "t-1", kind: "thread", parentChannelId: "c-room", latestSenderId: "u-bo", ownerParticipated: true }),
    row({ channelId: "c-other", latestSenderId: "u-ana", hasMention: true }),
  ], rules);
  assert.deepEqual(whys(f), ["c-room-mention:mention", "t-1:always"]);
  assert.deepEqual([f.counts.muted, f.counts.digest], [1, 1]);
  const brief = run([row({ channelId: "c-other", latestSenderId: "u-ana" })], rules, { mode: "brief" });
  assert.deepEqual(whys(brief), ["c-other:digest"]);
});

test("a person rule needs the row to be theirs: a DM by its peer; a channel row only with one unread", () => {
  const rules = [rule({ effect: "mute", subjectKind: "person", subjectId: "u-ana" })];
  const f = run([
    row({ channelId: "dm-ana", channelType: "dm", peer: { id: "u-ana", type: "human" }, latestSenderId: "u-owner" }),
    row({ channelId: "busy", hasMention: true, unread: 3, latestSenderId: "u-ana" }),
    row({ channelId: "one", hasMention: true, unread: 1, latestSenderId: "u-ana" }),
    row({ channelId: "system", hasMention: true, latestSenderId: "u-ana", latestSenderType: "system" }),
  ], rules);
  assert.deepEqual(whys(f), ["busy:mention", "system:mention"]);
});

test("night: only an always rule marked anytime lets anything through; expired rules never match", () => {
  const rules = [
    rule({ id: "anytime", effect: "always", subjectKind: "dms", anytime: true }),
    rule({ id: "old", effect: "always", subjectKind: "channel", subjectId: "c-room", anytime: true, until: new Date("2026-10-20T00:00:00Z") }),
  ];
  const f = run([row({ channelId: "dm", channelType: "dm" }), row({ channelId: "c-room", hasMention: true })], rules, { mode: "night" });
  assert.deepEqual(whys(f), ["dm:anytime"]);
  assert.equal(f.counts.night_held, 1);
});

test("quiet hours wrap midnight; from is in, to is out", () => {
  const quiet = { from: "22:00", to: "08:00" };
  const at = (iso: string) => Date.parse(iso);
  assert.equal(inQuietHours(at("2026-10-21T14:00:00Z"), "Asia/Shanghai", quiet), true, "22:00 Shanghai");
  assert.equal(inQuietHours(at("2026-10-21T00:00:00Z"), "Asia/Shanghai", quiet), false, "08:00 Shanghai");
  assert.equal(inQuietHours(at("2026-10-21T23:59:00Z"), "Asia/Shanghai", quiet), true, "07:59 Shanghai");
  assert.equal(inQuietHours(at("2026-10-21T14:00:00Z"), "Asia/Shanghai", null), false);
  assert.equal(inQuietHours(at("2026-10-21T12:00:00Z"), "UTC", { from: "09:00", to: "17:00" }), true);
});

test("a task conversation (task v2) is filtered like a thread and keeps its task number", () => {
  const task = (over: Partial<CheckRow>): CheckRow => row({
    kind: "thread", conversationKind: "task", taskNumber: 7, channelName: "room", parentChannelId: "c-room", parentMessageId: null, ...over,
  });
  // The defaults (in the brief): one the owner wrote in passes as a thread; one they only follow is general chat; an @mention passes.
  const f = run([
    task({ channelId: "task-7", ownerParticipated: true }),
    task({ channelId: "task-8", taskNumber: 8, ownerParticipated: false }),
    task({ channelId: "task-9", taskNumber: 9, hasMention: true }),
  ], [], { mode: "brief" });
  assert.deepEqual(whys(f), ["task-7:thread", "task-9:mention"]);
  assert.deepEqual(f.items.map((i) => [i.row.conversationKind, i.row.taskNumber]), [["task", 7], ["task", 9]]);
  assert.equal(f.counts.default_out, 1);

  // The rules: a thread rule names the task's own conversation; its channel's rule reaches it through the parent.
  const rules = [
    rule({ id: "mute-room", effect: "mute", subjectKind: "channel", subjectId: "c-room" }),
    rule({ id: "always-task-7", effect: "always", subjectKind: "thread", subjectId: "task-7" }),
  ];
  const ruled = run([
    task({ channelId: "task-7", ownerParticipated: false }),
    task({ channelId: "task-8", taskNumber: 8, ownerParticipated: true }),
    task({ channelId: "task-9", taskNumber: 9, hasMention: true }),
  ], rules);
  assert.deepEqual(whys(ruled), ["task-7:always", "task-9:mention"]);
  assert.deepEqual(ruled.items.map((i) => i.row.taskNumber), [7, 9]);
  assert.equal(ruled.counts.muted, 1);
  assert.equal(winningRule(rules, { channelId: "task-8", parentChannelId: "c-room", thread: true, dm: false, mention: false, senderId: "u-ana" }, now)?.id, "mute-room");
});

test("a DM whose latest message is a system one is nobody's words: a person rule about the DM's peer (the owner, in a self-DM) never holds it", () => {
  const selfDmNotice = row({
    channelId: "self-dm", channelType: "dm", peer: { id: "u-owen", type: "human" },
    latestSenderName: null, latestSenderId: "system", latestSenderType: "system", latestPreview: "Hostco disconnected Bravo Labs from #side.",
  });
  assert.equal(rowTarget(selfDmNotice).senderId, null);
  assert.deepEqual(whys(run([selfDmNotice], [rule({ subjectKind: "person", subjectId: "u-owen" })])), ["self-dm:dm"]);
  // The owner inbox's older shape (sender type human, id system) reads the same.
  assert.equal(rowTarget({ ...selfDmNotice, latestSenderType: "human" }).senderId, null);
  // A peer's own message is still theirs.
  const peerSaid = row({ channelId: "dm", channelType: "dm", peer: { id: "u-bo", type: "human" } });
  assert.equal(rowTarget(peerSaid).senderId, "u-bo");
  assert.deepEqual(whys(run([peerSaid], [rule({ subjectKind: "person", subjectId: "u-bo" })])), []);
});
