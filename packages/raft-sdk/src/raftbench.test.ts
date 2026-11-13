// RaftBench for the hosted harness of the read-only service agent: paged
// material with one Coverage line, a submit that is resent after a lost
// response (natural write), every validation problem in one list for the
// model's single fix, and a failure kind the harness can act on in code.
import assert from "node:assert/strict";
import {
  createRaft,
  formatRaftbenchCoverage,
  isRaftbenchRunAssigned,
  raftbenchRunAssignment,
  raftbenchEmptyWindowReport,
  RAFT_OPERATIONS,
  raftbenchFailedReport,
  raftbenchFailureKind,
  raftbenchGapsFromCoverage,
  raftbenchIncompleteReport,
  type RaftbenchCoverage,
  type RaftbenchReport,
} from "./index";

const credential = "sk_agent_raftbench_sentinel";
const runId = "11111111-1111-4111-8111-111111111111";
const coverage = (over: Partial<RaftbenchCoverage> = {}): RaftbenchCoverage => ({
  from: "2026-10-17T00:00:00.000Z",
  to: "2026-10-18T00:00:00.000Z",
  fetchedMessages: 100,
  exhausted: false,
  stopReason: "more_pages",
  notRead: [],
  ...over,
});
const page = (n: number, next: string | null, cov: RaftbenchCoverage) => ({
  runId,
  revision: 2,
  sourceText: `[target=#general msg=0000000${n} time=2026-10-17 12:00:0${n}Z type=human] @alice: page ${n}`,
  sources: [{ target: "#general", messageId: `0000000${n}` }],
  coverage: cov,
  nextCursor: next,
});
const report: RaftbenchReport = { runId, revision: 2, status: "complete", patterns: [], gaps: [] };

type Call = { url: string; method: string; body: unknown };
function server(reply: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  return { calls, fetch };
}

test("readAll follows nextCursor and puts one Coverage line on top, counting messages from the last page", async () => {
  const { calls, fetch } = server((_call, i) => Response.json(i === 0
    ? page(1, "c1", coverage({ fetchedMessages: 100 }))
    : page(2, null, coverage({ fetchedMessages: 140, exhausted: true, stopReason: "window_end", notRead: ["tool execution results"] }))));
  const outcome = await createRaft({ serverUrl: "https://raft.example", credential, fetch }).raftbench.readAll({ runId });
  assert.equal(outcome.ok && outcome.state, "complete");
  if (!outcome.ok) return;
  assert.match(calls[0]!.url, new RegExp(`/internal/agent-api/raftbench/context\\?runId=${runId}$`));
  assert.match(calls[1]!.url, /cursor=c1/);
  const [coverageBlock, ...rest] = outcome.text.split("\n\n");
  const body = rest.join("\n\n");
  assert.equal(coverageBlock, [
    "Coverage: 2026-10-17 00:00:00Z to 2026-10-18 00:00:00Z; 140 messages read; the whole window was read.",
    "Not included:",
    "- tool execution results",
    "Anything not included is unknown, not free of problems.",
  ].join("\n"));
  assert.equal(body, `${page(1, null, coverage()).sourceText}\n\n${page(2, null, coverage()).sourceText}`, "pages joined by a blank line, as messages within a page; no per-page Coverage");
  assert.deepEqual(outcome.data.sources.map((s) => s.messageId), ["00000001", "00000002"]);
});

test("the Coverage line says when the window was not read in full, and why", () => {
  assert.equal(formatRaftbenchCoverage(coverage({ fetchedMessages: 2000, stopReason: "message_limit" })), [
    "Coverage: 2026-10-17 00:00:00Z to 2026-10-18 00:00:00Z; 2000 messages read; NOT the whole window: reading stopped at the message limit. Your result must have status incomplete, with this as its reason.",
    "Anything not included is unknown, not free of problems.",
  ].join("\n"));
  assert.match(formatRaftbenchCoverage(coverage({ stopReason: "char_limit" })), /NOT the whole window: reading stopped at the character limit\. Your result must have status incomplete/);
  assert.match(formatRaftbenchCoverage(coverage({ stopReason: "more_pages" })), /NOT the whole window: more pages were not read\. Your result must have status incomplete/);
  assert.equal(formatRaftbenchCoverage(coverage({ fetchedMessages: 1, exhausted: true, stopReason: "window_end" })),
    "Coverage: 2026-10-17 00:00:00Z to 2026-10-18 00:00:00Z; 1 message read; the whole window was read.");
  assert.equal(formatRaftbenchCoverage([coverage({ notRead: ["a"] }), coverage({ fetchedMessages: 200, notRead: ["a", "b"] })]).split("\n").filter((l) => l.startsWith("- ")).join("|"), "- a|- b", "one line per item, de-duplicated across pages");
  assert.equal(formatRaftbenchCoverage([]), "Coverage: nothing was read.");
});

test("submit is resent after a lost response and the replay's receipt is the result", async () => {
  const receipt = { runId, revision: 2, status: "complete", receiptId: "22222222-2222-4222-8222-222222222222", coverage: coverage({ exhausted: true, stopReason: "window_end" }) };
  const { calls, fetch } = server((_call, i) => {
    if (i === 0) throw new TypeError("connection reset");
    return Response.json(receipt);
  });
  const outcome = await createRaft({ serverUrl: "https://raft.example", credential, fetch, retry: { attempts: 3 } }).raftbench.submit(report);
  assert.equal(outcome.ok && outcome.state, "accepted");
  assert.equal(calls.length, 2, "a natural write: the identical submission is resent");
  assert.deepEqual(calls[0]!.body, calls[1]!.body);
  if (outcome.ok && outcome.data.kind === "accepted") assert.equal(outcome.data.receipt.receiptId, receipt.receiptId);
});

test("an invalid result is a normal answer listing every problem, checked locally first and then by the Server", async () => {
  const { calls, fetch } = server(() => Response.json({
    error: "Result validation failed; nothing has been saved.",
    code: "raftbench_validation_failed",
    suggestedNextAction: "Correct all listed fields once. If still invalid, submit incomplete with the validation failure as its reason.",
    issues: [
      { path: "patterns.0.evidence.0", message: "This message is not in the material.", suggestedFix: "Copy target and msg exactly from the material, or remove this reference. Nothing has been saved." },
      { path: "status", message: "The material does not cover the whole window.", suggestedFix: "Change status to incomplete." },
    ],
  }, { status: 422 }));
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });

  const local = await raft.raftbench.submit({ ...report, status: "incomplete" });
  assert.equal(local.ok && local.state, "invalid");
  assert.equal(calls.length, 0, "a result the shared schema rejects is never sent");
  if (local.ok && local.data.kind === "invalid") assert.deepEqual(local.data.issues.map((i) => i.path), ["reason"]);

  const remote = await raft.raftbench.submit(report);
  assert.equal(remote.ok && remote.state, "invalid");
  if (!remote.ok) return;
  assert.equal(remote.text, [
    "The result was not saved. Fix every item below in one go:",
    "- patterns.0.evidence.0: This message is not in the material. Copy target and msg exactly from the material, or remove this reference.",
    "- status: The material does not cover the whole window. Change status to incomplete.",
    "Reply with the complete corrected result, not only the changes.",
  ].join("\n"));
  assert.equal(remote.text.includes("submit incomplete"), false, "what happens after a second failure is the harness's rule, not the model's");
});

test("each failure tells the harness whether to read again, stop, or repeat the same request", async () => {
  const cases: Array<[string, number, string]> = [
    ["raftbench_revision_conflict", 409, "reread"],
    ["raftbench_cursor_stale", 409, "reread"],
    ["raftbench_source_unavailable", 409, "stop"],
    ["raftbench_disabled", 409, "stop"],
    ["raftbench_access_revoked", 403, "stop"],
    ["raftbench_read_permission_revoked", 403, "stop"],
    ["raftbench_run_not_owned", 404, "stop"],
    ["raftbench_service_credential_required", 403, "stop"],
    ["raftbench_hosted_required", 403, "stop"],
    ["raftbench_submission_conflict", 409, "stop"],
    ["raftbench_unavailable", 503, "retry_identical"],
  ];
  for (const [code, status, kind] of cases) {
    const { fetch } = server(() => Response.json({ error: "x", code, suggestedNextAction: "y" }, { status }));
    const outcome = await createRaft({ serverUrl: "https://raft.example", credential, fetch, retry: { attempts: 1 } }).raftbench.context({ runId });
    assert.equal(outcome.ok, false, code);
    if (!outcome.ok) {
      assert.equal(raftbenchFailureKind(outcome), kind, code);
      assert.equal(outcome.error.nextAction, "y", "the Server's words, never the raw error");
    }
  }
});

test("the run-assignment event is recognised by kind, run id and revision; anything else is not", () => {
  const text = "This run is handled automatically by the system. You do not need to take any action or reply.";
  assert.equal(isRaftbenchRunAssigned({ kind: "raftbench_run_assigned", runId, revision: 2, text }), true);
  assert.equal(isRaftbenchRunAssigned({ kind: "raftbench_run_assigned", runId, revision: 0, text }), false);
  assert.equal(isRaftbenchRunAssigned({ kind: "raftbench_run_assigned", runId: "not-a-uuid", revision: 2, text }), false);
  assert.equal(isRaftbenchRunAssigned({ kind: "message", runId, revision: 2, text }), false);
  assert.equal(isRaftbenchRunAssigned(null), false);
});

test("raftbenchIncompleteReport is a valid incomplete result; background context and submission are not model-facing operations", () => {
  const incomplete = raftbenchIncompleteReport({ runId, revision: 2 }, "  Validation failed twice: status.  ", ["partial_scan"]);
  assert.deepEqual(incomplete, { runId, revision: 2, status: "incomplete", reason: "Validation failed twice: status.", patterns: [], gaps: ["partial_scan"] });
  assert.deepEqual(RAFT_OPERATIONS.filter((op) => op.name.startsWith("raftbench")).map(op => op.name), ["raftbench.findings"]);
});

test("only the harness's failure report may carry failure; a model result with it is refused locally in plain words", async () => {
  const receipt = { runId, revision: 2, status: "incomplete", receiptId: "33333333-3333-4333-8333-333333333333", coverage: coverage() };
  const { calls, fetch } = server(() => Response.json(receipt));
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });

  const fromModel = JSON.parse(JSON.stringify(raftbenchFailedReport({ runId, revision: 2 }, "x"))) as RaftbenchReport;
  const refused = await raft.raftbench.submit(fromModel);
  assert.equal(refused.ok && refused.state, "invalid");
  assert.equal(calls.length, 0, "a report that only looks like a failure report is never sent");
  if (refused.ok && refused.data.kind === "invalid") {
    assert.deepEqual(refused.data.issues, [{ path: "failure", message: "Remove the field `failure`: it is not part of the result." }]);
  }
  const extra = await raft.raftbench.submit({ ...report, failure: true, verdict: "ok" } as unknown as RaftbenchReport);
  if (extra.ok && extra.data.kind === "invalid") assert.deepEqual(extra.data.issues.map((i) => i.message), ["Remove the field `failure`: it is not part of the result.", "Remove the field `verdict`: it is not part of the result."]);

  const failed = await raft.raftbench.submitFailure({ runId, revision: 2 }, "  Model request timed out after 25 minutes.  ");
  assert.equal(failed.ok && failed.state, "accepted");
  assert.deepEqual(calls[0]!.body, { runId, revision: 2, status: "incomplete", failure: true, reason: "Model request timed out after 25 minutes.", patterns: [], gaps: [] });
  assert.equal(raftbenchIncompleteReport({ runId, revision: 2 }, "partial").failure, undefined, "a partial analysis within budget is not a failure");
});

test("a later run of a window points at Not included instead of guessing why", () => {
  const line = formatRaftbenchCoverage(coverage({ exhausted: false, stopReason: "window_end", notRead: ["Messages earlier in this window are not included here. They may have been analyzed or skipped in previous runs."] }));
  assert.match(line, /; NOT the whole window; see Not included below\. Your result must have status incomplete\.\nNot included:\n- Messages earlier/);
  assert.equal(line.match(/must have status incomplete/g)?.length, 1, "said once, in the Coverage line");
  for (const stopReason of ["more_pages", "message_limit", "char_limit", "window_end"] as const) {
    assert.equal(formatRaftbenchCoverage(coverage({ exhausted: false, stopReason, skippedChunks: 1 })).match(/must have status incomplete/g)?.length, 1, stopReason);
  }
});

test("a model output that is not an object (null, a string, an array) is invalid, never a throw", async () => {
  const { calls, fetch } = server(() => Response.json({}));
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });
  for (const output of [null, undefined, "complete", [report], 42]) {
    const outcome = await raft.raftbench.submit(output as unknown as RaftbenchReport);
    assert.equal(outcome.ok && outcome.state, "invalid", String(output));
    if (outcome.ok && outcome.data.kind === "invalid") {
      assert.deepEqual(outcome.data.issues.map((i) => i.message), ["Your reply was not a JSON object. Reply with the complete result as one JSON object."]);
      assert.match(outcome.text, /^The result was not saved\. Fix every item below in one go:\n- result: Your reply was not a JSON object\./);
    }
  }
  assert.equal(calls.length, 0);
});

test("validation problems a model can act on, never zod's defaults", async () => {
  const { calls, fetch } = server(() => Response.json({}));
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });
  const outcome = await raft.raftbench.submit({
    runId: "not-a-run", revision: 0, status: "done", reason: 5, gaps: [],
    patterns: [{ kind: "k", explanation: "", evidence: [], counterevidence: [], evidenceLevel: "conversation_only", intent: "unknown", suggestion: "x".repeat(1001) }],
  } as unknown as RaftbenchReport);
  assert.equal(calls.length, 0);
  assert.equal(outcome.ok && outcome.state, "invalid");
  if (!outcome.ok || outcome.data.kind !== "invalid") return;
  assert.deepEqual(Object.fromEntries(outcome.data.issues.map((i) => [i.path, i.message])), {
    runId: "Copy the runId given with the material exactly.",
    revision: "Copy the revision given with the material exactly.",
    status: "Use one of: complete, incomplete.",
    reason: "Use a text string here.",
    "patterns.0.kind": "Use one of: repeated_clarification, repeated_attempt, unsupported_completion, successful_practice.",
    "patterns.0.explanation": "Do not leave this empty.",
    "patterns.0.evidence": "Give at least 1 item.",
    "patterns.0.suggestion": "Shorten this to at most 1000 characters.",
  });
  assert.equal(/Invalid input|Too small|Too big|expected/.test(outcome.text), false);
  const missing = await raft.raftbench.submit({ runId, revision: 2, status: "complete", patterns: [] } as unknown as RaftbenchReport);
  if (missing.ok && missing.data.kind === "invalid") assert.deepEqual(missing.data.issues, [{ path: "gaps", message: "Add this field: a list." }]);
});

test("gaps come from coverage, not from the model", () => {
  assert.deepEqual(raftbenchGapsFromCoverage(coverage({ exhausted: true, stopReason: "window_end" })), ["missing_tool_outcomes"]);
  assert.deepEqual(raftbenchGapsFromCoverage(coverage({ stopReason: "message_limit" })), ["missing_tool_outcomes", "budget"]);
  assert.deepEqual(raftbenchGapsFromCoverage(coverage({ stopReason: "char_limit" })), ["missing_tool_outcomes", "budget"]);
  assert.deepEqual(raftbenchGapsFromCoverage(coverage({ stopReason: "more_pages" })), ["missing_tool_outcomes", "partial_scan"]);
  assert.deepEqual(raftbenchGapsFromCoverage(coverage({ exhausted: false, stopReason: "window_end" })), ["missing_tool_outcomes", "partial_scan"], "a later run of a window");
  assert.deepEqual(raftbenchGapsFromCoverage(coverage({ exhausted: true, stopReason: "window_end", skippedChunks: 2 })), ["missing_tool_outcomes", "partial_scan"], "a skipped chunk is never a complete scan");
  assert.deepEqual(raftbenchGapsFromCoverage(coverage({ stopReason: "message_limit", skippedChunks: 1 })), ["missing_tool_outcomes", "budget", "partial_scan"], "a skip and a limit: both");
  assert.deepEqual(raftbenchGapsFromCoverage(coverage({ stopReason: "char_limit", skippedChunks: 0 })), ["missing_tool_outcomes", "budget"]);
});

test("a Server that adds a field or more notes does not break a running client", async () => {
  const notes = Array.from({ length: 16 }, (_, i) => `Note ${i} ${"x".repeat(300)}`);
  const { fetch } = server(() => Response.json({ ...page(1, null, { ...coverage({ exhausted: true, stopReason: "window_end", skippedChunks: 0 }), notRead: notes, futureField: 1 } as RaftbenchCoverage), futureTop: { a: 1 } }));
  const outcome = await createRaft({ serverUrl: "https://raft.example", credential, fetch }).raftbench.context({ runId });
  assert.equal(outcome.ok && outcome.state, "last_page");
  if (outcome.ok) assert.equal(outcome.data.coverage.notRead.length, 16);
});

test("the assignment is found in the delivered event, a third-party event, or the payload itself", () => {
  const payload = { kind: "raftbench_run_assigned", runId, revision: 2, text: "This run is handled automatically by the system. You do not need to take any action or reply." };
  assert.deepEqual(raftbenchRunAssignment({ third_party_event: { id: "e1", kind: "event", client_id: "system.raftbench", payload } }), payload);
  assert.deepEqual(raftbenchRunAssignment({ id: "e1", client_id: "system.raftbench", payload }), payload);
  assert.equal(raftbenchRunAssignment({ third_party_event: { client_id: "some-oauth-app", payload } }), null, "the same payload from another app is not an assignment");
  assert.equal(raftbenchRunAssignment({ id: "e1", payload }), null, "an event without its source is not trusted");
  assert.deepEqual(raftbenchRunAssignment(payload), payload);
  assert.equal(raftbenchRunAssignment({ third_party_event: { payload: { ...payload, revision: 0 } } }), null);
  assert.equal(raftbenchRunAssignment({ content: "run assigned" }), null);
  assert.equal(raftbenchRunAssignment(null), null);
});

test("a window with no messages is empty, not complete; its result is an ordinary incomplete made without the model", async () => {
  const { fetch } = server(() => Response.json({ ...page(1, null, coverage({ fetchedMessages: 0, exhausted: true, stopReason: "window_end" })), sourceText: "", sources: [] }));
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });
  const material = await raft.raftbench.readAll({ runId });
  assert.equal(material.ok && material.state, "empty", "never 'complete' with nothing read");
  if (!material.ok) return;
  const report = raftbenchEmptyWindowReport(material.data);
  assert.deepEqual(report, { runId, revision: 2, status: "incomplete", reason: "No messages were read in this window; nothing was analyzed.", patterns: [], gaps: ["missing_tool_outcomes"] });
  assert.equal(report.failure, undefined, "not a failure: it must not count towards the 3-failure limit");
});

test("a findings page with more to read names the next call with the same filters; the last page names none", async () => {
  const finding = {
    id: "44444444-4444-4444-8444-444444444444",
    evidenceAt: "2026-10-17T12:00:01.000Z",
    pattern: { kind: "repeated_attempt", explanation: "x", evidence: [{ target: "#general", messageId: "55555555-5555-4555-8555-555555555555" }], counterevidence: [], evidenceLevel: "conversation_only", intent: "unknown", suggestion: "" },
  };
  const body = (nextCursor: string | null) => ({ revision: 2, findings: [finding], total: 2, nextCursor, coverage: { historyFrom: null, scannedThroughAt: null, note: "n" } });
  const { calls, fetch } = server((_call, i) => Response.json(body(i === 0 ? "c1" : null)));
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch });

  const first = await raft.raftbench.findings({ kind: "repeated_attempt", period: "recent" });
  assert.equal(first.ok && first.state, "page");
  const nextArgs = { kind: "repeated_attempt", period: "recent", limit: 5, cursor: "c1" };
  assert.deepEqual(first.next, {
    kind: "next_findings_page",
    args: nextArgs,
    operation: { name: "raftbench.findings", args: nextArgs },
    why: "More findings match these filters; read the next page only if more examples would change the answer.",
  });
  const last = await raft.invoke("raftbench.findings", first.next!.operation!.args);
  assert.equal(last.ok && last.state, "last_page");
  assert.equal(last.next, null);
  assert.match(calls[1]!.url, /cursor=c1/);
  assert.match(calls[1]!.url, /kind=repeated_attempt/);
});

test("a findings refusal says whether to read the first page again or to tell the person who asked", async () => {
  const cases: Array<[string, number, string]> = [
    ["raftbench_findings_changed", 409, "reread"],
    ["raftbench_cursor_stale", 409, "reread"],
    ["raftbench_reader_not_authorized", 403, "stop"],
    ["raftbench_findings_unavailable", 409, "stop"],
    ["raftbench_disabled", 403, "stop"],
    ["raftbench_server_not_allowed", 403, "stop"],
    ["raftbench_unavailable", 503, "retry_identical"],
  ];
  for (const [code, status, kind] of cases) {
    const { fetch } = server(() => Response.json({ error: "x", code, suggestedNextAction: "y" }, { status }));
    const outcome = await createRaft({ serverUrl: "https://raft.example", credential, fetch, retry: { attempts: 1 } }).raftbench.findings();
    assert.equal(outcome.ok, false, code);
    if (!outcome.ok) {
      assert.equal(raftbenchFailureKind(outcome), kind, code);
      assert.equal(outcome.error.nextAction, "y", "the Server's words reach the model");
    }
  }
  // A code this SDK does not know still fails in the generic way, with the Server's next action.
  const { fetch } = server(() => Response.json({ error: "x", code: "raftbench_some_future_code", suggestedNextAction: "z" }, { status: 409 }));
  const unknown = await createRaft({ serverUrl: "https://raft.example", credential, fetch, retry: { attempts: 1 } }).raftbench.findings();
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error.code, "CONFLICT");
    assert.equal(unknown.error.nextAction, "z");
    assert.equal(raftbenchFailureKind(unknown), null);
  }
});
