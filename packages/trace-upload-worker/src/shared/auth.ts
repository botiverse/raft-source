// Server-signed scope attestations and the short-lived upload/complete tokens.
import type { TraceUploadWorkerEnv } from "../env";
import { HttpError, isJsonObject, type JsonObject } from "./http";

export const SESSION_TTL_SECONDS = 10 * 60;

export interface ScopeAttestationClaims {
  v: 1;
  typ: "scope-attestation";
  scope: string;
  sub: string;
  actorType?: "user" | "machine";
  /** users.trace_user_id: the only user identifier written to traces (never `sub`). */
  traceUserId?: string | null;
  machineId?: string | null;
  serverId: string;
  aud?: string | null;
  resource?: string | null;
  exp: number;
  metadata?: JsonObject;
}

export async function verifyScopeAttestation(token: string, env: TraceUploadWorkerEnv): Promise<ScopeAttestationClaims> {
  return await verifyToken<ScopeAttestationClaims>(token, env.SCOPE_ATTESTATION_SECRET);
}

export async function verifyToken<T extends { exp?: number }>(token: string, secret: string): Promise<T> {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) throw new HttpError(401, "Invalid token");
  const payload = token.slice(0, dotIdx);
  const signature = token.slice(dotIdx + 1);
  const expected = await hmacSha256Base64Url(secret, payload);
  if (!constantTimeEqual(signature, expected)) throw new HttpError(401, "Invalid token signature");

  let claims: T;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as T;
  } catch {
    throw new HttpError(401, "Invalid token payload");
  }
  // No token issued today carries a `purpose`; one that does (a retired
  // feedback report read token) is refused on every route.
  if (!isJsonObject(claims) || (claims as JsonObject).purpose !== undefined) {
    throw new HttpError(401, "Invalid token payload");
  }
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp) {
    throw new HttpError(401, "Token expired");
  }
  return claims;
}

export async function signToken(payload: object, secret: string): Promise<string> {
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSha256Base64Url(secret, encoded);
  return `${encoded}.${signature}`;
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function sha256Hex(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function getUploadSessionSecret(env: TraceUploadWorkerEnv): string {
  return env.TRACE_UPLOAD_WORKER_SECRET || env.SCOPE_ATTESTATION_SECRET;
}
