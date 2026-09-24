import type {
  FeedbackTranscriptReportTimeSource,
  FeedbackTranscriptWindow,
} from "@botiverse/raft-shared";

// Reports are commonly submitted a few minutes after the failing turn. This
// bounded grace period proves that the transcript reaches the report window
// without pretending the last transcript row must equal the submit instant.
export const FEEDBACK_TRANSCRIPT_REPORT_WINDOW_TOLERANCE_MS = 15 * 60 * 1000;

const TIMESTAMP_KEYS = new Set([
  "timestamp",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "startedAt",
  "started_at",
  "endedAt",
  "ended_at",
]);
const MAX_SCAN_DEPTH = 12;
const MAX_SCANNED_NODES = 100_000;

export function assessFeedbackTranscriptWindow(input: {
  transcript: string;
  reportGeneratedAt: string;
  reportTimeSource: FeedbackTranscriptReportTimeSource;
  toleranceMs?: number;
}): FeedbackTranscriptWindow {
  const toleranceMs = input.toleranceMs ?? FEEDBACK_TRANSCRIPT_REPORT_WINDOW_TOLERANCE_MS;
  const reportMs = parseTimestamp(input.reportGeneratedAt);
  if (reportMs === null) {
    return {
      reportGeneratedAt: input.reportGeneratedAt,
      reportTimeSource: input.reportTimeSource,
      reportWindowStartAt: input.reportGeneratedAt,
      toleranceMs,
      coverage: "report_time_invalid",
    };
  }

  const timestamps = extractTranscriptTimestamps(input.transcript);
  const reportWindowStartMs = reportMs - toleranceMs;
  const base = {
    reportGeneratedAt: new Date(reportMs).toISOString(),
    reportTimeSource: input.reportTimeSource,
    reportWindowStartAt: new Date(reportWindowStartMs).toISOString(),
    toleranceMs,
  } as const;
  if (timestamps.length === 0) {
    return { ...base, coverage: "timestamps_unavailable" };
  }

  let firstMs = timestamps[0]!;
  let lastMs = timestamps[0]!;
  for (const timestamp of timestamps) {
    if (timestamp < firstMs) firstMs = timestamp;
    if (timestamp > lastMs) lastMs = timestamp;
  }
  return {
    ...base,
    coverage: lastMs >= reportWindowStartMs ? "covered" : "outside_report_window",
    transcriptFirstEventAt: new Date(firstMs).toISOString(),
    transcriptLastEventAt: new Date(lastMs).toISOString(),
  };
}

function extractTranscriptTimestamps(transcript: string): number[] {
  const timestamps: number[] = [];
  const budget = { visited: 0 };
  const trimmed = transcript.trim();
  if (!trimmed) return timestamps;

  try {
    collectTimestamps(JSON.parse(trimmed), timestamps, budget, 0);
    return timestamps;
  } catch {
    // Most runtime transcripts are JSONL. Parse each record independently so
    // one malformed/truncated line cannot suppress timestamps from good rows.
  }

  for (const line of transcript.split(/\r?\n/)) {
    if (budget.visited >= MAX_SCANNED_NODES) break;
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      collectTimestamps(JSON.parse(candidate), timestamps, budget, 0);
    } catch {
      // Content is never exported from this scanner; malformed rows are simply
      // unavailable evidence.
    }
  }
  return timestamps;
}

function collectTimestamps(
  value: unknown,
  timestamps: number[],
  budget: { visited: number },
  depth: number,
): void {
  if (depth > MAX_SCAN_DEPTH || budget.visited >= MAX_SCANNED_NODES) return;
  budget.visited += 1;
  if (Array.isArray(value)) {
    for (const item of value) collectTimestamps(item, timestamps, budget, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (TIMESTAMP_KEYS.has(key)) {
      const parsed = parseTimestamp(child);
      if (parsed !== null) timestamps.push(parsed);
    }
    collectTimestamps(child, timestamps, budget, depth + 1);
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
