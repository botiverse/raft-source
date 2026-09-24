import assert from "node:assert/strict";
import { test } from "vitest";
import { assessFeedbackTranscriptWindow } from "./feedbackTranscriptWindow.js";

test("feedback transcript window marks a near-report JSONL transcript covered", () => {
  const result = assessFeedbackTranscriptWindow({
    transcript: [
      JSON.stringify({ timestamp: "2026-07-20T16:20:00.000Z", type: "turn" }),
      JSON.stringify({ nested: { created_at: "2026-07-20T16:39:38.024Z" } }),
    ].join("\n"),
    reportGeneratedAt: "2026-07-20T16:40:04.797Z",
    reportTimeSource: "web_report_bundle",
  });

  assert.equal(result.coverage, "covered");
  assert.equal(result.transcriptFirstEventAt, "2026-07-20T16:20:00.000Z");
  assert.equal(result.transcriptLastEventAt, "2026-07-20T16:39:38.024Z");
  assert.equal(result.reportWindowStartAt, "2026-07-20T16:25:04.797Z");
});

test("feedback transcript window exposes stale or unavailable evidence without reading content", () => {
  const stale = assessFeedbackTranscriptWindow({
    transcript: JSON.stringify({ events: [{ timestamp: "2026-07-08T06:00:00.000Z" }] }),
    reportGeneratedAt: "2026-07-20T16:40:04.797Z",
    reportTimeSource: "web_report_bundle",
  });
  assert.equal(stale.coverage, "outside_report_window");

  const unavailable = assessFeedbackTranscriptWindow({
    transcript: JSON.stringify({ prompt: "private content with no timestamp" }),
    reportGeneratedAt: "2026-07-20T16:40:04.797Z",
    reportTimeSource: "server_request_received",
  });
  assert.deepEqual(unavailable, {
    reportGeneratedAt: "2026-07-20T16:40:04.797Z",
    reportTimeSource: "server_request_received",
    reportWindowStartAt: "2026-07-20T16:25:04.797Z",
    toleranceMs: 900_000,
    coverage: "timestamps_unavailable",
  });
});
