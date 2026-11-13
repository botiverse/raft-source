/**
 * App login handoff (HarmonyOS web login, #raft-mobile-reconcile:9607096f).
 *
 * A native app starts a request with a PKCE S256 challenge and a return URI
 * from a fixed allowlist, then opens `/login/app?request=<id>` in the system
 * browser. The ordinary web login runs there (any method, including a GitHub
 * round trip). The signed-in user explicitly confirms, which issues a
 * one-time code; the browser jumps to the return URI saved at start. The app
 * exchanges code + verifier for a normal user session.
 *
 * Deliberately separate from the mobile OAuth handoff: there is no provider
 * and no provider callback. Only the code is secret; it is stored as a
 * sha256 hash and consumed once by compare-and-set.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, type DatabaseTransaction } from "../db/index";
import { appLoginRequests, users } from "../db/schema";
import { currentDate } from "@botiverse/raft-shared";
import { isApprovingSessionLive } from "./sessionService";

export const APP_LOGIN_REQUEST_TTL_MS = 10 * 60_000;
/** An approved code is exchangeable for this long after approval, and never
 * past its request's expiry. Apps exchange right after the redirect. */
export const APP_LOGIN_CODE_TTL_MS = 2 * 60_000;

/** A client the confirm page can name. Never self-declared: derived from
 * the return URI saved at start (see `appLoginClientForReturnUri`). */
export type AppLoginClient = { id: string; name: string };

type AppLoginClientEntry = AppLoginClient & {
  /** Exact return URIs this client may use. */
  returnUris: readonly string[];
  /** RFC 8252 loopback redirect (random port) instead of exact URIs. */
  loopback?: true;
};

export const APP_LOGIN_CLIENTS: readonly AppLoginClientEntry[] = [
  {
    id: "raft-app",
    name: "Raft",
    returnUris: [
      "raft://login/callback",
      "raft-alpha://login/callback",
      "raft-beta://login/callback",
      "raft-debug://login/callback",
    ],
  },
  // The Compose Multiplatform Mac app (botiverse/mobile desktopApp). Its own
  // scheme: the Electron Raft Desktop also registers raft://, and macOS hands
  // a raft:// callback to whichever app it picks.
  { id: "raft-mac", name: "Raft for Mac", returnUris: ["raft-mac://login/callback"] },
  // The Electron Raft Desktop: a loopback listener on a random port (RFC 8252
  // §7.3), like its social login, since it cannot rely on receiving raft://.
  { id: "raft-desktop", name: "Raft Desktop", returnUris: [], loopback: true },
];

/** A URI listed only in APP_LOGIN_RETURN_URIS (not in the registry). */
export const GENERIC_APP_LOGIN_CLIENT: AppLoginClient = { id: "custom", name: "Raft" };

const DEFAULT_APP_LOGIN_RETURN_URIS = APP_LOGIN_CLIENTS.flatMap((client) => client.returnUris);

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

export function isLoopbackAppLoginReturnUri(uri: string): boolean {
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

/** Exact-URI allowlist. APP_LOGIN_RETURN_URIS replaces the registry's exact
 * URIs (as before); loopback is pattern-matched separately and always on. */
export function allowedAppLoginReturnUris(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.APP_LOGIN_RETURN_URIS?.trim();
  if (!raw) return DEFAULT_APP_LOGIN_RETURN_URIS;
  return raw.split(/[\n,]/).map((uri) => uri.trim()).filter(Boolean);
}

/** The client a return URI belongs to, or null when the URI is not allowed. */
export function appLoginClientForReturnUri(uri: string, env: NodeJS.ProcessEnv = process.env): AppLoginClient | null {
  if (isLoopbackAppLoginReturnUri(uri)) {
    const desktop = APP_LOGIN_CLIENTS.find((client) => client.loopback)!;
    return { id: desktop.id, name: desktop.name };
  }
  if (!allowedAppLoginReturnUris(env).includes(uri)) return null;
  const entry = APP_LOGIN_CLIENTS.find((client) => client.returnUris.includes(uri));
  return entry ? { id: entry.id, name: entry.name } : GENERIC_APP_LOGIN_CLIENT;
}

/** Display client for a stored request: the registry entry for its return
 * URI, falling back to the generic client if the allowlist changed since. */
function storedClient(returnUri: string): AppLoginClient {
  return appLoginClientForReturnUri(returnUri) ?? GENERIC_APP_LOGIN_CLIENT;
}

export type AppLoginStartError = "return_uri_not_allowed" | "code_challenge_invalid" | "client_mismatch";
export type AppLoginResolveError = "request_not_found" | "request_expired" | "request_already_resolved";
export type AppLoginExchangeError = "code_not_found" | "code_expired" | "code_consumed" | "pkce_mismatch" | "return_uri_mismatch";

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** `clientId` is optional; when sent it must name the registry client of
 * `returnUri` — it can never pick a client the URI does not belong to. */
export async function startAppLogin(input: { returnUri: string; codeChallenge: string; clientId?: string }): Promise<
  | { ok: true; requestId: string; expiresAt: Date; client: AppLoginClient }
  | { ok: false; error: AppLoginStartError }
> {
  const client = appLoginClientForReturnUri(input.returnUri);
  if (!client) return { ok: false, error: "return_uri_not_allowed" };
  if (input.clientId !== undefined && input.clientId !== client.id) return { ok: false, error: "client_mismatch" };
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) return { ok: false, error: "code_challenge_invalid" };
  const expiresAt = new Date(currentDate().getTime() + APP_LOGIN_REQUEST_TTL_MS);
  const [row] = await getDb().insert(appLoginRequests).values({
    codeChallenge: input.codeChallenge,
    returnUri: input.returnUri,
    expiresAt,
  }).returning({ id: appLoginRequests.id });
  return { ok: true, requestId: row!.id, expiresAt, client };
}

async function loadPending(requestId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return { ok: false as const, error: "request_not_found" as const };
  const [row] = await getDb().select().from(appLoginRequests).where(eq(appLoginRequests.id, requestId)).limit(1);
  if (!row) return { ok: false as const, error: "request_not_found" as const };
  if (row.status !== "pending") return { ok: false as const, error: "request_already_resolved" as const, row };
  if (row.expiresAt.getTime() <= currentDate().getTime()) return { ok: false as const, error: "request_expired" as const, row };
  return { ok: true as const, row };
}

/** Every callback names its request, so an app that retried can ignore a
 * late callback from an earlier attempt before exchanging anything. */
function callbackUrl(returnUri: string, requestId: string, params: Record<string, string>): string {
  const url = new URL(returnUri);
  url.searchParams.set("requestId", requestId);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** What the confirmation page needs; the return URI is included so a
 * cancel on an expired request can still hand control back to the app. */
export async function describeAppLogin(requestId: string): Promise<
  | { ok: true; expiresAt: Date; createdAt: Date; client: AppLoginClient }
  | { ok: false; error: AppLoginResolveError; cancelUrl?: string }
> {
  const pending = await loadPending(requestId);
  if (pending.ok) {
    const { row } = pending;
    return { ok: true, expiresAt: row.expiresAt, createdAt: row.createdAt, client: storedClient(row.returnUri) };
  }
  if (pending.error === "request_expired") {
    return { ok: false, error: pending.error, cancelUrl: callbackUrl(pending.row!.returnUri, requestId, { error: "expired" }) };
  }
  return { ok: false, error: pending.error };
}

/** The signed-in user confirmed: bind them, mint the one-time code, and
 * return the saved return URI with it. `approverFamilyId` is the approving
 * web session's family (null for a token without one), recorded on the row. */
export async function approveAppLogin(requestId: string, userId: string, approverFamilyId: string | null = null): Promise<
  | { ok: true; redirectUrl: string }
  | { ok: false; error: AppLoginResolveError; redirectUrl?: string }
> {
  const pending = await loadPending(requestId);
  if (!pending.ok) {
    return pending.error === "request_expired"
      ? { ok: false, error: pending.error, redirectUrl: callbackUrl(pending.row!.returnUri, requestId, { error: "expired" }) }
      : { ok: false, error: pending.error };
  }
  const code = randomBytes(32).toString("base64url");
  const [updated] = await getDb().update(appLoginRequests)
    .set({ status: "approved", userId, codeHash: hashCode(code), approvedAt: currentDate(), approverFamilyId })
    .where(and(
      eq(appLoginRequests.id, requestId),
      eq(appLoginRequests.status, "pending"),
      gt(appLoginRequests.expiresAt, currentDate()),
    ))
    .returning({ returnUri: appLoginRequests.returnUri });
  if (!updated) return { ok: false, error: "request_already_resolved" };
  return { ok: true, redirectUrl: callbackUrl(updated.returnUri, requestId, { code }) };
}

export async function denyAppLogin(requestId: string): Promise<
  | { ok: true; redirectUrl: string }
  | { ok: false; error: AppLoginResolveError }
> {
  const pending = await loadPending(requestId);
  if (!pending.ok) {
    return pending.error === "request_expired"
      ? { ok: true, redirectUrl: callbackUrl(pending.row!.returnUri, requestId, { error: "expired" }) }
      : { ok: false, error: pending.error };
  }
  const [updated] = await getDb().update(appLoginRequests)
    .set({ status: "denied" })
    .where(and(eq(appLoginRequests.id, requestId), eq(appLoginRequests.status, "pending")))
    .returning({ returnUri: appLoginRequests.returnUri });
  if (!updated) return { ok: false, error: "request_already_resolved" };
  return { ok: true, redirectUrl: callbackUrl(updated.returnUri, requestId, { error: "access_denied" }) };
}

/** Single-use exchange. A wrong verifier does not burn the code: only the
 * device holding the verifier can use it, and a failed guess reveals
 * nothing. The code lives APP_LOGIN_CODE_TTL_MS from approval, capped by
 * its request's expiry (TTL from start), and only while the sign-in that
 * approved it is live (isApprovingSessionLive): a revoke of that sign-in
 * (a logout, a password change or reset, the account's retirement) denies
 * the code, and either way it answers as an expired one.
 * `returnUri` is optional for older apps but required for a loopback client
 * (Raft Desktop); when sent it must equal the
 * URI saved at start, and a mismatch does not burn the code either.
 *
 * Run it in the transaction that issues the session (routes/appLogin.ts):
 * past the verifier, the person's `users` row is taken FOR UPDATE (as every
 * family revoker takes it first, and as the session issue does after this),
 * so a revoke of the approver commits before the check (refused) or after
 * the new session exists. */
export async function exchangeAppLoginCode(tx: DatabaseTransaction, code: string, codeVerifier: string, returnUri?: string): Promise<
  | { ok: true; userId: string; approverFamilyId: string | null }
  | { ok: false; error: AppLoginExchangeError }
> {
  if (!code || code.length > 256) return { ok: false, error: "code_not_found" };
  const [row] = await tx.select().from(appLoginRequests)
    .where(eq(appLoginRequests.codeHash, hashCode(code))).limit(1);
  if (!row || !row.userId) return { ok: false, error: "code_not_found" };
  if (row.status === "completed") return { ok: false, error: "code_consumed" };
  const now = currentDate().getTime();
  if (row.expiresAt.getTime() <= now) return { ok: false, error: "code_expired" };
  if (!row.approvedAt || row.approvedAt.getTime() + APP_LOGIN_CODE_TTL_MS < now) return { ok: false, error: "code_expired" };
  if (!codeVerifier || pkceChallenge(codeVerifier) !== row.codeChallenge) return { ok: false, error: "pkce_mismatch" };
  // A loopback client (Raft Desktop) is new and must send it; others may omit it.
  if (returnUri === undefined ? isLoopbackAppLoginReturnUri(row.returnUri) : returnUri !== row.returnUri) {
    return { ok: false, error: "return_uri_mismatch" };
  }
  await tx.select({ id: users.id }).from(users).where(eq(users.id, row.userId)).limit(1).for("update");
  // Denied by a revoke of the approving sign-in, or that sign-in no longer
  // live: refused as an expired code, so it tells nothing new.
  if (row.status !== "approved" || !(await isApprovingSessionLive(tx, { userId: row.userId, familyId: row.approverFamilyId }))) {
    return { ok: false, error: "code_expired" };
  }
  const [consumed] = await tx.update(appLoginRequests)
    .set({ status: "completed", consumedAt: currentDate() })
    .where(and(
      eq(appLoginRequests.id, row.id),
      eq(appLoginRequests.status, "approved"),
      isNull(appLoginRequests.consumedAt),
    ))
    .returning({ userId: appLoginRequests.userId, approverFamilyId: appLoginRequests.approverFamilyId });
  if (!consumed?.userId) return { ok: false, error: "code_consumed" };
  return { ok: true, userId: consumed.userId, approverFamilyId: consumed.approverFamilyId };
}
