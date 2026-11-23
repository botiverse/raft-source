import { describe, expect, it } from "vitest";
import { type CpuProfile, analyzeCpuProfile, attributeForcedReflows, buildCriticalPathSummary } from "./cpuProfile";
import type { ForcedSpan, WorkSplit } from "./workSplit";

describe("analyzeCpuProfile", () => {
  const profile: CpuProfile = {
    startTime: 100_000,
    endTime: 200_000,
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 }, children: [2, 4, 5] },
      { id: 2, callFrame: { functionName: "MessageList", url: "packages/web/src/MessageList.tsx", lineNumber: 19, columnNumber: 2 }, children: [3] },
      { id: 3, callFrame: { functionName: "renderMarkdown", url: "node_modules/react-markdown/index.js", lineNumber: 49, columnNumber: 0 }, children: [6] },
      { id: 6, callFrame: { functionName: "renderMarkdown", url: "node_modules/react-markdown/index.js", lineNumber: 49, columnNumber: 0 } },
      { id: 4, callFrame: { functionName: "(idle)", url: "", lineNumber: -1, columnNumber: -1 } },
      { id: 5, callFrame: { functionName: "(garbage collector)", url: "", lineNumber: -1, columnNumber: -1 } },
    ],
    samples: [4, 2, 6, 5],
    timeDeltas: [0, 20_000, 30_000, 30_000],
  };

  it("slices samples to [fromUs, toUs], separates idle/GC, and deduplicates recursive frames in totalMs", () => {
    const res = analyzeCpuProfile(profile, { fromUs: 110_000, toUs: 190_000 });
    expect(res.windowMs).toBe(80);
    expect(res.sampledMs).toBe(80);
    expect(res.idleMs).toBe(10);
    expect(res.gcMs).toBe(10);
    expect(res.activeMs).toBe(70);

    const msgList = res.topTotal.find((e) => e.functionName === "MessageList")!;
    expect(msgList.selfMs).toBe(30);
    expect(msgList.totalMs).toBe(60);

    const markdown = res.topTotal.find((e) => e.functionName === "renderMarkdown")!;
    expect(markdown.selfMs).toBe(30);
    expect(markdown.totalMs).toBe(30);
  });
});

describe("attributeForcedReflows and buildCriticalPathSummary", () => {
  const mkSplit = (windowMs: number, taskMs: number): WorkSplit => ({
    windowMs,
    recordedMs: windowMs,
    taskMs,
    scriptMs: Math.max(0, taskMs - 10),
    styleMs: 5,
    layoutMs: 5,
    forcedMs: 0,
    stylePasses: 1,
    styleElements: 50,
    layouts: 1,
    largeStylePasses: [],
  });

  it("attributes forced layouts to the innermost app frame and splits before-request (critical) vs in-flight (network slack)", () => {
    const spans: ForcedSpan[] = [
      {
        kind: "layout",
        startUs: 155_000,
        endUs: 170_000,
        atMs: 55,
        durationMs: 15,
        elements: 0,
        stackTrace: [
          { functionName: "commitLayoutEffects", url: "node_modules/react-dom/index.js", lineNumber: 100, columnNumber: 1 },
          { functionName: "syncScrollBottom", url: "packages/web/src/MessageScroller.tsx", lineNumber: 88, columnNumber: 5 },
        ],
      },
    ];
    const culprits = attributeForcedReflows(spans, null);
    expect(culprits).toHaveLength(1);
    expect(culprits[0]).toMatchObject({
      functionName: "syncScrollBottom",
      source: "packages/web/src/MessageScroller.tsx",
      line: 88,
      bucket: "app",
      layoutCount: 1,
      totalForcedMs: 15,
    });

    // 120 ms before messagesStart (100 ms busy -> critical!), 300 ms in-flight (90 ms busy -> 210 ms slack, hidden!), 980 ms post-response (900 ms busy -> critical!)
    const cp = buildCriticalPathSummary({
      messagesStartMs: 120,
      messagesResponseEndMs: 420,
      paintedMs: 1400,
      beforeRequestSplit: mkSplit(120, 100),
      inFlightSplit: mkSplit(300, 90),
      responseToPaintSplit: mkSplit(980, 900),
    });
    expect(cp.shownBeforeResponse).toBe(false);
    expect(cp.phases[0]).toMatchObject({ phase: "before-request", role: "critical-path", networkSlackMs: 0, durationMs: 120 });
    expect(cp.phases[1]).toMatchObject({ phase: "in-flight", role: "hidden-by-network", networkSlackMs: 210, durationMs: 300 });
    expect(cp.phases[2]).toMatchObject({ phase: "response-to-paint", role: "critical-path", networkSlackMs: 0, durationMs: 980 });
    expect(cp.maxMainThreadSavingsMs).toBe(1000); // 100 ms before-request + 900 ms response-to-paint
  });

  it("keeps totalToPaintMs equal to paintedMs (never inflated to responseEnd) when local cache paints before network finishes", () => {
    const cp = buildCriticalPathSummary({
      messagesStartMs: 25,
      messagesResponseEndMs: 900,
      paintedMs: 320,
      cachedToPaintSplit: mkSplit(320, 260),
    });
    expect(cp.shownBeforeResponse).toBe(true);
    expect(cp.totalToPaintMs).toBe(320);
    expect(cp.responseToPaintMs).toBeNull();
    expect(cp.phases[0]).toMatchObject({ phase: "cached-to-paint", role: "critical-path", durationMs: 320 });
    expect(cp.maxMainThreadSavingsMs).toBe(260);
  });
});
