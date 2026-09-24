import type { SocialAuthProviderId } from "../hooks/useAuthProviders";
import { sanitizeAppLocalReturnPath } from "@botiverse/raft-shared";
import { assertValidDesktopRuntimeEnvironment, RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";

export const PENDING_INVITE_STORAGE_KEY = "slock_pending_invite";

function getApiBaseUrl(): string {
  assertValidDesktopRuntimeEnvironment();

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
  return url.toString();
}

const EMBEDDED_BROWSER_USER_AGENT_PATTERNS = [
  /MicroMessenger/i,
  /DingTalk/i,
  /Lark|Feishu/i,
  /FBAN|FBAV|FB_IAB/i,
  /Instagram/i,
  /Line\//i,
  /Weibo/i,
  /Twitter/i,
  /;\s*wv\)/i,
];

export function isEmbeddedBrowserUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return EMBEDDED_BROWSER_USER_AGENT_PATTERNS.some((pattern) => pattern.test(userAgent));
}

export function isEmbeddedBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return isEmbeddedBrowserUserAgent(navigator.userAgent);
}

export function getExternalBrowserLoginUrl(returnTo = getCurrentReturnTo()): string {
  const url = new URL(window.location.origin);
  url.pathname = sanitizeReturnTo(returnTo);
  url.search = "";
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
