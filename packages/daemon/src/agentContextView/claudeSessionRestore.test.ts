import { describe, expect, it } from "vitest";
import { parseAgentContextView } from "@botiverse/raft-shared";
import {
  CLAUDE_UNRESTORED_MESSAGE_TEXT,
  ClaudeSessionIndex,
  findClaudeSendOffset,
  parseClaudeSessionRecords,
  restoreClaudeContextView,
  verifyClaudeSessionDigests,
} from "./claudeSessionRestore";
import { redactContextView } from "./contextViewRedaction";
import { SEND_1, SessionBuilder, sha, twoRequestSession, type Msg } from "../testing/claudeSessionFixture";

function restore(buffer: Buffer, offset: number, messageId: string) {
  const index = new ClaudeSessionIndex(parseClaudeSessionRecords(buffer));
  return restoreClaudeContextView({ index, offset, messageId, runtime: "claude", sessionId: "fallback-session" });
}

describe("Claude session restore", () => {
  it("rebuilds every request exactly (recomputed digest = recorded digest)", () => {
    const { s } = twoRequestSession();
    const report = verifyClaudeSessionDigests(new ClaudeSessionIndex(parseClaudeSessionRecords(s.buffer())));
    expect(report).toEqual({ requests: 2, matched: 2, mismatched: 0, unresolved: 0, noDigest: 0 });
  });

  it("restores the request before the send plus its response, with the send as the trigger", () => {
    const { s, offsetAtSend1 } = twoRequestSession();
    const result = restore(s.buffer(), offsetAtSend1, "msg-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.digestMatch).toBe(true);
    const view = result.view;
    expect(view.model).toBe("claude-test-model");
    expect(view.sessionId).toBe("sess-1");
    expect(view.requestAt).toBe("2026-11-04T10:01:00.000Z");
    expect(view.source).toEqual({ kind: "native", format: "claude-jsonl", version: "2.1.304" });
    expect(view.system).toEqual([{ text: "You are a Raft agent." }, { text: "Workspace rules." }]);
    expect(view.tools).toEqual([{ name: "Bash", description: "Run a shell command", inputSchema: { type: "object", properties: { command: { type: "string" } } } }]);
    expect(view.messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "Post the plan to #general." }] },
      {
        role: "assistant",
        parts: [
          { kind: "thinking", text: "The user wants the plan." },
          { kind: "text", text: "Posting it." },
          { kind: "tool_use", toolName: "Bash", toolUseId: "toolu_1", input: { command: SEND_1 } },
        ],
      },
    ]);
    expect(view.trigger).toEqual({ messageIndex: 1, partIndex: 2, toolUseId: "toolu_1" });
    // input_tokens + cache_creation, cache reads, and the whole prompt.
    expect(view.tokens).toEqual({ input: 10, cacheRead: 90, total: 100 });
    expect(view.compaction).toEqual({ happened: false });
    expect(parseAgentContextView(view).ok).toBe(true);
  });

  it("follows base/keep/tail into a later request: merged user records, blobs, repeated messages", () => {
    const { s } = twoRequestSession();
    const buffer = s.buffer();
    const result = restore(buffer, buffer.length, "msg-2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.digestMatch).toBe(true);
    expect(result.view.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system", "system", "assistant"]);
    expect(result.view.messages[2]!.parts).toEqual([
      { kind: "tool_result", toolName: "Bash", toolUseId: "toolu_1", output: "Message sent to #general. Message ID: msg-1", isError: false },
      { kind: "text", text: "<system-reminder>a note</system-reminder>" },
    ]);
    expect(result.view.trigger).toEqual({ messageIndex: 5, partIndex: 0, toolUseId: "toolu_2" });
  });

  it("finds the send by its `raft message send` command when no tool result names the message", () => {
    const { s, offsetAtSend1 } = twoRequestSession();
    const result = restore(s.buffer(), offsetAtSend1, "msg-unknown");
    expect(result.ok && result.view.trigger).toEqual({ messageIndex: 1, partIndex: 2, toolUseId: "toolu_1" });
  });

  it("locates an unindexed message by the tool result that reports its id", () => {
    const { s, offsetAtSend1 } = twoRequestSession();
    const buffer = s.buffer();
    const offset = findClaudeSendOffset(buffer, "msg-1");
    // The start of the tool result line, right after the send's response.
    expect(offset).toBe(offsetAtSend1);
    expect(findClaudeSendOffset(buffer, "msg")).toBeNull();
    expect(findClaudeSendOffset(buffer, "msg-9")).toBeNull();
    const result = restore(buffer, offset!, "msg-1");
    expect(result.ok && result.view.trigger?.toolUseId).toBe("toolu_1");
  });

  it("says no_request for an offset before the first request", () => {
    const { s } = twoRequestSession();
    expect(restore(s.buffer(), 10, "msg-1")).toEqual({ ok: false, failure: "no_request" });
  });

  it("resolves a message the runtime wrote itself (an API error) when a resumed request sends it", () => {
    const s = new SessionBuilder();
    s.setShape([{ type: "text", text: "sys" }], []);
    const prompt = s.user("hi");
    s.request("r1", { tail: [prompt] });
    const errorMessage: Msg = { role: "assistant", content: [{ type: "text", text: "API Error: overloaded" }] };
    s.raw({ type: "assistant", isApiErrorMessage: true, message: { id: "x", model: "<synthetic>", ...errorMessage } });
    const again = s.user([{ type: "text", text: "try again" }]);
    s.request("r2", { tail: [prompt, errorMessage, again] });
    const report = verifyClaudeSessionDigests(new ClaudeSessionIndex(parseClaudeSessionRecords(s.buffer())));
    expect(report.matched).toBe(2);
  });

  it("keeps a message the file does not hold as a placeholder (and never claims a digest match)", () => {
    const s = new SessionBuilder();
    s.setShape([{ type: "text", text: "sys" }], []);
    const prompt = s.user("hi");
    s.request("r1", { tail: [prompt], tailHashes: [sha(prompt), "f".repeat(64)] });
    s.assistantBlock("r1", 0, { type: "text", text: "ok" });
    const result = restore(s.buffer(), s.offset, "m");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.digestMatch).toBe(false);
    expect(result.unrestoredMessages).toBe(1);
    expect(result.view.messages[1]).toEqual({ role: "user", parts: [{ kind: "text", text: CLAUDE_UNRESTORED_MESSAGE_TEXT }] });
  });

  it("maps images (size only), empty thinking and compaction", () => {
    const s = new SessionBuilder();
    s.setShape("one system string", []);
    s.raw({ type: "system", subtype: "compact_boundary" });
    const summary = s.user("Summary of the earlier conversation.", { isCompactSummary: true });
    const shot = s.user([{ type: "tool_result", tool_use_id: "t9", content: [{ type: "text", text: "see image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }]);
    s.request("r1", { tail: [summary, shot] });
    s.assistantBlock("r1", 0, { type: "thinking", thinking: "", signature: "encrypted" });
    const result = restore(s.buffer(), s.offset, "m");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.system).toEqual([{ text: "one system string" }]);
    expect(result.view.compaction).toEqual({ happened: true, summary: { kind: "text", text: "Summary of the earlier conversation." } });
    expect(result.view.messages[1]!.parts).toEqual([
      { kind: "tool_result", toolName: null, toolUseId: "t9", output: "see image", isError: false },
      { kind: "image", mediaType: "image/png", sizeBytes: 3 },
    ]);
    expect(result.view.messages[2]!.parts).toEqual([{ kind: "thinking", text: null }]);
    expect(result.view.trigger).toBeNull();
    expect(parseAgentContextView(result.view).ok).toBe(true);
  });
});

describe("context view redaction", () => {
  it("redacts every text and counts what it replaced", () => {
    const s = new SessionBuilder();
    s.setShape([{ type: "text", text: "key: Bearer abcdefghijklmnop" }], [{ name: "Bash", description: "uses ghp_abcdefghijklmnopqrstuvwx", input_schema: {} }]);
    const prompt = s.user("my token is sk-ant-abcdefghijklmnop");
    s.request("r1", { tail: [prompt] });
    s.assistantBlock("r1", 0, { type: "tool_use", id: "t1", name: "Bash", input: { command: "curl https://x.test/a?token=1" } });
    const result = restore(s.buffer(), s.offset, "m");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = redactContextView(result.view);
    expect(view.redactions).toEqual({ bearer: 1, github_token: 1, vendor_key: 1, url_query: 1 });
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/abcdefghijklmnop|token=1/);
    expect(view.messages[1]!.parts[0]).toEqual({ kind: "tool_use", toolName: "Bash", toolUseId: "t1", input: { command: "curl https://x.test/a?«redacted:url_query»" } });
    expect(parseAgentContextView(view).ok).toBe(true);
  });
});
