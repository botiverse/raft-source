import type { SocialAuthProviderId } from "../hooks/useAuthProviders";
import { sanitizeAppLocalReturnPath } from "@botiverse/raft-shared";
import { RUNTIME_API_BASE } from "../runtimeEndpoints";
import { shareableWebOrigin } from "./desktopShell";

export { isEmbeddedBrowser, isEmbeddedBrowserUserAgent } from "./embeddedBrowser";

export const PENDING_INVITE_STORAGE_KEY = "slock_pending_invite";

function getApiBaseUrl(): string {
  return RUNTIME_API_BASE;
}

export function sanitizeReturnTo(value: string | null | undefined): string {
  return sanitizeAppLocalReturnPath(value);
}

export function getCurrentReturnTo(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function buildSocialAuthStartUrl(provider: SocialAuthProviderId, returnTo: string): string {
  const url = new URL(`${getApiBaseUrl()}/auth/${provider}/start`, window.location.origin);
  url.searchParams.set("returnTo", sanitizeReturnTo(returnTo));
  url.searchParams.set("linkOnConflict", "1");
  return url.toString();
}

export function getExternalBrowserLoginUrl(returnTo = getCurrentReturnTo()): string {
  // The return path keeps its query: a message link's ?msg= / ?thread= must
  // reach the system browser too. Setting `pathname` to it would escape the
  // "?" (%3F). The sanitized path is app-local, so it cannot change the origin.
  const url = new URL(sanitizeReturnTo(returnTo), shareableWebOrigin());
  url.hash = "";
  return url.toString();
}

export function isEmbeddedUserAgentProviderError(error: string | null | undefined): boolean {
  return error === "disallowed_useragent";
}

export function storePendingInvite(token: string, storage: Storage = window.localStorage): void {
  storage.setItem(PENDING_INVITE_STORAGE_KEY, token);
}

export function takePendingInviteRedirectPath(storage: Storage = window.localStorage): string | null {
  const token = storage.getItem(PENDING_INVITE_STORAGE_KEY);
  if (!token) return null;

  storage.removeItem(PENDING_INVITE_STORAGE_KEY);
  const params = new URLSearchParams();
  params.set("invite", token);
  return `/?${params.toString()}`;
}
