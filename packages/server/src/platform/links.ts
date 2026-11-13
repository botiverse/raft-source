// Platform entry point: Raft's own web addresses. The origin an app builds
// its objects' URLs on, the hosts on which a link names something of
// Raft's (the same configuration message permalinks are recognised by:
// config/appUrl), the server a slug (the `/s/<slug>` its links carry)
// names, and the servers a person can open a link in (their slugs; one of
// them with its name).
// Every app that makes or recognises links needs them.
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { getAppPermalinkHostnames, getAppUrl } from "../config/appUrl";
import { getDb } from "../db/index";
import { serverMembers, servers } from "../db/schema";

/** The one outward address's host, as the web's CANONICAL_APP_HOST: recognised on every deployment. */
const CANONICAL_APP_HOST = "app.raft.build";

/** This deployment's web origin (APP_URL, or the local default). */
export function appUrl(): string {
  return getAppUrl();
}

/**
 * This deployment's API origin (SERVER_URL, as an http(s) origin: what
 * daemons and the OIDC issuer use), or null when it isn't configured or
 * isn't one. For links an app's signed-out answers give to the API itself.
 */
export function apiUrl(): string | null {
  const value = process.env.SERVER_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Raft's own app hosts, lowercased, without a port: the canonical one, this
 * deployment's (APP_URL, or the local default), and the hosts its message
 * permalinks are recognised on (getAppPermalinkHostnames: Raft's earlier
 * hosts, APP_PERMALINK_HOSTS).
 */
export function appHosts(): string[] {
  return [...new Set([CANONICAL_APP_HOST, new URL(getAppUrl()).hostname, ...getAppPermalinkHostnames()].map((host) => host.toLowerCase()))];
}

/** The server whose slug (`/s/<slug>` in its links) is `slug` now, or null when none has it. */
export async function serverIdBySlug(slug: string): Promise<ServerId | null> {
  const [row] = await getDb().select({ id: servers.id }).from(servers).where(eq(servers.slug, slug)).limit(1);
  return row ? (row.id as ServerId) : null;
}

/**
 * The servers a person can open a link in, with the slug each one's links
 * carry: every server they are a member of (guests included) that isn't
 * deleted, exactly the servers core's requireServer lets them act in (never
 * a joint's storage namespace). In no particular order. One query.
 */
export async function serversOfUser(userId: string): Promise<Array<{ id: ServerId; slug: string }>> {
  const rows = await getDb()
    .select({ id: servers.id, slug: servers.slug })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(eq(serverMembers.userId, userId), ne(servers.kind, "joint_storage"), isNull(servers.deletedAt)));
  return rows.map((row) => ({ id: row.id as ServerId, slug: row.slug }));
}

/** Each live server's name, by id (a deleted one, or an unknown id, is absent). One query. */
export async function serverNames(serverIds: readonly ServerId[]): Promise<Map<ServerId, string>> {
  const unique = [...new Set(serverIds)];
  if (unique.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: servers.id, name: servers.name })
    .from(servers)
    .where(and(inArray(servers.id, unique), isNull(servers.deletedAt)));
  return new Map(rows.map((row) => [row.id as ServerId, row.name]));
}

/**
 * `serverId`, with its slug and name, when the person can open a link in it
 * (serversOfUser's rule: a member, guests included, of a server that isn't
 * deleted and isn't a joint's storage namespace); else null. One query.
 */
export async function serverOfUser(userId: string, serverId: ServerId): Promise<{ id: ServerId; slug: string; name: string } | null> {
  const [row] = await getDb()
    .select({ id: servers.id, slug: servers.slug, name: servers.name })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(eq(serverMembers.userId, userId), eq(serverMembers.serverId, serverId), ne(servers.kind, "joint_storage"), isNull(servers.deletedAt)))
    .limit(1);
  return row ? { id: row.id as ServerId, slug: row.slug, name: row.name } : null;
}

/**
 * Where Artifacts embed (#proj-workspace:#260): ARTIFACTS_EMBED_ORIGIN, the content Worker's embed
 * host as an origin (`https://embed.raftusercontent.com`, the Worker's EMBED_DOMAIN; http only on
 * localhost or *.localhost), which the web builds an Artifact's embed code from
 * (`<origin>/<artifact id>`). Null when unset or not exactly an origin. It is the server's one
 * embed switch: null, the web offers no Embed and the Worker's embed question
 * (`/internal/artifacts-content/embeds/:artifact`, apps/artifacts contentRoutes.ts) answers the one
 * 404 for every Artifact, so the embed host blanks every embed within its 30 s cache too. The
 * Worker's EMBEDS is the hard kill switch beside it; with EMBEDS off and this set, Embed is still
 * offered but every embed is the Worker's harmless "isn't available" page: unset both together.
 */
export function artifactsEmbedOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.ARTIFACTS_EMBED_ORIGIN?.trim() ?? "";
  if (raw === "" || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (!(url.protocol === "https:" || (url.protocol === "http:" && local))) return null;
  return url.origin === raw ? url.origin : null;
}
