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

function toAllowedHostnames(hostnames?: string | readonly string[]): Set<string> {
  const values = Array.isArray(hostnames) ? hostnames : [hostnames];
  return new Set(
    [...values, ...DEFAULT_RAFT_PERMALINK_HOSTNAMES]
      .filter((value): value is string => Boolean(value))
  );
}

/**
 * Whether `hostname` is one of Raft's own app hosts: `currentHostname` (the
 * page's and the deployment's) or the fixed defaults parseRaftPermalink also
 * reads. A link there is Raft's, and routes in the app rather than in a web
 * preview.
 */
export function isRaftAppHostname(hostname: string, currentHostname?: string | readonly string[]): boolean {
  return toAllowedHostnames(currentHostname).has(hostname);
}

export function parseRaftPermalink(
  href: string,
  currentHostname?: string | readonly string[],
): ParsedRaftPermalink | null {
  try {
    const url = new URL(href);
    const allowedHostnames = toAllowedHostnames(currentHostname);
    if (!allowedHostnames.has(url.hostname)) return null;

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
