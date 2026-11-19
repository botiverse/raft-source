export interface ParsedRaftPermalink {
  routeKind: "channel" | "dm";
  serverSlug: string;
  channelId: string;
  messageId: string;
  threadParentMessageId: string | null;
}

const DEFAULT_RAFT_PERMALINK_HOSTNAMES = ["app.slock.ai", "staging.slock.ai", "app.raft.build"] as const;

// A link typed straight into CJK prose has no space before the next word
// (`?msg=<uuid>这条…`), so the autolinked URL swallows the text. Keep only the
// leading message id (a full UUID or an 8-hex short id) and drop the rest; the
// id must end on a non-id character so `<uuid>abc` is not silently truncated.
const LEADING_MESSAGE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})(?![0-9a-f-])/i;

function leadingMessageId(value: string): string | null {
  return value.match(LEADING_MESSAGE_ID)?.[1] ?? null;
}

/**
 * A host name as it is compared here: lower case, without the trailing dots of
 * a fully-qualified name. `app.raft.build.` (and `app.raft.build..`) reach the
 * same server as `app.raft.build`, but WHATWG `URL.hostname` keeps the dots,
 * so comparing it as written lets a Raft address pass for an outside one.
 * Everything else that names the same host (upper case, a percent-encoded or
 * full-width dot, a port, a user name) is already gone from `URL.hostname`.
 */
function comparableHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function toAllowedHostnames(hostnames?: string | readonly string[]): Set<string> {
  const values = Array.isArray(hostnames) ? hostnames : [hostnames];
  return new Set(
    [...values, ...DEFAULT_RAFT_PERMALINK_HOSTNAMES]
      .filter((value): value is string => Boolean(value))
      .map(comparableHostname)
      .filter(Boolean)
  );
}

/**
 * Whether `hostname` is one of Raft's own app hosts: `currentHostname` (the
 * page's and the deployment's) or the fixed defaults parseRaftPermalink also
 * reads. A link there is Raft's, and routes in the app rather than in a web
 * preview. Both sides are compared as comparableHostname spells them, so
 * every caller (the link router, the built-in browser's address rule, the
 * web preview) may pass `URL.hostname` as it is.
 */
export function isRaftAppHostname(hostname: string, currentHostname?: string | readonly string[]): boolean {
  return toAllowedHostnames(currentHostname).has(comparableHostname(hostname));
}

export function parseRaftPermalink(
  href: string,
  currentHostname?: string | readonly string[],
): ParsedRaftPermalink | null {
  try {
    const url = new URL(href);
    if (!isRaftAppHostname(url.hostname, currentHostname)) return null;

    const match = url.pathname.match(/^\/s\/([^/]+)\/(channel|dm)\/([0-9a-f-]+)$/i);
    if (!match) return null;

    const threadParam = url.searchParams.get("thread");
    let threadParentMessageId: string | null = null;
    if (threadParam) {
      const threadMatch = threadParam.match(/^([0-9a-f-]+):(.+)$/is);
      if (!threadMatch) return null;
      const [, threadChannelId, parentMessageIdParam] = threadMatch;
      if (threadChannelId !== match[3]) return null;
      threadParentMessageId = leadingMessageId(parentMessageIdParam);
      if (!threadParentMessageId) return null;
    }

    // `msg=` pinpoints a specific message. Without it, a thread-only URL
    // (e.g. the address bar while viewing a thread) still resolves — we treat
    // the thread parent as the target message so the link opens the thread.
    const explicitMessageIdParam = url.searchParams.get("msg");
    const explicitMessageId = explicitMessageIdParam === null ? null : leadingMessageId(explicitMessageIdParam);
    if (explicitMessageIdParam !== null && !explicitMessageId) return null;
    const messageId = explicitMessageId ?? threadParentMessageId;
    if (!messageId) return null;

    return {
      serverSlug: decodeURIComponent(match[1]),
      routeKind: match[2].toLowerCase() as "channel" | "dm",
      channelId: match[3],
      messageId,
      threadParentMessageId,
    };
  } catch {
    return null;
  }
}
