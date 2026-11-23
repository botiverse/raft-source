import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeChannelDigest, fixtureTag, loadBenchFixture, parseBenchFixture, resolveFixtureTargets, verifyFixtureDigest } from "./benchFixture";

const samplePayload = () => {
  const messages = [
    { id: "m-2", content: "second line", createdAt: "2026-11-18T06:00:02.000Z" },
    { id: "m-1", content: "first", createdAt: "2026-11-18T06:00:01.000Z" },
  ];
  const expectedSha = createHash("sha256").update("m-1\nfirst\nm-2\nsecond line\n").digest("hex").slice(0, 16);
  return {
    payload: {
      messages,
      threadSummariesByParentMessageId: {
        "m-1": { replyCount: 6 },
        "m-2": { replyCount: 6 },
      },
    },
    expectedSha,
  };
};

describe("benchFixture", () => {
  it("loads the built-in bench-v1 fixture and formats its tag", () => {
    const spec = loadBenchFixture("bench-v1");
    expect(spec).toEqual({
      fixture: "bench-v1",
      server: "qa-perf-bench",
      channel: "bench-v1",
      other: "bench-other",
      expected: {
        topLevel: 80,
        threadSummaries: 12,
        repliesPerThread: 6,
        contentChars: 12256,
        sha256: "5395d2b0966a6dd6",
      },
    });
    expect(fixtureTag(spec)).toBe("bench-v1@5395d2b0");
  });

  it("computes the ordered id+content digest and thread reply counts", () => {
    const { payload, expectedSha } = samplePayload();
    const digest = computeChannelDigest(payload);
    expect(digest).toEqual({
      inFirstPage: 2,
      topLevel: 2,
      threadSummaries: 2,
      summaryReplies: [6, 6],
      contentChars: 16,
      sha256: expectedSha,
    });
  });

  it("verifies both hash and counts so a new thread reply cannot slip past an unchanged top-level hash", () => {
    const { payload, expectedSha } = samplePayload();
    const spec = parseBenchFixture({
      fixture: "mini-bench",
      server: "qa-perf-bench",
      channel: "bench-v1",
      expected: { topLevel: 2, threadSummaries: 2, repliesPerThread: 6, contentChars: 16, sha256: expectedSha },
    });
    expect(verifyFixtureDigest(computeChannelDigest(payload), spec)).toMatchObject({ ok: true, tag: `mini-bench@${expectedSha.slice(0, 8)}`, mismatches: [] });

    // Top-level messages unchanged (same sha256!), but someone posted a 7th reply in a thread:
    const mutated = {
      ...payload,
      threadSummariesByParentMessageId: { "m-1": { replyCount: 7 }, "m-2": { replyCount: 6 } },
    };
    const result = verifyFixtureDigest(computeChannelDigest(mutated), spec);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(["thread reply counts have [7,6], expected 6 each"]);
  });

  it("refuses malformed specs and conflicting CLI target flags", () => {
    expect(() => parseBenchFixture({ fixture: "BAD", server: "s", channel: "c", expected: {} })).toThrow(/lowercase name/);
    expect(() => parseBenchFixture({ fixture: "ok", server: "s", channel: "c", expected: { topLevel: 1, threadSummaries: 0, repliesPerThread: 0, contentChars: 5, sha256: "short" } })).toThrow(/16 hex/);
    const spec = loadBenchFixture("bench-v1");
    expect(resolveFixtureTargets(spec, {}, { channel: "all", other: "all" })).toEqual({ server: "qa-perf-bench", channel: "bench-v1", other: "bench-other" });
    expect(() => resolveFixtureTargets(spec, { server: "qa-wa-1ilac" }, { channel: "all" })).toThrow(/belongs to server "qa-perf-bench"/);
    expect(() => resolveFixtureTargets(spec, { channel: "wa-main" }, { channel: "all" })).toThrow(/belongs to channel "bench-v1"/);
  });
});
