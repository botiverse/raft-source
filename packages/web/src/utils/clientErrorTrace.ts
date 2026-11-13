/**
 * slock.client_error — client crash/exception reporting into the existing
 * web trace pipeline (L5 schema v0.1, field table by Manjusaka, assigned by
 * Tenny as structural fix #1 of the 2026-07-07 React #185 incident: client
 * crashes were structurally invisible — no error family existed, so a
 * founder hitting the crash was the only detector).
 *
 * Field discipline (closed sets, no PII):
 *   capture_source       error_boundary | window_onerror | unhandled_rejection
 *                        | desktop_bridge (a Raft Desktop bridge read failed)
 *                        | sign_in (a sign-in failed in the page, not at the API)
 *                        | mermaid_export (a Mermaid PNG export failed in the
 *                          browser, e.g. no 2D canvas; the user sees a plain error)
 *   error_name           Error.name low-cardinality; minified React errors
 *                        normalized to `react_error_NNN` (code only — the
 *                        raw message is never reported)
 *   component_stack_top  top component frame NAME only (never the full stack);
 *                        for desktop_bridge and sign_in, the fixed site name
 *   suppressed_count     occurrences swallowed by throttling since the last
 *                        reported event of the same signature
 *
 * error_boundary, window_onerror and unhandled_rejection:
 *   top_frame            first stack frame as `file:line:col`, the file the
 *                        asset name without its content hash and extension
 *                        (`app-shell:15:57771`); never a URL. A frame outside
 *                        the built assets (dev: /src/) is just `external`
 *   error_fingerprint    hash of error_name + the message with digits and
 *                        quoted text removed + top_frame: groups one crash
 *                        across users without sending the message
 *
 * error_boundary only (the crash page, RootErrorBoundary; sent urgently):
 *   client_trace_id      the trace id the crash page shows, verbatim, so a
 *                        user's screenshot finds the row
 *   webAssetId / tabId   standard pipeline fields (added by the trace layer)
 *
 * Throttling (the incident's own lesson — a render loop fires thousands of
 * errors per second; unthrottled reporting would DoS the pipeline): per
 * (error_name + component_stack_top) signature (the three fingerprinted
 * sources: per source + error_fingerprint), at most
 * MAX_REPORTS_PER_WINDOW reports per rolling window; excess only increments
 * suppressed_count, carried out on the next allowed report. window_onerror and
 * unhandled_rejection are also capped at MAX_SOURCE_REPORTS_PER_WINDOW per
 * source across all fingerprints; the signature table holds at most
 * MAX_SIGNATURE_BUCKETS. Quantification survives; the pipe does not melt.
 */

import { emitWebEvent, emitWebEventAndFlushBeforeUnload } from "./webAuthTrace";
import { isDynamicImportFailure } from "./dynamicImportRecovery";

type ClientErrorEmitter = (
  name: "slock.client_error",
  attrs: Record<string, unknown>,
  options: { traceId: string; urgent: boolean },
) => void;

// The crash page is one click from a reload, which drops a report still
// waiting in the shared batch: crash page reports go out on the urgent path.
const pipelineEmitter: ClientErrorEmitter = (name, attrs, { traceId, urgent }) => {
  if (urgent) void emitWebEventAndFlushBeforeUnload(name, attrs, { traceId });
  else emitWebEvent(name, attrs, { traceId });
};
let emitter: ClientErrorEmitter = pipelineEmitter;

/** Test seam: capture emitted records without coupling to the pipeline. */
export function __setClientErrorEmitterForTest(next: ClientErrorEmitter | null): void {
  emitter = next ?? pipelineEmitter;
}

export type ClientErrorCaptureSource =
  | "error_boundary"
  | "window_onerror"
  | "unhandled_rejection"
  | "desktop_bridge"
  | "sign_in"
  | "mermaid_export";

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
// window_onerror / unhandled_rejection, all fingerprints together: a loop whose
// message varies (new fingerprint each time) cannot get past this.
const MAX_SOURCE_REPORTS_PER_WINDOW = 20;
const MAX_SIGNATURE_BUCKETS = 200;

interface SignatureBucket {
  windowStartMs: number;
  reported: number;
  suppressed: number;
}

const bucketsBySignature = new Map<string, SignatureBucket>();
const sourceWindows = new Map<ClientErrorCaptureSource, { windowStartMs: number; reported: number }>();

export function __clientErrorThrottleSizeForTest(): number {
  return bucketsBySignature.size;
}

export function __resetClientErrorThrottleForTest(): void {
  bucketsBySignature.clear();
  sourceWindows.clear();
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

/** First component name from a React componentStack: "\n    at Name (…)"
 *  (Chromium) or "Name@…" (Firefox, Safari). */
export function topComponentFrame(componentStack: string | null | undefined): string {
  if (!componentStack) return "unknown";
  const match = /^\s*(?:at\s+([A-Za-z0-9_$.]+)|([A-Za-z0-9_$.]+)@)/m.exec(componentStack);
  const name = match?.[1] ?? match?.[2];
  return name ? name.slice(0, 64) : "unknown";
}

// "    at fn (https://h/assets/app-shell-Dx1AbC_9.js:15:57771)", "    at https://…:1:2"
// (Chromium) and "fn@https://h/assets/…js:15:57771" (Firefox, Safari).
const CHROMIUM_FRAME_RE = /^\s*at\s+(?:.*?\()?(\S+?):(\d+):(\d+)\)?\s*$/;
const AT_SIGN_FRAME_RE = /^[^@\s]*@(\S+?):(\d+):(\d+)\s*$/;
// Vite/Rolldown names built assets `/assets/[name]-[hash].js`, the hash 8
// base64url chars.
// Assumes Vite's default 8-char asset hash: change this if the build config's hash length changes.
const ASSET_HASH_RE = /-[A-Za-z0-9_-]{8}$/;

/** A built asset's name without its hash, a dev module's name (dev builds only),
 *  else "external": any other URL (the page's own, from an extension or a
 *  bookmarklet) may end in an id, so none of its path is kept. */
function frameFileName(location: string): string {
  const path = location.split(/[?#]/, 1)[0];
  const slash = path.lastIndexOf("/");
  const base = path.slice(slash + 1).replace(/\.[A-Za-z0-9]+$/, "");
  const built = path.slice(0, slash).endsWith("/assets") && ASSET_HASH_RE.test(base);
  const devModule = import.meta.env.DEV && path.includes("/src/");
  if (!built && !devModule) return "external";
  const name = built ? base.replace(ASSET_HASH_RE, "") : base;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : "unknown";
}

/**
 * The first frame of an error stack as `file:line:col`, the file the asset
 * name without its content hash (`app-shell:15:57771`). The message lines a
 * Chromium stack starts with are skipped, so message text never gets here.
 */
export function topStackFrame(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== "string") return "unknown";
  let stack = error.stack;
  const header = `${error.name}: ${error.message}`;
  if (stack.startsWith(header)) stack = stack.slice(header.length);
  for (const line of stack.split("\n")) {
    const match = CHROMIUM_FRAME_RE.exec(line) ?? AT_SIGN_FRAME_RE.exec(line);
    if (!match) continue;
    const file = frameFileName(match[1]);
    return file === "external" ? file : `${file}:${match[2]}:${match[3]}`;
  }
  return "unknown";
}

/** The message with digits and quoted text removed: ids, counts and values go,
 *  the shape of the error stays. Hashed only, never sent. */
export function normalizeErrorMessageForFingerprint(message: string): string {
  return message
    // A quote opens only after a non-letter and closes only before one, so
    // the apostrophes in "can't" and "user's" are not quotes.
    .replace(/(?<![\p{L}\p{N}])(["'`])(?:(?!\1).)*?\1(?![\p{L}\p{N}])/gu, "\"\"")
    .replace(/\d+/g, "");
}

/** FNV-1a 32-bit, as 8 hex chars. Grouping, not security. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function clientErrorFingerprint(errorName: string, error: unknown, topFrame: string): string {
  const message = error instanceof Error ? error.message ?? "" : typeof error === "string" ? error : "";
  return fnv1a(`${errorName}\n${normalizeErrorMessageForFingerprint(message)}\n${topFrame}`);
}

// Bounded table: a new signature first evicts expired buckets, then the oldest
// (their unreported suppressed counts are lost; the total stays a lower bound).
function setBucket(signature: string, bucket: SignatureBucket, nowMs: number): void {
  bucketsBySignature.delete(signature);
  if (bucketsBySignature.size >= MAX_SIGNATURE_BUCKETS) {
    for (const [key, old] of bucketsBySignature) {
      if (nowMs - old.windowStartMs >= THROTTLE_WINDOW_MS) bucketsBySignature.delete(key);
    }
    if (bucketsBySignature.size >= MAX_SIGNATURE_BUCKETS) {
      bucketsBySignature.delete(bucketsBySignature.keys().next().value!);
    }
  }
  bucketsBySignature.set(signature, bucket);
}

/** The per-source window of the capped sources (rolled over when expired); null for the others. */
function sourceWindow(source: ClientErrorCaptureSource, nowMs: number) {
  if (source !== "window_onerror" && source !== "unhandled_rejection") return null;
  let win = sourceWindows.get(source);
  if (!win || nowMs - win.windowStartMs >= THROTTLE_WINDOW_MS) {
    win = { windowStartMs: nowMs, reported: 0 };
    sourceWindows.set(source, win);
  }
  return win;
}

/** Over the source cap: count it on its own signature, carried by that signature's next report. */
function suppressOverSourceCap(signature: string, nowMs: number): void {
  const bucket = bucketsBySignature.get(signature);
  if (bucket && nowMs - bucket.windowStartMs < THROTTLE_WINDOW_MS) bucket.suppressed += 1;
  else setBucket(signature, { windowStartMs: nowMs, reported: 0, suppressed: (bucket?.suppressed ?? 0) + 1 }, nowMs);
}

function throttleDecision(signature: string, nowMs: number): { report: boolean; suppressedToCarry: number } {
  const bucket = bucketsBySignature.get(signature);
  if (!bucket || nowMs - bucket.windowStartMs >= THROTTLE_WINDOW_MS) {
    const carried = bucket?.suppressed ?? 0;
    setBucket(signature, { windowStartMs: nowMs, reported: 1, suppressed: 0 }, nowMs);
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
  /** desktop_bridge / sign_in / mermaid_export: where it failed, a fixed name ("localComputer.getStatus", "login.second_factor_challenge", "mermaid.png_canvas_unavailable"). */
  site?: string;
}

/**
 * Report a client error. Returns the trace id the report was sent under, so a
 * crash screen can show it for the user to send us (#proj-o11y:#18); null when
 * the report was throttled or failed, so no id is shown that leads nowhere.
 */
export function reportClientError(
  input: ClientErrorReport,
  nowMs: number = Date.now(),
): string | null {
  try {
    const errorName = normalizeClientErrorName(input.error);
    const errorClass = classifyClientError(input.error, input.source);
    const stackTop = input.source === "error_boundary"
      ? topComponentFrame(input.componentStack)
      : (input.source === "desktop_bridge" || input.source === "sign_in" || input.source === "mermaid_export") && input.site
        ? input.site.slice(0, 64)
        : "global";
    const boundary = input.source === "error_boundary";
    const fingerprinted = boundary || input.source === "window_onerror" || input.source === "unhandled_rejection";
    const topFrame = fingerprinted ? topStackFrame(input.error) : null;
    const errorFingerprint = topFrame === null ? null : clientErrorFingerprint(errorName, input.error, topFrame);
    const signature = errorFingerprint === null
      ? `${errorClass}|${errorName}|${stackTop}`
      : `${input.source}|${errorFingerprint}`;
    const sourceWin = sourceWindow(input.source, nowMs);
    if (sourceWin && sourceWin.reported >= MAX_SOURCE_REPORTS_PER_WINDOW) {
      suppressOverSourceCap(signature, nowMs);
      return null;
    }
    const { report, suppressedToCarry } = throttleDecision(signature, nowMs);
    if (!report) return null;
    if (sourceWin) sourceWin.reported += 1;
    const traceId = newTraceId();
    emitter("slock.client_error", {
      captureSource: input.source,
      errorClass,
      errorName,
      componentStackTop: stackTop,
      suppressedCount: suppressedToCarry,
      ...(fingerprinted ? { errorFingerprint, topFrame } : {}),
      ...(boundary ? { clientTraceId: traceId } : {}),
    }, { traceId, urgent: boundary });
    return traceId;
  } catch {
    // The error reporter must never become an error source itself.
    return null;
  }
}

function newTraceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
