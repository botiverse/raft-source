/**
 * Pure Interaction to Next Paint (INP) & interactive latency analyzer for
 * `raft-perf input` (#proj-frontend:#78).
 *
 * Implements W3C Event Timing grouping by `interactionId` and Google web-vitals
 * p98 INP selection (drop 1 worst interaction per 50 distinct interactions),
 * plus separate keyboard and click latency percentiles so `perf.page_runs.inp_ms`
 * and its breakdown in `extra` are deterministic and unit-tested.
 */

export type InputInteractionKind = "click" | "key" | "pointer";

export interface RawEventTimingEntry {
  name: string;
  interactionId: number;
  startTime: number;
  duration: number;
  processingStart?: number;
  processingEnd?: number;
}

export interface GroupedInteraction {
  id: number;
  kind: InputInteractionKind;
  durationMs: number;
  inputDelayMs: number | null;
  processingMs: number | null;
  presentationDelayMs: number | null;
}

export interface InputLatencySummary {
  /** W3C p98 INP across all distinct interactions (ms), or null if none recorded. */
  inpMs: number | null;
  /** Coarse kind of the winning INP interaction. */
  inpInteraction: InputInteractionKind | null;
  interactionCount: number;
  longInteractionCount: number;
  keyCount: number;
  keyP50Ms: number | null;
  keyP95Ms: number | null;
  keyMaxMs: number | null;
  clickCount: number;
  clickP50Ms: number | null;
  clickP95Ms: number | null;
  clickMaxMs: number | null;
  longtaskMs: number;
  worstInteractions: GroupedInteraction[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function classifyInputEvent(name: string): InputInteractionKind | null {
  switch (name) {
    case "keydown":
    case "keypress":
    case "keyup":
      return "key";
    case "click":
    case "auxclick":
    case "dblclick":
    case "contextmenu":
      return "click";
    case "pointerdown":
    case "pointerup":
    case "pointercancel":
    case "mousedown":
    case "mouseup":
    case "touchstart":
    case "touchend":
      return "pointer";
    default:
      return null;
  }
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round1(sorted[rank]!);
}

/**
 * Group raw Event Timing entries by `interactionId` and compute W3C p98 INP
 * plus keyboard & click latency distributions.
 */
export function summarizeInputInteractions(
  entries: readonly RawEventTimingEntry[],
  longtaskMs = 0,
  totalInteractionCountOverride?: number,
): InputLatencySummary {
  const byId = new Map<number, GroupedInteraction>();

  for (const e of entries) {
    if (!(e.interactionId > 0) || !Number.isFinite(e.duration) || e.duration < 0) continue;
    const kind = classifyInputEvent(e.name);
    if (!kind) continue;

    const inputDelayMs =
      typeof e.processingStart === "number" && Number.isFinite(e.processingStart)
        ? round1(Math.max(0, e.processingStart - e.startTime))
        : null;
    const processingMs =
      typeof e.processingStart === "number" &&
      typeof e.processingEnd === "number" &&
      Number.isFinite(e.processingStart) &&
      Number.isFinite(e.processingEnd)
        ? round1(Math.max(0, e.processingEnd - e.processingStart))
        : null;
    const presentationDelayMs =
      typeof e.processingEnd === "number" && Number.isFinite(e.processingEnd)
        ? round1(Math.max(0, e.startTime + e.duration - e.processingEnd))
        : null;

    const prev = byId.get(e.interactionId);
    if (!prev) {
      byId.set(e.interactionId, {
        id: e.interactionId,
        kind,
        durationMs: round1(e.duration),
        inputDelayMs,
        processingMs,
        presentationDelayMs,
      });
    } else {
      if (e.duration > prev.durationMs) {
        prev.durationMs = round1(e.duration);
        prev.inputDelayMs = inputDelayMs;
        prev.processingMs = processingMs;
        prev.presentationDelayMs = presentationDelayMs;
        if (kind === "click" || prev.kind === "pointer") prev.kind = kind;
      } else if (kind === "click" && prev.kind === "pointer") {
        prev.kind = "click";
      }
    }
  }

  const all = [...byId.values()].sort((a, b) => b.durationMs - a.durationMs);
  const interactionCount = Math.max(
    all.length,
    typeof totalInteractionCountOverride === "number" && Number.isFinite(totalInteractionCountOverride) && totalInteractionCountOverride > 0
      ? Math.floor(totalInteractionCountOverride)
      : 0,
  );

  let inpMs: number | null = null;
  let inpInteraction: InputInteractionKind | null = null;
  if (all.length > 0) {
    const idx = Math.min(Math.floor(interactionCount / 50), all.length - 1);
    const winner = all[idx]!;
    inpMs = winner.durationMs;
    inpInteraction = winner.kind;
  }

  const keys = all.filter((i) => i.kind === "key").map((i) => i.durationMs);
  const clicks = all.filter((i) => i.kind === "click" || i.kind === "pointer").map((i) => i.durationMs);

  return {
    inpMs,
    inpInteraction,
    interactionCount,
    longInteractionCount: all.filter((i) => i.durationMs > 200).length,
    keyCount: keys.length,
    keyP50Ms: percentile(keys, 50),
    keyP95Ms: percentile(keys, 95),
    keyMaxMs: keys.length ? round1(Math.max(...keys)) : null,
    clickCount: clicks.length,
    clickP50Ms: percentile(clicks, 50),
    clickP95Ms: percentile(clicks, 95),
    clickMaxMs: clicks.length ? round1(Math.max(...clicks)) : null,
    longtaskMs: round1(Math.max(0, longtaskMs)),
    worstInteractions: all.slice(0, 10),
  };
}
