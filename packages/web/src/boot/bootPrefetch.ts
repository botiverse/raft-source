/**
 * The API client's side of the boot prefetch (bootInlineScript.ts
 * BOOT_PREFETCH_STATEMENT, docs/frontend/boot-requests.md "From the HTML"):
 * a request the app is about to send takes the answer of the one the boot
 * script already sent, when it is the same request (URL and every header but
 * the trace's). Each answer is taken once, and only within a few seconds of
 * landing; a failed one (an error status, a 401, no network) is never taken,
 * so the app sends its own and its usual handling (refresh, sign-out) runs.
 */

/** Where the boot script leaves its requests (window.__raftBootFetches). Here, not in bootInlineScript.ts, so the app's bundle doesn't carry the script's text. */
export const BOOT_FETCHES_GLOBAL = "__raftBootFetches";

/** One request the boot script sent: its URL, headers, when it went out (ms), the fetch, and when that settled. */
export interface BootFetch {
  readonly u: string;
  readonly h: Readonly<Record<string, string>>;
  readonly t: number;
  readonly p: Promise<Response>;
  d?: number;
}

export interface BootFetchAnswer {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: string;
}

/** How long a landed answer may still be taken: it is then as old as one the app's own request could bring. */
export const BOOT_FETCH_TAKE_WITHIN_MS = 10_000;

/** Reads the server answers alike whichever server is current: X-Server-Id is not part of their match. */
const SERVER_AGNOSTIC_PATH = /\/api\/(?:auth\/me|servers)$/;
const HISTORY_READ_PATH = /\/api\/messages\/channel\/[^/?]+\?/;

let sentHistoryRead = false;

function isBootFetch(value: unknown): value is BootFetch {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<BootFetch>;
  return typeof entry.u === "string" && typeof entry.t === "number" && !!entry.h && typeof entry.h === "object"
    && !!entry.p && typeof entry.p.then === "function";
}

/** The boot script's list, still to be taken; entries that can't be taken any more leave it. */
function pending(now: number): BootFetch[] {
  const list = (globalThis as Record<string, unknown>)[BOOT_FETCHES_GLOBAL];
  if (!Array.isArray(list)) return [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry: unknown = list[index];
    if (!isBootFetch(entry)) list.splice(index, 1);
    else {
      if (HISTORY_READ_PATH.test(entry.u)) sentHistoryRead = true;
      if (entry.d !== undefined && now - entry.d > BOOT_FETCH_TAKE_WITHIN_MS) list.splice(index, 1);
    }
  }
  return list as BootFetch[];
}

/** The headers as sent, by lower-case name, without the trace's (and the server's for a server-agnostic read). */
function comparableHeaders(headers: Readonly<Record<string, unknown>>, url: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    // Axios sends no header whose value is empty, null, undefined or false.
    if (value === undefined || value === null || value === false || value === "") continue;
    const key = name.toLowerCase();
    if (key === "traceparent" || (key === "x-server-id" && SERVER_AGNOSTIC_PATH.test(url))) continue;
    result.set(key, String(value));
  }
  return result;
}

function sameHeaders(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, value] of a) if (b.get(name) !== value) return false;
  return true;
}

/**
 * The boot script's request for this GET (absolute URL, the headers the API
 * client is about to send), taken out of the list so nothing takes it again;
 * null when there is none.
 */
export function takeBootFetch(url: string, headers: Readonly<Record<string, unknown>>, now = Date.now()): BootFetch | null {
  const list = pending(now);
  if (list.length === 0) return null;
  const wanted = comparableHeaders(headers, url);
  const index = list.findIndex((entry) => entry.u === url && sameHeaders(comparableHeaders(entry.h, url), wanted));
  if (index < 0) return null;
  const [entry] = list.splice(index, 1);
  return entry;
}

/** Its answer when it succeeded (2xx), as the browser gave it to the page; null for anything else. */
export async function readBootFetch(entry: BootFetch): Promise<BootFetchAnswer | null> {
  try {
    const response = await entry.p;
    if (!response.ok) return null;
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    return { status: response.status, statusText: response.statusText, headers, data: await response.text() };
  } catch {
    return null;
  }
}

/**
 * Whether the boot script read a page of message history. Its read then went
 * out before the socket's starting sync horizon could be asked for, so that
 * horizon is not safe (socketBridge); the page's own horizon still is.
 */
export function bootSentHistoryRead(): boolean {
  pending(Date.now());
  return sentHistoryRead;
}

export function __resetBootFetchesForTest(): void {
  delete (globalThis as Record<string, unknown>)[BOOT_FETCHES_GLOBAL];
  sentHistoryRead = false;
}
