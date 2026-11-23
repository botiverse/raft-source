/**
 * RFC 8252 loopback redirect + PKCE S256, shared by the two flows that hand a
 * one-time code back to a program on the person's own machine: app login
 * (Raft Desktop, appLoginService.ts) and loopback device authorization
 * (`raft-computer login`, deviceAuthService.ts). One implementation of the
 * return-URI rule, the challenge shape, the verifier check and the code hash.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Strict loopback redirect: exactly `http://127.0.0.1:<port>/callback` or
 * `http://[::1]:<port>/callback`, port explicit, 1–65535, no leading zero.
 * Matched on the raw string (no `localhost`, https, userinfo, query,
 * fragment, other path, uppercase, percent-encoding, or numeric host tricks
 * like `127.1` / `0x7f.0.0.1`), and the WHATWG serialization must equal the
 * input — which also rejects `:80`, since URL drops the default port and the
 * callback could no longer echo the URI as given.
 */
const LOOPBACK_RETURN_URI = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/callback$/;

export function isLoopbackReturnUri(uri: string): boolean {
  const match = LOOPBACK_RETURN_URI.exec(uri);
  if (!match) return false;
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return false;
  try {
    return new URL(uri).href === uri;
  } catch {
    return false;
  }
}

/** A PKCE S256 challenge as a client sends it: base64url, 43–128 chars. */
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export function isPkceChallenge(value: unknown): value is string {
  return typeof value === "string" && PKCE_CHALLENGE.test(value);
}

/** The S256 challenge of a verifier: base64url(sha256(verifier)). */
export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Whether `verifier` is the one `challenge` was made from (S256). */
export function pkceVerifierMatches(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !verifier) return false;
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(pkceS256Challenge(verifier));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** How a one-time redirect code is stored: sha256, hex. Only the hash is kept. */
export function hashOneTimeCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** The return URI with `params` set in its query (anything already there, such as the client's `state`, is kept). */
export function loopbackCallbackUrl(returnUri: string, params: Record<string, string>): string {
  const url = new URL(returnUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
