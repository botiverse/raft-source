import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { getServerUrl, parseCookieHeader } from "./socialAuthService";

// A sign-in that hands the web app a one-time completion code
// (`?auth_callback=…&code=…`) completes only in the browser the provider
// answered. The callback's redirect leaves an HttpOnly cookie, named after the
// code so concurrent sign-ins do not overwrite each other and sent only to the
// completion endpoint. A link carrying someone else's code, opened in another
// browser, has no such cookie, and the completion refuses it (login CSRF).
// The value is an HMAC of the code under a key derived from the server
// secret, so the completion checks it before any lookup: another browser gets
// the same refusal whether or not the code exists. App sign-ins prove PKCE
// instead. The web app posts the completion with
// credentials; SameSite=None (with Secure) keeps it working where the app and
// the API are different sites, and the cookie proves nothing without the code,
// which only that browser has.

export interface CompletionBrowserBinding {
  /** Cookie name prefix, distinct per flow. */
  prefix: string;
  /** The completion endpoint's path; the cookie is sent nowhere else. */
  completePath: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cookieName(binding: CompletionBrowserBinding, codeHashHex: string): string {
  return `${binding.prefix}${codeHashHex.slice(0, 16)}`;
}

function serialize(binding: CompletionBrowserBinding, name: string, value: string, maxAgeSeconds: number): string {
  const secure = getServerUrl().startsWith("https://");
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${binding.completePath}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    `SameSite=${secure ? "None" : "Lax"}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function proofKey(binding: CompletionBrowserBinding): Buffer {
  const secret = process.env.SOCIAL_AUTH_STATE_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for sign-in completion");
  return Buffer.from(hkdfSync("sha256", secret, "raft-completion-binding", binding.prefix, 32));
}

function proof(binding: CompletionBrowserBinding, code: string): string {
  return createHmac("sha256", proofKey(binding)).update(code, "utf8").digest("base64url");
}

/** Set-Cookie for the callback's redirect: binds `code` to this browser. */
export function completionBindingCookie(binding: CompletionBrowserBinding, code: string, ttlSeconds: number): string {
  return serialize(binding, cookieName(binding, sha256Hex(code)), proof(binding, code), ttlSeconds);
}

/** Set-Cookie that removes the binding once the code is spent. */
export function clearCompletionBindingCookie(binding: CompletionBrowserBinding, code: string): string {
  return serialize(binding, cookieName(binding, sha256Hex(code)), "", 0);
}

/** Whether this request comes from the browser the callback bound `code` to. */
export function completionIsBound(binding: CompletionBrowserBinding, cookieHeader: string | undefined, code: string): boolean {
  if (!code) return false;
  let held: string | undefined;
  try {
    held = parseCookieHeader(cookieHeader)[cookieName(binding, sha256Hex(code))];
  } catch {
    return false; // a malformed Cookie header proves nothing
  }
  if (!held) return false;
  const expected = Buffer.from(proof(binding, code));
  const actual = Buffer.from(held);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Social sign-in (`POST /api/auth/:provider/complete`). */
export function socialCompletionBinding(provider: string): CompletionBrowserBinding {
  return { prefix: "raft_social_done_", completePath: `/api/auth/${provider}/complete` };
}

/** A social completion code lives this long (socialAuthService); its binding cookie too. */
export const SOCIAL_COMPLETION_BINDING_TTL_SECONDS = 5 * 60;
