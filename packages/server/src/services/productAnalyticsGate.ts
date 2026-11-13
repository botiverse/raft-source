// Product-analytics gate (RFC-067 §3.6).
//
// The one place that decides, for a user acting in a server, whether the
// activity may be recorded, which user key it may carry, and whether the
// user's clients may send product events. Server-derived facts, flag
// exposures and client-event ingest all go through here; the RisingWave
// derivation mirrors decideProductAnalyticsGate in SQL and must keep the same
// cases (productAnalyticsGate.test.ts).
//
// The only user key product data may carry is the AnalyticsId read from
// user_analytics_ids. This module is its single mint site
// (scripts/ci/check-branded-mint-sites.ts).

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { SHARE_USAGE_DATA_DEFAULT, type AnalyticsId, type ServerId } from "@botiverse/raft-shared";
import type { Database, DatabaseExecutor } from "../db/index";
import { servers, userAnalyticsIds, users } from "../db/schema";

// "Share usage data" for a user who has not chosen (pending RFC-067 §9.4).
export { SHARE_USAGE_DATA_DEFAULT };

// NOT A SETTLED RULE — pending RFC-067 §9.5 (does a workspace with product
// analytics off still contribute anonymous per-workspace counts?). Until it is
// decided, off means nothing from that workspace is recorded: the stricter side.
export const DISABLED_WORKSPACE_KEEPS_COUNTS = false;

export interface ProductAnalyticsFacts {
  /** The user's user_analytics_ids row; null when opted out or unknown. */
  analyticsId: string | null;
  /** users.share_usage_data; null when the user has not chosen. */
  shareUsageData: boolean | null;
  /** servers.product_analytics_enabled; null when no server applies. */
  workspaceEnabled: boolean | null;
}

export interface ProductAnalyticsGate {
  /** Whether anything about this activity may be recorded at all. */
  recordAllowed: boolean;
  /** The user key it may carry; null means count it toward the workspace only. */
  analyticsId: AnalyticsId | null;
  /** Whether this user's clients may send product events. */
  clientEventsAllowed: boolean;
}

// One switch for everything personal: unless the user (effectively) shares
// usage data, nothing is linked to them — not client events, not server-derived
// facts. Their activity then counts only toward workspace totals.
export function decideProductAnalyticsGate(facts: ProductAnalyticsFacts): ProductAnalyticsGate {
  const workspaceOff = facts.workspaceEnabled === false;
  const recordAllowed = !workspaceOff || DISABLED_WORKSPACE_KEEPS_COUNTS;
  const sharing = facts.shareUsageData ?? SHARE_USAGE_DATA_DEFAULT;
  const analyticsId = !workspaceOff && sharing && facts.analyticsId !== null
    ? (facts.analyticsId as AnalyticsId)
    : null;
  return {
    recordAllowed,
    analyticsId,
    clientEventsAllowed: analyticsId !== null,
  };
}

export interface ProductAnalyticsGateBatch {
  /** userId null: activity with no human actor (e.g. an agent's), counted per workspace only. */
  gate(userId: string | null, serverId: ServerId | null): ProductAnalyticsGate;
}

/**
 * Loads the facts for a whole batch in two queries (one for the users, one for
 * the servers), then decides each pair in memory. Writers that handle many
 * events (the derivation job) call this once per batch, never per event.
 */
export async function loadProductAnalyticsGateBatch(
  db: DatabaseExecutor,
  input: { userIds: readonly string[]; serverIds: readonly ServerId[] },
): Promise<ProductAnalyticsGateBatch> {
  const userIds = [...new Set(input.userIds)];
  const serverIds = [...new Set(input.serverIds)];
  const userRows = userIds.length === 0 ? [] : await db
    .select({
      userId: users.id,
      analyticsId: userAnalyticsIds.analyticsId,
      shareUsageData: users.shareUsageData,
    })
    .from(users)
    .leftJoin(userAnalyticsIds, eq(userAnalyticsIds.userId, users.id))
    .where(inArray(users.id, userIds));
  const serverRows = serverIds.length === 0 ? [] : await db
    .select({ serverId: servers.id, enabled: servers.productAnalyticsEnabled })
    .from(servers)
    .where(inArray(servers.id, serverIds));
  const byUser = new Map(userRows.map((row) => [row.userId, row]));
  const byServer = new Map(serverRows.map((row) => [row.serverId, row.enabled]));
  return {
    gate(userId, serverId) {
      const user = userId === null ? undefined : byUser.get(userId);
      return decideProductAnalyticsGate({
        analyticsId: user?.analyticsId ?? null,
        shareUsageData: user?.shareUsageData ?? null,
        workspaceEnabled: serverId === null ? null : byServer.get(serverId) ?? null,
      });
    },
  };
}

export async function resolveProductAnalyticsGate(
  db: DatabaseExecutor,
  input: { userId: string; serverId: ServerId | null },
): Promise<ProductAnalyticsGate> {
  const batch = await loadProductAnalyticsGateBatch(db, {
    userIds: [input.userId],
    serverIds: input.serverId === null ? [] : [input.serverId],
  });
  return batch.gate(input.userId, input.serverId);
}

/**
 * The legacy Postgres `product_events` written from client clicks (the
 * onboarding wizard route), and the web push log's interaction rows, keep the
 * real actor id for their readers (the Daily Brief, the push funnel), but
 * follow the same switches as everything else: the workspace switch and the
 * user's effective "Share usage data" choice. `serverId` null: no workspace
 * applies (the request named none it may use), only the user's choice.
 */
export async function legacyProductEventsAllowed(
  db: DatabaseExecutor,
  input: { userId: string; serverId: ServerId | null },
): Promise<boolean> {
  const [user] = await db
    .select({ shareUsageData: users.shareUsageData })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!(user?.shareUsageData ?? SHARE_USAGE_DATA_DEFAULT)) return false;
  if (input.serverId === null) return true;
  const [server] = await db
    .select({ enabled: servers.productAnalyticsEnabled })
    .from(servers)
    .where(eq(servers.id, input.serverId))
    .limit(1);
  return server?.enabled !== false;
}

/**
 * Opting out deletes the user's mapping, so everything already recorded under
 * the old analytics id stops belonging to anyone (RFC-067 §3.4). Opting back
 * in mints a fresh random id; the earlier history stays unlinked.
 */
export async function setProductAnalyticsOptOut(
  db: Database,
  userId: string,
  optedOut: boolean,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ analyticsOptedOutAt: optedOut ? now : null, updatedAt: now })
      .where(eq(users.id, userId));
    if (optedOut) {
      await tx.delete(userAnalyticsIds).where(eq(userAnalyticsIds.userId, userId));
    } else {
      await tx
        .insert(userAnalyticsIds)
        .values({ userId, analyticsId: randomUUID() })
        .onConflictDoNothing();
    }
  });
}
