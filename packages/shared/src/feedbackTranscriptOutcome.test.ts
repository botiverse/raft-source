// task #1228 ①, reviewer ruling: the uploaded transcript_outcome object carries
// NO paths. The builder never copies one in, and the strict parser rejects an
// object that carries `searchedPaths` (or any other unknown lookup key).
import assert from "node:assert/strict";
import { buildFeedbackTranscriptOutcome, parseFeedbackTranscriptOutcome } from "./index";

const LOOKUP = {
  reachable: false, content: "placeholder", reasonCode: "native_session_file_not_found", runtime: "claude",
  lookupMethod: "claude_jsonl", workspaceDirPresent: null, sourceBytes: null, transcriptBytes: null, selectionBasis: "lookup_time",
} as const;
const UPLOAD = { status: "not_attempted", reason: "lookup_failed", stage: null, httpStatus: null, httpClass: null, uploadId: null, contentLabel: null } as const;

function input(lookupExtra: Record<string, unknown> = {}) {
  return {
    feedbackReportId: "report-1",
    agentId: "agent-1",
    requestId: "req-1",
    daemonVersion: "1.0.43",
    generatedAt: "2026-10-04T08:00:01.000Z",
    lookup: { ...LOOKUP, ...lookupExtra },
    upload: UPLOAD,
  } as any;
}

function envelope(lookupExtra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "feedback_transcript_outcome", schemaVersion: 1, selfStorage: "not_self_attested", ...input(lookupExtra) };
}

function assertNoPath(json: string): void {
  for (const needle of ["/srv/", "custom-private-workspace", "~", "/", "\\", "searchedPaths"]) {
    assert.ok(!json.includes(needle), `outcome JSON carries ${JSON.stringify(needle)}: ${json}`);
  }
}

test("a lookup that searched an absolute custom-dataDir path builds an outcome with no path at all", () => {
  const built = buildFeedbackTranscriptOutcome(input({ searchedPaths: ["/srv/custom-private-workspace/agent/agent-1"] }));
  assert.ok(built.ok, JSON.stringify(built));
  assertNoPath(built.json);
  assertNoPath(JSON.stringify(built.envelope));
});

test("a home-folded ~/... path is absent from the built outcome", () => {
  const built = buildFeedbackTranscriptOutcome(input({ searchedPaths: ["~/.claude/projects/-srv-custom-private-workspace"] }));
  assert.ok(built.ok, JSON.stringify(built));
  assertNoPath(built.json);
});

test("the path-free lookup shape is accepted (positive control)", () => {
  const parsed = parseFeedbackTranscriptOutcome(envelope());
  assert.equal(parsed.lookup.reasonCode, "native_session_file_not_found");
  assertNoPath(JSON.stringify(parsed));
});

test("the strict parser rejects an outcome carrying searchedPaths (even empty) or any unknown lookup key", () => {
  assert.throws(() => parseFeedbackTranscriptOutcome(envelope({ searchedPaths: ["~/.claude/projects"] })), /unknown field/);
  assert.throws(() => parseFeedbackTranscriptOutcome(envelope({ searchedPaths: [] })), /unknown field/);
  assert.throws(() => parseFeedbackTranscriptOutcome(envelope({ searchedPath: "/srv/x" })), /unknown field/);
  assert.throws(() => parseFeedbackTranscriptOutcome({ ...envelope(), searchedPaths: [] }), /unknown field/);
});

test("the result-frame reader never throws: typed / untyped / invalid", async () => {
  const { readFeedbackTranscriptResultOutcome } = await import("./index") as any;
  assert.equal(typeof readFeedbackTranscriptResultOutcome, "function");
  const upload = UPLOAD;
  assert.equal(readFeedbackTranscriptResultOutcome({ reachable: true }).status, "untyped");
  const typed = readFeedbackTranscriptResultOutcome({ outcomeVersion: 1, lookup: LOOKUP, upload, outcomeObject: "attempt_after_result" });
  assert.equal(typed.status, "typed");
  assert.deepEqual(typed.lookup, LOOKUP);
  for (const [i, frame] of [
    null, "x", [], { outcomeVersion: 1, lookup: { reachable: false }, upload: { status: "not_attempted" } },
    { outcomeVersion: 1, lookup: LOOKUP }, { outcomeVersion: 1, lookup: { ...LOOKUP, searchedPaths: [] }, upload },
    { outcomeVersion: 2, lookup: LOOKUP, upload }, { lookup: LOOKUP, upload }, { outcomeVersion: 1, lookup: LOOKUP, upload, outcomeObject: 7 },
    { get outcomeVersion() { throw new Error("hostile getter"); } },
  ].entries()) {
    const read = readFeedbackTranscriptResultOutcome(frame);
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      assert.ok(read.status === "untyped" || read.status === "invalid", `case ${i}`);
    } else {
      assert.equal(read.status, "invalid", `case ${i}`);
      assert.ok(typeof read.reason === "string" && read.reason.length > 0 && read.reason.length <= 120);
    }
  }
});

test("the session-record answer: stored → attached; any other typed upload → not_attached; untyped → null", async () => {
  const { feedbackSessionRecordAnswer, isFeedbackSessionRecordAnswer, FEEDBACK_SESSION_RECORD_ANSWERS } = await import("./index");
  assert.deepEqual([...FEEDBACK_SESSION_RECORD_ANSWERS], ["attached", "not_attached"]);
  const typed = (upload: Record<string, unknown>) => ({ outcomeVersion: 1 as const, upload: { ...UPLOAD, ...upload } as any });

  assert.equal(feedbackSessionRecordAnswer(typed({ status: "stored", reason: null, uploadId: "upload-1", contentLabel: "signed" })), "attached");
  // Not attached, whatever the reason: the reason is not something the Computer verified for the reporter.
  assert.equal(feedbackSessionRecordAnswer(typed({ status: "not_attempted", reason: "lookup_failed" })), "not_attached");
  assert.equal(feedbackSessionRecordAnswer(typed({ status: "not_attempted", reason: "worker_not_configured" })), "not_attached");
  assert.equal(feedbackSessionRecordAnswer(typed({ status: "not_attempted", reason: null })), "not_attached");
  assert.equal(feedbackSessionRecordAnswer(typed({ status: "failed", reason: "upload_failed", stage: "put", httpStatus: 503, httpClass: "5xx" })), "not_attached");

  // An older Computer: no typed outcome, so nothing is claimed.
  assert.equal(feedbackSessionRecordAnswer({}), null);
  assert.equal(feedbackSessionRecordAnswer({ outcomeVersion: 1 }), null);
  assert.equal(feedbackSessionRecordAnswer({ upload: { ...UPLOAD, status: "stored", reason: null } }), null);

  for (const answer of FEEDBACK_SESSION_RECORD_ANSWERS) assert.equal(isFeedbackSessionRecordAnswer(answer), true);
  for (const other of ["stored", "not_found", "not_uploaded", "requested", "", "ATTACHED", null, undefined, 1, {}, ["attached"]]) {
    assert.equal(isFeedbackSessionRecordAnswer(other), false, JSON.stringify(other));
  }
});
