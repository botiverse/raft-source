// The check Worker's two calls to Raft (shared artifactCheckContract.ts;
// docs/development/workspace-artifacts.md, "The check Worker's API"), each with
// `Authorization: Bearer <ARTIFACTS_CHECK_WORKER_TOKEN>`:
//
// - POST <RAFT_API_ORIGIN>/internal/artifacts-check/lease → 200 a lease, 204 none;
// - POST <RAFT_API_ORIGIN>/internal/artifacts-check/:checkId/result, multipart: the report
//   (JSON) and a PNG per shot → 200 { status }, 409 for a lease no longer current.
//
// Answers are typed outcomes, never thrown; nothing here logs (runner.ts logs ids and
// statuses), and the lease's url is handed on, never written anywhere.
import {
  ARTIFACT_CHECK_SHOT_MAX_BYTES,
  ARTIFACT_CHECK_VIEWPORTS,
  artifactCheckWorkerPaths,
  type ArtifactCheckLease,
  type ArtifactCheckReport,
  type ArtifactCheckViewport,
} from "@botiverse/raft-shared/src/artifactCheckContract";

import { isPng } from "./png";

export type CheckShot = ArtifactCheckViewport["shot"];
/** The shots the result takes, in the contract's order (its ARTIFACT_CHECK_SHOTS). */
export const CHECK_SHOTS: readonly CheckShot[] = ARTIFACT_CHECK_VIEWPORTS.map((viewport) => viewport.shot);

export interface RaftApi {
  /** RAFT_API_ORIGIN: an origin, no path. */
  origin: string;
  /** ARTIFACTS_CHECK_WORKER_TOKEN. */
  token: string;
  fetch: typeof fetch;
}

const LEASE_TIMEOUT_MS = 15_000;
const RESULT_TIMEOUT_MS = 30_000;

export type LeaseAnswer =
  | { kind: "leased"; lease: ArtifactCheckLease }
  /** 204: nothing to run. */
  | { kind: "none" }
  /** 401 or 403: the token is wrong (a rotation in progress, or not set on the server). */
  | { kind: "refused"; status: number }
  /** Raft can't lease now (5xx, 429, a network error or timeout: status 0). */
  | { kind: "unavailable"; status: number }
  /** Any other answer, or a 200 that isn't a lease. */
  | { kind: "invalid"; status: number };

export type ResultAnswer =
  | { kind: "recorded"; status: "done" | "failed" }
  /** 409: the lease is no longer current (late, repeated, another's); nothing was written. */
  | { kind: "conflict" }
  /** 401 or 403. */
  | { kind: "refused"; status: number }
  /** 5xx, 429, a network error or timeout (status 0): worth another try within the lease. */
  | { kind: "unavailable"; status: number }
  /** 400, 404, 413 or anything else: the same result would be refused again. */
  | { kind: "rejected"; status: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const isDimension = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;

function parseViewport(value: unknown): ArtifactCheckViewport | null {
  if (!isRecord(value)) return null;
  const { shot, width, height, deviceScaleFactor, mobile } = value;
  if (typeof shot !== "string" || !(CHECK_SHOTS as readonly string[]).includes(shot)) return null;
  if (!isDimension(width, 4096) || !isDimension(height, 4096)) return null;
  if (typeof deviceScaleFactor !== "number" || !(deviceScaleFactor > 0 && deviceScaleFactor <= 4) || typeof mobile !== "boolean") return null;
  return { shot: shot as CheckShot, width, height, deviceScaleFactor, mobile };
}

/**
 * A 200's body as a lease, or null. `url` must be an https URL (the content
 * origin's ticket address); `lease` an ISO time as the server writes it (it
 * is sent back verbatim). `viewports` are the lease's when every one is one
 * the result takes (each shot once), else the contract's.
 */
export function parseLease(value: unknown): ArtifactCheckLease | null {
  if (!isRecord(value)) return null;
  const { checkId, artifactId, versionId, url, lease, leaseExpiresAt, viewports } = value;
  if (!isText(checkId) || !isText(artifactId) || !isText(versionId) || !isText(url) || !isText(lease) || !isText(leaseExpiresAt)) return null;
  if (!URL.canParse(url) || new URL(url).protocol !== "https:") return null;
  if (Number.isNaN(Date.parse(leaseExpiresAt)) || Number.isNaN(Date.parse(lease))) return null;
  const parsed = Array.isArray(viewports) ? viewports.map(parseViewport) : [];
  const shots = parsed.map((viewport) => viewport?.shot);
  const usable = parsed.length > 0 && parsed.every((viewport) => viewport !== null) && new Set(shots).size === shots.length;
  return {
    checkId,
    artifactId,
    versionId,
    url,
    lease,
    leaseExpiresAt,
    viewports: usable ? (parsed as ArtifactCheckViewport[]) : ARTIFACT_CHECK_VIEWPORTS.map((viewport) => ({ ...viewport })),
  };
}

const headersOf = (api: RaftApi) => ({ authorization: `Bearer ${api.token}` });
const transient = (status: number) => status === 0 || status === 429 || status >= 500;

/** POST …/lease. */
export async function requestLease(api: RaftApi): Promise<LeaseAnswer> {
  let response: Response;
  try {
    response = await api.fetch(`${api.origin}${artifactCheckWorkerPaths.lease}`, {
      method: "POST",
      headers: headersOf(api),
      signal: AbortSignal.timeout(LEASE_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable", status: 0 };
  }
  const { status } = response;
  if (status === 204) return { kind: "none" };
  if (status === 200) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const lease = parseLease(body);
    return lease === null ? { kind: "invalid", status } : { kind: "leased", lease };
  }
  await response.body?.cancel();
  if (status === 401 || status === 403) return { kind: "refused", status };
  return transient(status) ? { kind: "unavailable", status } : { kind: "invalid", status };
}

/**
 * The result's form (ArtifactCheckReportForm): `report` as JSON and, for a
 * load that was `ok`, one PNG part per shot taken; a shot that isn't a PNG or
 * is past ARTIFACT_CHECK_SHOT_MAX_BYTES is left out (the server would refuse
 * the whole result for it).
 */
export function resultForm(report: ArtifactCheckReport, shots: Partial<Record<CheckShot, Uint8Array>>): FormData {
  const form = new FormData();
  form.append("report", JSON.stringify(report));
  if (report.load.outcome !== "ok") return form;
  for (const shot of CHECK_SHOTS) {
    const bytes = shots[shot];
    if (bytes === undefined || !isPng(bytes) || bytes.length > ARTIFACT_CHECK_SHOT_MAX_BYTES) continue;
    form.append(shot, new Blob([new Uint8Array(bytes)], { type: "image/png" }), `${shot}.png`);
  }
  return form;
}

/** POST …/:checkId/result once. */
export async function postResult(api: RaftApi, report: ArtifactCheckReport, shots: Partial<Record<CheckShot, Uint8Array>>): Promise<ResultAnswer> {
  let response: Response;
  try {
    response = await api.fetch(`${api.origin}${artifactCheckWorkerPaths.result(report.checkId)}`, {
      method: "POST",
      headers: headersOf(api),
      body: resultForm(report, shots),
      signal: AbortSignal.timeout(RESULT_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable", status: 0 };
  }
  const { status } = response;
  if (status === 200) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const recorded = isRecord(body) ? body.status : null;
    return recorded === "done" || recorded === "failed" ? { kind: "recorded", status: recorded } : { kind: "rejected", status };
  }
  await response.body?.cancel();
  if (status === 409) return { kind: "conflict" };
  if (status === 401 || status === 403) return { kind: "refused", status };
  return transient(status) ? { kind: "unavailable", status } : { kind: "rejected", status };
}

/** Waits between tries of a result that met an `unavailable` answer. */
export const RESULT_RETRY_DELAYS_MS = [2_000, 5_000] as const;
/** A try is only started this long before the lease runs out. */
const RESULT_LEASE_MARGIN_MS = 5_000;

/** postResult, tried again after a transient answer while the lease still holds. */
export async function postResultWithRetry(
  api: RaftApi,
  lease: Pick<ArtifactCheckLease, "leaseExpiresAt">,
  report: ArtifactCheckReport,
  shots: Partial<Record<CheckShot, Uint8Array>>,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<ResultAnswer> {
  const expiresAt = Date.parse(lease.leaseExpiresAt);
  let answer = await postResult(api, report, shots);
  for (const delay of RESULT_RETRY_DELAYS_MS) {
    if (answer.kind !== "unavailable") return answer;
    if (clock.now() + delay + RESULT_LEASE_MARGIN_MS >= expiresAt) return answer;
    await clock.sleep(delay);
    answer = await postResult(api, report, shots);
  }
  return answer;
}
