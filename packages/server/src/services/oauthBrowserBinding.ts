import { createHash, timingSafeEqual } from "node:crypto";
import { getServerUrl, parseCookieHeader } from "./socialAuthService";

// An OAuth sign-in Raft starts for someone completes only in the browser that
// started it. The start request (authenticated, made with credentials) sets an
// HttpOnly cookie holding the attempt's state, named after the state's hash so
// concurrent sign-ins do not overwrite each other, scoped to the callback path
// and living as long as the attempt. The provider's redirect back is a
// top-level GET, so the Lax cookie returns with it. Someone who opens another
// person's authorization link has no such cookie, and the callback refuses to
// connect their account to that person's Server. Used by managed MCP, the
// Slack Bridge and the WeChat bridge's QR binding (which polls with the cookie
// instead of a provider redirect, and keeps only the state's hash).

export interface OAuthBrowserBinding {
  /** Cookie name prefix, distinct per flow. */
  prefix: string;
  /** The callback's path; the cookie is sent nowhere else. */
  callbackPath: string;
}

/** SHA-256 of a state, hex: what a flow that keeps no plaintext state stores (and the cookie name is cut from). */
export function oauthBrowserBindingStateHash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function cookieNameForHash(binding: OAuthBrowserBinding, stateHash: string): string {
  return `${binding.prefix}_${stateHash.slice(0, 16)}`;
}

function cookieName(binding: OAuthBrowserBinding, state: string): string {
  return cookieNameForHash(binding, oauthBrowserBindingStateHash(state));
}

function serialize(binding: OAuthBrowserBinding, name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${binding.callbackPath}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (getServerUrl().startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie for the start response; lives exactly as long as the attempt. */
export function oauthBrowserBindingCookie(binding: OAuthBrowserBinding, state: string, ttlSeconds: number): string {
  return serialize(binding, cookieName(binding, state), state, ttlSeconds);
}

/** Set-Cookie that removes the binding once its callback has been handled. */
export function clearOAuthBrowserBindingCookie(binding: OAuthBrowserBinding, state: string): string {
  return serialize(binding, cookieName(binding, state), "", 0);
}

/** Set-Cookie that removes the binding, for a flow that kept only the state's hash. */
export function clearOAuthBrowserBindingCookieForStateHash(binding: OAuthBrowserBinding, stateHash: string): string {
  return serialize(binding, cookieNameForHash(binding, stateHash), "", 0);
}

/** Whether this callback request comes from the browser that started the sign-in. */
export function oauthCallbackIsBound(binding: OAuthBrowserBinding, cookieHeader: string | undefined, state: string): boolean {
  if (!state) return false;
  let bound: string | undefined;
  try {
    bound = parseCookieHeader(cookieHeader)[cookieName(binding, state)];
  } catch {
    return false; // a malformed Cookie header proves nothing
  }
  if (!bound) return false;
  const expected = Buffer.from(state, "utf8");
  const actual = Buffer.from(bound, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * oauthCallbackIsBound for a flow that stored only the state's hash
 * (oauthBrowserBindingStateHash): the request carries the cookie named after
 * that hash, and its value hashes to it.
 */
export function oauthRequestIsBoundToStateHash(binding: OAuthBrowserBinding, cookieHeader: string | undefined, stateHash: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(stateHash)) return false;
  let bound: string | undefined;
  try {
    bound = parseCookieHeader(cookieHeader)[cookieNameForHash(binding, stateHash)];
  } catch {
    return false; // a malformed Cookie header proves nothing
  }
  if (!bound) return false;
  const expected = Buffer.from(stateHash, "hex");
  const actual = createHash("sha256").update(bound, "utf8").digest();
  return timingSafeEqual(actual, expected);
}
