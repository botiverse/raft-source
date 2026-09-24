// packages/desktop-contract/src/uri.ts
// raft:// URI grammar and web route mapping.
// Uses WHATWG URL parser. Browsers and Node >=22 support custom schemes.
// Rust equivalent uses the `url` crate with same test vectors.

export const URI_SCHEME = "raft";
export const URI_VERSION = "v1";

const VALID_ACTIONS = new Set(["open", "channel", "dm"]);

/** Parse a raft:// URI into structured components. Returns null if invalid. */
export function parseRaftUri(uri: string): RaftUri | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }

  if (url.protocol !== "raft:") return null;

  // Fragment, userinfo, and port are not allowed in raft:// URIs
  if (url.hash || url.username || url.password || url.port) return null;

  // Version is in host (WHATWG URL parses raft://v1/... with host=v1)
  if (url.host !== URI_VERSION) return null;

  // Path must be exactly /<action>/<serverId>[/<context>]. Do not collapse
  // empty segments: repeated/trailing slashes are contract violations.
  if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return null;
  const pathParts = url.pathname.slice(1).split("/");
  if (pathParts.some((part) => part.length === 0)) return null;
  if (pathParts.length < 2 || pathParts.length > 3) return null;

  const action = pathParts[0]!;
  if (!VALID_ACTIONS.has(action)) return null;

  const serverId = pathParts[1]!;
  if (!isValidUuid(serverId)) return null;

  const context = pathParts[2];
  if (action === "open" && context !== undefined) return null;
  if ((action === "channel" || action === "dm") && context === undefined) return null;

  if (context !== undefined && !isValidPathSegment(context)) return null;

  // Query keys: only "msg" and "thread" are allowed
  const allowedKeys = new Set(["msg", "thread"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) return null;
  }
  // Duplicate keys are rejected
  if (url.searchParams.getAll("msg").length > 1) return null;
  if (url.searchParams.getAll("thread").length > 1) return null;

  const rawMessageId = url.searchParams.get("msg");
  const rawThreadParentMessageId = url.searchParams.get("thread");
  if (rawMessageId !== null && !isValidQueryValue(rawMessageId)) return null;
  if (rawThreadParentMessageId !== null && !isValidQueryValue(rawThreadParentMessageId)) return null;
  const messageId = rawMessageId ?? undefined;
  const threadParentMessageId = rawThreadParentMessageId ?? undefined;

  return {
    scheme: URI_SCHEME,
    version: URI_VERSION,
    action: action as RaftUriAction,
    serverId,
    channelId: action === "channel" ? context : undefined,
    dmChannelId: action === "dm" ? context : undefined,
    messageId,
    threadParentMessageId,
  };
}

export type RaftUriAction = "open" | "channel" | "dm";

export interface RaftUri {
  scheme: "raft";
  version: "v1";
  action: RaftUriAction;
  serverId: string;
  channelId?: string;
  dmChannelId?: string;
  messageId?: string;
  threadParentMessageId?: string;
}

function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function isValidPathSegment(s: string): boolean {
  if (s.length === 0) return false;
  if (s.includes("\\") || hasEncodedSeparatorOrControl(s)) return false;
  if (s.includes("..") || s === ".") return false;
  if (/[\x00-\x1f\x7f]/.test(s)) return false;
  return true;
}

function isValidQueryValue(s: string): boolean {
  return s.length > 0 && !/[\\/\x00-\x1f\x7f]/.test(s);
}

function hasEncodedSeparatorOrControl(s: string): boolean {
  for (const match of s.matchAll(/%([0-9a-f]{2})/gi)) {
    const value = Number.parseInt(match[1]!, 16);
    if (value === 0x2f || value === 0x5c || value <= 0x1f || value === 0x7f) {
      return true;
    }
  }
  return false;
}
