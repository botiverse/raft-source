import { sanitizeAppLocalReturnPath, SOCKET_SSO_REQUIRED_ERROR } from "@botiverse/raft-shared";
import { RUNTIME_API_BASE } from "../runtimeEndpoints";

/**
 * Single sign-on in the web app (rfcs/083-server-sso.md §5.1, §6.2): the IdP
 * round-trip starts on the API host (an opaque start link, or a Server's
 * stable link) and comes back to `?auth_callback=sso` (SsoAuthCallbackPage).
 */

/** The 403 `code` (and the socket handshake error) of a Server that requires its SSO. */
export const SSO_REQUIRED_CODE = SOCKET_SSO_REQUIRED_ERROR;

/** A start link with where to land afterwards (a path in this app; anything else lands on /). */
export function ssoStartUrlWithReturnTo(startUrl: string, returnTo: string): string {
  const url = new URL(startUrl, window.location.origin);
  url.searchParams.set("returnTo", sanitizeAppLocalReturnPath(returnTo));
  return url.toString();
}

/** A Server's stable SSO link (what "require SSO" sends people to). */
export function ssoServerStartUrl(serverId: string, returnTo: string): string {
  return ssoStartUrlWithReturnTo(`${RUNTIME_API_BASE}/auth/sso/servers/${encodeURIComponent(serverId)}/start`, returnTo);
}

let redirecting = false;
const LAST_REDIRECT_KEY = "raft.sso.requiredRedirectAt";
const REDIRECT_PAUSE_MS = 60_000;

/**
 * Leaves for the Server's SSO sign-in, once however many requests were
 * refused together, and not again within a minute of the last time (an IdP
 * that keeps refusing must not bounce the tab forever; the callback page's
 * way back signs out).
 */
export function goToServerSsoSignIn(serverId: string): void {
  if (redirecting) return;
  try {
    const last = Number(window.sessionStorage.getItem(LAST_REDIRECT_KEY));
    if (Number.isFinite(last) && Date.now() - last < REDIRECT_PAUSE_MS) return;
    window.sessionStorage.setItem(LAST_REDIRECT_KEY, String(Date.now()));
  } catch {
    // No storage: the in-memory guard alone.
  }
  redirecting = true;
  window.location.assign(ssoServerStartUrl(serverId, `${window.location.pathname}${window.location.search}`));
}

/**
 * An API answer of 403 SSO_REQUIRED: this Server requires its SSO and this
 * session was not signed in with it (or too long ago). Sends the person to
 * sign in and returns true; anything else returns false.
 */
export function redirectForSsoRequired(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { code?: unknown; signInUrl?: unknown } } } | null)?.response;
  if (response?.status !== 403 || response.data?.code !== SSO_REQUIRED_CODE) return false;
  const serverId = serverIdOfSignInUrl(response.data.signInUrl);
  if (!serverId) return false;
  goToServerSsoSignIn(serverId);
  return true;
}

/** The Server id in `/api/auth/sso/servers/<id>/start`; the link itself is rebuilt here, never followed as sent. */
function serverIdOfSignInUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /\/auth\/sso\/servers\/([0-9a-f-]{36})\/start$/iu.exec(value);
  return match ? match[1]! : null;
}

/**
 * The owner's test sign-in comes back to `/?sso_test=ok|failed&server=<id>`:
 * the path of that Server's administration settings (which show the result),
 * with the query kept; null for any other address or a Server not in the list.
 */
export function ssoTestLandingPath(search: string, servers: ReadonlyArray<{ id: string; slug: string }>): string | null {
  const params = new URLSearchParams(search);
  if (!params.has("sso_test")) return null;
  const server = servers.find((candidate) => candidate.id === params.get("server"));
  return server ? `/s/${server.slug}/settings/administration${search}` : null;
}
