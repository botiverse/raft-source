// Product events the server records itself (RFC-067 §3.6 server-derived
// facts): no consent prompt, but the gate still decides. Nothing is written
// for a workspace that turned product analytics off; a user who does not
// share usage data gets no analytics_id, so their action counts toward the
// workspace only. Best effort: never throws, never delays the caller.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  type PaywallGate,
  type PaywallHitVia,
  type PaywallLimitSide,
  type ProductEventName,
  type ProductEventProperties,
  type ServerId,
  validateProductEvent,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { serverMembers, servers } from "../db/schema";
import { getRedis, isRedisAvailable } from "../redis";
import { loadProductAnalyticsGateBatch } from "./productAnalyticsGate";
import { countIngest } from "./productEventIngest";
import type { ProductEventSink } from "./productEventScopeDbWriter";

export type ServerProductEventOutcome = "written" | "gated" | "unconfigured" | "rejected" | "duplicate" | "failed";

export interface ServerProductEventInput<E extends ProductEventName> {
  event: E;
  /** The acting user; null for activity with no human actor. */
  userId: string | null;
  /** The workspace; null for an account-level fact (e.g. account_created). */
  serverId: ServerId | null;
  properties: ProductEventProperties<E>;
  now?: number;
}

export async function recordServerProductEvent<E extends ProductEventName>(
  sink: ProductEventSink | null,
  input: ServerProductEventInput<E>,
): Promise<ServerProductEventOutcome> {
  try {
    if (sink === null) {
      countIngest("unconfigured", 1);
      return "unconfigured";
    }
    const properties: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(input.properties)) {
      if (value !== undefined) properties[key] = value as string | number | boolean;
    }
    const validation = validateProductEvent(input.event, properties, "server");
    if (!validation.ok) {
      countIngest(`rejected_${validation.reason}`, 1);
      return "rejected";
    }
    const gates = await loadProductAnalyticsGateBatch(getDb(), {
      userIds: input.userId === null ? [] : [input.userId],
      serverIds: input.serverId === null ? [] : [input.serverId],
    });
    const gate = gates.gate(input.userId, input.serverId);
    if (!gate.recordAllowed) {
      countIngest("gated", 1);
      return "gated";
    }
    const at = new Date(input.now ?? Date.now()).toISOString();
    sink.enqueue([{
      // Random, never derived from a Stripe or request id: a derived uuid
      // would be a key into the diagnostics that hold the real user id.
      uuid: randomUUID(),
      event: input.event,
      source: "server",
      timestamp: at,
      received_at: at,
      analytics_id: gate.analyticsId,
      server_id: input.serverId,
      client_session_id: null,
      app_version: null,
      platform: null,
      properties,
    }]);
    return "written";
  } catch (err) {
    console.warn(`[product-events] ${input.event} not recorded:`, err instanceof Error ? err.name : "unknown");
    return "failed";
  }
}

const ONCE_A_DAY_KEY_TTL_SECONDS = 26 * 60 * 60;
const LOCAL_ONCE_A_DAY_LIMIT = 50_000;
// Keys this replica already saw, each until it expires (as in Redis, 26
// hours). Checked before Redis, so a hit that repeats on every read (the
// history cut-off) costs no round trip after the first (Tenny, #10389); also
// the whole check when Redis is absent or failing. Insertion order is expiry
// order (one TTL), so expired keys are dropped from the front.
const localOnceADayKeys = new Map<string, number>();

function dropExpiredLocalKeys(now: number): void {
  for (const [key, expiresAt] of localOnceADayKeys) {
    if (expiresAt > now && localOnceADayKeys.size <= LOCAL_ONCE_A_DAY_LIMIT) return;
    localOnceADayKeys.delete(key);
  }
}

/**
 * True the first time any replica sees this key: the once-a-day rule of
 * `paywall_hit`, `external_invite_page_viewed` and
 * `external_invite_link_opened`. The caller puts the UTC day in the key; it
 * lives only in Redis and in this process, 26 hours in each (so never past
 * the day after), and nothing of it goes into an event.
 */
export async function firstSeenToday(key: string, now: number = Date.now()): Promise<boolean> {
  dropExpiredLocalKeys(now);
  if (localOnceADayKeys.has(key)) return false;
  localOnceADayKeys.set(key, now + ONCE_A_DAY_KEY_TTL_SECONDS * 1000);
  dropExpiredLocalKeys(now);
  if (isRedisAvailable()) {
    try {
      return await getRedis().set(key, "1", "EX", ONCE_A_DAY_KEY_TTL_SECONDS, "NX") === "OK";
    } catch {
      // this replica's set decides
    }
  }
  return true;
}

/** The `upload_monthly_quota` usage numbers of a paywall_hit (the registry's `requested_bytes`, `month_used_bytes`). */
export interface PaywallHitUsage {
  requestedBytes: number;
  monthUsedBytes: number;
}

/**
 * `paywall_hit` where the server refuses an action for the server's plan.
 * Once per user, server, gate (and `via`, where set) and UTC day: some gates
 * (the 30-day history cut-off) apply on every read. `userId` null: an agent's
 * refusal, no person (no viewer_role, counted toward the server only), once
 * per server for all its agents. `limitSide`: the external channel gates'
 * `limit_side` (which side of the channel `serverId` was); not part of the
 * once-a-day key. Call without awaiting.
 */
export async function recordPaywallHit(
  sink: ProductEventSink | null,
  input: { gate: PaywallGate; userId: string | null; serverId: ServerId; via?: PaywallHitVia; usage?: PaywallHitUsage; limitSide?: PaywallLimitSide; now?: number },
): Promise<ServerProductEventOutcome> {
  try {
    const now = input.now ?? Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    // One decision for the key and for `actor`: no user id is an agent's refusal.
    const userId = input.userId ?? null;
    const who = userId ?? "agents";
    if (!await firstSeenToday(`paywall-hit:${day}:${input.serverId}:${who}:${input.gate}${input.via ? `:${input.via}` : ""}`)) {
      return "duplicate";
    }
    const [row] = await getDb()
      .select({ plan: servers.plan, role: serverMembers.role })
      .from(servers)
      // An agent's (no person): no member row, so no viewer_role.
      .leftJoin(serverMembers, and(eq(serverMembers.serverId, servers.id), userId === null ? sql`false` : eq(serverMembers.userId, userId)))
      .where(eq(servers.id, input.serverId))
      .limit(1);
    if (!row) return "rejected";
    const role = row.role;
    return await recordServerProductEvent(sink, {
      event: "paywall_hit",
      userId,
      serverId: input.serverId,
      properties: {
        gate: input.gate,
        // Whose refusal it is, not the role: a person without a member row is still a person.
        actor: userId === null ? "agent" : "person",
        plan: row.plan,
        ...(role ? { viewer_role: role } : {}),
        ...(input.via ? { via: input.via } : {}),
        ...(input.usage ? { requested_bytes: Math.max(0, Math.round(input.usage.requestedBytes)), month_used_bytes: Math.max(0, Math.round(input.usage.monthUsedBytes)) } : {}),
        ...(input.limitSide ? { limit_side: input.limitSide } : {}),
      },
      now,
    });
  } catch (err) {
    console.warn("[product-events] paywall_hit not recorded:", err instanceof Error ? err.name : "unknown");
    return "failed";
  }
}

/** Test-only: forgets this process's once-a-day keys (paywall hits, invite page views and link opens). */
export function resetPaywallHitsForTest(): void {
  localOnceADayKeys.clear();
}

/** Test-only: whether this process still holds the key (it expires 26 hours after it was first seen). */
export function holdsOnceADayKeyForTest(key: string, now: number = Date.now()): boolean {
  dropExpiredLocalKeys(now);
  return localOnceADayKeys.has(key);
}
