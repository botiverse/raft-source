// Public Server visit counts (RFC-067 registry: public_page_viewed,
// public_page_channel_opened, public_page_thread_opened). Design reviewed in #proj-analytics (Tenny,
// 2026-10-14); see docs/analytics/public-server-visits.md.
//
// What a row may carry: the visited server, the event, and a server-decided
// visitor class. Never an IP, cookie, user agent or visitor id. A signed-in
// visitor who shares usage data (gate: their choice + the VISITED server's
// switch) also carries their analytics_id; nobody else carries any user key.
// Since 2026-10-14 (cindyz) also where a view came from (entry, referring
// site, utm_*) and which public channel was opened; since 2026-10-15
// (cindyz) also which thread in it.

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { parse as parseDomain } from "tldts";
import {
  PRODUCT_EVENT_HOSTNAME,
  PUBLIC_SERVER_FEATURE_FLAG_KEY,
  type PUBLIC_SERVER_VISIT_ENTRIES,
  type PUBLIC_SERVER_VISITORS,
  type ServerId,
  validateProductEvent,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { UUID_RE } from "../lib/messageId";
import { channels, messages, serverMembers, servers } from "../db/schema";
import { getRedis, isRedisAvailable } from "../redis";
import { evaluateFeatureFlag } from "./featureFlagService";
import { decideProductAnalyticsGate, resolveProductAnalyticsGate } from "./productAnalyticsGate";
import { countIngest, rememberEventUuid } from "./productEventIngest";
import type { ProductEventContext } from "./productEventContext";
import type { ProductEventRow, ProductEventSink, PublicVisitorSink } from "./productEventScopeDbWriter";

/**
 * Shared cap per visited server per UTC day, across replicas (Redis). Past it,
 * visits are dropped: a server-day with this many rows reads as "at least".
 */
export const PUBLIC_VISIT_DAILY_CAP = 20_000;

const TARGET_CACHE_TTL_MS = 30_000;
const TARGET_CACHE_MAX = 2_000;
const DAILY_KEY_TTL_SECONDS = 2 * 24 * 60 * 60;
const UUID_KEY_TTL_SECONDS = 24 * 60 * 60;

export type PublicVisitEvent = "public_page_viewed" | "public_page_channel_opened" | "public_page_thread_opened";
export type PublicVisitor = (typeof PUBLIC_SERVER_VISITORS)[number];

interface VisitTarget {
  serverId: ServerId;
  /**
   * The visited server's own product-analytics switch (gate, §9.5 strict).
   * Also gates the cookie banner and the visitor id that follows consent
   * (cindyz, 2026-10-14): only where visits are counted.
   */
  workspaceEnabled: boolean;
}

/** Why a slug is not counted: no public server by that slug, or public_server_v0 is off for it. */
type NoVisitTarget = "no_target" | "flag_off";

// replica-local: a 30 s view of "public + flags + switch", so a flood of
// visits does not become a flood of flag evaluations. Turning any of them off
// takes effect within the TTL.
const targetCache = new Map<string, { target: VisitTarget | NoVisitTarget; expiresAt: number }>();

async function loadVisitTarget(slug: string): Promise<VisitTarget | NoVisitTarget> {
  const [row] = await getDb()
    .select({ id: servers.id, workspaceEnabled: servers.productAnalyticsEnabled })
    .from(servers)
    .where(and(eq(servers.slug, slug), eq(servers.publiclyVisible, true), isNull(servers.deletedAt)))
    .limit(1);
  if (!row) return "no_target";
  const serverId = row.id as ServerId;
  const publicGate = await evaluateFeatureFlag({ key: PUBLIC_SERVER_FEATURE_FLAG_KEY, serverId, platform: "web" });
  if (!publicGate.enabled) return "flag_off";
  return { serverId, workspaceEnabled: row.workspaceEnabled };
}

async function resolveVisitTarget(slug: string, now: number): Promise<VisitTarget | NoVisitTarget> {
  const cached = targetCache.get(slug);
  if (cached && cached.expiresAt > now) return cached.target;
  const target = await loadVisitTarget(slug);
  targetCache.delete(slug);
  targetCache.set(slug, { target, expiresAt: now + TARGET_CACHE_TTL_MS });
  if (targetCache.size > TARGET_CACHE_MAX) {
    const oldest = targetCache.keys().next().value;
    if (oldest !== undefined) targetCache.delete(oldest);
  }
  return target;
}

/**
 * True the first time any replica sees `uuid` within a day (Redis `SET NX`),
 * so a repeat landing on another replica does not take a cap slot (Tenny,
 * 2026-10-14). Without Redis, or when it fails, the per-replica set: a Redis
 * hiccup must not cost the visit. Readers still dedupe by uuid.
 */
async function firstSighting(uuid: string): Promise<boolean> {
  if (isRedisAvailable()) {
    try {
      return await getRedis().set(`public-visits:uuid:${uuid}`, "1", "EX", UUID_KEY_TTL_SECONDS, "NX") === "OK";
    } catch {
      // fall back below
    }
  }
  return rememberEventUuid(uuid);
}

// Fallback when Redis is absent or failing (local dev, tests): per-replica only.
const localDailyCounts = new Map<string, number>();
let dailyCap = PUBLIC_VISIT_DAILY_CAP;

/** True while the visited server is still under today's cap. */
async function takeDailySlot(serverId: ServerId, now: number): Promise<boolean> {
  const key = `public-visits:${serverId}:${new Date(now).toISOString().slice(0, 10)}`;
  if (isRedisAvailable()) {
    try {
      const redis = getRedis();
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, DAILY_KEY_TTL_SECONDS);
      return count <= dailyCap;
    } catch {
      // fall back below
    }
  }
  const count = (localDailyCounts.get(key) ?? 0) + 1;
  localDailyCounts.set(key, count);
  return count <= dailyCap;
}

async function isAnonymousReadableChannel(serverId: ServerId, channelId: string): Promise<boolean> {
  // Same predicate as the public read surface (routes/publicServer.ts).
  const [row] = await getDb()
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.id, channelId),
      eq(channels.serverId, serverId),
      eq(channels.type, "channel"),
      eq(channels.guestVisible, true),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .limit(1);
  return row !== undefined;
}

async function isAnonymousReadableThread(serverId: ServerId, channelId: string, threadChannelId: string): Promise<boolean> {
  // Same predicate as the public thread read (findPublicThread in
  // routes/publicServer.ts): a live thread whose parent message sits in this
  // anonymous-readable channel.
  const [row] = await getDb()
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(messages, eq(messages.id, channels.parentMessageId))
    .where(and(
      eq(channels.id, threadChannelId),
      eq(channels.serverId, serverId),
      eq(channels.type, "thread"),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
      eq(messages.channelId, channelId),
    ))
    .limit(1);
  return row !== undefined && (await isAnonymousReadableChannel(serverId, channelId));
}

/** Where a view came from, as the page reported it. Only kept on views. */
export interface PublicVisitSource {
  entry?: (typeof PUBLIC_SERVER_VISIT_ENTRIES)[number];
  referrer_domain?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

export interface PublicVisitInput {
  slug: string;
  uuid: string;
  event: PublicVisitEvent;
  channelId: string | null;
  /** Only on `public_page_thread_opened`: the thread, under `channelId`. */
  threadChannelId?: string | null;
  /** From a verified bearer token only; never from the request body. */
  userId: string | null;
  source?: PublicVisitSource;
  /** The page's visitor id, sent only after the visitor accepted cookies. */
  anonymousId?: string | null;
  /** `$` properties derived from the request headers (productEventContext.ts). */
  context?: ProductEventContext;
}

/** A well-formed visitor id, lowercased; anything else is dropped. */
function visitorIdOf(value: string | null | undefined): string | null {
  const id = value?.toLowerCase();
  return id && UUID_RE.test(id) ? id : null;
}

/**
 * The referring site as stored: its registrable domain under an ICANN suffix
 * of the Public Suffix List (Tenny, 2026-10-14). A host name can itself name a
 * person (`alice.github.io` -> `github.io`) or an internal system
 * (`wiki.corp.acme.com` -> `acme.com`); a suffix the list does not know
 * (`jira.corp.internal`) is dropped.
 */
export function referrerSite(host: string): string | null {
  // A bare host name only: tldts would also pull the host out of a full URL.
  if (!PRODUCT_EVENT_HOSTNAME.test(host)) return null;
  const parsed = parseDomain(host, { allowPrivateDomains: false });
  if (parsed.isIp || parsed.isIcann !== true || !parsed.domain) return null;
  return parsed.domain;
}

/**
 * The properties a row keeps. A source field the registry refuses is dropped
 * on its own, so a malformed utm value never costs the visit.
 */
function visitProperties(input: PublicVisitInput, visitor: PublicVisitor): Record<string, string | number> {
  const properties: Record<string, string | number> = { ...input.context, visitor };
  const extra: Record<string, string | undefined> = input.event === "public_page_viewed"
    ? {
      ...input.source,
      referrer_domain: input.source?.referrer_domain === undefined
        ? undefined
        : referrerSite(input.source.referrer_domain) ?? undefined,
    }
    : {
      channel_id: input.channelId?.toLowerCase(),
      thread_channel_id: input.event === "public_page_thread_opened" ? input.threadChannelId?.toLowerCase() : undefined,
    };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && validateProductEvent(input.event, { [key]: value }, "server").ok) {
      properties[key] = value;
    }
  }
  return properties;
}

export type PublicVisitOutcome =
  | "written"
  | NoVisitTarget
  | "workspace_off"
  | "bad_channel"
  | "capped"
  | "duplicate"
  | "unconfigured";

/**
 * Records one visit, or says why not. Callers answer 204 either way, so the
 * outcome never reaches the visitor (no slug oracle).
 */
export async function recordPublicVisit(
  input: PublicVisitInput,
  sink: ProductEventSink | null,
  now: number = Date.now(),
  visitorSink: PublicVisitorSink | null = null,
): Promise<PublicVisitOutcome> {
  if (sink === null) return "unconfigured";
  const target = await resolveVisitTarget(input.slug, now);
  if (typeof target === "string") return target;
  const anonymousGate = decideProductAnalyticsGate({
    analyticsId: null,
    shareUsageData: null,
    workspaceEnabled: target.workspaceEnabled,
  });
  if (!anonymousGate.recordAllowed) return "workspace_off";
  if (input.event === "public_page_channel_opened") {
    if (!input.channelId || !(await isAnonymousReadableChannel(target.serverId, input.channelId))) return "bad_channel";
  }
  if (input.event === "public_page_thread_opened") {
    if (
      !input.channelId
      || !input.threadChannelId
      || !(await isAnonymousReadableThread(target.serverId, input.channelId, input.threadChannelId))
    ) return "bad_channel";
  }
  // Dedupe before taking a slot, so a repeated beacon does not use up the cap.
  if (!(await firstSighting(input.uuid))) return "duplicate";
  if (!(await takeDailySlot(target.serverId, now))) return "capped";

  let visitor: PublicVisitor = "anonymous";
  let analyticsId: ProductEventRow["analytics_id"] = null;
  if (input.userId) {
    const db = getDb();
    const [member] = await db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, target.serverId), eq(serverMembers.userId, input.userId)))
      .limit(1);
    visitor = member ? "signed_in_member" : "signed_in_non_member";
    analyticsId = (await resolveProductAnalyticsGate(db, { userId: input.userId, serverId: target.serverId })).analyticsId;
  }

  const at = new Date(now).toISOString();
  sink.enqueue([{
    uuid: input.uuid,
    event: input.event,
    source: "server",
    timestamp: at,
    received_at: at,
    analytics_id: analyticsId,
    server_id: target.serverId,
    client_session_id: null,
    app_version: null,
    platform: null,
    properties: visitProperties(input, visitor),
  }]);
  // Logged-out visits only: a signed-in visitor is linked to an account only
  // when they join (recordPublicServerJoin), never on a view.
  const anonymousId = visitorIdOf(input.anonymousId);
  if (visitor === "anonymous" && anonymousId && visitorSink) {
    visitorSink.enqueue([{
      uuid: input.uuid,
      event: input.event,
      server_id: target.serverId,
      received_at: at,
      anonymous_id: anonymousId,
    }]);
  }
  return "written";
}

/** Whether a public page should offer the cookie banner (GET /api/public/servers/:slug). */
export async function publicVisitorIdOffered(slug: string, now: number = Date.now()): Promise<boolean> {
  const target = await resolveVisitTarget(slug, now);
  return typeof target !== "string" && target.workspaceEnabled;
}

export type PublicServerJoinOutcome = "written" | "no_target" | "gated" | "unconfigured";

/**
 * The one place a public-page visitor is linked to an account (Tenny,
 * 2026-10-14): after a successful join, and only when the joiner shares usage
 * data and the joined server's switch is on. Writes public_page_server_joined with
 * the analytics id, and the page's visitor id beside it in
 * product.public_visitors under the same uuid. Any other join path that wants
 * the conversion calls this too, never its own check. One visitor id may end
 * up on several accounts; a forged one only skews the numbers.
 */
export async function recordPublicServerJoin(
  input: { slug: string; userId: string; anonymousId?: string | null },
  sink: ProductEventSink | null,
  visitorSink: PublicVisitorSink | null,
  now: number = Date.now(),
): Promise<PublicServerJoinOutcome> {
  if (sink === null) return "unconfigured";
  const target = await resolveVisitTarget(input.slug, now);
  if (typeof target === "string") return "no_target";
  const { analyticsId } = await resolveProductAnalyticsGate(getDb(), { userId: input.userId, serverId: target.serverId });
  if (!analyticsId) return "gated";

  const uuid = randomUUID();
  const at = new Date(now).toISOString();
  const anonymousId = visitorIdOf(input.anonymousId);
  const hasVisitorId = anonymousId !== null && visitorSink !== null;
  sink.enqueue([{
    uuid,
    event: "public_page_server_joined",
    source: "server",
    timestamp: at,
    received_at: at,
    analytics_id: analyticsId,
    server_id: target.serverId,
    client_session_id: null,
    app_version: null,
    platform: null,
    properties: { has_visitor_id: hasVisitorId },
  }]);
  if (hasVisitorId) {
    visitorSink.enqueue([{
      uuid,
      event: "public_page_server_joined",
      server_id: target.serverId,
      received_at: at,
      anonymous_id: anonymousId,
    }]);
  }
  return "written";
}

// Each reason keeps its own outcome, so "the flag is off" never reads like
// "nobody visited" or "no store" (AndyLok, Tenny 2026-10-15).
export function countPublicVisit(outcome: PublicVisitOutcome): void {
  switch (outcome) {
    case "written": return; // the writer counts written / lost rows
    case "unconfigured": countIngest("unconfigured", 1); return;
    case "duplicate": countIngest("rejected_duplicate", 1); return;
    case "capped": countIngest("public_visit_capped", 1); return;
    case "no_target": countIngest("public_visit_no_target", 1); return;
    case "flag_off": countIngest("public_visit_flag_off", 1); return;
    case "workspace_off": countIngest("public_visit_workspace_off", 1); return;
    case "bad_channel": countIngest("public_visit_bad_channel", 1); return;
  }
}

/** Test-only. */
export function resetPublicVisitCountsForTest(options: { dailyCap?: number } = {}): void {
  targetCache.clear();
  localDailyCounts.clear();
  dailyCap = options.dailyCap ?? PUBLIC_VISIT_DAILY_CAP;
}
