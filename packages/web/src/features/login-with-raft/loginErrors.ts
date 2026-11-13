import { appendOAuthErrorParams } from "@botiverse/raft-shared";

/**
 * Where a refused authorization goes, when the answer belongs to the app: this
 * Server's admin did not approve openid for it. The app gets `invalid_scope`
 * at the registered callback the server matched (RFC 6749 §4.1.2.1), with its
 * state, so it can recover. Null for every other refusal, shown on this page.
 */
export function authorizationErrorRedirectUrl(body: unknown, state: string): string | null {
  if (!body || typeof body !== "object") return null;
  const { errorCode, returnUrl, error_description: description } = body as Record<string, unknown>;
  if (errorCode !== "OAUTH_SCOPE_NOT_APPROVED" || typeof returnUrl !== "string" || !returnUrl) return null;
  try {
    return appendOAuthErrorParams(returnUrl, "invalid_scope", {
      description: typeof description === "string" ? description : null,
      state,
    });
  } catch {
    return null;
  }
}

/**
 * The App is not open to this person on that Server: 403 `app_not_available`
 * (outside its audience), or the 404 a missing App gets. Both read the same
 * here, so the page never tells whether the App exists (RFC 079 D4).
 */
export function isAppNotAvailableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { response } = err as { response?: { status?: unknown; data?: { code?: unknown } } };
  return response?.status === 404 || (response?.status === 403 && response.data?.code === "app_not_available");
}

function errorResponse(err: unknown): { status?: unknown; data?: Record<string, unknown> } | undefined {
  if (!err || typeof err !== "object") return undefined;
  return (err as { response?: { status?: unknown; data?: Record<string, unknown> } }).response;
}

/**
 * RFC 079 phase 3a: 409 `login_mode_changed` from /authorize/human. The page
 * was opened before the App switched to account mode; look it up again.
 */
export function isLoginModeChangedError(err: unknown): boolean {
  const response = errorResponse(err);
  return response?.status === 409 && response.data?.code === "login_mode_changed";
}

/** An account-mode refusal the page words itself (design §4.1). */
export type AccountLoginRefusal = "rootIssuerRequired" | "installationSuspended";

/** The refusal POST /oauth/authorize/account answered, if it is one the page words itself. */
export function accountLoginRefusalOf(err: unknown): AccountLoginRefusal | null {
  const response = errorResponse(err);
  if (response?.status === 400 && response.data?.code === "root_issuer_required") return "rootIssuerRequired";
  if (response?.status === 403 && (
    response.data?.errorCode === "OAUTH_INSTALLATION_SUSPENDED" || response.data?.error === "installation_suspended"
  )) return "installationSuspended";
  return null;
}
