/**
 * The only way Raft talks to a Server's identity provider (OIDC discovery,
 * JWKS, the token endpoint; rfcs/083-server-sso.md §7). The URLs come from an
 * owner's configuration and the IdP's own discovery document, so every
 * request is treated as untrusted: https only, the host resolved once and
 * pinned, every resolved address public, no redirects, no ambient
 * credentials, a small body, a 5 s budget for DNS and an idle timeout for the
 * exchange (openid-client's own abort signal bounds the whole request). Shaped as `fetch` so
 * openid-client can use it (its `customFetch`).
 */
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isPublicWebhookAddress } from "../appWebhookConfigService";
import { createAppWebhookPinnedLookup } from "../appNotificationDeliveryService";

const BUDGET_MS = 5_000;
const MAX_BODY_BYTES = 256 * 1024;

export class SsoIdpUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsoIdpUnreachableError";
  }
}

/** A developer's local IdP (Keycloak on localhost) may use http and a private address, never in production. */
function allowsLocalIdp(env: NodeJS.ProcessEnv): boolean {
  return env.RAFT_SSO_ALLOW_HTTP_IDP === "1" && env.NODE_ENV !== "production";
}

type FetchInit = { method?: string; headers?: HeadersInit; body?: unknown; signal?: AbortSignal | null };

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    // Nothing ambient: no cookies; the caller's own authorization (client
    // credentials to the token endpoint) is the only credential sent.
    if (key !== "cookie") out[key] = value;
  });
  return out;
}

function bodyBytes(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new SsoIdpUnreachableError("Unsupported request body for the identity provider");
}

let fetchOverride: ((input: string | URL | Request, init?: FetchInit) => Promise<Response>) | null = null;

/** Tests stand in for the identity provider; null restores the network. */
export function setSsoIdpFetchForTests(fetchImpl: typeof fetchOverride): void {
  fetchOverride = fetchImpl;
}

export async function ssoIdpFetch(input: string | URL | Request, init: FetchInit = {}, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  if (fetchOverride) return fetchOverride(input, init);
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const local = allowsLocalIdp(env);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new SsoIdpUnreachableError("The identity provider must use https");
  if (url.username || url.password) throw new SsoIdpUnreachableError("The identity provider URL must not contain credentials");

  const deadline = Date.now() + BUDGET_MS;
  let addresses: LookupAddress[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), BUDGET_MS); }),
    ]).finally(() => clearTimeout(timer));
  } catch {
    throw new SsoIdpUnreachableError("The identity provider's host could not be resolved");
  }
  if (!addresses.length || (!local && addresses.some((entry) => !isPublicWebhookAddress(entry.address)))) {
    throw new SsoIdpUnreachableError("The identity provider's host is not a public address");
  }

  const body = bodyBytes(init.body);
  const headers = headerRecord(init.headers);
  if (body) headers["content-length"] = String(body.byteLength);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, rejectOnce) => {
    let settled = false;
    const remaining = Math.max(1, deadline - Date.now());
    const onAbort = () => req.destroy(new SsoIdpUnreachableError("Request aborted"));
    const done = () => {
      settled = true;
      clearTimeout(totalTimer);
      init.signal?.removeEventListener("abort", onAbort);
    };
    const reject = (err: unknown) => {
      if (settled) return;
      done();
      rejectOnce(err);
    };
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: init.method ?? "GET",
      headers,
      lookup: createAppWebhookPinnedLookup(addresses[0]!) as never,
      timeout: remaining,
      ...(url.protocol === "https:" ? { servername: url.hostname, rejectUnauthorized: true } : {}),
    }, (res) => {
      const status = res.statusCode ?? 0;
      // An untrusted peer: a status a Response cannot carry (outside 200-599, or 205 with a body) is refused
      // here, inside the promise, never thrown from an event listener (that would crash the process).
      if (status < 200 || status > 599 || status === 205) {
        res.resume();
        reject(new SsoIdpUnreachableError(`The identity provider answered with status ${status}`));
        return;
      }
      // No redirects: a 3xx is handed back as is, and openid-client treats it as a failure.
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.destroy();
          reject(new SsoIdpUnreachableError("The identity provider's answer is too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", () => reject(new SsoIdpUnreachableError("The identity provider's answer was interrupted")));
      // Closed before the body ended: the answer is incomplete.
      res.on("close", () => {
        if (!res.complete) reject(new SsoIdpUnreachableError("The identity provider's answer was interrupted"));
      });
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item);
        }
        const buffer = Buffer.concat(chunks);
        if (settled) return;
        try {
          const response = new Response(status === 204 || status === 304 ? null : buffer, { status, headers: responseHeaders });
          done();
          resolve(response);
        } catch {
          reject(new SsoIdpUnreachableError("The identity provider's answer could not be read"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new SsoIdpUnreachableError("The identity provider did not answer in time")));
    // A total deadline for the whole exchange (the socket timeout above is per idle period).
    const totalTimer = setTimeout(() => req.destroy(new SsoIdpUnreachableError("The identity provider did not answer in time")), remaining);
    req.on("error", (err) => reject(err instanceof SsoIdpUnreachableError ? err : new SsoIdpUnreachableError("The identity provider could not be reached")));
    if (init.signal?.aborted) onAbort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    if (body) req.write(body);
    req.end();
  });
}
