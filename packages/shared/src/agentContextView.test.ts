import assert from "node:assert/strict";
import {
  AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE,
  AGENT_CONTEXT_VIEW_DAEMON_FAILURE_REASONS,
  AGENT_CONTEXT_VIEW_FAILURE_REASON_PRODUCERS,
  AGENT_CONTEXT_VIEW_FAILURE_REASONS,
  AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS,
  AGENT_CONTEXT_VIEW_MAX_BYTES,
  AGENT_CONTEXT_VIEW_REQUEST_TYPE,
  AGENT_CONTEXT_VIEW_RESULT_ROUTE,
  agentContextViewResultPath,
  asAgentContextViewRequestId,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
  mintAgentContextViewRequestId,
  parseAgentContextView,
  parseAgentContextViewResultBody,
  readAgentContextViewAvailability,
  readAgentContextViewRequest,
  type AgentContextView,
  type AgentContextViewRequestId,
} from "./agentContextView";
import { AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY } from "./featureFlags";
import type { MachineToServerMessage, ServerToMachineMessage } from "./index";

const REQUEST_ID = asAgentContextViewRequestId("ctxv_0123456789abcdef0123")!;

function nativeExample(): AgentContextView {
  return {
    runtime: "claude",
    model: "claude-opus-4-5",
    sessionId: "session-1",
    requestAt: "2026-11-04T08:00:00.000Z",
    messageId: "msg-1",
    tokens: { input: 1200, cacheRead: 48000, total: 50000 },
    system: [{ text: "You are an agent in Raft." }, { text: "Workspace rules." }],
    tools: [
      { name: "Bash", description: "Run a shell command.", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "Read", description: "", inputSchema: null },
    ],
    messages: [
      { role: "user", parts: [{ kind: "text", text: "New message in #general: can you check CI?" }] },
      {
        role: "assistant",
        parts: [
          { kind: "thinking", text: "I should look at the CI run first." },
          { kind: "tool_use", toolName: "Bash", toolUseId: "toolu_1", input: { command: "gh run list --limit 1" } },
        ],
      },
      {
        role: "user",
        parts: [
          { kind: "tool_result", toolName: "Bash", toolUseId: "toolu_1", output: "completed success", isError: false },
          { kind: "image", mediaType: "image/png", sizeBytes: 48213 },
        ],
      },
      {
        role: "assistant",
        parts: [
          { kind: "thinking", text: null },
          { kind: "text", text: "Replying." },
          { kind: "tool_use", toolName: "Bash", toolUseId: "toolu_2", input: { command: "raft message send --target '#general' 'CI is green'" } },
        ],
      },
    ],
    compaction: { happened: false },
    trigger: { messageIndex: 3, partIndex: 2, toolUseId: "toolu_2" },
    redactions: { jwt: 1, secret_assignment: 2 },
    source: { kind: "native", format: "claude-jsonl", version: "2.1.0" },
  };
}

function capturedExample(): AgentContextView {
  return {
    runtime: "codex",
    model: null,
    sessionId: "thread-9",
    requestAt: null,
    messageId: "msg-2",
    tokens: { input: null, cacheRead: null, total: null },
    system: [],
    tools: [],
    messages: [
      { role: "system", parts: [{ kind: "compaction", text: null }] },
      { role: "tool", parts: [{ kind: "tool_result", toolName: null, toolUseId: null, output: "", isError: true }] },
    ],
    compaction: { happened: true, summary: { kind: "encrypted" } },
    trigger: null,
    redactions: {},
    source: { kind: "captured", format: "provider-request", version: null },
  };
}

describe("AgentContextView", () => {
  test("examples round-trip through JSON and the parser unchanged", () => {
    for (const example of [nativeExample(), capturedExample()]) {
      const wire = JSON.parse(JSON.stringify(example)) as unknown;
      assert.deepEqual(parseAgentContextView(wire), { ok: true, context: example });
      assert.deepEqual(parseAgentContextViewResultBody({ ok: true, context: wire }), { ok: true, body: { ok: true, context: example } });
    }
  });

  test("compaction with a text summary and with no retained summary both parse", () => {
    for (const compaction of [{ happened: true, summary: { kind: "text", text: "Earlier: fixed CI." } }, { happened: true, summary: null }] as const) {
      const parsed = parseAgentContextView({ ...nativeExample(), compaction });
      assert.ok(parsed.ok);
      assert.deepEqual(parsed.context.compaction, compaction);
    }
  });

  test("drops fields it does not know and keeps a newer daemon's part kind as a placeholder", () => {
    const wire = nativeExample() as unknown as Record<string, unknown> & { messages: { parts: unknown[] }[] };
    wire.extra = "ignored";
    wire.messages[0]!.parts.unshift({ kind: "audio", seconds: 3 });
    // A placeholder, not a dropped part: positions (and so trigger indexes) stay put.
    const parsed = parseAgentContextView(wire);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal("extra" in parsed.context, false);
    assert.deepEqual(parsed.context.messages[0]!.parts[0], { kind: "unknown", originalKind: "audio" });
  });

  test("drops redaction kinds it does not know and refuses bad counts", () => {
    const parsed = parseAgentContextView({ ...nativeExample(), redactions: { jwt: 2, some_future_kind: 4, bearer: 0 } });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.context.redactions, { jwt: 2 });
    assert.equal(parseAgentContextView({ ...nativeExample(), redactions: { jwt: -1 } }).ok, false);
  });

  test("refuses malformed views with the failing path", () => {
    const cases: [string, (v: Record<string, unknown>) => void][] = [
      ["context.runtime", (v) => { v.runtime = ""; }],
      ["context.requestAt", (v) => { v.requestAt = "yesterday"; }],
      ["context.tokens.total", (v) => { v.tokens = { input: 1, cacheRead: 0, total: 1.5 }; }],
      ["context.tools[0].inputSchema", (v) => { (v.tools as Record<string, unknown>[])[0]!.inputSchema = { n: Number.NaN }; }],
      ["context.messages[0].role", (v) => { (v.messages as Record<string, unknown>[])[0]!.role = "developer"; }],
      ["context.messages[1].parts[1].input", (v) => { ((v.messages as { parts: Record<string, unknown>[] }[])[1]!.parts[1]!).input = undefined; }],
      ["context.messages[2].parts[1].data", (v) => { ((v.messages as { parts: Record<string, unknown>[] }[])[2]!.parts[1]!).data = "iVBORw0KGgo="; }],
      ["context.trigger.partIndex", (v) => { v.trigger = { messageIndex: 3, partIndex: 1, toolUseId: null }; }],
      ["context.trigger.partIndex", (v) => { v.trigger = { messageIndex: 9, partIndex: 0, toolUseId: null }; }],
      ["context.trigger.toolUseId", (v) => { v.trigger = { messageIndex: 3, partIndex: 2, toolUseId: "toolu_1" }; }],
      ["context.compaction.summary", (v) => { v.compaction = { happened: true, summary: "encrypted" }; }],
      ["context.source.kind", (v) => { v.source = { kind: "guessed", format: "x", version: null }; }],
    ];
    for (const [path, mutate] of cases) {
      const wire = JSON.parse(JSON.stringify(nativeExample())) as Record<string, unknown>;
      mutate(wire);
      assert.deepEqual(parseAgentContextView(wire), { ok: false, error: `invalid ${path}` }, path);
    }
    assert.deepEqual(parseAgentContextView(null), { ok: false, error: "invalid context" });
  });
});

describe("AgentContextView verification", () => {
  test("keeps a known state, and drops an unknown or missing one without rejecting the view", () => {
    const parse = (extra: Record<string, unknown>) => parseAgentContextView(JSON.parse(JSON.stringify({ ...nativeExample(), ...extra })));
    const verified = parse({ verification: "verified" });
    assert.ok(verified.ok);
    assert.equal(verified.context.verification, "verified");
    const matched = parse({ verification: "count_matched" });
    assert.ok(matched.ok);
    assert.equal(matched.context.verification, "count_matched");
    const unknown = parse({ verification: "a_newer_state" });
    assert.ok(unknown.ok);
    assert.equal("verification" in unknown.context, false);
    const absent = parse({});
    assert.ok(absent.ok);
    assert.equal("verification" in absent.context, false);
  });
});

describe("parseAgentContextViewResultBody", () => {
  test("keeps a too_large cause it knows, only on too_large", () => {
    assert.deepEqual(parseAgentContextViewResultBody({ ok: false, reason: "too_large", tooLargeCause: "session_file" }), { ok: true, body: { ok: false, reason: "too_large", tooLargeCause: "session_file" } });
    assert.deepEqual(parseAgentContextViewResultBody({ ok: false, reason: "too_large", tooLargeCause: "a_newer_cause" }), { ok: true, body: { ok: false, reason: "too_large" } });
    assert.deepEqual(parseAgentContextViewResultBody({ ok: false, reason: "not_found", tooLargeCause: "session_file" }), { ok: true, body: { ok: false, reason: "not_found" } });
  });

  test("accepts every daemon failure reason", () => {
    for (const reason of AGENT_CONTEXT_VIEW_DAEMON_FAILURE_REASONS) {
      assert.deepEqual(parseAgentContextViewResultBody({ ok: false, reason }), { ok: true, body: { ok: false, reason } });
    }
  });

  test("folds an unknown or Server-only reason into read_failed and says which", () => {
    assert.deepEqual(parseAgentContextViewResultBody({ ok: false, reason: "disk_on_fire" }), {
      ok: true,
      body: { ok: false, reason: "read_failed" },
      unknownReason: "disk_on_fire",
    });
    assert.deepEqual(parseAgentContextViewResultBody({ ok: false, reason: "offline" }), {
      ok: true,
      body: { ok: false, reason: "read_failed" },
      unknownReason: "offline",
    });
  });

  test("refuses bodies without a usable ok / reason / context", () => {
    assert.deepEqual(parseAgentContextViewResultBody(null), { ok: false, error: "invalid ok" });
    assert.deepEqual(parseAgentContextViewResultBody({ ok: "true" }), { ok: false, error: "invalid ok" });
    assert.deepEqual(parseAgentContextViewResultBody({ ok: false }), { ok: false, error: "invalid reason" });
    assert.deepEqual(parseAgentContextViewResultBody({ ok: true }), { ok: false, error: "invalid context" });
  });
});

describe("failure reasons", () => {
  test("every reason names who produces it, and the daemon list is exactly the daemon-produced ones", () => {
    assert.deepEqual(Object.keys(AGENT_CONTEXT_VIEW_FAILURE_REASON_PRODUCERS), [...AGENT_CONTEXT_VIEW_FAILURE_REASONS]);
    const daemonProduced = AGENT_CONTEXT_VIEW_FAILURE_REASONS.filter((reason) => AGENT_CONTEXT_VIEW_FAILURE_REASON_PRODUCERS[reason].includes("daemon"));
    assert.deepEqual(daemonProduced, [...AGENT_CONTEXT_VIEW_DAEMON_FAILURE_REASONS]);
  });

  test("the wire values stay as shipped (renaming one breaks older peers)", () => {
    assert.deepEqual(AGENT_CONTEXT_VIEW_FAILURE_REASONS, ["offline", "old_daemon", "agent_moved", "not_found", "expired", "unsupported_runtime", "too_large", "read_failed", "no_computer", "context_mismatch", "media_removed", "newer_session_format", "not_recorded"]);
    assert.equal(DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0, "agent-context-view:v0");
    assert.equal(AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, "agent_context_view_v0");
    assert.equal(AGENT_CONTEXT_VIEW_REQUEST_TYPE, "agent:context_view_request");
    assert.equal(AGENT_CONTEXT_VIEW_AVAILABILITY_TYPE, "agent:context_view_availability");
  });
});

describe("request id and result path", () => {
  test("a minted id passes the receipt check; other strings do not", () => {
    const minted = mintAgentContextViewRequestId();
    assert.equal(asAgentContextViewRequestId(minted), minted);
    for (const bad of ["", "ctxv_short", "probe_0123456789abcdef0123", "ctxv_0123456789abcdef/../x"]) {
      assert.equal(asAgentContextViewRequestId(bad), null, bad);
    }
  });

  test("the path fills the route's :requestId", () => {
    assert.equal(agentContextViewResultPath(REQUEST_ID), AGENT_CONTEXT_VIEW_RESULT_ROUTE.replace(":requestId", REQUEST_ID));
  });
});

describe("readAgentContextViewRequest", () => {
  const valid = { type: "agent:context_view_request", requestId: REQUEST_ID, agentId: "agent-1", messageId: "msg-1", maxBytes: 1024 };

  test("accepts a valid frame and keeps only known fields", () => {
    const frame: ServerToMachineMessage = { ...valid, type: "agent:context_view_request" };
    assert.deepEqual(readAgentContextViewRequest({ ...frame, path: "/etc/passwd" }), valid);
  });

  test("refuses bad ids, empty fields and out-of-range maxBytes", () => {
    for (const bad of [
      { ...valid, type: "agent:stop" },
      { ...valid, requestId: "not-an-id" },
      { ...valid, agentId: "" },
      { ...valid, messageId: 7 },
      { ...valid, maxBytes: 0 },
      { ...valid, maxBytes: AGENT_CONTEXT_VIEW_MAX_BYTES + 1 },
      { ...valid, maxBytes: 10.5 },
      null,
    ]) {
      assert.equal(readAgentContextViewRequest(bad), null, JSON.stringify(bad));
    }
  });
});

describe("readAgentContextViewAvailability", () => {
  const supported = { type: "agent:context_view_availability", agentId: "agent-1", runtime: "claude", supported: true, retainedSince: "2026-11-01T00:00:00.000Z" } as const;

  test("accepts supported and unsupported reports", () => {
    const frame: MachineToServerMessage = supported;
    assert.deepEqual(readAgentContextViewAvailability(frame), supported);
    const unsupported = { ...supported, runtime: "gemini", supported: false, unsupportedReason: "unsupported_runtime", retainedSince: null } as const;
    assert.deepEqual(readAgentContextViewAvailability(unsupported), unsupported);
  });

  test("drops an unknown unsupportedReason, or one sent with supported: true", () => {
    assert.deepEqual(
      readAgentContextViewAvailability({ ...supported, supported: false, unsupportedReason: "some_future_reason" }),
      { ...supported, supported: false },
    );
    assert.deepEqual(readAgentContextViewAvailability({ ...supported, unsupportedReason: "no_session" }), supported);
  });

  test("refuses malformed reports", () => {
    for (const bad of [
      { ...supported, type: "agent:status" },
      { ...supported, agentId: "" },
      { ...supported, supported: "yes" },
      { ...supported, retainedSince: "last week" },
      { ...supported, retainedSince: undefined },
    ]) {
      assert.equal(readAgentContextViewAvailability(bad), null, JSON.stringify(bad));
    }
  });
});


test("an availability report's retentionDays is kept when sane and dropped when not", () => {
  const base = { type: "agent:context_view_availability", agentId: "a1", runtime: "claude", supported: true, retainedSince: null };
  assert.equal(readAgentContextViewAvailability({ ...base, retentionDays: 14 })?.retentionDays, 14);
  for (const bad of [0, -1, 1.5, "30", 99999]) {
    const report = readAgentContextViewAvailability({ ...base, retentionDays: bad });
    assert.ok(report, String(bad));
    assert.equal(report.retentionDays, undefined, String(bad));
  }
  assert.equal(AGENT_CONTEXT_VIEW_DEFAULT_RETENTION_DAYS, 30);
});
