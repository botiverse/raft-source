// HTTP entry: routes each request to the trace or feedback handlers. See README.md
// for what the service does; src/node.ts is the runtime entry point.
import type { ExecutionContextLike, TraceUploadWorkerEnv } from "./env";
import {
  completeFeedbackReport,
  createFeedbackReportUpload,
  feedbackReportCorsHeaders,
  feedbackReportCorsResponse,
  isFeedbackReportPath,
  putFeedbackReportObject,
} from "./feedback/reports";
import { ANTIPROTON_TRACE_PATH, ingestAntiprotonTraceBatch } from "./external/antiprotonTrace";
import { GITHUB_REFRESH_PATH, ingestGithubRefreshBatch } from "./external/githubRefresh";
import { HttpError, jsonResponse } from "./shared/http";
import { createTraceBundleUpload, putTraceBundleObject } from "./traces/bundles";
import { OtlpSinkError } from "./traces/otlpSink";
import { ingestWebTraceBatch, webTraceCorsHeaders, webTraceCorsResponse } from "./traces/web";

export async function handleRequest(request: Request, env: TraceUploadWorkerEnv, ctx?: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/trace-bundles") {
      return await createTraceBundleUpload(request, env);
    }
    if (isFeedbackReportPath(url.pathname)) {
      if (request.method === "OPTIONS") {
        return feedbackReportCorsResponse(env, request);
      }
      if (request.method === "POST" && (url.pathname === "/api/feedback-reports" || url.pathname === "/api/reports")) {
        return await createFeedbackReportUpload(request, env);
      }
    }
    if (request.method === "POST" && url.pathname === GITHUB_REFRESH_PATH) {
      return await ingestGithubRefreshBatch(request, env);
    }
    if (request.method === "POST" && url.pathname === ANTIPROTON_TRACE_PATH) {
      return await ingestAntiprotonTraceBatch(request, env);
    }
    if (url.pathname === "/api/web-traces") {
      if (request.method === "OPTIONS") {
        return webTraceCorsResponse(env, request);
      }
      if (request.method === "POST") {
        return await ingestWebTraceBatch(request, env);
      }
    }
    const objectMatch = url.pathname.match(/^\/api\/trace-bundles\/([^/]+)\/object$/);
    if (request.method === "PUT" && objectMatch) {
      return await putTraceBundleObject(request, env, decodeURIComponent(objectMatch[1]), ctx);
    }
    const feedbackObjectMatch = url.pathname.match(/^\/api\/(?:feedback-reports|reports)\/([^/]+)\/object$/);
    if (request.method === "PUT" && feedbackObjectMatch) {
      return await putFeedbackReportObject(request, env, decodeURIComponent(feedbackObjectMatch[1]));
    }
    const feedbackCompleteMatch = url.pathname.match(/^\/api\/(?:feedback-reports|reports)\/([^/]+)\/complete$/);
    if (request.method === "POST" && feedbackCompleteMatch) {
      return await completeFeedbackReport(request, env, decodeURIComponent(feedbackCompleteMatch[1]));
    }
    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    const headers: Record<string, string> = url.pathname === "/api/web-traces"
      ? webTraceCorsHeaders(env, request)
      : isFeedbackReportPath(url.pathname)
        ? feedbackReportCorsHeaders(env, request)
        : {};
    if (err instanceof HttpError) {
      if (err.retryAfterSeconds !== undefined) headers["Retry-After"] = String(err.retryAfterSeconds);
      // The sink's own error text stays in the server log, never in the response.
      const body = err instanceof OtlpSinkError
        ? { error: "Trace sink unavailable", reason: err.reason }
        : { error: err.message };
      return jsonResponse(body, err.status, headers);
    }
    // The client went away, or stalled into the server's request timeout,
    // before its request arrived (the Node entry point aborts the request's
    // signal). It is not a failure of ours, so it gets its own line; the
    // message is kept so a mislabelled failure would still show.
    if (request.signal.aborted) {
      console.warn("[TraceUploadWorker] request_aborted", {
        method: request.method,
        path: url.pathname,
        error_message: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse({ error: "Internal server error" }, 500, headers);
    }
    // The client only sees "Internal server error"; without this line a 500
    // leaves no trace of its cause. Path only: the query can carry a token.
    console.error("[TraceUploadWorker] request_failed", {
      method: request.method,
      path: url.pathname,
      error_class: err instanceof Error ? err.name : "Error",
      error_message: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse({ error: "Internal server error" }, 500, headers);
  }
}

export type { TraceUploadRuntimeEnv, TraceUploadWorkerEnv } from "./env";
export { ingestTraceBundleObject, isLocalTraceRecord } from "./traces/otlp";
