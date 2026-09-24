export const ATTACHMENT_PREVIEW_EXTERNAL_LINK_COOLDOWN_MS = 500;
export const ATTACHMENT_PREVIEW_EXTERNAL_LINK_MAX_LENGTH = 4096;

export type AttachmentPreviewExternalLink = {
  href: string;
  hostname: string;
};

export type AttachmentPreviewExternalLinkRejection =
  | "invalid_url"
  | "url_too_long"
  | "non_https"
  | "credentials"
  | "nonstandard_port"
  | "private_host"
  | "internal_origin"
  | "sensitive_query";

export type AttachmentPreviewExternalLinkValidation =
  | { ok: true; link: AttachmentPreviewExternalLink }
  | { ok: false; reason: AttachmentPreviewExternalLinkRejection };

const INTERNAL_APP_HOSTS = new Set([
  "api.raft.build",
  "api.slock.ai",
  "app.raft.build",
  "app.slock.ai",
  "staging.slock.ai",
]);

const PRIVATE_HOST_SUFFIXES = [
  ".home",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".test",
];

const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "accesstoken",
  "auth_token",
  "preview_token",
  "previewtoken",
  "refresh_token",
  "refreshtoken",
  "token",
]);

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isPrivateHostname(hostname: string): boolean {
  if (hostname === "localhost" || isIpLiteral(hostname)) return true;
  if (!hostname.includes(".")) return true;
  return PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function isInternalAppHostname(hostname: string, appOrigin: string): boolean {
  try {
    if (hostname === normalizedHostname(new URL(appOrigin).hostname)) return true;
  } catch {
    // The current browser origin is expected to be absolute. If an embedding
    // test supplies an invalid one, the explicit production-host list below
    // remains the conservative boundary.
  }
  if (INTERNAL_APP_HOSTS.has(hostname)) return true;
  return hostname === "botiverse.dev" || hostname.endsWith(".botiverse.dev");
}

function hasSensitiveQuery(url: URL): boolean {
  for (const [key] of url.searchParams) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  const hashParams = new URLSearchParams(url.hash.slice(1));
  for (const [key] of hashParams) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

export function validateAttachmentPreviewExternalLink(
  rawHref: unknown,
  appOrigin: string,
): AttachmentPreviewExternalLinkValidation {
  if (typeof rawHref !== "string") return { ok: false, reason: "invalid_url" };
  const href = rawHref.trim();
  if (href.length === 0) return { ok: false, reason: "invalid_url" };
  if (href.length > ATTACHMENT_PREVIEW_EXTERNAL_LINK_MAX_LENGTH) {
    return { ok: false, reason: "url_too_long" };
  }

  let url: URL;
  try {
    // Intentionally no base URL: relative attachment links may resolve back
    // into the tokenized preview route and are never external-navigation
    // authority.
    url = new URL(href);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "non_https" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.port && url.port !== "443") return { ok: false, reason: "nonstandard_port" };

  const hostname = normalizedHostname(url.hostname);
  if (isPrivateHostname(hostname)) return { ok: false, reason: "private_host" };
  if (isInternalAppHostname(hostname, appOrigin)) {
    return { ok: false, reason: "internal_origin" };
  }
  if (hasSensitiveQuery(url)) return { ok: false, reason: "sensitive_query" };

  return {
    ok: true,
    link: {
      href: url.href,
      hostname,
    },
  };
}

type OpenWindow = (url: string, target: "_blank") => Window | null;

export function openAttachmentPreviewExternalLink(
  link: AttachmentPreviewExternalLink,
  openWindow: OpenWindow = (url, target) => window.open(url, target),
): boolean {
  // Using `noopener,noreferrer` as window features makes successful opens
  // return null in Chromium, which is indistinguishable from a popup block.
  // Reserve a same-origin blank tab first; before any untrusted page loads,
  // synchronously sever its opener and navigate through an anchor whose
  // referrer policy is `no-referrer`. A null reservation is an honest signal
  // to render the parent-owned fallback button.
  const popup = openWindow("about:blank", "_blank");
  if (!popup) return false;
  try {
    popup.opener = null;
    const meta = popup.document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    popup.document.head.append(meta);

    const anchor = popup.document.createElement("a");
    anchor.href = link.href;
    anchor.rel = "noopener noreferrer";
    anchor.referrerPolicy = "no-referrer";
    (popup.document.body ?? popup.document.documentElement).append(anchor);
    anchor.click();
    return true;
  } catch {
    try {
      popup.close();
    } catch {
      // Best effort: the browser can revoke the WindowProxy at any point.
    }
    return false;
  }
}
