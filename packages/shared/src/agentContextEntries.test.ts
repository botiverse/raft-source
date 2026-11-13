import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";
import {
  AGENT_CONTEXT_SEARCH_REQUEST_TYPE,
  answerAgentContextQuery,
  parseAgentContextQueryAnswerBody,
  readAgentContextSearchRequest,
  AGENT_CONTEXT_READ_MAX_CHARS,
  AGENT_CONTEXT_READ_PAGE_CHARS,
  AGENT_CONTEXT_SEARCH_LINE_CHARS,
  AGENT_CONTEXT_SEARCH_MAX_LIMIT,
  agentContextEntries,
  readAgentContextWindow,
  searchAgentContextEntries,
} from "./agentContextEntries";
import type { AgentContextView } from "./agentContextView";

function view(overrides: Partial<AgentContextView> = {}): AgentContextView {
  return {
    runtime: "claude",
    model: "m",
    sessionId: "s",
    requestAt: null,
    messageId: "msg-1",
    tokens: { input: null, cacheRead: null, total: null },
    system: [{ text: "You are an agent" }],
    tools: [{ name: "bash", description: "Run a command", inputSchema: { type: "object" } }],
    messages: [
      { role: "user", parts: [{ kind: "text", text: "the deploy notes say v1.21.56 is out" }] },
      {
        role: "assistant",
        parts: [
          { kind: "thinking", text: null },
          { kind: "tool_use", toolName: "bash", toolUseId: "t1", input: { command: "raft message send --target #x" } },
        ],
      },
      { role: "tool", parts: [{ kind: "tool_result", toolName: "bash", toolUseId: "t1", output: "Message sent", isError: false }] },
      { role: "user", parts: [{ kind: "image", mediaType: "image/png", sizeBytes: 12 }, { kind: "compaction", text: null }] },
    ],
    compaction: { happened: false },
    trigger: null,
    redactions: {} as AgentContextView["redactions"],
    source: { kind: "native", format: "claude-jsonl", version: null },
    ...overrides,
  } as AgentContextView;
}

describe("agentContextEntries", () => {
  test("ids by position: system, tools, then each message part, in panel order", () => {
    const entries = agentContextEntries(view());
    assert.deepEqual(entries.map((e) => [e.id, e.role, e.type]), [
      ["s0", "system", "system"],
      ["t0", "tool_definition", "bash"],
      ["m0.p0", "user", "text"],
      ["m1.p0", "assistant", "thinking"],
      ["m1.p1", "assistant", "tool_use bash"],
      ["m2.p0", "tool", "tool_result bash"],
      ["m3.p0", "user", "image"],
      ["m3.p1", "user", "compaction"],
    ]);
    assert.equal(entries.find((e) => e.id === "m3.p0")?.text, "[image image/png, 12 bytes]");
    assert.equal(entries.find((e) => e.id === "m1.p0")?.text, "");
  });
});

describe("searchAgentContextEntries", () => {
  test("literal and case-insensitive, one row per entry with its hits", () => {
    const answer = searchAgentContextEntries(agentContextEntries(view()), "RAFT MESSAGE");
    assert.deepEqual(answer, { total: 1, matches: [{ id: "m1.p1", role: "assistant", type: "tool_use bash", hits: 1, line: "command: raft message send --target #x" }] });
    // Not a pattern: a dot matches a dot only.
    assert.equal(searchAgentContextEntries(agentContextEntries(view()), "v1.21.5.").total, 0);
    assert.equal(searchAgentContextEntries(agentContextEntries(view()), "  ").total, 0);
    // A call's input reads as the panel shows it, so quotes and backslashes match as typed.
    const quoted = view({ messages: [{ role: "assistant", parts: [{ kind: "tool_use", toolName: "bash", toolUseId: null, input: { command: 'grep "foo" C:\\x' } }] }] });
    assert.equal(searchAgentContextEntries(agentContextEntries(quoted), 'grep "foo" C:\\x').total, 1);
  });

  test("paged by offset and limit; the limit is capped", () => {
    const many = view({ messages: Array.from({ length: 60 }, (_, i) => ({ role: "user" as const, parts: [{ kind: "text" as const, text: `needle ${i}` }] })) });
    const entries = agentContextEntries(many);
    const first = searchAgentContextEntries(entries, "needle", { limit: 500 });
    assert.equal(first.total, 60);
    assert.equal(first.matches.length, AGENT_CONTEXT_SEARCH_MAX_LIMIT);
    const next = searchAgentContextEntries(entries, "needle", { offset: 55, limit: 10 });
    assert.deepEqual(next.matches.map((m) => m.id), ["m55.p0", "m56.p0", "m57.p0", "m58.p0", "m59.p0"]);
  });

  test("a match after characters that lowercase longer is still the line shown", () => {
    const text = `${"İ".repeat(300)}${"x".repeat(300)}NEEDLE${"y".repeat(300)}`;
    const [match] = searchAgentContextEntries(agentContextEntries(view({ messages: [{ role: "user", parts: [{ kind: "text", text }] }] })), "needle").matches;
    assert.ok(match!.line.includes("NEEDLE"));
  });

  test("a limit or offset that isn't a whole number falls back to the default", () => {
    const entries = agentContextEntries(view());
    assert.equal(searchAgentContextEntries(entries, "a", { limit: Number.NaN }).matches.length <= 20, true);
    const read = readAgentContextWindow(entries, "m1.p1", { limit: Number.NaN, page: 1.5 });
    assert.ok(read.found);
    assert.equal(read.entries.length, 5);
  });

  test("a long line is cut around the match", () => {
    const long = view({ messages: [{ role: "user", parts: [{ kind: "text", text: `${"a".repeat(2000)}NEEDLE${"b".repeat(2000)}` }] }] });
    const [match] = searchAgentContextEntries(agentContextEntries(long), "needle").matches;
    assert.ok(match!.line.includes("NEEDLE"));
    assert.ok(match!.line.length <= AGENT_CONTEXT_SEARCH_LINE_CHARS + 2);
    assert.ok(match!.line.startsWith("…") && match!.line.endsWith("…"));
  });
});

describe("readAgentContextWindow", () => {
  test("a window centred on the anchor, clamped at the ends", () => {
    const entries = agentContextEntries(view());
    const mid = readAgentContextWindow(entries, "m1.p1", { limit: 3 });
    assert.ok(mid.found);
    assert.deepEqual(mid.entries.map((e) => e.id), ["m1.p0", "m1.p1", "m2.p0"]);
    const start = readAgentContextWindow(entries, "s0", { limit: 3 });
    assert.ok(start.found);
    assert.deepEqual(start.entries.map((e) => e.id), ["s0", "t0", "m0.p0"]);
    assert.deepEqual(readAgentContextWindow(entries, "m9.p9"), { found: false });
  });

  test("a long anchor reads by page; others show their first page; the answer stays inside its size", () => {
    const big = "x".repeat(AGENT_CONTEXT_READ_PAGE_CHARS * 2 + 10);
    const entries = agentContextEntries(view({
      messages: Array.from({ length: 21 }, () => ({ role: "tool" as const, parts: [{ kind: "tool_result" as const, toolName: null, toolUseId: null, output: big, isError: false }] })),
    }));
    const page3 = readAgentContextWindow(entries, "m10.p0", { limit: 1, page: 3 });
    assert.ok(page3.found);
    assert.deepEqual([page3.entries[0]!.page, page3.entries[0]!.pages, page3.entries[0]!.text.length], [3, 3, 10]);
    const wide = readAgentContextWindow(entries, "m10.p0", { limit: 21 });
    assert.ok(wide.found);
    const shown = wide.entries.reduce((sum, e) => sum + e.text.length, 0);
    assert.ok(shown <= AGENT_CONTEXT_READ_MAX_CHARS);
    assert.ok(wide.entries.some((e) => e.id === "m10.p0"));
    assert.equal(wide.entries.length + wide.omitted, 21);
  });

  test("a page boundary never splits a surrogate pair, and nothing is lost", () => {
    const text = `${"a".repeat(AGENT_CONTEXT_READ_PAGE_CHARS - 1)}😀tail`;
    const entries = agentContextEntries(view({ messages: [{ role: "user", parts: [{ kind: "text", text }] }] }));
    const one = readAgentContextWindow(entries, "m0.p0", { limit: 1, page: 1 });
    const two = readAgentContextWindow(entries, "m0.p0", { limit: 1, page: 2 });
    assert.ok(one.found && two.found);
    assert.equal(one.entries[0]!.text + two.entries[0]!.text, text);
  });
});

describe("agent:context_search_request", () => {
  const base = { type: AGENT_CONTEXT_SEARCH_REQUEST_TYPE, requestId: "ctxv_0123456789abcdef0123", agentId: "a1", messageId: "m1", maxBytes: 65536 };
  test("a valid search or read parses; the query is trimmed", () => {
    expect(readAgentContextSearchRequest({ ...base, query: { kind: "search", query: "  foo ", limit: 20, offset: 0 } })?.query).toEqual({ kind: "search", query: "foo", limit: 20, offset: 0 });
    expect(readAgentContextSearchRequest({ ...base, query: { kind: "read", around: "m3.p1", limit: 5, page: 2 } })?.query).toEqual({ kind: "read", around: "m3.p1", limit: 5, page: 2 });
  });
  test.each([
    ["an empty query", { kind: "search", query: "  ", limit: 20, offset: 0 }],
    ["a query over 200 characters", { kind: "search", query: "x".repeat(201), limit: 20, offset: 0 }],
    ["a limit over 50", { kind: "search", query: "x", limit: 51, offset: 0 }],
    ["a fractional offset", { kind: "search", query: "x", limit: 5, offset: 0.5 }],
    ["an entry id that isn't one", { kind: "read", around: "../m1", limit: 5, page: 1 }],
    ["a page of 0", { kind: "read", around: "m1.p0", limit: 5, page: 0 }],
    ["an unknown kind", { kind: "grep", query: "x" }],
  ])("refuses %s", (_label, query) => {
    expect(readAgentContextSearchRequest({ ...base, query })).toBeNull();
  });
  test("the answer never carries the view", () => {
    const body = answerAgentContextQuery(view(), { kind: "search", query: "deploy", limit: 5, offset: 0 });
    expect(Object.keys(body).sort()).toEqual(["answer", "entryCount", "model", "ok", "runtime"]);
    expect(body.answer).toMatchObject({ kind: "search", total: 1 });
  });
});

describe("the Server's check of a daemon's answer", () => {
  test("a search or read answer the daemon builds passes unchanged", () => {
    const search = answerAgentContextQuery(view(), { kind: "search", query: "deploy", limit: 5, offset: 0 });
    assert.deepEqual(parseAgentContextQueryAnswerBody(JSON.parse(JSON.stringify(search))), search);
    const read = answerAgentContextQuery(view(), { kind: "read", around: "s0", limit: 3, page: 1 });
    assert.deepEqual(parseAgentContextQueryAnswerBody(JSON.parse(JSON.stringify(read))), read);
    const missing = answerAgentContextQuery(view(), { kind: "read", around: "m999.p0", limit: 3, page: 1 });
    assert.deepEqual(parseAgentContextQueryAnswerBody(missing), missing);
  });

  test("a whole view is never an answer, even beside one", () => {
    const search = answerAgentContextQuery(view(), { kind: "search", query: "deploy", limit: 5, offset: 0 });
    assert.equal(parseAgentContextQueryAnswerBody({ ok: true, context: view() }), null);
    assert.equal(parseAgentContextQueryAnswerBody({ ...search, context: view() }), null);
  });

  test("extra fields are dropped and malformed entries refuse the whole body", () => {
    const search = answerAgentContextQuery(view(), { kind: "search", query: "deploy", limit: 5, offset: 0 });
    const extra = { ...search, answer: { ...search.answer, matches: search.answer.kind === "search" ? search.answer.matches.map((m) => ({ ...m, raw: "x" })) : [] } };
    assert.deepEqual(parseAgentContextQueryAnswerBody(extra), search);
    const base = { ok: true, runtime: "claude", model: null, entryCount: 1 };
    assert.equal(parseAgentContextQueryAnswerBody({ ...base, answer: { kind: "search", total: 1, matches: [{ id: "../x", role: "user", type: "text", hits: 1, line: "" }] } }), null);
    assert.equal(parseAgentContextQueryAnswerBody({ ...base, answer: { kind: "search", total: 1, matches: [{ id: "m0.p0", role: "root", type: "text", hits: 1, line: "" }] } }), null);
    assert.equal(parseAgentContextQueryAnswerBody({ ...base, answer: { kind: "read", found: true, omitted: 0, entries: [{ id: "m0.p0", role: "user", type: "text", text: 1, page: 1, pages: 1 }] } }), null);
    assert.equal(parseAgentContextQueryAnswerBody({ ...base, answer: { kind: "dump" } }), null);
    assert.equal(parseAgentContextQueryAnswerBody({ ok: false, reason: "read_failed" }), null);
  });
});
