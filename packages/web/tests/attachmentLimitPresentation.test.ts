import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages";
import { DEFAULT_LOCALE } from "../src/i18n/locale";
import { attachmentRejectionPlan, formatUploadSize, notAttachedCopy } from "../src/utils/attachmentLimitPresentation";
import type { AttachmentRejection } from "../src/utils/messageAttachmentLimits";

const fmt = createIntl({ locale: DEFAULT_LOCALE, messages: mergedMessages(DEFAULT_LOCALE) }).formatMessage;
const MIB = 1024 * 1024;
const file = (name: string, size: number) => ({ name, size });
const quota = { month: "2026-10", limitBytes: 100 * MIB, remainingBytes: 2 * MIB };

function rejection(rejected: AttachmentRejection<ReturnType<typeof file>>["rejected"], monthlyUpload: typeof quota | null = null): AttachmentRejection<ReturnType<typeof file>> {
  return { rejected, limits: { maxBytes: 50 * MIB, monthlyUpload } };
}

test("on Free, a file Pro takes opens the file-size dialog and doesn't stay", () => {
  const demo = file("demo.mov", 63 * MIB);
  assert.deepEqual(attachmentRejectionPlan(rejection([{ file: demo, reason: "size" }]), true), {
    upgradeGate: "upload_file_size",
    upgradeContext: { kind: "file_size", files: [{ name: "demo.mov", size: 63 * MIB }] },
    keep: [],
    hits: [{ limit: "file_size", response: "upgrade_dialog", sizes: [63 * MIB] }],
  });
});

test("the month's quota wins the dialog when both apply; what no plan takes stays", () => {
  const demo = file("demo.mov", 63 * MIB);
  const report = file("report.pdf", 6 * MIB);
  const huge = file("huge.mov", 250 * MIB);
  const empty = file("empty.txt", 0);
  const plan = attachmentRejectionPlan(rejection([
    { file: demo, reason: "size" },
    { file: report, reason: "quota" },
    { file: huge, reason: "size" },
    { file: empty, reason: "empty" },
  ], quota), true);

  assert.equal(plan.upgradeGate, "upload_monthly_quota");
  assert.deepEqual(plan.upgradeContext, { kind: "monthly_quota", quota, files: [{ name: "report.pdf", size: 6 * MIB }] });
  assert.deepEqual(plan.keep, [{ file: huge, reason: "size" }, { file: empty, reason: "empty" }]);
  // Recorded per limit met (upload_limit_hit), each with what Raft did about it.
  assert.deepEqual(plan.hits, [
    { limit: "monthly_quota", response: "upgrade_dialog", sizes: [6 * MIB] },
    { limit: "file_size", response: "upgrade_dialog", sizes: [63 * MIB] },
    { limit: "file_size_beyond_pro", response: "kept_unattached", sizes: [250 * MIB] },
    { limit: "empty_file", response: "kept_unattached", sizes: [0] },
  ]);
});

test("on a paid plan nothing opens the dialog: a file over the ceiling stays, saying why", () => {
  const big = file("big.mov", 63 * MIB);
  assert.deepEqual(attachmentRejectionPlan(rejection([{ file: big, reason: "size" }]), false), {
    upgradeGate: null,
    upgradeContext: null,
    keep: [{ file: big, reason: "size" }],
    hits: [{ limit: "file_size_beyond_pro", response: "kept_unattached", sizes: [63 * MIB] }],
  });
});

test("each reason a file stays says what it is, in a word, and why, in full", () => {
  assert.deepEqual(notAttachedCopy({ reason: "size", size: 250 * MIB, maxBytes: 50 * MIB, freePlan: true }, fmt), {
    label: "Too large",
    detail: "It's 250 MB. Free uploads files up to 50 MB each, and Pro up to 200 MB. Share a link instead.",
  });
  assert.deepEqual(notAttachedCopy({ reason: "size", size: 250 * MIB, maxBytes: 200 * MIB, freePlan: false }, fmt), {
    label: "Too large",
    detail: "It's 250 MB. Files can be up to 200 MB each. Share a link instead.",
  });
  assert.deepEqual(notAttachedCopy({ reason: "count", size: 1, maxBytes: 50 * MIB, freePlan: true }, fmt), {
    label: "Too many",
    detail: "A message can have up to 10 attachments.",
  });
  assert.deepEqual(notAttachedCopy({ reason: "empty", size: 0, maxBytes: 50 * MIB, freePlan: true }, fmt), {
    label: "Empty",
    detail: "Empty files can't be attached.",
  });
  assert.deepEqual(notAttachedCopy({ reason: "unchecked", size: 1, maxBytes: null, freePlan: true }, fmt), {
    label: "Not checked",
    detail: "The upload size limit could not be checked. Try again in a moment.",
  });
});

test("sizes read as limits do: whole megabytes plain, the rest to one decimal", () => {
  assert.equal(formatUploadSize(63 * MIB, fmt), "63 MB");
  assert.equal(formatUploadSize(2.44 * MIB, fmt), "2.4 MB");
  assert.equal(formatUploadSize(512 * 1024, fmt), "512.0 KB");
});
