// The publish check Worker's API (task #proj-workspace:#130;
// docs/development/workspace-artifacts.md, "The check Worker's API"): what
// the check Worker (a Cloudflare Worker of its own, `raft-artifact-check`,
// packages/check-worker) and Raft's server say to each other. The Worker pulls: each lease is
// one pending check (the Worker leases many, one call each, and runs them at once), it opens
// the lease's `url` top-level in a headless browser at each of `viewports`, and posts what it
// saw back, while the lease holds.
//
// Both routes take `Authorization: Bearer <ARTIFACTS_CHECK_WORKER_TOKEN>`
// (the server's setting; at least 32 bytes, its own: never a content Worker
// token). Without it configured both answer 503 and nothing is leased.
// Additive only: a field is added, never renamed or removed.
import type { ArtifactCheckShot } from "./webArtifactsContract";

/** Where the check Worker calls Raft, under its RAFT_API_ORIGIN. */
export const artifactCheckWorkerPaths = {
  /** POST, no body → 200 ArtifactCheckLease, or 204 with no pending check. */
  lease: "/internal/artifacts-check/lease",
  /** POST multipart/form-data (ArtifactCheckReportForm) → 200 ArtifactCheckResultAnswer, or 409 for a lease no longer current. */
  result: (checkId: string) => `/internal/artifacts-check/${encodeURIComponent(checkId)}/result`,
} as const;

/** One screenshot the check takes: the viewport's CSS size, its device pixel ratio, and whether it is a phone's (touch, mobile UA). A viewport screenshot, never the full page. */
export interface ArtifactCheckViewport {
  shot: ArtifactCheckShot;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

/** The check's two screenshots (ARTIFACT_CHECK_SHOTS): desktop width, then phone width. */
export const ARTIFACT_CHECK_VIEWPORTS: readonly ArtifactCheckViewport[] = [
  { shot: "desktop", width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  { shot: "phone", width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
];

/**
 * A leased check (200 from `lease`). `url` is the version's content ticket
 * (`<origin>/_raft/open?ticket=…`, good once, within 60 s): open it top-level,
 * once, and never log it. `lease` is the lease's fencing token: send it back
 * with the result; a result for any other lease is refused (409).
 * `leaseExpiresAt` (ISO 8601): the result must arrive before it, and the
 * page reads the version only until then.
 */
export interface ArtifactCheckLease {
  checkId: string;
  artifactId: string;
  versionId: string;
  url: string;
  viewports: ArtifactCheckViewport[];
  lease: string;
  leaseExpiresAt: string;
}

/** How the page loaded: `ok`, or it didn't within the check's time (`timeout`), or the browser failed (`error`, with a code-shaped class: `^[a-z][a-z0-9_.-]{0,47}$`, as the server keeps it, checkTask.ts ERROR_CLASS; any other is recorded as `other`). */
export type ArtifactCheckLoad = { outcome: "ok" } | { outcome: "timeout" } | { outcome: "error"; errorClass: string };

/** At most this many console errors are kept, each message and source cut to ARTIFACT_CHECK_TEXT_MAX_CHARS. */
export const ARTIFACT_CHECK_MAX_CONSOLE_ERRORS = 10;
/** At most this many blocked resources are kept, each URL cut to ARTIFACT_CHECK_TEXT_MAX_CHARS. */
export const ARTIFACT_CHECK_MAX_BLOCKED_RESOURCES = 20;
/** A console error's message or source, or a blocked URL, is cut to this many characters. */
export const ARTIFACT_CHECK_TEXT_MAX_CHARS = 300;
/** Each screenshot is a PNG of at most this many bytes (413 past it). */
export const ARTIFACT_CHECK_SHOT_MAX_BYTES = 5 * 1024 * 1024;
/** The `report` field is JSON of at most this many bytes (413 past it). */
export const ARTIFACT_CHECK_REPORT_MAX_BYTES = 64 * 1024;

/**
 * What the check saw, the `report` field of the result's form (JSON).
 * `checkId` and `lease` are the lease's. Lists past their caps are cut (the
 * first ones kept), not refused. `blank` and `phoneOverflow` are optional
 * (false and null when left out).
 */
export interface ArtifactCheckReport {
  checkId: string;
  lease: string;
  load: ArtifactCheckLoad;
  consoleErrors: Array<{ message: string; source: string | null; line: number | null }>;
  blockedResources: string[];
  blank?: boolean;
  phoneOverflow?: { contentWidth: number; viewportWidth: number } | null;
  /** Where the check's time went (ArtifactCheckTiming); left out by a Worker older than it. */
  timing?: ArtifactCheckTiming;
}

/**
 * Where one check's time went, whole milliseconds, for the check's own latency (the result's
 * span carries them; trace.ts): never a finding, and nothing of the page is in them. In order:
 * - `browserMs`: getting a browser (a warm session taken, or one launched);
 * - `prepareMs`: its context and page, the request guard, the first viewport;
 * - `loadMs`: the navigation, to the document's `load` (or to its timeout or error);
 * - `settleMs`: from `load` to the first shot: the idle network, the shell's word, the pause;
 * - `shotsMs`: every viewport's shot, with the waits a change of viewport brings.
 * What is left of the result span's `run_ms` is the browser's release and the result's upload.
 * A stage a check never reached is 0.
 */
export interface ArtifactCheckTiming {
  browserMs: number;
  prepareMs: number;
  loadMs: number;
  settleMs: number;
  shotsMs: number;
}

/** The names of ArtifactCheckTiming's stages, in order. */
export const ARTIFACT_CHECK_TIMING_STAGES = ["browserMs", "prepareMs", "loadMs", "settleMs", "shotsMs"] as const satisfies ReadonlyArray<keyof ArtifactCheckTiming>;

/** The most any one stage is taken to have lasted: more than this is no timing (a clock gone wrong), and the report's is left out. */
export const ARTIFACT_CHECK_TIMING_MAX_MS = 10 * 60_000;

/**
 * The result's form: the field `report` (ArtifactCheckReport as JSON) and,
 * for a load that was `ok`, one PNG file part per viewport named by its
 * `shot` (`desktop`, `phone`). A part may be left out (that screenshot
 * failed); nothing else is taken.
 */
export type ArtifactCheckReportForm = { report: string } & Partial<Record<ArtifactCheckShot, Blob>>;

/** 200 from `result`: how the check ended (`done` for a page that loaded, else `failed`). */
export interface ArtifactCheckResultAnswer {
  status: "done" | "failed";
}
