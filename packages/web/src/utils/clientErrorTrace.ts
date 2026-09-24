/**
 * slock.client_error — client crash/exception reporting into the existing
 * web trace pipeline (L5 schema v0.1, field table by Manjusaka, assigned by
 * Tenny as structural fix #1 of the 2026-07-07 React #185 incident: client
 * crashes were structurally invisible — no error family existed, so a
 * founder hitting the crash was the only detector).
 *
 * Field discipline (closed sets, no PII):
 *   capture_source       error_boundary | window_onerror | unhandled_rejection
 *   error_name           Error.name low-cardinality; minified React errors
 *                        normalized to `react_error_NNN` (code only — the
 *                        raw message is never reported)
 *   component_stack_top  top component frame NAME only (never the full stack)
 *   suppressed_count     occurrences swallowed by throttling since the last
 *                        reported event of the same signature
 *   webAssetId / tabId   standard pipeline fields (added by the trace layer)
 *
 * Throttling (the incident's own lesson — a render loop fires thousands of
 * errors per second; unthrottled reporting would DoS the pipeline): per
 * (error_name + component_stack_top) signature, at most
 * MAX_REPORTS_PER_WINDOW reports per rolling window; excess only increments
 * suppressed_count, carried out on the next allowed report. Quantification
 * survives; the pipe does not melt.
 */

import { emitWebTrace } from "./webAuthTrace";
import { isDynamicImportFailure } from "./dynamicImportRecovery";

type ClientErrorEmitter = typeof emitWebTrace;
let emitter: ClientErrorEmitter = emitWebTrace;

/** Test seam: capture emitted records without coupling to the pipeline. */
export function __setClientErrorEmitterForTest(next: ClientErrorEmitter | null): void {
  emitter = next ?? emitWebTrace;
}

export type ClientErrorCaptureSource =
  | "error_boundary"
  | "window_onerror"
  | "unhandled_rejection";

/** Query-safe, closed cause classes for the client-error family. */
export type ClientErrorClass =
  | "chunk_syntax"
  | "chunk_fetch_module"
  | "lazy_type_default"
  | "react_boundary"
  | "network"
  | "unhandled_other";

const THROTTLE_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_WINDOW = 3;

interface SignatureBucket {
  windowStartMs: number;
  reported: number;
  suppressed: number;
}

const bucketsBySignature = new Map<string, SignatureBucket>();

export function __resetClientErrorThrottleForTest(): void {
  bucketsBySignature.clear();
}

/** Minified React production errors carry the code in the message
 *  ("Minified React error #185; visit …"). We extract ONLY the code. */
const REACT_MINIFIED_RE = /Minified React error #(\d{1,6})(?!\d)/;
const STANDARD_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "ReferenceError",
  "RangeError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DOMException",
]);

export function normalizeClientErrorName(error: unknown): string {
  if (error instanceof Error) {
    const reactCode = REACT_MINIFIED_RE.exec(error.message ?? "");
    if (reactCode) return `react_error_${reactCode[1]}`;
    return STANDARD_ERROR_NAMES.has(error.name) ? error.name : "custom_error";
  }
  if (typeof error === "string") {
    const reactCode = REACT_MINIFIED_RE.exec(error);
    if (reactCode) return `react_error_${reactCode[1]}`;
    return "string_throw";
  }
  return "unknown_error";
}

function clientErrorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}\n${error.message}`;
  return typeof error === "string" ? error : "";
}

/**
 * Classify locally from the thrown value, then emit only the enum. Raw error
 * text, URLs and stacks never cross the trace boundary.
 */
export function classifyClientError(
  error: unknown,
  source: ClientErrorCaptureSource,
): ClientErrorClass {
  if (isDynamicImportFailure(error)) return "chunk_fetch_module";
  if (error instanceof SyntaxError) return "chunk_syntax";

  const text = clientErrorText(error);
  if (/Cannot read propert(?:y|ies) of undefined \(reading ['"]default['"]\)/i.test(text)) {
    return "lazy_type_default";
  }
  if (REACT_MINIFIED_RE.test(text) || source === "error_boundary") return "react_boundary";
  if (/\b(?:NetworkError|Failed to fetch|network request failed)\b/i.test(text)) return "network";
  return "unhandled_other";
}

/** First component name from a React componentStack ("\n    at Name (…)"). */
export function topComponentFrame(componentStack: string | null | undefined): string {
  if (!componentStack) return "unknown";
  const match = /^\s*at\s+([A-Za-z0-9_$.]+)/m.exec(componentStack);
  return match ? match[1].slice(0, 64) : "unknown";
}

function throttleDecision(signature: string, nowMs: number): { report: boolean; suppressedToCarry: number } {
  const bucket = bucketsBySignature.get(signature);
  if (!bucket || nowMs - bucket.windowStartMs >= THROTTLE_WINDOW_MS) {
    const carried = bucket?.suppressed ?? 0;
    bucketsBySignature.set(signature, { windowStartMs: nowMs, reported: 1, suppressed: 0 });
    return { report: true, suppressedToCarry: carried };
  }
  if (bucket.reported < MAX_REPORTS_PER_WINDOW) {
    bucket.reported += 1;
    const carried = bucket.suppressed;
    bucket.suppressed = 0;
    return { report: true, suppressedToCarry: carried };
  }
  bucket.suppressed += 1;
  return { report: false, suppressedToCarry: 0 };
}

export interface ClientErrorReport {
  source: ClientErrorCaptureSource;
  error: unknown;
  componentStack?: string | null;
}

export function reportClientError(
  input: ClientErrorReport,
  nowMs: number = Date.now(),
): void {
  try {
    const errorName = normalizeClientErrorName(input.error);
    const errorClass = classifyClientError(input.error, input.source);
    const stackTop = input.source === "error_boundary"
      ? topComponentFrame(input.componentStack)
      : "global";
    const { report, suppressedToCarry } = throttleDecision(`${errorClass}|${errorName}|${stackTop}`, nowMs);
    if (!report) return;
    emitter("slock.client_error", {
      captureSource: input.source,
      errorClass,
      errorName,
      componentStackTop: stackTop,
      suppressedCount: suppressedToCarry,
    });
  } catch {
    // The error reporter must never become an error source itself.
  }
}

let globalReportersInstalled = false;

/**
 * Global capture: window "error" + "unhandledrejection". Idempotent —
 * repeated calls (StrictMode, HMR) install exactly once. Returns uninstall
 * (for tests; production installs for the page lifetime).
 */
export function installGlobalClientErrorReporters(): () => void {
  if (globalReportersInstalled || typeof window === "undefined") return () => {};
  globalReportersInstalled = true;

  const onError = (event: ErrorEvent) => {
    reportClientError({ source: "window_onerror", error: event.error ?? event.message });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    reportClientError({ source: "unhandled_rejection", error: event.reason });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    globalReportersInstalled = false;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
