import assert from "node:assert/strict";
import { AttachmentUploadClientError } from "../src/utils/directAttachmentUpload";
import { monthlyUploadResetsAt, readMonthlyUploadQuota, uploadQuotaRefusal } from "../src/utils/monthlyUploadQuota";
import { monthlyUploadUsedUp, noteMonthlyUploadQuota, useMonthlyUploadQuotaStore } from "../src/store/monthlyUploadQuotaStore";
import { useServerStore } from "../src/store/serverStore";

const MIB = 1024 * 1024;
const quota = (remainingBytes: number, month = "2026-10") => ({ month, limitBytes: 100 * MIB, remainingBytes });
const OCT_28 = new Date("2026-10-28T08:00:00Z");

beforeEach(() => {
  useMonthlyUploadQuotaStore.setState({ serverId: null, quota: null });
  useServerStore.setState({ current: { id: "server-1", plan: "free" } as never, billing: null });
});

test("a server body is a quota only with its three fields", () => {
  assert.deepEqual(readMonthlyUploadQuota({ ...quota(0), usedBytes: 7 }), quota(0));
  for (const body of [null, undefined, "x", { month: "2026-10" }, { ...quota(1), month: "October" }, { ...quota(1), limitBytes: 0 }, { ...quota(-1) }]) {
    assert.equal(readMonthlyUploadQuota(body), null, JSON.stringify(body));
  }
});

test("the quota resets when the next UTC month starts, December into January too", () => {
  assert.equal(monthlyUploadResetsAt(quota(0)).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(monthlyUploadResetsAt(quota(0, "2026-12")).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("both upload paths' quota refusals are recognised, and nothing else is", () => {
  // Direct upload: the session route's code and monthlyUpload.
  assert.deepEqual(uploadQuotaRefusal(new AttachmentUploadClientError("FILE_UPLOAD_QUOTA_EXCEEDED", "…", false, undefined, quota(0))), quota(0));
  // Legacy upload: errorCode and the quota summary.
  assert.deepEqual(uploadQuotaRefusal({ response: { data: { errorCode: "FILE_UPLOAD_QUOTA_EXCEEDED", quota: { ...quota(0), usedBytes: 100 * MIB } } } }), quota(0));
  assert.equal(uploadQuotaRefusal(new AttachmentUploadClientError("UPLOAD_FORBIDDEN", "The member cannot upload to this channel.")), null);
  assert.equal(uploadQuotaRefusal({ response: { data: { errorCode: "ATTACHMENT_TOO_LARGE" } } }), null);
  assert.equal(uploadQuotaRefusal(new Error("network")), null);
});

test("the month counts as used up under 1 MB left, on this Free server, this month", () => {
  noteMonthlyUploadQuota("server-1", quota(MIB - 1));
  assert.deepEqual(monthlyUploadUsedUp(OCT_28), quota(MIB - 1));

  noteMonthlyUploadQuota("server-1", quota(MIB));
  assert.equal(monthlyUploadUsedUp(OCT_28), null, "1 MB left is still worth picking a file for");
});

test("a used-up answer from another server, another month, or before upgrading doesn't block", () => {
  noteMonthlyUploadQuota("server-2", quota(0));
  assert.equal(monthlyUploadUsedUp(OCT_28), null, "another server's");

  noteMonthlyUploadQuota("server-1", quota(0, "2026-09"));
  assert.equal(monthlyUploadUsedUp(OCT_28), null, "last month's: this one started fresh");

  noteMonthlyUploadQuota("server-1", quota(0));
  useServerStore.setState({ billing: { plan: "pro" } as never });
  assert.equal(monthlyUploadUsedUp(OCT_28), null, "the server is Pro now");
});


test("AppSumo identity survives both refusal formats and blocks preselection without a billing read", () => {
  const managed = { month: "2026-10", limitBytes: 1024 ** 3, remainingBytes: 0, source: "appsumo" as const };
  assert.deepEqual(readMonthlyUploadQuota(managed), managed);
  assert.deepEqual(uploadQuotaRefusal({ response: { data: { errorCode: "FILE_UPLOAD_QUOTA_EXCEEDED", quota: { month: managed.month, limitBytes: managed.limitBytes, remainingBytes: 0, appsumo: { tier: 1, lifetime: true } } } } }), managed);
  assert.deepEqual(uploadQuotaRefusal(new AttachmentUploadClientError("FILE_UPLOAD_QUOTA_EXCEEDED", "limit", false, undefined, managed)), managed);
  useServerStore.setState({ current: { id: "server-1", plan: "pro" } as never, billing: null });
  noteMonthlyUploadQuota("server-1", managed);
  assert.deepEqual(monthlyUploadUsedUp(OCT_28), managed);
  assert.equal(monthlyUploadUsedUp(new Date("2026-11-01T00:00:00Z")), null);
  useServerStore.setState({ current: { id: "server-1", plan: "partner" } as never });
  assert.equal(monthlyUploadUsedUp(OCT_28), null);
});
