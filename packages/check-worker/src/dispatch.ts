// How the cron run hands a lease to an invocation of its own (runner.ts; task #proj-workspace:#185):
// a request to the Worker itself through its loopback, `ctx.exports.default` (a service binding to
// its own default export that the runtime provides at this compatibility date, with no binding in
// wrangler.jsonc), `POST /run` with the lease as JSON. Each such request is a separate invocation
// with its own limits, among them its six simultaneous connections: one browser session and its
// result call. The request carries the Worker's own token (`Authorization: Bearer
// <ARTIFACTS_CHECK_WORKER_TOKEN>`) and handler.ts refuses `/run` without it: deployed, the Worker
// has no host (`workers_dev: false`, no routes), so only the loopback reaches it, and the token
// keeps it closed should another Worker of the account ever bind it.
//
// The body carries the ticket URL: never logged here or in the handler (log lines carry ids and
// codes only). The answer is `{ outcome }` (runner.ts CheckOutcome), nothing else.
import type { ArtifactCheckLease } from "@botiverse/raft-shared/src/artifactCheckContract";

import { CHECK_OUTCOMES, type CheckOutcome, type DispatchAnswer } from "./runner";

export const RUN_PATH = "/run";
/** Any URL reaches the loopback; its host names nothing. */
const RUN_URL = `https://raft-artifact-check.internal${RUN_PATH}`;
/** A check answers well within its lease (2 minutes); past this its result would be refused anyway. */
export const DISPATCH_TIMEOUT_MS = 150_000;

/** The Worker's loopback to its own default export, when the runtime provides it (`ctx.exports.default`); else null. */
export function loopbackOf(ctx: ExecutionContext): Fetcher | null {
  const exports = (ctx as { exports?: Record<string, unknown> }).exports;
  const self = exports?.default as Fetcher | undefined;
  return self !== undefined && self !== null && typeof self.fetch === "function" ? self : null;
}

/** `dispatch` for runner.ts: each lease posted to `self`'s `/run` with `token`; never throws. */
export function dispatchThrough(self: Pick<Fetcher, "fetch">, token: string, timeoutMs = DISPATCH_TIMEOUT_MS): (lease: ArtifactCheckLease) => Promise<DispatchAnswer> {
  return async (lease) => {
    let response: Response;
    try {
      response = await self.fetch(RUN_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(lease),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: "failed", status: 0 };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const outcome = typeof body === "object" && body !== null ? (body as { outcome?: unknown }).outcome : undefined;
    if (response.status !== 200 || !isOutcome(outcome)) return { kind: "failed", status: response.status };
    return { kind: "ran", outcome };
  };
}

const isOutcome = (value: unknown): value is CheckOutcome => typeof value === "string" && (CHECK_OUTCOMES as readonly string[]).includes(value);

/** Whether `authorization` is `Bearer <token>`, compared in constant time (sha256 digests of each). */
export async function bearerMatches(authorization: string | null, token: string): Promise<boolean> {
  if (authorization === null || token === "") return false;
  const encoder = new TextEncoder();
  const [given, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(authorization)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${token}`)),
  ]);
  const a = new Uint8Array(given);
  const b = new Uint8Array(expected);
  let differs = 0;
  for (let at = 0; at < a.length; at += 1) differs |= a[at]! ^ b[at]!;
  return differs === 0;
}
