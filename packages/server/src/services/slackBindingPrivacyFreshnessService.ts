import { and, eq } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type Database, type DatabaseExecutor } from "../db/index";
import {
  externalAppInstalls,
  externalChannelBindings,
} from "../db/schema";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import {
  lookupSlackProviderConversation,
  type SlackProviderAuthorityFence,
} from "./slackProviderAdapter";
import { resolveExternalInstallServerGrantAuthority } from "./externalInstallServerGrantAuthority";

// Visibility is per-platform (yezizp, task #241): a channel flipping
// public/private on either side is recorded, never paused. The historical
// stateReason values "privacy_changed_reconfirmation_required" and
// "raft_privacy_mismatch" remain readable on old rows.

const DEFAULT_PRIVACY_FRESHNESS_MS = 10 * 60_000;

export function slackPrivacyFreshUntil(
  now: Date,
  freshnessMs = DEFAULT_PRIVACY_FRESHNESS_MS,
): Date {
  if (!validDate(now) || !Number.isSafeInteger(freshnessMs) || freshnessMs <= 0) {
    throw new Error("Slack privacy freshness input is invalid");
  }
  return new Date(now.getTime() + freshnessMs);
}

export type SlackBindingPrivacyRefreshReceipt =
  | { kind: "fresh"; bindingId: string; privacyClass: "public" | "private"; freshUntil: Date }
  | { kind: "changed"; bindingId: string; privacyClass: "public" | "private"; freshUntil: Date }
  | { kind: "unavailable"; bindingId: string; reason: string; retryAfterMs?: number }
  | { kind: "missing"; bindingId: string };

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function loadAuthority(executor: DatabaseExecutor, bindingId: string) {
  const rows = await executor.select({
    bindingId: externalChannelBindings.id,
    bindingState: externalChannelBindings.state,
    bindingEpoch: externalChannelBindings.bindingEpoch,
    bindingGrantEpoch: externalChannelBindings.grantEpoch,
    serverId: externalChannelBindings.serverId,
    registrationId: externalChannelBindings.registrationId,
    providerConversationId: externalChannelBindings.providerConversationId,
    privacyClass: externalChannelBindings.privacyClass,
    installId: externalAppInstalls.id,
    installState: externalAppInstalls.state,
    providerAppId: externalAppInstalls.providerAppId,
    providerAuthorityId: externalAppInstalls.providerAuthorityId,
    connectionEpoch: externalAppInstalls.connectionEpoch,
    credentialRevision: externalAppInstalls.credentialRevision,
  }).from(externalChannelBindings)
    .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
    .where(eq(externalChannelBindings.id, bindingId))
    .limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.bindingState !== "active" || row.installState !== "active") return null;
  return row;
}

type PrivacyAuthority = NonNullable<Awaited<ReturnType<typeof loadAuthority>>>;

async function lockCurrentPrivacyWriteAuthority(
  executor: DatabaseExecutor,
  frozen: PrivacyAuthority,
) {
  // Global binding-consumer lock order: binding first, then the shared-install
  // association/current grant. Reversing these two locks creates a deadlock
  // cycle with audience, lifecycle, and credential-lease transactions.
  const bindings = await executor.select({
    bindingId: externalChannelBindings.id,
    serverId: externalChannelBindings.serverId,
    registrationId: externalChannelBindings.registrationId,
    installId: externalChannelBindings.installId,
    bindingGrantEpoch: externalChannelBindings.grantEpoch,
  }).from(externalChannelBindings).where(and(
    eq(externalChannelBindings.id, frozen.bindingId),
    eq(externalChannelBindings.serverId, frozen.serverId),
    eq(externalChannelBindings.registrationId, frozen.registrationId),
    eq(externalChannelBindings.installId, frozen.installId),
    eq(externalChannelBindings.providerConversationId, frozen.providerConversationId),
    eq(externalChannelBindings.privacyClass, frozen.privacyClass),
    eq(externalChannelBindings.state, "active"),
    eq(externalChannelBindings.grantEpoch, frozen.bindingGrantEpoch),
    eq(externalChannelBindings.connectionEpoch, frozen.connectionEpoch),
    eq(externalChannelBindings.bindingEpoch, frozen.bindingEpoch),
  )).for("update").limit(2);
  if (bindings.length !== 1) return { kind: "fence_mismatch" as const };
  const binding = bindings[0]!;
  const serverAuthority = await resolveExternalInstallServerGrantAuthority(executor, {
    installId: binding.installId,
    serverId: binding.serverId,
    registrationId: binding.registrationId,
  }, { lock: true });
  if (!serverAuthority.current || binding.bindingGrantEpoch !== serverAuthority.grant.grantEpoch) {
    return { kind: "authority_quarantined" as const };
  }
  return { kind: "ready" as const, binding };
}

/**
 * Refreshes provider privacy without using audience freshness as a proxy.
 * Provider I/O happens before the write transaction so credential leasing and
 * binding row locks cannot deadlock each other. The final update is fenced by
 * the exact install/binding epochs observed before the call.
 */
export async function refreshSlackBindingPrivacy(input: {
  bindingId: string;
  provider: SlackBridgeProviderRuntime;
  db?: Database;
  now?: Date;
  freshnessMs?: number;
  isRunHeld?(): Promise<boolean>;
}): Promise<SlackBindingPrivacyRefreshReceipt> {
  const db = input.db ?? getDb();
  const now = input.now ?? currentDate();
  const freshnessMs = input.freshnessMs ?? DEFAULT_PRIVACY_FRESHNESS_MS;
  if (!validDate(now) || !Number.isSafeInteger(freshnessMs) || freshnessMs <= 0) {
    return { kind: "unavailable", bindingId: input.bindingId, reason: "invalid_clock" };
  }
  const row = await loadAuthority(db, input.bindingId);
  if (!row) return { kind: "missing", bindingId: input.bindingId };
  const serverAuthority = await resolveExternalInstallServerGrantAuthority(db, {
    installId: row.installId,
    serverId: row.serverId,
    registrationId: row.registrationId,
  });
  if (!serverAuthority.current || row.bindingGrantEpoch !== serverAuthority.grant.grantEpoch) {
    return { kind: "unavailable", bindingId: row.bindingId, reason: "authority_quarantined" };
  }
  const authority: SlackProviderAuthorityFence = {
    installId: row.installId,
    providerAppId: row.providerAppId,
    providerAuthorityId: row.providerAuthorityId,
    providerConversationId: row.providerConversationId,
    connectionEpoch: row.connectionEpoch,
    credentialRevision: row.credentialRevision,
    bindingId: row.bindingId,
    bindingEpoch: row.bindingEpoch,
  };
  const handle = await input.provider.credentialResolver.resolve({ authority, now });
  if (!handle) return { kind: "unavailable", bindingId: row.bindingId, reason: "credential_unavailable" };
  let observation;
  try {
    if (input.isRunHeld && !await input.isRunHeld()) {
      return { kind: "unavailable", bindingId: input.bindingId, reason: "fence_mismatch" };
    }
    observation = await lookupSlackProviderConversation({
      transport: input.provider.transport,
      quarantineSink: input.provider.quarantineSink,
      credentialHandle: handle,
      authority,
      providerConversationId: row.providerConversationId,
      now,
    });
  } finally {
    await input.provider.releaseCredential(handle);
  }
  if (observation.kind !== "fact") {
    return {
      kind: "unavailable",
      bindingId: row.bindingId,
      reason: observation.kind === "rate_limited" ? "provider_rate_limited" : observation.reason,
      ...(observation.kind === "rate_limited"
        ? { retryAfterMs: observation.retryAfterMs }
        : {}),
    };
  }
  if (input.isRunHeld && !await input.isRunHeld()) {
    return { kind: "unavailable", bindingId: input.bindingId, reason: "fence_mismatch" };
  }
  const privacyClass = observation.fact.privacyClass;
  const freshUntil = slackPrivacyFreshUntil(now, freshnessMs);
  return db.transaction(async (tx) => {
    const current = await lockCurrentPrivacyWriteAuthority(tx, row);
    if (current.kind !== "ready") {
      return { kind: "unavailable" as const, bindingId: row.bindingId, reason: current.kind };
    }
    if (privacyClass === row.privacyClass) {
      const [updated] = await tx.update(externalChannelBindings).set({
        privacyFreshUntil: freshUntil,
        updatedAt: now,
      }).where(and(
        eq(externalChannelBindings.id, row.bindingId),
        eq(externalChannelBindings.state, "active"),
        eq(externalChannelBindings.grantEpoch, row.bindingGrantEpoch),
        eq(externalChannelBindings.connectionEpoch, row.connectionEpoch),
        eq(externalChannelBindings.bindingEpoch, row.bindingEpoch),
      )).returning({ id: externalChannelBindings.id });
      return updated
        ? { kind: "fresh" as const, bindingId: row.bindingId, privacyClass, freshUntil }
        : { kind: "unavailable" as const, bindingId: row.bindingId, reason: "fence_mismatch" };
    }
    // Visibility changed: record the new class in place — no pause, no
    // re-confirmation. The binding keeps syncing; each platform's own
    // access control still applies.
    const [updated] = await tx.update(externalChannelBindings).set({
      privacyClass,
      providerConversationKind: privacyClass === "private" ? "private_channel" : "public_channel",
      privacyFreshUntil: freshUntil,
      updatedAt: now,
    }).where(and(
      eq(externalChannelBindings.id, row.bindingId),
      eq(externalChannelBindings.state, "active"),
      eq(externalChannelBindings.grantEpoch, row.bindingGrantEpoch),
      eq(externalChannelBindings.connectionEpoch, row.connectionEpoch),
      eq(externalChannelBindings.bindingEpoch, row.bindingEpoch),
    )).returning({ id: externalChannelBindings.id });
    return updated
      ? { kind: "changed" as const, bindingId: row.bindingId, privacyClass, freshUntil }
      : { kind: "unavailable" as const, bindingId: row.bindingId, reason: "fence_mismatch" };
  });
}

export function privacyIsFresh(freshUntil: Date | null, now: Date): boolean {
  return validDate(now) && freshUntil instanceof Date && freshUntil > now;
}

export async function refreshSlackChannelBindingsPrivacy(input: {
  serverId: string;
  channelId: string;
  provider: SlackBridgeProviderRuntime;
  db?: Database;
  now?: Date;
}): Promise<SlackBindingPrivacyRefreshReceipt[]> {
  const db = input.db ?? getDb();
  const rows = await db.select({ bindingId: externalChannelBindings.id })
    .from(externalChannelBindings)
    .where(and(
      eq(externalChannelBindings.serverId, input.serverId),
      eq(externalChannelBindings.channelId, input.channelId),
      eq(externalChannelBindings.state, "active"),
    ));
  const receipts: SlackBindingPrivacyRefreshReceipt[] = [];
  for (const row of rows) {
    receipts.push(await refreshSlackBindingPrivacy({
      bindingId: row.bindingId,
      provider: input.provider,
      db,
      ...(input.now ? { now: input.now } : {}),
    }));
  }
  return receipts;
}

