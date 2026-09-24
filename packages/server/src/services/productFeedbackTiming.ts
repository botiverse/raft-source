const ALLOWED_HANDS_TIMING_NAMES = new Set([
  "hands_auth",
  "hands_preflight",
  "hands_commit",
  "hands_postcommit",
  "hands_list",
  "hands_session_mint",
  "hands_session_verify",
]);

const HANDS_TIMING_RE = /^([a-z_]+);dur=(\d+(?:\.\d+)?)$/;
const MAX_DURATION_MS = 60_000;

export function sanitizeHandsServerTiming(value: string | null): string[] {
  if (!value) return [];
  const metrics: string[] = [];
  const seen = new Set<string>();
  for (const rawMetric of value.split(",")) {
    const metric = rawMetric.trim();
    const match = HANDS_TIMING_RE.exec(metric);
    if (!match) continue;
    const [, name, rawDuration] = match;
    if (!name || !rawDuration || !ALLOWED_HANDS_TIMING_NAMES.has(name) || seen.has(name)) continue;
    const duration = Number(rawDuration);
    if (!Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION_MS) continue;
    seen.add(name);
    metrics.push(`${name};dur=${duration.toFixed(1)}`);
  }
  return metrics;
}

export function productFeedbackServerTiming(
  durationMs: number,
  handsServerTiming: string | null,
): string {
  const boundedDuration = Number.isFinite(durationMs)
    ? Math.max(0, Math.min(MAX_DURATION_MS, durationMs))
    : 0;
  return [
    `raft_feedback_hands;dur=${boundedDuration.toFixed(1)}`,
    ...sanitizeHandsServerTiming(handsServerTiming),
  ].join(", ");
}
