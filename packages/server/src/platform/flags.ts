// Platform entry point: whether an app is switched on for a server (its
// server-scoped feature flag). Pass `executor` to read inside the caller's
// transaction or savepoint.
//
// A soft-deleted server (`servers.deleted_at`) keeps its rows and its flag
// rules, so its flag alone still reads on: where an object of a server is
// read by someone who doesn't stand in that server (another server's
// reader of a public object, a joint's other side, a signed-out visitor),
// ask appEnabledOnLiveServer(s), which is also false once the server is
// deleted. A reader's own server is live already (requireServer).
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { servers } from "../db/schema";
import { answerFlagFromDeployment } from "../services/deploymentAnsweredFlags";
import { evaluateFeatureFlag, evaluateFeatureFlags } from "../services/featureFlagService";
import { cachedServerFlagAnswers } from "../services/featureFlagReadCache";
import { inboxItemsEnabled } from "../services/inboxItemsLaunch";

/**
 * An app whose rollout is over answers its flag by what the deployment can
 * run (`answer`, the same for every server), instead of Feature Flag Admin.
 * Everything that asks the flag (the functions below, core's reads of
 * FirstPartyApp.flag, what agents and clients are told) gets that answer;
 * "on for a server" then only adds that the server still exists.
 */
export function answerAppFlagFromDeployment(flag: string, answer: () => boolean): void {
  answerFlagFromDeployment(flag, answer);
}

/** Whether `flag` is on for `serverId`. */
export async function appEnabled(serverId: ServerId, flag: string, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  return (await evaluateFeatureFlag({ key: flag, serverId }, opts?.executor)).enabled;
}

/** appEnabled for many servers, one answer per server in input order, in one batched evaluation. */
export async function appEnabledOn(serverIds: readonly ServerId[], flag: string, opts?: { executor?: DatabaseExecutor }): Promise<boolean[]> {
  if (serverIds.length === 0) return [];
  const answers = await evaluateFeatureFlags(serverIds.map((serverId) => ({ key: flag, serverId })), opts?.executor);
  return serverIds.map((_, index) => answers[index]?.enabled === true);
}

/**
 * appEnabledOn through this process's short flag cache (services/featureFlagReadCache.ts):
 * for hot reads that may be up to its TTL behind a change the notifier misses, never for a write.
 */
export async function appEnabledOnCached(serverIds: readonly ServerId[], flag: string): Promise<boolean[]> {
  if (serverIds.length === 0) return [];
  return cachedServerFlagAnswers(serverIds, flag, (missing) => appEnabledOn(missing as ServerId[], flag));
}

/**
 * Which of these servers exist and aren't soft-deleted, one answer per server
 * in input order, in one query. Also for an app's own cleanup of a deleted
 * server's objects.
 */
export async function liveServers(serverIds: readonly ServerId[], executor: DatabaseExecutor = getDb()): Promise<boolean[]> {
  if (serverIds.length === 0) return [];
  const distinct = [...new Set(serverIds)];
  const rows = await executor.select({ id: servers.id }).from(servers).where(and(inArray(servers.id, distinct), isNull(servers.deletedAt)));
  const live = new Set(rows.map((row) => row.id));
  return serverIds.map((serverId) => live.has(serverId));
}

/**
 * Whether this server exists and is closed (soft-deleted): what an app checks
 * before it clears a server's data (FirstPartyApp.purgeServer). False for a
 * live server and for one that doesn't exist.
 */
export async function isClosedServer(serverId: ServerId, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const rows = await executor.select({ id: servers.id }).from(servers).where(and(eq(servers.id, serverId), isNotNull(servers.deletedAt))).limit(1);
  return rows.length > 0;
}

/** appEnabled, and the server still exists: false for a soft-deleted server, whatever its flag says. */
export async function appEnabledOnLiveServer(serverId: ServerId, flag: string, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  return (await appEnabledOnLiveServers([serverId], flag, opts))[0]!;
}

/** appEnabledOn, and each server still exists (appEnabledOnLiveServer), in one query and one batched evaluation. */
export async function appEnabledOnLiveServers(serverIds: readonly ServerId[], flag: string, opts?: { executor?: DatabaseExecutor }): Promise<boolean[]> {
  if (serverIds.length === 0) return [];
  const [live, enabled] = await Promise.all([liveServers(serverIds, opts?.executor ?? getDb()), appEnabledOn(serverIds, flag, opts)]);
  return serverIds.map((_, index) => live[index]! && enabled[index]!);
}

/**
 * Whether agents' inbox items (RFC 081) are on for this server: its
 * `agent_inbox_items_v0` flag and the deployment's launch time
 * (services/inboxItemsLaunch.ts; an evaluation failure reads as off). Only
 * there are an app's notices about one object one inbox item, later ones
 * joining it without a new wake; elsewhere every notice is delivered on its
 * own. For an app whose notices only make sense as items.
 */
export function agentInboxItemsEnabled(serverId: ServerId): Promise<boolean> {
  return inboxItemsEnabled(serverId);
}
