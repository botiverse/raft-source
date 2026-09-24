import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  currentDate,
  type FeedbackTranscriptReportTimeSource,
  type FeedbackTranscriptWindow,
  type Tracer,
} from "@botiverse/raft-shared";
import { uploadWithSignedCapability } from "./directUploadCapability.js";
import { assessFeedbackTranscriptWindow } from "./feedbackTranscriptWindow.js";
import { logger } from "./logger.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FeedbackTranscriptReportWindowInput {
  reportGeneratedAt: string;
  reportTimeSource: FeedbackTranscriptReportTimeSource;
}

export interface FeedbackTranscriptCollectionResult {
  traceBundleId?: string;
  reachable: boolean;
  fallbackReason?: string;
  error?: string;
  transcriptWindow?: FeedbackTranscriptWindow;
}

interface FeedbackTranscriptSourceResult {
  runtime: string;
  sessionId: string;
  reachable: boolean;
  fallbackReason?: string;
  transcript: string | null;
  sizeBytes: number;
  truncated?: boolean;
  truncationDirection?: "head" | "tail" | "window";
}

export function defaultFeedbackTranscriptReportWindow(): FeedbackTranscriptReportWindowInput {
  return {
    reportGeneratedAt: currentDate().toISOString(),
    reportTimeSource: "server_request_received",
  };
}

export async function collectFeedbackTranscriptAttachment(input: {
  agentId: string;
  feedbackReportId: string;
  reportWindow: FeedbackTranscriptReportWindowInput;
  getSessionTranscript: () => Promise<FeedbackTranscriptSourceResult>;
  serverUrl: string;
  daemonApiKey: string;
  workerUrl: string | null;
  tracer: Tracer;
  fetchImpl: FetchLike;
}): Promise<FeedbackTranscriptCollectionResult> {
  const transcriptResult = await input.getSessionTranscript();
  if (!transcriptResult.reachable || !transcriptResult.transcript) {
    return {
      reachable: false,
      fallbackReason: transcriptResult.fallbackReason ?? "transcript not reachable",
    };
  }

  const transcriptWindow = assessFeedbackTranscriptWindow({
    transcript: transcriptResult.transcript,
    ...input.reportWindow,
  });
  if (!input.workerUrl) {
    return {
      reachable: true,
      fallbackReason: "daemon worker URL is not configured",
      transcriptWindow,
    };
  }

  const span = input.tracer.startSpan("daemon.feedback_transcript.upload", {
    surface: "daemon",
    kind: "producer",
    attrs: {
      agentId: input.agentId,
      feedbackReportId: input.feedbackReportId,
      runtime: transcriptResult.runtime,
      sessionId: transcriptResult.sessionId,
      transcript_size_bytes: transcriptResult.sizeBytes,
      transcript_window_coverage: transcriptWindow.coverage,
      transcript_window_report_time_source: transcriptWindow.reportTimeSource,
    },
  });

  try {
    const gzipped = gzipSync(Buffer.from(transcriptResult.transcript, "utf8"));
    const bundleSha256 = createHash("sha256").update(gzipped).digest("hex");
    const bundleSizeBytes = gzipped.byteLength;
    const bundleId = randomUUID();
    const uploadResult = await uploadWithSignedCapability({
      serverUrl: input.serverUrl,
      apiKey: input.daemonApiKey,
      workerUrl: input.workerUrl,
      scope: "daemon-trace-bundle:create",
      createPath: "/api/trace-bundles",
      createBody: { bundleSha256, bundleSizeBytes },
      attestationMetadata: {
        bundleId,
        bundleSha256,
        bundleSizeBytes,
        bundleContentType: "application/json",
        bundleContentEncoding: "gzip",
        feedbackReportId: input.feedbackReportId,
        agentId: input.agentId,
        feedbackReportGeneratedAt: transcriptWindow.reportGeneratedAt,
        feedbackReportTimeSource: transcriptWindow.reportTimeSource,
        feedbackReportWindowStartAt: transcriptWindow.reportWindowStartAt,
        feedbackTranscriptWindowToleranceMs: transcriptWindow.toleranceMs,
        feedbackTranscriptWindowCoverage: transcriptWindow.coverage,
        ...(transcriptResult.truncated !== undefined
          ? { feedbackTranscriptTruncated: transcriptResult.truncated ? "true" : "false" }
          : {}),
        ...(transcriptResult.truncationDirection
          ? { feedbackTranscriptTruncationDirection: transcriptResult.truncationDirection }
          : {}),
        ...(transcriptWindow.transcriptFirstEventAt
          ? { feedbackTranscriptFirstEventAt: transcriptWindow.transcriptFirstEventAt }
          : {}),
        ...(transcriptWindow.transcriptLastEventAt
          ? { feedbackTranscriptLastEventAt: transcriptWindow.transcriptLastEventAt }
          : {}),
      },
      uploadBody: new Blob([new Uint8Array(gzipped)], { type: "application/json" }),
      fetchImpl: input.fetchImpl,
    });

    const traceBundleId = typeof uploadResult.session.id === "string" ? uploadResult.session.id : bundleId;
    logger.info(`[FeedbackTranscript] uploaded for report=${input.feedbackReportId} agent=${input.agentId} traceBundleId=${traceBundleId} size=${bundleSizeBytes}`);
    span.end("ok", { attrs: { traceBundleId, bundleSizeBytes, transcript_window_coverage: transcriptWindow.coverage } });
    return { reachable: true, traceBundleId, transcriptWindow };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[FeedbackTranscript] upload failed for report=${input.feedbackReportId} agent=${input.agentId}: ${message}`);
    span.end("error", { attrs: { error_class: err instanceof Error ? err.name : "Error", error_message: message } });
    return { reachable: true, error: message, transcriptWindow };
  }
}
