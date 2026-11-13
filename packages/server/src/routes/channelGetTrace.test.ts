import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ACTIVITY_LIST_FETCH_REASONS,
  ACTIVITY_ROW_FETCH_REASONS,
  activityListFetchTraceAttrs,
  CHANNEL_FETCH_REASONS,
  channelFetchReasonAttr,
  channelGetTargetTraceAttrs,
  INBOX_FETCH_COALESCED_CAP,
  INBOX_FETCH_COALESCED_HEADER,
  INBOX_FETCH_TRIGGER_HEADER,
  inboxFetchTriggerTraceAttrs,
} from "./channelGetTrace";
import { INBOX_REFRESH_TRIGGERS } from "@botiverse/raft-shared";

test("records the channel type and each agreed fetch reason", () => {
  for (const reason of CHANNEL_FETCH_REASONS) {
    assert.deepEqual(channelGetTargetTraceAttrs("thread", reason), { channel_type: "thread", fetch_reason: reason });
  }
  assert.deepEqual(channelGetTargetTraceAttrs("channel", "receipts"), { channel_type: "channel", fetch_reason: "receipts" });
});

test("an older bundle without the header is unknown; anything unexpected is other", () => {
  assert.equal(channelFetchReasonAttr(undefined), "unknown");
  assert.equal(channelFetchReasonAttr(""), "unknown");
  assert.equal(channelFetchReasonAttr("Receipts"), "other");
  assert.equal(channelFetchReasonAttr("receipts; drop table"), "other");
  assert.equal(channelFetchReasonAttr(["ensure", "refresh"]), "ensure");
});

test("an unexpected channel type is collapsed, so no free text reaches the span", () => {
  assert.deepEqual(channelGetTargetTraceAttrs("some-new-type", undefined), { channel_type: "other", fetch_reason: "unknown" });
});

test("activity list loads record the list, kind and each agreed reason", () => {
  for (const reason of ACTIVITY_LIST_FETCH_REASONS) {
    assert.deepEqual(activityListFetchTraceAttrs("inbox", reason), { list: "inbox", fetch_kind: "list", fetch_reason: reason, ids_count: 0 });
  }
  assert.deepEqual(activityListFetchTraceAttrs("done", undefined), { list: "done", fetch_kind: "list", fetch_reason: "unknown", ids_count: 0 });
  assert.equal(activityListFetchTraceAttrs("followed_threads", "Initial").fetch_reason, "other");
});

test("#245: the mobile inplace_reconcile read is recorded as itself, not other", () => {
  assert.ok((ACTIVITY_LIST_FETCH_REASONS as readonly string[]).includes("inplace_reconcile"));
  assert.deepEqual(activityListFetchTraceAttrs("inbox", "inplace_reconcile"), { list: "inbox", fetch_kind: "list", fetch_reason: "inplace_reconcile", ids_count: 0 });
  assert.equal(activityListFetchTraceAttrs("inbox", "Inplace_Reconcile").fetch_reason, "other");
});

test("an ?ids= request is a row fetch with the row reasons, and only the id count is kept", () => {
  for (const reason of ACTIVITY_ROW_FETCH_REASONS) {
    assert.deepEqual(activityListFetchTraceAttrs("inbox", reason, "a,b,c"), { list: "inbox", fetch_kind: "rows", fetch_reason: reason, ids_count: 3 });
  }
  // A list reason on a row fetch is not a row reason.
  assert.equal(activityListFetchTraceAttrs("inbox", "initial", "a").fetch_reason, "other");
  assert.equal(activityListFetchTraceAttrs("inbox", "follow_change", "").fetch_kind, "list");
  assert.equal(activityListFetchTraceAttrs("inbox", undefined, ["x,y"]).ids_count, 2);
  assert.ok(!JSON.stringify(activityListFetchTraceAttrs("inbox", "read_partial", "secret-id")).includes("secret-id"));
});

test("ids_count is capped just above the route limit of 50", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`).join(",");
  assert.equal(activityListFetchTraceAttrs("inbox", "read_partial", ids(50)).ids_count, 50);
  assert.equal(activityListFetchTraceAttrs("inbox", "read_partial", ids(51)).ids_count, 51);
  assert.equal(activityListFetchTraceAttrs("inbox", "read_partial", ids(5000)).ids_count, 51);
});

test("#triage:#229: records each agreed inbox refresh trigger and its coalesced count", () => {
  assert.equal(INBOX_FETCH_TRIGGER_HEADER, "x-raft-fetch-trigger");
  assert.equal(INBOX_FETCH_COALESCED_HEADER, "x-raft-fetch-coalesced");
  for (const trigger of INBOX_REFRESH_TRIGGERS) {
    assert.deepEqual(inboxFetchTriggerTraceAttrs(trigger, "3"), { fetch_trigger: trigger, fetch_coalesced: 3 });
  }
  assert.deepEqual(inboxFetchTriggerTraceAttrs(["dm_new", "message_new"], ["2", "9"]), { fetch_trigger: "dm_new", fetch_coalesced: 2 });
});

test("#triage:#229: an absent trigger is unknown, an unlisted one other; a bad count is 0, a huge one capped", () => {
  assert.deepEqual(inboxFetchTriggerTraceAttrs(undefined, undefined), { fetch_trigger: "unknown", fetch_coalesced: 0 });
  assert.deepEqual(inboxFetchTriggerTraceAttrs("", ""), { fetch_trigger: "unknown", fetch_coalesced: 0 });
  assert.equal(inboxFetchTriggerTraceAttrs("Message_New", "1").fetch_trigger, "other");
  assert.equal(inboxFetchTriggerTraceAttrs("message_new; drop table", "1").fetch_trigger, "other");
  assert.equal(inboxFetchTriggerTraceAttrs("realtime_fallback", "1").fetch_trigger, "other", "a reason is not a trigger");
  for (const bad of ["-1", "1.5", "abc", " 2", "1e3", "0x10"]) {
    assert.equal(inboxFetchTriggerTraceAttrs("dm_new", bad).fetch_coalesced, 0, bad);
  }
  assert.equal(inboxFetchTriggerTraceAttrs("dm_new", "999999999").fetch_coalesced, INBOX_FETCH_COALESCED_CAP);
});
