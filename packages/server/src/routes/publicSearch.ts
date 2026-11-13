import { Router, type Router as ExpressRouter } from "express";
import { sql, type SQL } from "drizzle-orm";
import {
  PUBLIC_SERVER_FEATURE_FLAG_KEY,
  PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { isShownUserAvatarUrl, isStoredServerScopedAvatarUrl } from "../services/avatarService";
import { evaluateFeatureFlags } from "../services/featureFlagService";

/**
 * Public server SEO (#proj-public-server-seo), step 1: the read-only API that
 * raft.build renders indexable pages and its sitemap from.
 *
 * Narrower than the anonymous read surface in publicServer.ts, never wider:
 * everything here is also readable there, plus two more conditions — the
 * owner's `public_search_enabled` and the indexing master switch
 * (`public_server_search_index_v0`). Anything that fails the predicate is a
 * plain 404 (it does not confirm the resource existed) and is absent from the
 * index.
 *
 * Rules this file keeps:
 *  - Lookup is by public id only. Every request re-runs the whole predicate;
 *    nothing is cached, and responses are `no-store` (no edge cache on
 *    raft.build either), so revocation applies on the next request.
 *  - Responses carry no internal database ids (server, channel, thread,
 *    message, user or agent). Public ids are the routing contract.
 *  - No expiring (signed) URLs. Avatars follow the same stored-upload rule as
 *    the guest view; attachments are not projected at all.
 *  - No user-agent based decisions.
 */
export const publicSearchRouter: ExpressRouter = Router();

publicSearchRouter.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  // GET and HEAD only (Express answers HEAD from the GET handlers); every
  // other method is refused here, before any lookup.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.set("Allow", "GET, HEAD");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  next();
});

const PUBLIC_ID_RE = /^[0-9a-f]{32}$/;
const CHANNEL_THREADS_PAGE_SIZE = 50;
const THREAD_REPLY_LIMIT = 50;
const INDEX_PAGE_SIZE = 1000;
const THREAD_TITLE_MAX = 80;
const SLUG_MAX = 60;

// ── The predicate ────────────────────────────────────────────────────────────
// Spelled out as SQL fragments over fixed aliases so every query below uses
// the same words. `s` = server, `c` = channel, `t` = thread channel, `pm` =
// the thread's parent message.

/** Server is anonymously readable and its owner allows search. */
const SEARCHABLE_SERVER = sql`s.publicly_visible = true AND s.public_search_enabled = true AND s.deleted_at IS NULL AND s.kind = 'normal'`;

/**
 * The same channel predicate as publicServer.ts `anonymousReadableChannel`.
 * Every query also inner-joins the route rows (`sr`, `cr`, `tr`), so a row
 * without a public id is never served or listed.
 */
const SEARCHABLE_CHANNEL = sql`c.server_id = s.id AND c.type = 'channel' AND c.guest_visible = true AND c.deleted_at IS NULL AND c.archived_at IS NULL`;

/**
 * A live thread whose parent message lives in a searchable channel of the
 * same server — the parent's channel decides, as in publicServer.ts
 * `findPublicThread`, not the cached `parent_channel_id`.
 */
const SEARCHABLE_THREAD = sql`t.type = 'thread' AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.server_id = s.id AND pm.id = t.parent_message_id AND pm.channel_id = c.id AND pm.message_type = 'chat'`;

// ── lastmod ──────────────────────────────────────────────────────────────────
// The latest change to what a page renders, never deploy or crawl time
// (Ginny). Row stamps come from the 0347 triggers: the route tables'
// `public_changed_at` (names, descriptions, avatar, visibility, archive,
// delete — channels only while public-shaped, so private edits never show)
// and messages `updated_at` (content edits). Sender display-name changes are
// not tracked. GREATEST ignores NULLs.

/** Server page: its own fields and the list of public channels on it. */
const SERVER_LASTMOD = sql`GREATEST(
  s.created_at,
  sr.public_changed_at,
  (SELECT max(GREATEST(cr2.public_changed_at, CASE WHEN c2.type = 'channel' AND c2.guest_visible THEN c2.created_at END))
     FROM channels c2 LEFT JOIN channel_public_routes cr2 ON cr2.channel_id = c2.id WHERE c2.server_id = s.id AND c2.type <> 'thread')
)`;

/**
 * Channel page: breadcrumb server fields, the channel's own fields, its newest
 * message, and per thread its title (parent edits), state and newest reply.
 */
const CHANNEL_LASTMOD = sql`GREATEST(
  s.created_at,
  sr.public_changed_at,
  c.created_at,
  cr.public_changed_at,
  (SELECT m.created_at FROM messages m WHERE m.channel_id = c.id ORDER BY m.seq DESC LIMIT 1),
  (SELECT max(GREATEST(t2.created_at, tr2.public_changed_at, pm2.updated_at, lr.created_at))
     FROM channels t2
     LEFT JOIN channel_public_routes tr2 ON tr2.channel_id = t2.id
     JOIN messages pm2 ON pm2.id = t2.parent_message_id
     LEFT JOIN LATERAL (
       SELECT r.created_at FROM messages r WHERE r.channel_id = t2.id ORDER BY r.seq DESC LIMIT 1
     ) lr ON true
     WHERE t2.parent_channel_id = c.id AND t2.type = 'thread' AND t2.deleted_at IS NULL)
)`;

/** Thread page: breadcrumbs, the thread's state, its parent and every reply's create/edit time. */
const THREAD_LASTMOD = sql`GREATEST(
  s.created_at,
  sr.public_changed_at,
  c.created_at,
  cr.public_changed_at,
  t.created_at,
  tr.public_changed_at,
  pm.updated_at,
  (SELECT max(GREATEST(r.created_at, r.updated_at)) FROM messages r WHERE r.channel_id = t.id)
)`;

/**
 * Both switches, per server: the public-server rollout (`public_server_v0`)
 * and the indexing master switch. Evaluated anonymously, like the guest view
 * (`{ key, serverId, platform: "web" }`, no user).
 */
async function serversPassingGates(serverIds: string[]): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set();
  const inputs = serverIds.flatMap((serverId) => [
    { key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId, platform: "web" as const },
    { key: PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY, serverId, platform: "web" as const },
  ]);
  const results = await evaluateFeatureFlags(inputs);
  const allowed = new Set<string>();
  serverIds.forEach((serverId, index) => {
    if (results[index * 2]?.enabled && results[index * 2 + 1]?.enabled) allowed.add(serverId);
  });
  return allowed;
}

async function rows<T>(query: SQL): Promise<T[]> {
  const result = await getDb().execute(query);
  return result.rows as T[];
}

interface SearchableServer {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  updatedAt: Date | string;
}

async function findSearchableServer(serverPid: string): Promise<SearchableServer | null> {
  if (!PUBLIC_ID_RE.test(serverPid)) return null;
  const [server] = await rows<SearchableServer>(sql`
    SELECT s.id::text AS "id", sr.public_id AS "publicId", s.name, s.slug,
           s.avatar_url AS "avatarUrl", ${SERVER_LASTMOD} AS "updatedAt"
    FROM servers s
      JOIN server_public_routes sr ON sr.server_id = s.id
    WHERE sr.public_id = ${serverPid} AND ${SEARCHABLE_SERVER}
    LIMIT 1
  `);
  if (!server) return null;
  const allowed = await serversPassingGates([server.id]);
  return allowed.has(server.id) ? server : null;
}

// ── Projection helpers ───────────────────────────────────────────────────────

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

/**
 * Lowercase words joined by `-`, letters and digits of any script kept, capped.
 * Display only: lookup never reads a slug.
 */
export function slugifyForPublicPath(text: string, fallback: string): string {
  const slug = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const capped = [...slug].slice(0, SLUG_MAX).join("").replace(/-+$/g, "");
  return capped || fallback;
}

/**
 * v1 thread title (Ginny): the first non-empty line of the parent message,
 * stripped of leading Markdown markers and capped; "Discussion" when there is
 * none (empty or attachment-only).
 */
export function publicThreadTitle(content: string | null | undefined): string {
  const firstLine = (content ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)*/, "").trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "Discussion";
  const chars = [...firstLine];
  return chars.length > THREAD_TITLE_MAX ? `${chars.slice(0, THREAD_TITLE_MAX - 1).join("").trimEnd()}…` : firstLine;
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function serverPath(server: { publicId: string; slug: string }): string {
  return `/servers/${pathSegment(server.publicId)}/${pathSegment(slugifyForPublicPath(server.slug, "server"))}`;
}

function channelPath(server: { publicId: string; slug: string }, channel: { publicId: string; name: string }): string {
  return `${serverPath(server)}/${pathSegment(channel.publicId)}/${pathSegment(slugifyForPublicPath(channel.name, "channel"))}`;
}

function threadPath(
  server: { publicId: string; slug: string },
  channel: { publicId: string; name: string },
  thread: { publicId: string; title: string },
): string {
  return `${channelPath(server, channel)}/${pathSegment(thread.publicId)}/${pathSegment(slugifyForPublicPath(thread.title, "discussion"))}`;
}

interface SenderRow {
  senderType: string;
  senderName: string;
  userAvatarUrl: string | null;
  agentAvatarUrl: string | null;
}

/** Display name and a stored-upload (or built pixel) avatar only — the guest view's rule. No id, no handle. */
function projectSender(row: SenderRow, serverId: string) {
  return {
    type: row.senderType === "user" ? "user" as const : row.senderType === "agent" ? "agent" as const : "external" as const,
    displayName: row.senderName,
    avatarUrl: row.senderType === "user"
      ? (isShownUserAvatarUrl(row.userAvatarUrl) ? row.userAvatarUrl : null)
      : row.senderType === "agent"
        ? (isStoredServerScopedAvatarUrl(row.agentAvatarUrl, serverId) ? row.agentAvatarUrl : null)
        : null,
  };
}

/** Sender columns for a message aliased `alias`, joined like the guest view (agents scoped to the server). */
function senderColumns(alias: string, serverIdSql: SQL) {
  const m = sql.raw(alias);
  const u = sql.raw(`${alias}_u`);
  const a = sql.raw(`${alias}_a`);
  return {
    select: sql`
      ${m}.sender_type AS "senderType",
      CASE
        WHEN ${u}.id IS NOT NULL THEN COALESCE(${u}.display_name, ${u}.name, 'Unknown user')
        WHEN ${m}.sender_type = 'user' THEN 'Unknown user'
        WHEN ${a}.id IS NOT NULL THEN COALESCE(${a}.display_name, ${a}.name, 'Unknown agent')
        WHEN ${m}.sender_type = 'agent' THEN 'Unknown agent'
        ELSE 'External'
      END AS "senderName",
      ${u}.avatar_url AS "userAvatarUrl",
      ${a}.avatar_url AS "agentAvatarUrl"`,
    joins: sql`
      LEFT JOIN users ${u} ON ${m}.sender_type = 'user' AND ${m}.sender_id = ${u}.id::text
      LEFT JOIN agents ${a} ON ${m}.sender_type = 'agent' AND ${m}.sender_id = ${a}.id::text AND ${a}.server_id = ${serverIdSql}`,
  };
}

function notFound(res: import("express").Response) {
  res.status(404).json({ error: "Not found" });
}

// ── GET /servers/:serverPid ──────────────────────────────────────────────────

publicSearchRouter.get("/servers/:serverPid", async (req, res) => {
  try {
    const server = await findSearchableServer(req.params.serverPid);
    if (!server) return notFound(res);
    const channelRows = await rows<{ publicId: string; name: string; description: string | null }>(sql`
      SELECT cr.public_id AS "publicId", c.name, c.description
      FROM servers s
      JOIN server_public_routes sr ON sr.server_id = s.id
      JOIN channels c ON ${SEARCHABLE_CHANNEL}
      JOIN channel_public_routes cr ON cr.channel_id = c.id
      WHERE s.id = ${server.id}::uuid AND ${SEARCHABLE_SERVER}
      ORDER BY c.name
    `);
    res.json({
      server: {
        publicId: server.publicId,
        name: server.name,
        slug: server.slug,
        avatarUrl: isStoredServerScopedAvatarUrl(server.avatarUrl, `server-${server.id}`) ? server.avatarUrl : null,
        updatedAt: iso(server.updatedAt),
        canonicalPath: serverPath(server),
      },
      channels: channelRows.map((channel) => ({
        publicId: channel.publicId,
        name: channel.name,
        description: channel.description,
        canonicalPath: channelPath(server, channel),
      })),
    });
  } catch {
    res.status(500).json({ error: "Failed to load public server" });
  }
});

// ── GET /servers/:serverPid/channels/:channelPid?cursor= ─────────────────────

interface ThreadListRow {
  publicId: string;
  parentContent: string;
  parentSeq: string;
  replyCount: number;
  lastReplyAt: Date | string | null;
}

publicSearchRouter.get("/servers/:serverPid/channels/:channelPid", async (req, res) => {
  try {
    const server = await findSearchableServer(req.params.serverPid);
    if (!server || !PUBLIC_ID_RE.test(req.params.channelPid)) return notFound(res);
    const [channel] = await rows<{ id: string; publicId: string; name: string; description: string | null }>(sql`
      SELECT c.id::text AS "id", cr.public_id AS "publicId", c.name, c.description
      FROM servers s
      JOIN server_public_routes sr ON sr.server_id = s.id
      JOIN channels c ON ${SEARCHABLE_CHANNEL}
      JOIN channel_public_routes cr ON cr.channel_id = c.id
      WHERE s.id = ${server.id}::uuid AND ${SEARCHABLE_SERVER} AND cr.public_id = ${req.params.channelPid}
      LIMIT 1
    `);
    if (!channel) return notFound(res);

    const rawCursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    if (rawCursor !== undefined && !/^\d{1,18}$/.test(rawCursor)) return notFound(res);

    // Threads with at least one reply, newest parent first. Reply aggregates
    // count chat replies only; system events are not page content.
    const threadRows = await rows<ThreadListRow>(sql`
      SELECT tr.public_id AS "publicId", pm.content AS "parentContent", pm.seq::text AS "parentSeq",
             agg.reply_count AS "replyCount", agg.last_reply_at AS "lastReplyAt"
      FROM servers s
      JOIN server_public_routes sr ON sr.server_id = s.id
      JOIN channels c ON ${SEARCHABLE_CHANNEL}
      JOIN channel_public_routes cr ON cr.channel_id = c.id
      JOIN messages pm ON pm.channel_id = c.id AND pm.thread_id IS NOT NULL
      JOIN channels t ON t.id = pm.thread_id::uuid
      JOIN channel_public_routes tr ON tr.channel_id = t.id
      JOIN LATERAL (
        SELECT count(*)::int AS reply_count, max(r.created_at) AS last_reply_at
        FROM messages r
        WHERE r.channel_id = t.id AND r.message_type = 'chat'
      ) agg ON agg.reply_count > 0
      WHERE s.id = ${server.id}::uuid AND ${SEARCHABLE_SERVER} AND c.id = ${channel.id}::uuid
        AND ${SEARCHABLE_THREAD}
        ${rawCursor !== undefined ? sql`AND pm.seq < ${rawCursor}::bigint` : sql``}
      ORDER BY pm.seq DESC
      LIMIT ${CHANNEL_THREADS_PAGE_SIZE + 1}
    `);
    const page = threadRows.slice(0, CHANNEL_THREADS_PAGE_SIZE);
    const nextCursor = threadRows.length > CHANNEL_THREADS_PAGE_SIZE ? page[page.length - 1]!.parentSeq : null;
    res.json({
      server: { publicId: server.publicId, name: server.name, slug: server.slug, canonicalPath: serverPath(server) },
      channel: {
        publicId: channel.publicId,
        name: channel.name,
        description: channel.description,
        canonicalPath: channelPath(server, channel),
      },
      threads: page.map((thread) => {
        const title = publicThreadTitle(thread.parentContent);
        return {
          publicId: thread.publicId,
          title,
          replyCount: thread.replyCount,
          lastReplyAt: iso(thread.lastReplyAt),
          canonicalPath: threadPath(server, channel, { publicId: thread.publicId, title }),
        };
      }),
      nextCursor,
    });
  } catch {
    res.status(500).json({ error: "Failed to load public channel" });
  }
});

// ── GET /servers/:serverPid/threads/:threadPid ───────────────────────────────

interface MessageRow extends SenderRow {
  content: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

publicSearchRouter.get("/servers/:serverPid/threads/:threadPid", async (req, res) => {
  try {
    const server = await findSearchableServer(req.params.serverPid);
    if (!server || !PUBLIC_ID_RE.test(req.params.threadPid)) return notFound(res);
    const parentSender = senderColumns("pm", sql`${server.id}::uuid`);
    const [thread] = await rows<MessageRow & {
      threadId: string;
      threadPublicId: string;
      channelPublicId: string;
      channelName: string;
    }>(sql`
      SELECT t.id::text AS "threadId", tr.public_id AS "threadPublicId",
             cr.public_id AS "channelPublicId", c.name AS "channelName",
             pm.content, pm.created_at AS "createdAt", pm.updated_at AS "updatedAt",
             ${parentSender.select}
      FROM servers s
      JOIN server_public_routes sr ON sr.server_id = s.id
      JOIN channel_public_routes tr ON tr.public_id = ${req.params.threadPid}
      JOIN channels t ON t.id = tr.channel_id
      JOIN messages pm ON pm.id = t.parent_message_id
      JOIN channels c ON ${SEARCHABLE_CHANNEL}
      JOIN channel_public_routes cr ON cr.channel_id = c.id
      ${parentSender.joins}
      WHERE s.id = ${server.id}::uuid AND ${SEARCHABLE_SERVER} AND ${SEARCHABLE_THREAD}
      LIMIT 1
    `);
    if (!thread) return notFound(res);

    const replySender = senderColumns("r", sql`${server.id}::uuid`);
    const [replyRows, [total]] = await Promise.all([
      rows<MessageRow>(sql`
        SELECT r.content, r.created_at AS "createdAt", r.updated_at AS "updatedAt", ${replySender.select}
        FROM messages r
        ${replySender.joins}
        WHERE r.channel_id = ${thread.threadId}::uuid AND r.message_type = 'chat'
        ORDER BY r.seq ASC
        LIMIT ${THREAD_REPLY_LIMIT}
      `),
      rows<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM messages r
        WHERE r.channel_id = ${thread.threadId}::uuid AND r.message_type = 'chat'
      `),
    ]);
    const replyCount = total?.count ?? 0;
    const title = publicThreadTitle(thread.content);
    const channel = { publicId: thread.channelPublicId, name: thread.channelName };
    res.json({
      server: { publicId: server.publicId, name: server.name, slug: server.slug, canonicalPath: serverPath(server) },
      channel: { ...channel, canonicalPath: channelPath(server, channel) },
      thread: {
        publicId: thread.threadPublicId,
        title,
        canonicalPath: threadPath(server, channel, { publicId: thread.threadPublicId, title }),
        parent: {
          sender: projectSender(thread, server.id),
          content: thread.content,
          createdAt: iso(thread.createdAt),
          updatedAt: iso(thread.updatedAt),
        },
        replies: replyRows.map((reply) => ({
          sender: projectSender(reply, server.id),
          content: reply.content,
          createdAt: iso(reply.createdAt),
          updatedAt: iso(reply.updatedAt),
        })),
        replyCount,
        truncated: replyCount > replyRows.length,
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to load public thread" });
  }
});

// ── GET /index?cursor= ───────────────────────────────────────────────────────
//
// Everything the predicate admits, as canonical paths with `lastmod`, server by
// server in public-id order: the server, then its channels, then its threads.
//
// Bounded per request (Ark, task #4): servers are read in batches of
// INDEX_SERVER_BATCH and the switches are evaluated only for that batch; at
// most INDEX_MAX_SERVER_BATCHES batches and INDEX_MAX_SERVERS_WITH_ENTRIES
// servers that contribute entries are visited, and each kind query is LIMITed.
// The page may therefore be short (even empty) while `nextCursor` is set;
// callers follow the cursor until it is null. When the master switch is
// certainly off for every server, the answer is an empty list without reading
// servers at all.
//
// Cursor: `<serverPid>:<kind>[:<afterPid>]` resumes inside that server;
// `<serverPid>:done` resumes after it. Opaque to callers.

type IndexKind = "server" | "channel" | "thread";
const INDEX_KINDS: IndexKind[] = ["server", "channel", "thread"];
const INDEX_SERVER_BATCH = 100;
const INDEX_MAX_SERVER_BATCHES = 5;
const INDEX_MAX_SERVERS_WITH_ENTRIES = 25;

interface IndexEntry {
  type: IndexKind;
  canonicalPath: string;
  lastmod: string | null;
}

type IndexCursor =
  | { serverPid: string; kind: IndexKind; after: string | null }
  | { serverPid: string; kind: "done"; after: null };

function parseIndexCursor(raw: unknown): IndexCursor | null | "invalid" {
  if (raw === undefined) return null;
  if (typeof raw !== "string") return "invalid";
  const done = /^([0-9a-f]{32}):done$/.exec(raw);
  if (done) return { serverPid: done[1]!, kind: "done", after: null };
  const match = /^([0-9a-f]{32}):(server|channel|thread)(?::([0-9a-f]{32}))?$/.exec(raw);
  if (!match) return "invalid";
  return { serverPid: match[1]!, kind: match[2] as IndexKind, after: match[3] ?? null };
}

/**
 * True only when the master switch cannot be on for any server: the flag row
 * is missing, disabled or killed, or it defaults off and has no rules. Any
 * rule means some server might be in, so the per-server path decides.
 */
async function masterSwitchClosedEverywhere(): Promise<boolean> {
  const [flag] = await rows<{ enabled: boolean; killSwitch: boolean; defaultEnabled: boolean; ruleCount: number }>(sql`
    SELECT f.enabled, f.kill_switch AS "killSwitch", f.default_enabled AS "defaultEnabled",
           (SELECT count(*)::int FROM feature_flag_rules r WHERE r.flag_key = f.key) AS "ruleCount"
    FROM feature_flags f WHERE f.key = ${PUBLIC_SERVER_SEARCH_INDEX_FEATURE_FLAG_KEY}
  `);
  if (!flag) return true;
  return !flag.enabled || flag.killSwitch || (!flag.defaultEnabled && flag.ruleCount === 0);
}

async function indexPage(kind: IndexKind, serverId: string, after: string | null, limit: number) {
  const serverScope = sql`s.id = ${serverId}::uuid`;
  const afterClause = (column: SQL) => (after ? sql`AND ${column} > ${after}` : sql``);
  if (kind === "server") {
    const found = await rows<{ publicId: string; slug: string; lastmod: Date | string }>(sql`
      SELECT sr.public_id AS "publicId", s.slug, ${SERVER_LASTMOD} AS "lastmod"
      FROM servers s
      JOIN server_public_routes sr ON sr.server_id = s.id
      WHERE ${serverScope} AND ${SEARCHABLE_SERVER} ${afterClause(sql`sr.public_id`)}
      ORDER BY sr.public_id
      LIMIT ${limit}
    `);
    return found.map((row) => ({
      key: row.publicId,
      entry: { type: kind, canonicalPath: serverPath(row), lastmod: iso(row.lastmod) },
    }));
  }
  if (kind === "channel") {
    const found = await rows<{ serverPublicId: string; slug: string; publicId: string; name: string; lastmod: Date | string }>(sql`
      SELECT sr.public_id AS "serverPublicId", s.slug, cr.public_id AS "publicId", c.name,
             ${CHANNEL_LASTMOD} AS "lastmod"
      FROM servers s
      JOIN server_public_routes sr ON sr.server_id = s.id
      JOIN channels c ON ${SEARCHABLE_CHANNEL}
      JOIN channel_public_routes cr ON cr.channel_id = c.id
      WHERE ${serverScope} AND ${SEARCHABLE_SERVER} ${afterClause(sql`cr.public_id`)}
      ORDER BY cr.public_id
      LIMIT ${limit}
    `);
    return found.map((row) => ({
      key: row.publicId,
      entry: {
        type: kind,
        canonicalPath: channelPath({ publicId: row.serverPublicId, slug: row.slug }, row),
        lastmod: iso(row.lastmod),
      },
    }));
  }
  // Only threads with at least one chat reply, as on the channel page.
  const found = await rows<{
    serverPublicId: string;
    slug: string;
    channelPublicId: string;
    channelName: string;
    publicId: string;
    parentContent: string;
    lastmod: Date | string;
  }>(sql`
    SELECT sr.public_id AS "serverPublicId", s.slug, cr.public_id AS "channelPublicId", c.name AS "channelName",
           tr.public_id AS "publicId", pm.content AS "parentContent",
           ${THREAD_LASTMOD} AS "lastmod"
    FROM servers s
      JOIN server_public_routes sr ON sr.server_id = s.id
    JOIN channels t ON t.server_id = s.id
    JOIN channel_public_routes tr ON tr.channel_id = t.id
    JOIN messages pm ON pm.id = t.parent_message_id
    JOIN channels c ON ${SEARCHABLE_CHANNEL}
      JOIN channel_public_routes cr ON cr.channel_id = c.id
    JOIN LATERAL (
      SELECT 1 FROM messages r WHERE r.channel_id = t.id AND r.message_type = 'chat' LIMIT 1
    ) has_reply ON true
    WHERE ${serverScope} AND ${SEARCHABLE_SERVER} AND ${SEARCHABLE_THREAD} ${afterClause(sql`tr.public_id`)}
    ORDER BY tr.public_id
    LIMIT ${limit}
  `);
  return found.map((row) => {
    const title = publicThreadTitle(row.parentContent);
    return {
      key: row.publicId,
      entry: {
        type: kind,
        canonicalPath: threadPath(
          { publicId: row.serverPublicId, slug: row.slug },
          { publicId: row.channelPublicId, name: row.channelName },
          { publicId: row.publicId, title },
        ),
        lastmod: iso(row.lastmod),
      },
    };
  });
}

publicSearchRouter.get("/index", async (req, res) => {
  try {
    const cursor = parseIndexCursor(req.query.cursor);
    if (cursor === "invalid") return notFound(res);
    if (await masterSwitchClosedEverywhere()) {
      res.json({ entries: [], nextCursor: null });
      return;
    }

    const entries: IndexEntry[] = [];
    let nextCursor: string | null = null;
    let resume: IndexCursor | null = cursor;
    let lastServerPid: string | null = null;
    let serversWithEntries = 0;
    let finished = false;

    batches: for (let batch = 0; batch < INDEX_MAX_SERVER_BATCHES; batch += 1) {
      const from: SQL = lastServerPid
        ? sql`AND sr.public_id > ${lastServerPid}`
        : resume
          ? (resume.kind === "done" ? sql`AND sr.public_id > ${resume.serverPid}` : sql`AND sr.public_id >= ${resume.serverPid}`)
          : sql``;
      const servers: Array<{ id: string; publicId: string }> = await rows<{ id: string; publicId: string }>(sql`
        SELECT s.id::text AS "id", sr.public_id AS "publicId"
        FROM servers s JOIN server_public_routes sr ON sr.server_id = s.id
        WHERE ${SEARCHABLE_SERVER} ${from}
        ORDER BY sr.public_id
        LIMIT ${INDEX_SERVER_BATCH}
      `);
      const allowed = await serversPassingGates(servers.map((server) => server.id));
      for (const server of servers) {
        const resumeHere = resume && resume.kind !== "done" && resume.serverPid === server.publicId ? resume : null;
        resume = null;
        lastServerPid = server.publicId;
        if (!allowed.has(server.id)) continue;

        let added = 0;
        let after = resumeHere ? resumeHere.after : null;
        for (let k = resumeHere ? INDEX_KINDS.indexOf(resumeHere.kind as IndexKind) : 0; k < INDEX_KINDS.length; k += 1) {
          const kind = INDEX_KINDS[k]!;
          const remaining = INDEX_PAGE_SIZE - entries.length;
          // One extra row tells whether this kind continues past the page.
          const page = await indexPage(kind, server.id, after, remaining + 1);
          after = null;
          for (const item of page.slice(0, remaining)) entries.push(item.entry);
          added += Math.min(page.length, remaining);
          if (page.length > remaining) {
            nextCursor = `${server.publicId}:${kind}:${page[remaining - 1]?.key ?? ""}`.replace(/:$/, "");
            break batches;
          }
        }
        if (added > 0) serversWithEntries += 1;
        if (entries.length >= INDEX_PAGE_SIZE || serversWithEntries >= INDEX_MAX_SERVERS_WITH_ENTRIES) {
          nextCursor = `${server.publicId}:done`;
          break batches;
        }
      }
      if (servers.length < INDEX_SERVER_BATCH) {
        finished = true;
        break;
      }
    }
    if (!finished && nextCursor === null && lastServerPid) nextCursor = `${lastServerPid}:done`;
    res.json({ entries, nextCursor });
  } catch {
    res.status(500).json({ error: "Failed to load public index" });
  }
});
