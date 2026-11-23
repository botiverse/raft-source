/**
 * Pure long-lived session memory & DOM node retention / leak slope analyzer
 * for `raft-perf soak` (#proj-frontend:#78).
 *
 * Uses post-warmup ordinary least squares (OLS) slope across rounds `1..N`
 * (skipping round 0 initial baseline so cold-cache/JIT fill does not masquerade
 * as a steady-state leak) plus monotonic growth detection.
 */

export interface SoakSample {
  /** 0 = baseline after initial settle; 1..N = after round k switch/scroll + GC. */
  round: number;
  jsHeapUsedBytes: number;
  jsHeapTotalBytes: number;
  domNodes: number;
  jsEventListeners: number;
  documents: number;
}

export interface SoakTrendSummary {
  rounds: number;
  jsHeapStartMb: number;
  jsHeapEndMb: number;
  jsHeapDeltaMb: number;
  /** OLS slope in MB/round over post-warmup samples (rounds 1..N when >= 3 samples, else all). */
  jsHeapSlopeMbPerRound: number;
  domNodesStart: number;
  domNodesEnd: number;
  domNodesDelta: number;
  /** OLS slope in DOM nodes/round over post-warmup samples. */
  domNodesSlopePerRound: number;
  jsListenersStart: number;
  jsListenersEnd: number;
  jsListenersDelta: number;
  /** True when post-warmup JS heap grew on every consecutive round AND net delta > 1 MB. */
  monotonicHeapGrowth: boolean;
}

const MB = 1024 * 1024;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Ordinary least squares slope `dy/dx` for points `(x_i, y_i)`. Returns 0 when fewer than 2 distinct x values. */
export function olsSlope(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i]!;
    sumY += ys[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    num += dx * (ys[i]! - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

export function analyzeSoakSamples(samples: readonly SoakSample[]): SoakTrendSummary {
  if (samples.length === 0) {
    return {
      rounds: 0,
      jsHeapStartMb: 0,
      jsHeapEndMb: 0,
      jsHeapDeltaMb: 0,
      jsHeapSlopeMbPerRound: 0,
      domNodesStart: 0,
      domNodesEnd: 0,
      domNodesDelta: 0,
      domNodesSlopePerRound: 0,
      jsListenersStart: 0,
      jsListenersEnd: 0,
      jsListenersDelta: 0,
      monotonicHeapGrowth: false,
    };
  }
  const ordered = [...samples].sort((a, b) => a.round - b.round);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  // Skip round 0 warmup when computing steady-state slope if >= 3 post-warmup samples exist.
  const trendWindow = ordered.length >= 4 ? ordered.slice(1) : ordered;
  const xs = trendWindow.map((s) => s.round);
  const heapMbs = trendWindow.map((s) => s.jsHeapUsedBytes / MB);
  const doms = trendWindow.map((s) => s.domNodes);

  let strictlyGrowing = trendWindow.length >= 3;
  for (let i = 1; i < trendWindow.length; i += 1) {
    if (!(trendWindow[i]!.jsHeapUsedBytes > trendWindow[i - 1]!.jsHeapUsedBytes)) {
      strictlyGrowing = false;
      break;
    }
  }
  const heapStartMb = first.jsHeapUsedBytes / MB;
  const heapEndMb = last.jsHeapUsedBytes / MB;
  const heapDeltaMb = heapEndMb - heapStartMb;

  return {
    rounds: Math.max(0, ordered.length - 1),
    jsHeapStartMb: round2(heapStartMb),
    jsHeapEndMb: round2(heapEndMb),
    jsHeapDeltaMb: round2(heapDeltaMb),
    jsHeapSlopeMbPerRound: round3(olsSlope(xs, heapMbs)),
    domNodesStart: Math.round(first.domNodes),
    domNodesEnd: Math.round(last.domNodes),
    domNodesDelta: Math.round(last.domNodes - first.domNodes),
    domNodesSlopePerRound: round2(olsSlope(xs, doms)),
    jsListenersStart: Math.round(first.jsEventListeners),
    jsListenersEnd: Math.round(last.jsEventListeners),
    jsListenersDelta: Math.round(last.jsEventListeners - first.jsEventListeners),
    monotonicHeapGrowth: strictlyGrowing && heapDeltaMb > 1.0,
  };
}
