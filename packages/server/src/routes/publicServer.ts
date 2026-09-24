import { Router, type Router as ExpressRouter } from "express";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, channels, messages, servers, users } from "../db/schema.js";
import { UUID_RE } from "../lib/messageId.js";
import { evaluateFeatureFlag, PUBLIC_SERVER_FEATURE_FLAG_KEY } from "../services/featureFlagService.js";

/**
 * Task #70 — the logged-out read surface for a public server.
 *
 * This is deliberately a SEPARATE narrow path rather than letting an anonymous
 * caller through the ordinary authorization chain (@cindyz approved this shape).
 * That chain assumes a principal everywhere — `req.userId!` appears in ~571
 * places and `canUserAccessChannel` in ~59 — so threading "no principal" through
 * it means auditing every one of them. Every widening here has to be written
 * out in this file, where it is visible, instead of arriving as a side effect of
 * someone relaxing a shared helper.
 *
 * Two properties this file exists to guarantee:
 *
 *  1. **Revocation applies on the next request.** Every request re-reads
 *     `publiclyVisible` from the row. There is no cache, anonymous session or
 *     token, so a reader's next list/page request is refused after the toggle
 *     turns off. Content already downloaded by the browser cannot be revoked,
 *     nor can a database query be cancelled after it has passed this check.
 *
 *  2. **Public means public.** The slug is guessable, so this surface must never
 *     be described as "only people with the link". A semi-private mode needs
 *     tokens plus expiry and is separate work.
 */
export const publicServerRouter: ExpressRouter = Router();

// A browser/CDN cache would outlive the database decision and violate the
// next-request revocation contract even if every request handler re-queries it.
publicServerRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/** The one place that decides a server is readable by anyone. */
async function findPubliclyVisibleServer(slug: string) {
  const [row] = await getDb()
    .select({ id: servers.id, name: servers.name, slug: servers.slug, avatarUrl: servers.avatarUrl })
    .from(servers)
    .where(and(
      eq(servers.slug, slug),
      eq(servers.publiclyVisible, true),
      isNull(servers.deletedAt),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * The channel predicate, spelled out rather than reused.
 *
 * `guestVisible` alone is NOT sufficient: it is also set on channels of other
 * kinds, and an anonymous reader must never reach a private, dm, joint or
 * thread surface. Requiring `type = "channel"` explicitly means a future change
 * to what `guestVisible` means cannot quietly widen the anonymous surface.
 */
function anonymousReadableChannel(serverId: string, channelId?: string) {
  const conditions = [
    eq(channels.serverId, serverId),
    eq(channels.type, "channel"),
    eq(channels.guestVisible, true),
    isNull(channels.deletedAt),
    isNull(channels.archivedAt),
  ];
  if (channelId) conditions.push(eq(channels.id, channelId));
  return and(...conditions);
}

/**
 * Authorize a message-page request in one indexed query. Keeping the server
 * toggle and channel predicate in the same query preserves next-request
 * revocation without adding a separate database round trip to every page.
 */
async function findAnonymousReadableChannel(slug: string, channelId: string) {
  const [row] = await getDb()
    .select({ id: channels.id, serverId: servers.id })
    .from(channels)
    .innerJoin(servers, and(
      eq(servers.id, channels.serverId),
      eq(servers.slug, slug),
      eq(servers.publiclyVisible, true),
      isNull(servers.deletedAt),
    ))
    .where(and(
      eq(channels.id, channelId),
      eq(channels.type, "channel"),
      eq(channels.guestVisible, true),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Anonymous history is an explicit public projection, not the authenticated
 * message DTO. In particular it excludes actor ids, task/action metadata,
 * mentions, reactions and attachment metadata; widening this response requires
 * an intentional change at this boundary.
 */
async function listPublicMessages(channelId: string, limit: number, beforeMessageId?: string) {
  const conditions = [eq(messages.channelId, channelId)];
  if (beforeMessageId !== undefined) {
    const [cursor] = await getDb()
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.id, beforeMessageId), eq(messages.channelId, channelId)))
      .limit(1);
    if (!cursor) return null;
    conditions.push(lt(messages.seq, cursor.seq));
  }
  const rows = await getDb()
    .select({
      id: messages.id,
      senderType: messages.senderType,
      senderName: sql<string>`CASE
        WHEN ${messages.messageType} = 'system' THEN 'System'
        WHEN ${messages.senderType} = 'user' THEN COALESCE(${users.displayName}, ${users.name}, 'Unknown user')
        WHEN ${messages.senderType} = 'agent' THEN COALESCE(${agents.displayName}, ${agents.name}, 'Unknown agent')
        ELSE 'External'
      END`,
      messageType: messages.messageType,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, and(
      eq(messages.senderType, "user"),
      sql`${messages.senderId} = ${users.id}::text`,
    ))
    .leftJoin(agents, and(
      eq(messages.senderType, "agent"),
      sql`${messages.senderId} = ${agents.id}::text`,
    ))
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse();
}

// GET /api/public/servers/:slug — server card + the channels a stranger may read.
publicServerRouter.get("/servers/:slug", async (req, res) => {
  try {
    const server = await findPubliclyVisibleServer(req.params.slug);
    // 404, not 403: a non-public server must not be distinguishable from one
    // that does not exist, or this endpoint becomes a server-slug oracle.
    if (!server) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const gate = await evaluateFeatureFlag({
      key: PUBLIC_SERVER_FEATURE_FLAG_KEY,
      serverId: server.id,
      platform: "web",
    });
    if (!gate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const visible = await getDb()
      .select({ id: channels.id, name: channels.name, description: channels.description })
      .from(channels)
      .where(anonymousReadableChannel(server.id))
      .orderBy(channels.name);

    res.json({ server, channels: visible });
  } catch {
    res.status(500).json({ error: "Failed to load public server" });
  }
});

// GET /api/public/servers/:slug/channels/:channelId/messages
publicServerRouter.get("/servers/:slug/channels/:channelId/messages", async (req, res) => {
  try {
    // Re-resolved on every page request, but as one join rather than a server
    // lookup followed by a channel lookup. See property 1 above.
    const channel = await findAnonymousReadableChannel(req.params.slug, req.params.channelId);
    if (!channel) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const gate = await evaluateFeatureFlag({
      key: PUBLIC_SERVER_FEATURE_FLAG_KEY,
      serverId: channel.serverId,
      platform: "web",
    });
    if (!gate.enabled) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 50;
    const rawBefore = typeof req.query.beforeMessageId === "string"
      ? req.query.beforeMessageId
      : undefined;
    const beforeMessageId = rawBefore && UUID_RE.test(rawBefore) ? rawBefore : undefined;
    if (rawBefore !== undefined && beforeMessageId === undefined) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rows = await listPublicMessages(channel.id, limit, beforeMessageId);
    if (!rows) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ messages: rows });
  } catch {
    res.status(500).json({ error: "Failed to load public channel messages" });
  }
});
