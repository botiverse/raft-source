export interface ParsedRaftPermalink {
  routeKind: "channel" | "dm";
  serverSlug: string;
  channelId: string;
  messageId: string;
  threadParentMessageId: string | null;
}

const DEFAULT_RAFT_PERMALINK_HOSTNAMES = ["app.slock.ai", "staging.slock.ai", "app.raft.build"] as const;

function toAllowedHostnames(hostnames?: string | readonly string[]): Set<string> {
  const values = Array.isArray(hostnames) ? hostnames : [hostnames];
  return new Set(
    [...values, ...DEFAULT_RAFT_PERMALINK_HOSTNAMES]
      .filter((value): value is string => Boolean(value))
  );
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
      const threadMatch = threadParam.match(/^([0-9a-f-]+):([0-9a-f-]+)$/i);
      if (!threadMatch) return null;
      const [, threadChannelId, parentMessageId] = threadMatch;
      if (threadChannelId !== match[3]) return null;
      threadParentMessageId = parentMessageId;
    }

    // `msg=` pinpoints a specific message. Without it, a thread-only URL
    // (e.g. the address bar while viewing a thread) still resolves — we treat
    // the thread parent as the target message so the link opens the thread.
    const explicitMessageId = url.searchParams.get("msg");
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
