/**
 * Pure V8 CPUProfile window slicer, SourceMap resolver, forced-reflow stack
 * attributor, and first-principles critical-path slack model for `raft-perf diagnose`.
 *
 * All time inputs to `analyzeCpuProfile` (`fromUs`, `toUs`, `profile.startTime`,
 * `profile.endTime`, `profile.timeDeltas`) are microseconds on Chromium's monotonic
 * clock, matching `TraceEvent.ts`.
 */

import { type ResolvedLocation, type SourceBucket, type SourceMapRegistry, classifySourceBucket, cleanSourcePath, scriptBasename } from "./sourceMap";
import type { ForcedSpan, WorkSplit } from "./workSplit";

export interface CpuCallFrame {
  functionName: string;
  scriptId?: string;
  url: string;
  /** 0-based line number in V8 CDP `Runtime.CallFrame`. */
  lineNumber: number;
  /** 0-based column number in V8 CDP `Runtime.CallFrame`. */
  columnNumber: number;
}

export interface CpuProfileNode {
  id: number;
  callFrame: CpuCallFrame;
  hitCount?: number;
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface HotspotEntry {
  functionName: string;
  source: string;
  line: number | null;
  column: number | null;
  bucket: SourceBucket;
  selfMs: number;
  totalMs: number;
  /** Share of `activeMs` (0..100). */
  selfPct: number;
  /** Share of `activeMs` (0..100), deduplicated across recursive frames. */
  totalPct: number;
}

export interface SourceFileRollup {
  source: string;
  bucket: SourceBucket;
  selfMs: number;
  totalMs: number;
  selfPct: number;
  totalPct: number;
}

export interface BucketRollup {
  bucket: SourceBucket;
  selfMs: number;
  selfPct: number;
}

export interface ForcedReflowCulprit {
  functionName: string;
  source: string;
  line: number | null;
  column: number | null;
  bucket: SourceBucket;
  count: number;
  layoutCount: number;
  styleCount: number;
  totalForcedMs: number;
  maxElements: number;
  /** Innermost-first resolved stack (`fn (source:line)`). */
  callStack: string[];
}

export interface CpuWindowAnalysis {
  windowMs: number;
  sampledMs: number;
  activeMs: number;
  idleMs: number;
  gcMs: number;
  programMs: number;
  sampleCount: number;
  topSelf: HotspotEntry[];
  topTotal: HotspotEntry[];
  /** Filtered to `app` / `ui` / `markdown` / `rich-content` / `state-network` frames with large subtree time (surfaces React components & feature entrypoints). */
  topAppEntrypoints: HotspotEntry[];
  bySource: SourceFileRollup[];
  byBucket: BucketRollup[];
}

export interface CriticalPathPhase {
  phase: "before-request" | "in-flight" | "response-to-paint" | "cached-to-paint" | "post-paint-settle";
  startMs: number;
  endMs: number;
  durationMs: number;
  networkSlackMs: number;
  role: "hidden-by-network" | "co-bottleneck" | "critical-path" | "deferred-after-paint";
  workSplit: WorkSplit;
}

export interface CriticalPathSummary {
  totalToPaintMs: number;
  messagesStartMs: number | null;
  messagesResponseEndMs: number | null;
  responseToPaintMs: number | null;
  shownBeforeResponse: boolean;
  /** Estimated upper bound of `paintedMs` savings available purely from main-thread optimization without touching the API. */
  maxMainThreadSavingsMs: number;
  phases: CriticalPathPhase[];
}

interface ResolvedFrame {
  key: string;
  functionName: string;
  source: string;
  line: number | null;
  column: number | null;
  bucket: SourceBucket;
  kind: "active" | "idle" | "gc" | "program" | "root";
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const pct = (part: number, whole: number): number => (whole <= 0 ? 0 : Math.round((part / whole) * 1000) / 10);

function isMinifiedSymbol(name: string): boolean {
  return !name || /^[a-zA-Z_$][\w$]?$/.test(name);
}

function fallbackSourceForUrl(url: string, emptyLabel: string): string {
  if (!url) return emptyLabel;
  if (/^https?:\/\//i.test(url)) return scriptBasename(url) || url;
  return cleanSourcePath(url) || url;
}

function resolveCallFrame(frame: CpuCallFrame, registry?: SourceMapRegistry | null): ResolvedFrame {
  const rawFn = frame.functionName || "";
  if (rawFn === "(root)") {
    return { key: "(root)", functionName: "(root)", source: "(runtime)", line: null, column: null, bucket: "runtime", kind: "root" };
  }
  if (rawFn === "(idle)") {
    return { key: "(idle)", functionName: "(idle)", source: "(runtime)", line: null, column: null, bucket: "runtime", kind: "idle" };
  }
  if (rawFn === "(garbage collector)") {
    return { key: "(gc)", functionName: "(garbage collector)", source: "(runtime)", line: null, column: null, bucket: "runtime", kind: "gc" };
  }
  if (rawFn === "(program)") {
    return { key: "(program)", functionName: "(program)", source: "(runtime)", line: null, column: null, bucket: "runtime", kind: "program" };
  }

  const mapped: ResolvedLocation | null =
    registry && frame.url && frame.lineNumber >= 0
      ? registry.resolveZeroBased(frame.url, frame.lineNumber, Math.max(0, frame.columnNumber))
      : null;

  if (mapped) {
    const fn = mapped.name && isMinifiedSymbol(rawFn) ? mapped.name : rawFn || mapped.name || "(anonymous)";
    return {
      key: `${mapped.source}:${mapped.line}:${fn}`,
      functionName: fn,
      source: mapped.source,
      line: mapped.line,
      column: mapped.column,
      bucket: mapped.bucket,
      kind: "active",
    };
  }

  const fallbackSource = fallbackSourceForUrl(frame.url, "(native)");
  const line = frame.lineNumber >= 0 ? frame.lineNumber + 1 : null;
  const col = frame.columnNumber >= 0 ? frame.columnNumber + 1 : null;
  const fn = rawFn || "(anonymous)";
  const bucket = classifySourceBucket(frame.url || fallbackSource, fn);
  return {
    key: `${fallbackSource}:${line ?? 0}:${col ?? 0}:${fn}`,
    functionName: fn,
    source: fallbackSource,
    line,
    column: col,
    bucket,
    kind: "active",
  };
}

interface SampleSpan {
  nodeId: number;
  startUs: number;
  endUs: number;
}

function buildSampleSpans(profile: CpuProfile): SampleSpan[] {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const count = Math.min(samples.length, deltas.length);
  if (count === 0) return [];
  const times = new Array<number>(count);
  let cursor = profile.startTime;
  for (let i = 0; i < count; i++) {
    cursor += deltas[i]!;
    times[i] = cursor;
  }
  const spans: SampleSpan[] = [];
  for (let i = 0; i < count; i++) {
    const startUs = times[i]!;
    const endUs = i + 1 < count ? times[i + 1]! : Math.max(startUs, profile.endTime);
    if (endUs > startUs) {
      spans.push({ nodeId: samples[i]!, startUs, endUs });
    }
  }
  return spans;
}

function buildNodeTables(
  profile: CpuProfile,
  registry?: SourceMapRegistry | null,
): {
  framesById: Map<number, ResolvedFrame>;
  parentById: Map<number, number>;
} {
  const framesById = new Map<number, ResolvedFrame>();
  const parentById = new Map<number, number>();
  for (const node of profile.nodes) {
    framesById.set(node.id, resolveCallFrame(node.callFrame, registry));
    if (node.children) {
      for (const childId of node.children) {
        parentById.set(childId, node.id);
      }
    }
  }
  return { framesById, parentById };
}

/** Slice a V8 `CPUProfile` to `[fromUs, toUs]` and aggregate self, inclusive, source-file, and subsystem hotspots. */
export function analyzeCpuProfile(
  profile: CpuProfile,
  options: {
    fromUs?: number;
    toUs?: number;
    registry?: SourceMapRegistry | null;
    top?: number;
  } = {},
): CpuWindowAnalysis {
  const fromUs = options.fromUs ?? profile.startTime;
  const toUs = Math.max(fromUs, options.toUs ?? profile.endTime);
  const topN = options.top ?? 20;

  const { framesById, parentById } = buildNodeTables(profile, options.registry);
  const spans = buildSampleSpans(profile);

  let sampledUs = 0;
  let activeUs = 0;
  let idleUs = 0;
  let gcUs = 0;
  let programUs = 0;
  let sampleCount = 0;

  const fnStats = new Map<string, { meta: ResolvedFrame; selfUs: number; totalUs: number }>();
  const fileStats = new Map<string, { bucket: SourceBucket; selfUs: number; totalUs: number }>();
  const bucketSelfUs = new Map<SourceBucket, number>();

  for (const span of spans) {
    const overlapStart = Math.max(span.startUs, fromUs);
    const overlapEnd = Math.min(span.endUs, toUs);
    const durUs = overlapEnd - overlapStart;
    if (durUs <= 0) continue;

    sampledUs += durUs;
    sampleCount++;

    const leaf = framesById.get(span.nodeId);
    if (!leaf || leaf.kind === "root") continue;
    if (leaf.kind === "idle") {
      idleUs += durUs;
      continue;
    }
    if (leaf.kind === "gc") {
      gcUs += durUs;
      activeUs += durUs;
      bucketSelfUs.set("runtime", (bucketSelfUs.get("runtime") ?? 0) + durUs);
      continue;
    }
    if (leaf.kind === "program") {
      programUs += durUs;
      activeUs += durUs;
      bucketSelfUs.set("runtime", (bucketSelfUs.get("runtime") ?? 0) + durUs);
      continue;
    }

    activeUs += durUs;
    bucketSelfUs.set(leaf.bucket, (bucketSelfUs.get(leaf.bucket) ?? 0) + durUs);

    let leafStat = fnStats.get(leaf.key);
    if (!leafStat) {
      leafStat = { meta: leaf, selfUs: 0, totalUs: 0 };
      fnStats.set(leaf.key, leafStat);
    }
    leafStat.selfUs += durUs;

    let leafFile = fileStats.get(leaf.source);
    if (!leafFile) {
      leafFile = { bucket: leaf.bucket, selfUs: 0, totalUs: 0 };
      fileStats.set(leaf.source, leafFile);
    }
    leafFile.selfUs += durUs;

    // Walk ancestors up to root, deduplicating recursive frames and files within this single sample.
    const seenFnKeys = new Set<string>();
    const seenSources = new Set<string>();
    let cur: number | undefined = span.nodeId;
    let guard = 0;
    while (cur !== undefined && guard++ < 512) {
      const frame = framesById.get(cur);
      if (frame && frame.kind === "active") {
        if (!seenFnKeys.has(frame.key)) {
          seenFnKeys.add(frame.key);
          let st = fnStats.get(frame.key);
          if (!st) {
            st = { meta: frame, selfUs: 0, totalUs: 0 };
            fnStats.set(frame.key, st);
          }
          st.totalUs += durUs;
        }
        if (!seenSources.has(frame.source)) {
          seenSources.add(frame.source);
          let fs = fileStats.get(frame.source);
          if (!fs) {
            fs = { bucket: frame.bucket, selfUs: 0, totalUs: 0 };
            fileStats.set(frame.source, fs);
          }
          fs.totalUs += durUs;
        }
      }
      cur = parentById.get(cur);
    }
  }

  const activeMs = round1(activeUs / 1000);
  const toEntry = (item: { meta: ResolvedFrame; selfUs: number; totalUs: number }): HotspotEntry => ({
    functionName: item.meta.functionName,
    source: item.meta.source,
    line: item.meta.line,
    column: item.meta.column,
    bucket: item.meta.bucket,
    selfMs: round1(item.selfUs / 1000),
    totalMs: round1(item.totalUs / 1000),
    selfPct: pct(item.selfUs, activeUs),
    totalPct: pct(item.totalUs, activeUs),
  });

  const allEntries = [...fnStats.values()];
  const topSelf = [...allEntries]
    .filter((x) => x.selfUs > 0)
    .sort((a, b) => b.selfUs - a.selfUs || b.totalUs - a.totalUs)
    .slice(0, topN)
    .map(toEntry);

  const topTotal = [...allEntries]
    .sort((a, b) => b.totalUs - a.totalUs || b.selfUs - a.selfUs)
    .slice(0, topN)
    .map(toEntry);

  const topAppEntrypoints = [...allEntries]
    .filter((x) => x.meta.bucket === "app" || x.meta.bucket === "ui" || x.meta.bucket === "markdown" || x.meta.bucket === "rich-content")
    .sort((a, b) => b.totalUs - a.totalUs || b.selfUs - a.selfUs)
    .slice(0, topN)
    .map(toEntry);

  const bySource: SourceFileRollup[] = [...fileStats.entries()]
    .sort((a, b) => b[1].selfUs - a[1].selfUs || b[1].totalUs - a[1].totalUs)
    .slice(0, topN)
    .map(([source, st]) => ({
      source,
      bucket: st.bucket,
      selfMs: round1(st.selfUs / 1000),
      totalMs: round1(st.totalUs / 1000),
      selfPct: pct(st.selfUs, activeUs),
      totalPct: pct(st.totalUs, activeUs),
    }));

  const byBucket: BucketRollup[] = [...bucketSelfUs.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([bucket, us]) => ({
      bucket,
      selfMs: round1(us / 1000),
      selfPct: pct(us, activeUs),
    }));

  return {
    windowMs: round1((toUs - fromUs) / 1000),
    sampledMs: round1(sampledUs / 1000),
    activeMs,
    idleMs: round1(idleUs / 1000),
    gcMs: round1(gcUs / 1000),
    programMs: round1(programUs / 1000),
    sampleCount,
    topSelf,
    topTotal,
    topAppEntrypoints,
    bySource,
    byBucket,
  };
}

/** Attribute forced synchronous `Layout` / `RecalcStyle` spans to their triggering JS call sites. */
export function attributeForcedReflows(
  forcedSpans: readonly ForcedSpan[],
  profile: CpuProfile | null,
  registry?: SourceMapRegistry | null,
  top = 10,
): ForcedReflowCulprit[] {
  if (forcedSpans.length === 0) return [];
  const profileTables = profile ? buildNodeTables(profile, registry) : null;
  const sampleSpans = profile ? buildSampleSpans(profile) : [];

  const grouped = new Map<
    string,
    {
      functionName: string;
      source: string;
      line: number | null;
      column: number | null;
      bucket: SourceBucket;
      count: number;
      layoutCount: number;
      styleCount: number;
      totalForcedMs: number;
      maxElements: number;
      callStack: string[];
    }
  >();

  for (const span of forcedSpans) {
    let frames: Array<{ functionName: string; source: string; line: number | null; column: number | null; bucket: SourceBucket }> = [];

    if (span.stackTrace.length > 0) {
      frames = span.stackTrace.slice(0, 8).map((f) => {
        const url = f.url ?? "";
        const line1 = f.lineNumber ?? 0;
        const col1 = f.columnNumber ?? 0;
        const mapped = registry && url && line1 > 0 ? registry.resolveOneBased(url, line1, Math.max(1, col1)) : null;
        if (mapped) {
          const rawFn = f.functionName ?? "";
          const fn = mapped.name && isMinifiedSymbol(rawFn) ? mapped.name : rawFn || mapped.name || "(anonymous)";
          return { functionName: fn, source: mapped.source, line: mapped.line, column: mapped.column, bucket: mapped.bucket };
        }
        const src = fallbackSourceForUrl(url, "(unknown)");
        const fn = f.functionName || "(anonymous)";
        return {
          functionName: fn,
          source: src,
          line: line1 > 0 ? line1 : null,
          column: col1 > 0 ? col1 : null,
          bucket: classifySourceBucket(url || src, fn),
        };
      });
    } else if (profileTables && sampleSpans.length > 0) {
      // Fall back to the V8 CPUProfile call stack active when the forced layout started
      const hit =
        sampleSpans.find((s) => s.startUs <= span.startUs && s.endUs > span.startUs) ??
        sampleSpans.find((s) => s.endUs > span.startUs && s.startUs < span.endUs);
      if (hit) {
        let cur: number | undefined = hit.nodeId;
        let guard = 0;
        while (cur !== undefined && guard++ < 12) {
          const rf = profileTables.framesById.get(cur);
          if (rf && rf.kind === "active") {
            frames.push({
              functionName: rf.functionName,
              source: rf.source,
              line: rf.line,
              column: rf.column,
              bucket: rf.bucket,
            });
          }
          cur = profileTables.parentById.get(cur);
        }
      }
    }

    // Prefer the innermost non-React/non-runtime frame when available so we point to the app caller rather than react-dom commit internals
    const primary =
      frames.find((f) => f.bucket === "app" || f.bucket === "ui" || f.bucket === "markdown" || f.bucket === "rich-content") ??
      frames[0] ?? {
        functionName: "(unattributed)",
        source: "(unknown)",
        line: null,
        column: null,
        bucket: "runtime" as SourceBucket,
      };

    const key = `${primary.source}:${primary.line ?? 0}:${primary.functionName}`;
    const stackText = frames.slice(0, 6).map((f) => `${f.functionName} (${f.source}${f.line != null ? `:${f.line}` : ""})`);

    let entry = grouped.get(key);
    if (!entry) {
      entry = {
        functionName: primary.functionName,
        source: primary.source,
        line: primary.line,
        column: primary.column,
        bucket: primary.bucket,
        count: 0,
        layoutCount: 0,
        styleCount: 0,
        totalForcedMs: 0,
        maxElements: 0,
        callStack: stackText,
      };
      grouped.set(key, entry);
    }
    entry.count++;
    if (span.kind === "layout") entry.layoutCount++;
    else entry.styleCount++;
    entry.totalForcedMs = round1(entry.totalForcedMs + span.durationMs);
    entry.maxElements = Math.max(entry.maxElements, span.elements);
  }

  return [...grouped.values()].sort((a, b) => b.totalForcedMs - a.totalForcedMs || b.count - a.count).slice(0, top);
}

/**
 * Build the first-principles critical-path and parallel-slack summary for channel startup:
 * - `[0, messagesStart]` (`before-request`): bundle eval, auth, and routing before the first-page
 *   messages request is sent. Every ms of main-thread delay here pushes the request itself later,
 *   so it sits on the critical path (`networkSlackMs = 0`).
 * - `[messagesStart, messagesResponseEnd]` (`in-flight`): runs in parallel with the network fetch,
 *   carrying `networkSlackMs = max(0, inFlightDuration - inFlightTaskMs)`.
 * - `[messagesResponseEnd, painted]` (`response-to-paint`): network has already answered, so every
 *   ms of main-thread work directly delays first paint (`networkSlackMs = 0`).
 * - When local cache paints before the network response finishes (`painted < messagesResponseEnd`),
 *   `shownBeforeResponse` is true, `totalToPaintMs` stays `paintedMs` (never inflated to responseEnd),
 *   and `[0, painted]` is reported as a single `cached-to-paint` critical-path phase.
 */
export function buildCriticalPathSummary(input: {
  messagesStartMs: number | null;
  messagesResponseEndMs: number | null;
  paintedMs: number;
  beforeRequestSplit?: WorkSplit | null;
  inFlightSplit?: WorkSplit | null;
  responseToPaintSplit?: WorkSplit | null;
  cachedToPaintSplit?: WorkSplit | null;
  postPaintSettleSplit?: WorkSplit | null;
}): CriticalPathSummary {
  const paintedMs = round1(Math.max(0, input.paintedMs));
  const rawStart = input.messagesStartMs != null ? round1(Math.max(0, input.messagesStartMs)) : null;
  const rawEnd = input.messagesResponseEndMs != null ? round1(Math.max(0, input.messagesResponseEndMs)) : null;
  const shownBeforeResponse = rawEnd == null || paintedMs < rawEnd;

  const phases: CriticalPathPhase[] = [];
  let maxSavings = 0;

  if (shownBeforeResponse) {
    if (input.cachedToPaintSplit) {
      phases.push({
        phase: "cached-to-paint",
        startMs: 0,
        endMs: paintedMs,
        durationMs: paintedMs,
        networkSlackMs: 0,
        role: "critical-path",
        workSplit: input.cachedToPaintSplit,
      });
      maxSavings += input.cachedToPaintSplit.taskMs;
    }
  } else {
    const responseEndMs = rawEnd;
    const startMs = Math.min(rawStart ?? 0, responseEndMs);
    const inFlightDurationMs = round1(Math.max(0, responseEndMs - startMs));
    const responseToPaintMs = round1(Math.max(0, paintedMs - responseEndMs));

    if (input.beforeRequestSplit && startMs > 0) {
      phases.push({
        phase: "before-request",
        startMs: 0,
        endMs: startMs,
        durationMs: startMs,
        networkSlackMs: 0,
        role: "critical-path",
        workSplit: input.beforeRequestSplit,
      });
      maxSavings += input.beforeRequestSplit.taskMs;
    }

    if (input.inFlightSplit) {
      const slackMs = round1(Math.max(0, inFlightDurationMs - input.inFlightSplit.taskMs));
      const inFlightRole: CriticalPathPhase["role"] =
        inFlightDurationMs > 0 && input.inFlightSplit.taskMs >= inFlightDurationMs * 0.85 ? "co-bottleneck" : "hidden-by-network";
      phases.push({
        phase: "in-flight",
        startMs,
        endMs: responseEndMs,
        durationMs: inFlightDurationMs,
        networkSlackMs: slackMs,
        role: inFlightRole,
        workSplit: input.inFlightSplit,
      });
      if (inFlightRole === "co-bottleneck") {
        maxSavings += Math.max(0, input.inFlightSplit.taskMs - inFlightDurationMs * 0.85);
      }
    }

    if (input.responseToPaintSplit) {
      phases.push({
        phase: "response-to-paint",
        startMs: responseEndMs,
        endMs: paintedMs,
        durationMs: responseToPaintMs,
        networkSlackMs: 0,
        role: "critical-path",
        workSplit: input.responseToPaintSplit,
      });
      maxSavings += input.responseToPaintSplit.taskMs;
    }
  }

  if (input.postPaintSettleSplit) {
    phases.push({
      phase: "post-paint-settle",
      startMs: paintedMs,
      endMs: round1(paintedMs + input.postPaintSettleSplit.windowMs),
      durationMs: input.postPaintSettleSplit.windowMs,
      networkSlackMs: 0,
      role: "deferred-after-paint",
      workSplit: input.postPaintSettleSplit,
    });
  }

  return {
    totalToPaintMs: paintedMs,
    messagesStartMs: rawStart,
    messagesResponseEndMs: rawEnd,
    responseToPaintMs: !shownBeforeResponse && rawEnd != null ? round1(paintedMs - rawEnd) : null,
    shownBeforeResponse,
    maxMainThreadSavingsMs: round1(Math.min(paintedMs, maxSavings)),
    phases,
  };
}
