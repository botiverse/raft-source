import api from "./client";
import { markRwFresh, markRwStale, markRwUnavailable } from "../store/rwFreshness";
import type { RwSurface, RwUnavailableCode } from "../store/rwFreshness";

// Inbox and unread reads come from RisingWave. When its pool is saturated the
// server answers 503 `rw_overloaded` with `Retry-After` (2 s); these waves last
// a minute or two. Callers already keep the data they have on failure, but a
// first load (page open, server switch, new filter) has nothing to keep, so
// retry once after the server's hint instead of showing an empty result until
// the next refresh. One retry only: more would add load while RW is behind.

const DEFAULT_RETRY_AFTER_MS = 2_000;
const MAX_RETRY_AFTER_MS = 10_000;

type ResponseLike = { status?: number; data?: unknown; headers?: unknown };

/** A response header, from axios' AxiosHeaders or a plain (test) object; names are lower case. */
function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const getter = (headers as { get?: unknown }).get;
  const value = typeof getter === "function"
    ? (getter as (key: string) => unknown).call(headers, name)
    : (headers as Record<string, unknown>)[name];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

/** `Retry-After` in ms (delta-seconds or an HTTP date), uncapped; null when missing or invalid. */
export function parseRetryAfterMs(headers: unknown, nowMs = Date.now()): number | null {
  const raw = readHeader(headers, "retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1_000 : null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/** The `X-Raft-Stale` reason (`rw_overloaded`, `rw_slow`) of an answer, else null. Readable since CORS exposes it (server app.ts). */
export function rwStaleReason(response: { headers?: unknown } | undefined): string | null {
  return readHeader(response?.headers, "x-raft-stale");
}

function isRwOverload(response: ResponseLike | undefined): boolean {
  if (response?.status !== 503) return false;
  const data = response.data as { code?: unknown; retryable?: unknown } | undefined;
  return data?.code === "rw_overloaded" && data.retryable === true;
}

/** The Retry-After delay (ms) if `error` is a retryable RisingWave overload, else null. */
export function rwOverloadRetryDelayMs(error: unknown): number | null {
  const response = (error as { response?: ResponseLike })?.response;
  if (!isRwOverload(response)) return null;
  const delayMs = parseRetryAfterMs(response?.headers);
  if (delayMs === null) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(delayMs, MAX_RETRY_AFTER_MS);
}

const RW_UNAVAILABLE_CODES: ReadonlySet<string> = new Set<RwUnavailableCode>(["rw_overloaded", "rw_unconfigured", "rw_read_failed"]);

/** The typed RisingWave code (`rw_unconfigured`, ...) of a failed answer's body, else null. */
function rwUnavailableCode(response: ResponseLike | undefined): RwUnavailableCode | null {
  const code = (response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && RW_UNAVAILABLE_CODES.has(code) ? code as RwUnavailableCode : null;
}

/** A failure that says the read is unavailable for now: a 5xx or no answer at all; not a 4xx, not an abort. */
function isUnavailableFailure(error: unknown): boolean {
  const candidate = error as { response?: ResponseLike; code?: unknown; name?: unknown } | null;
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.code === "ERR_CANCELED" || candidate.name === "CanceledError" || candidate.name === "AbortError") return false;
  const status = candidate.response?.status;
  if (typeof status === "number") return status >= 500;
  return candidate.code === "ERR_NETWORK" || candidate.code === "ECONNABORTED" || candidate.code === "ETIMEDOUT";
}

const wait = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** `api.get` that retries once after `Retry-After` on a RisingWave overload 503. */
export const getWithRwOverloadRetry = (async (url: string, config?: Parameters<typeof api.get>[1]) => {
  try {
    return await api.get(url, config);
  } catch (error) {
    const delayMs = rwOverloadRetryDelayMs(error);
    if (delayMs === null) throw error;
    await wait(delayMs, config?.signal as AbortSignal | undefined);
    return api.get(url, config);
  }
}) as typeof api.get;

/**
 * `getWithRwOverloadRetry` that also records whether `surface` is current
 * (store/rwFreshness.ts, task #164): a clean 200 is fresh; a 200 marked
 * `X-Raft-Stale` is stale; a 503 that survived the retry, a 5xx or no answer
 * is unavailable (with the body's RisingWave code, so `rw_unconfigured` can
 * say "temporarily unavailable"). The caller still gets the answer or the error, and keeps
 * what it shows on an error as before. `Retry-After` paces the recovery
 * (store/rwRecovery.ts).
 */
export async function getRwRead<T = unknown>(
  surface: RwSurface,
  url: string,
  config?: Parameters<typeof api.get>[1],
): Promise<{ data: T; stale: boolean }> {
  try {
    const response = await getWithRwOverloadRetry(url, config);
    // The API client resolves with nothing once a refused refresh signs the
    // session out (api/client.ts): that is the session ending, not an answer.
    if (!response) throw new Error(`No response for ${url}: the session ended`);
    if (rwStaleReason(response)) {
      markRwStale(surface, parseRetryAfterMs(response.headers));
      return { data: response.data as T, stale: true };
    }
    markRwFresh(surface);
    return { data: response.data as T, stale: false };
  } catch (error) {
    if (isUnavailableFailure(error)) {
      const response = (error as { response?: ResponseLike }).response;
      markRwUnavailable(surface, parseRetryAfterMs(response?.headers), rwUnavailableCode(response));
    }
    throw error;
  }
}
