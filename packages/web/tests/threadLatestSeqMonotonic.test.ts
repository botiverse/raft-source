import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

// task #361 — Activity thread-latest monotonic seq fix (read-side).
//
// Contract (three-axis model): the authoritative content frontier is
// `latestActivitySeq` (DB bigint canonical decimal string). `replyCount` is
// display-only and must NEVER veto a newer seq. The pre-fix bug: an
// out-of-order/re-delivered old socket reply inflated `replyCount` and regressed
// `latestActivityMessageId`, and `preserveNewerThreadActivity` used `replyCount`
// as the version — freezing a stale latest activity (old seq 10879336 displayed
// over the true newer seq 10938105).
//
// These teeth pin: seq monotonicity + fail-closed (no timestamp/messageId
// fallback, no Number() precision hole), newer-seq-wins-despite-lower-replyCount,
// older-seq-cannot-overwrite, same-seq-idempotent, the Done marker keys off the
// authoritative seq, and the reverse fixture (old code RED → new code restores
// the true newer frontier).

const {
  compareActivitySeq,
  safeSeqToDecimalString,
  preserveNewerThreadActivity,
  rememberLocalThreadActivity,
  clearInboxLocalThreadActivityHighWater,
  inboxItemLatestMarker,
} = await import("../src/store/inboxStore.js");

type ThreadItem = {
  kind: "thread";
  threadChannelId: string;
  parentMessageId: string;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: "channel" | "private" | "joint" | "dm";
  parentMessagePreview: string;
  parentMessageSenderType: "user" | "agent";
  parentMessageSenderId: string;
  latestActivityPreview: string;
  latestActivitySenderType: "user" | "agent" | "system";
  latestActivitySenderId: string;
  latestActivityMessageId: string;
  latestActivitySeq: string | null;
  firstUnreadMessageId: string | null;
  firstMentionMessageId: string | null;
  replyCount: number;
  lastActivityAt: string;
  lastReplyAt: string | null;
  unreadCount: number;
  hasMention: boolean;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByName: string | null;
};

function thread(overrides: Partial<ThreadItem> = {}): ThreadItem {
  return {
    kind: "thread",
    threadChannelId: "thread-1",
    parentMessageId: "parent-1",
    parentChannelId: "channel-1",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent preview",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "latest preview",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-1",
    latestActivityMessageId: "msg-latest",
    latestActivitySeq: null,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 0,
    lastActivityAt: "2026-07-29T00:00:00.000+00",
    lastReplyAt: "2026-07-29T00:00:00.000+00",
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

afterEach(() => {
  clearInboxLocalThreadActivityHighWater();
});

// ---------------------------------------------------------------------------
// compareActivitySeq — exact BigInt monotonic compare, fail-closed, no 2^53 hole
// ---------------------------------------------------------------------------

test("compareActivitySeq: newer canonical decimal seq wins", () => {
  assert.ok(compareActivitySeq("10938105", "10879336") > 0);
  assert.ok(compareActivitySeq("10879336", "10938105") < 0);
  assert.equal(compareActivitySeq("10938105", "10938105"), 0);
});

test("compareActivitySeq: adjacent seqs beyond 2^53 do not collapse (no Number() hole)", () => {
  // 2^53 = 9007199254740992. Adjacent int64 values must stay distinct.
  const a = "9007199254740992"; // 2^53
  const b = "9007199254740993"; // 2^53 + 1 (Number() would collapse this to 2^53)
  assert.ok(compareActivitySeq(b, a) > 0, "2^53+1 must compare greater than 2^53");
  assert.ok(compareActivitySeq(a, b) < 0);
  // int64 max stays distinct from int64 max - 1.
  assert.ok(compareActivitySeq("9223372036854775807", "9223372036854775806") > 0);
});

test("compareActivitySeq: absent/invalid seq is fail-closed (loses to any valid seq)", () => {
  // null/undefined lose to a present seq; two absents are equal.
  assert.ok(compareActivitySeq(null, "5") < 0);
  assert.ok(compareActivitySeq("5", null) > 0);
  assert.equal(compareActivitySeq(null, null), 0);
  assert.equal(compareActivitySeq(undefined, undefined), 0);
  // Non-canonical input (leading zero, non-digit, empty) is treated as absent,
  // never guessed — so it cannot win over a valid seq.
  assert.ok(compareActivitySeq("007", "5") < 0, "leading-zero seq must be rejected, not parsed as 7");
  assert.ok(compareActivitySeq("5", "007") > 0);
  assert.ok(compareActivitySeq("12abc", "5") < 0, "non-digit seq must be rejected");
  assert.ok(compareActivitySeq("", "5") < 0, "empty seq must be rejected");
  // "0" is canonical (a real seq value), not rejected.
  assert.equal(compareActivitySeq("0", "0"), 0);
  assert.ok(compareActivitySeq("1", "0") > 0);
});

// ---------------------------------------------------------------------------
// safeSeqToDecimalString — legacy socket seq overlay, never fabricate
// ---------------------------------------------------------------------------

test("safeSeqToDecimalString: safe non-negative integer converts; missing/unsafe refused", () => {
  assert.equal(safeSeqToDecimalString(0), "0");
  assert.equal(safeSeqToDecimalString(10938105), "10938105");
  assert.equal(safeSeqToDecimalString(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
  // Missing / unsafe / negative / non-integer must NOT be guessed.
  assert.equal(safeSeqToDecimalString(undefined), null);
  assert.equal(safeSeqToDecimalString(null), null);
  assert.equal(safeSeqToDecimalString(-1), null);
  assert.equal(safeSeqToDecimalString(1.5), null);
  assert.equal(safeSeqToDecimalString(Number.NaN), null);
  // Beyond safe integer range: refuse (would be an irreversible truncated value).
  assert.equal(safeSeqToDecimalString(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(safeSeqToDecimalString(Infinity), null);
});

// ---------------------------------------------------------------------------
// preserveNewerThreadActivity — seq is the version, replyCount never vetoes
// ---------------------------------------------------------------------------

test("preserveNewerThreadActivity: newer seq wins even when replyCount is LOWER (the core bug)", () => {
  // Local high-water: stale row, inflated replyCount (the pre-fix inflation).
  const stale = thread({ latestActivityMessageId: "msg-stale", latestActivitySeq: "10879336", replyCount: 9 });
  rememberLocalThreadActivity(stale);
  // Incoming server row: genuinely newer seq but a LOWER replyCount.
  const incoming = thread({ latestActivityMessageId: "msg-true", latestActivitySeq: "10938105", replyCount: 3 });

  const { items } = preserveNewerThreadActivity([incoming], [stale]);
  assert.equal(items[0].latestActivityMessageId, "msg-true", "newer seq must win despite lower replyCount");
  assert.equal((items[0] as ThreadItem).latestActivitySeq, "10938105");
});

test("preserveNewerThreadActivity: newer seq wins when replyCount is EQUAL too", () => {
  const stale = thread({ latestActivityMessageId: "msg-stale", latestActivitySeq: "100", replyCount: 5 });
  rememberLocalThreadActivity(stale);
  const incoming = thread({ latestActivityMessageId: "msg-true", latestActivitySeq: "200", replyCount: 5 });
  const { items } = preserveNewerThreadActivity([incoming], [stale]);
  assert.equal(items[0].latestActivityMessageId, "msg-true");
});

test("preserveNewerThreadActivity: older seq cannot overwrite newer (even with higher replyCount)", () => {
  const current = thread({ latestActivityMessageId: "msg-new", latestActivitySeq: "10938105", replyCount: 3 });
  rememberLocalThreadActivity(current);
  // An out-of-order old reply hydrated from the server: older seq, inflated replyCount.
  const incoming = thread({ latestActivityMessageId: "msg-old", latestActivitySeq: "10879336", replyCount: 99 });
  const { items } = preserveNewerThreadActivity([incoming], [current]);
  assert.equal(items[0].latestActivityMessageId, "msg-new", "older seq must not overwrite newer");
  assert.equal((items[0] as ThreadItem).latestActivitySeq, "10938105");
});

test("preserveNewerThreadActivity: same seq is idempotent (same message accepted, different message not)", () => {
  const current = thread({ latestActivityMessageId: "msg-a", latestActivitySeq: "500", replyCount: 5 });
  rememberLocalThreadActivity(current);
  // Same seq + same messageId → accepted (no-op equivalent).
  const sameMsg = thread({ latestActivityMessageId: "msg-a", latestActivitySeq: "500", replyCount: 5 });
  const r1 = preserveNewerThreadActivity([sameMsg], [current]);
  assert.equal(r1.items[0].latestActivityMessageId, "msg-a");
  // Same seq + different messageId → not newer → current preserved.
  const diffMsg = thread({ latestActivityMessageId: "msg-b", latestActivitySeq: "500", replyCount: 5 });
  const r2 = preserveNewerThreadActivity([diffMsg], [current]);
  assert.equal(r2.items[0].latestActivityMessageId, "msg-a", "same seq with a different message must not replace current");
});

test("preserveNewerThreadActivity: invalid incoming seq is fail-closed (does not win)", () => {
  const current = thread({ latestActivityMessageId: "msg-new", latestActivitySeq: "10938105", replyCount: 3 });
  rememberLocalThreadActivity(current);
  // Incoming carries a non-canonical seq (leading zero) — must be treated as absent
  // and therefore must NOT win over the valid current seq.
  const incoming = thread({ latestActivityMessageId: "msg-bad", latestActivitySeq: "007", replyCount: 99 });
  const { items } = preserveNewerThreadActivity([incoming], [current]);
  assert.equal(items[0].latestActivityMessageId, "msg-new", "invalid seq must be fail-closed, not parsed/guessed");
});

test("preserveNewerThreadActivity: seq absent on BOTH sides is fail-closed (no replyCount fallback)", () => {
  // Gate B1-3: latestActivitySeq is now required on every row, so a missing seq is an
  // invalid/pre-activation state. Fail closed (keep current) — do NOT fall back to the
  // display-only replyCount, which would re-mix axes and let a non-frontier axis win.
  const current = thread({ latestActivityMessageId: "msg-a", latestActivitySeq: null, replyCount: 2 });
  rememberLocalThreadActivity(current);
  const higherCount = thread({ latestActivityMessageId: "msg-b", latestActivitySeq: null, replyCount: 5 });
  const r1 = preserveNewerThreadActivity([higherCount], [current]);
  assert.equal(r1.items[0].latestActivityMessageId, "msg-a", "both-seq-absent must fail closed, not use replyCount");
});

test("preserveNewerThreadActivity: incoming has seq but local high-water lacks seq -> fail-closed (incoming does NOT win)", () => {
  // One side (local high-water) lacks seq -> fail closed; a valid incoming seq alone
  // cannot win over an absent local frontier (no axis to compare against).
  const current = thread({ latestActivityMessageId: "msg-current", latestActivitySeq: null, replyCount: 5 });
  rememberLocalThreadActivity(current);
  const incoming = thread({ latestActivityMessageId: "msg-incoming", latestActivitySeq: "100", replyCount: 3 });
  const { items } = preserveNewerThreadActivity([incoming], [current]);
  assert.equal(items[0].latestActivityMessageId, "msg-current", "local-seq-absent must fail closed even vs a valid incoming seq");
});

test("preserveNewerThreadActivity: incoming lacks seq but local has seq -> fail-closed (higher replyCount does NOT win)", () => {
  // One side (incoming) lacks seq -> fail closed; the higher replyCount must NOT win
  // (this is exactly the legacy replyCount fallback that Gate B1-3 removes).
  const current = thread({ latestActivityMessageId: "msg-current", latestActivitySeq: "100", replyCount: 5 });
  rememberLocalThreadActivity(current);
  const incoming = thread({ latestActivityMessageId: "msg-incoming", latestActivitySeq: null, replyCount: 99 });
  const { items } = preserveNewerThreadActivity([incoming], [current]);
  assert.equal(items[0].latestActivityMessageId, "msg-current", "incoming-seq-absent must fail closed; replyCount must not veto");
});

test("preserveNewerThreadActivity REVERSE FIXTURE: old-reply inflation then hydrate true newer (old logic RED)", () => {
  // Reproduce the production shape: an old reply (seq 10879336) inflated the local
  // replyCount; the server then hydrates the true newer frontier (seq 10938105) with
  // a lower/equal replyCount. Pre-fix (replyCount-as-version) this preserved the
  // stale row; the seq contract must restore the true newer frontier.
  const staleInflated = thread({
    latestActivityMessageId: "4e2ed00a",
    latestActivitySeq: "10879336",
    replyCount: 8, // inflated by the out-of-order old reply
  });
  rememberLocalThreadActivity(staleInflated);
  const trueNewer = thread({
    latestActivityMessageId: "b11fe7af",
    latestActivitySeq: "10938105",
    replyCount: 6, // genuinely newer frontier, lower count
  });
  const { items } = preserveNewerThreadActivity([trueNewer], [staleInflated]);
  assert.equal(items[0].latestActivityMessageId, "b11fe7af", "true newer seq must be restored");
  assert.equal((items[0] as ThreadItem).latestActivitySeq, "10938105");
});

// ---------------------------------------------------------------------------
// inboxItemLatestMarker — Done/read suppression marker keys off the seq
// ---------------------------------------------------------------------------

test("inboxItemLatestMarker: uses the normalised AUTHORITY frontier seq", () => {
  const withAuthority = thread({
    latestActivityMessageId: "msg-x",
    latestActivitySeq: "10938105",
    readStateLatestActivitySeq: "10938105",
  } as never);
  assert.equal(inboxItemLatestMarker(withAuthority), "10938105");
});

test("inboxItemLatestMarker: NO authority frontier -> null, never the display pair (#632 C1)", () => {
  // Retired deliberately. The display pair keeps the zero-reply parent
  // fallback, which puts the PARENT channel's seq beside a thread scope — a
  // different seq domain from the thread's own cursor, and the error family
  // behind "the row will not stay read". Returning null here is the point.
  const noAuthority = thread({
    latestActivityMessageId: "msg-x",
    latestActivitySeq: "10938105",
    readStateLatestActivitySeq: null,
  } as never);
  assert.equal(inboxItemLatestMarker(noAuthority), null);
});

test("inboxItemLatestMarker: channel rows no longer fall back to lastMessageId (#632 C1)", () => {
  // The second marker authority is retired too — otherwise threads key off the
  // union while channel/DM keep a parallel id-based key.
  const channel = {
    kind: "channel",
    channelId: "c1",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "last-msg",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-29T00:00:00.000+00",
    lastMessagePreview: "p",
    lastMessageSenderType: "user",
    lastMessageSenderId: "u1",
    lastMessageSenderName: null,
    unreadCount: 0,
    hasMention: false,
  };
  assert.equal(inboxItemLatestMarker(channel as never), null);
  assert.equal(
    inboxItemLatestMarker({ ...channel, readStateLatestActivitySeq: "909" } as never),
    "909",
    "a channel row with the authority frontier keys off it, same rule as threads",
  );
});
