import { and, eq, inArray, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { externalAppInstalls, externalAppRegistrations, externalChannelBindings } from "../db/schema";
import { refreshSlackConversationAuthority, type SlackBridgeProvisioningProvider } from "./slackBridgeProvisioningControlPlane";
import { evaluateFeatureFlag } from "./featureFlagService";
import { reconcileSlackChannelLifecycle, reserveSlackLifecycleVerification } from "./slackBindingLifecycleService";
import { slackLifecycleClockAt } from "./slackChannelLifecycleObservation";
import { readSlackPairRecoveryFence, type SlackPairRecoveryFence } from "./slackBridgePairQueue";

export const SLACK_LIFECYCLE_CHECKS_PER_PASS = 10;

/** Persist provider Retry-After for the whole installation, including other replicas. */
export async function deferSlackLifecycleInstall(db: Database, installId: string, retryAfterMs: number, now: Date): Promise<void> {
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0) return;
  const deadline = new Date(now.getTime() + retryAfterMs);
  if (!Number.isFinite(deadline.getTime())) return;
  await db.update(externalAppInstalls).set({
    slackLifecycleRetryNotBefore: sql`greatest(coalesce(${externalAppInstalls.slackLifecycleRetryNotBefore}, ${now}), ${deadline})`,
  }).where(eq(externalAppInstalls.id, installId));
}

/** Events API lacks unarchive subscriptions. Reuse the fleet-owned maintenance
 * pass; reserve bounded, durable checks before provider I/O. Errors never mean deletion. */
export async function recoverSlackLifecyclePauses(input: {
  db: Database; provider: SlackBridgeProvisioningProvider; now: Date;
  clock?(): Date;
  isRunHeld?(): Promise<boolean>;
  bindingId?: string;
  onError?(error: unknown): void;
}): Promise<void> {
  if (!input.provider.readConversationState) return;
  try {
    const rows = await input.db.select({ serverId: externalChannelBindings.serverId, registrationId: externalChannelBindings.registrationId,
      installId: externalAppInstalls.id, bindingId: externalChannelBindings.id,
      providerAuthorityId: externalAppInstalls.providerAuthorityId, providerConversationId: externalChannelBindings.providerConversationId,
      connectionEpoch: externalAppInstalls.connectionEpoch, bindingEpoch: externalChannelBindings.bindingEpoch })
      .from(externalChannelBindings)
      .innerJoin(externalAppInstalls, eq(externalAppInstalls.id, externalChannelBindings.installId))
      .innerJoin(externalAppRegistrations, eq(externalAppRegistrations.id, externalChannelBindings.registrationId))
      .where(and(eq(externalAppRegistrations.provider, "slack"), eq(externalAppRegistrations.state, "active"),
        eq(externalAppRegistrations.providerAppId, externalAppInstalls.providerAppId), eq(externalAppInstalls.state, "active"), isNotNull(externalAppInstalls.botUserId),
        or(isNull(externalAppInstalls.slackLifecycleRetryNotBefore), lte(externalAppInstalls.slackLifecycleRetryNotBefore, input.now)),
        or(and(eq(externalChannelBindings.state, "paused"),
          inArray(externalChannelBindings.stateReason, ["provider_channel_archived", "provider_bot_removed"])),
        and(eq(externalChannelBindings.state, "active"), input.bindingId ? sql`true` : sql`EXISTS (
          SELECT 1 FROM external_delivery_partitions p
          JOIN external_channel_bindings h ON p.binding_id = h.id::text
          JOIN external_app_installs hi ON hi.id = h.install_id
          WHERE h.registration_id = ${externalChannelBindings.registrationId}
            AND h.channel_id = ${externalChannelBindings.channelId}
            AND h.provider_conversation_id = ${externalChannelBindings.providerConversationId}
            AND hi.provider_authority_id = ${externalAppInstalls.providerAuthorityId}
            AND p.authority_blocked_reason IN ('slack_not_in_channel', 'binding_paused_bot_removed')
        )`)),
        input.bindingId ? eq(externalChannelBindings.id, input.bindingId)
          : sql`coalesce(${externalChannelBindings.slackLifecycleObservation}->'recovery'->>'nextCheckAt', '') <= ${input.now.toISOString()}`))
      .orderBy(sql`coalesce(${externalChannelBindings.slackLifecycleObservation}->'recovery'->>'nextCheckAt', '')`, externalChannelBindings.id)
      .limit(SLACK_LIFECYCLE_CHECKS_PER_PASS * 10);
    let calls = 0;
    for (const row of rows) {
      if (calls >= SLACK_LIFECYCLE_CHECKS_PER_PASS) break;
      if (input.isRunHeld && !await input.isRunHeld()) return;
      try {
        const now = input.clock?.() ?? input.now;
        const scope = await reserveSlackLifecycleVerification({ db: input.db, now, immediate: Boolean(input.bindingId),
          serverId: row.serverId, registrationId: row.registrationId, installId: row.installId,
          bindingId: row.bindingId, providerAuthorityId: row.providerAuthorityId,
          providerConversationId: row.providerConversationId,
          expectedConnectionEpoch: row.connectionEpoch, expectedBindingEpoch: row.bindingEpoch });
        if (!scope || (input.isRunHeld && !await input.isRunHeld())) continue;
        if (!(await evaluateFeatureFlag({ key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
          serverId: row.serverId }, input.db)).enabled) continue;
        const { binding, install } = scope;
        const requiresAudience = binding.stateReason === "provider_bot_removed" || binding.state === "active";
        const queueFence = requiresAudience ? await readSlackPairRecoveryFence(input.db, {
          bindingId: binding.id, bindingEpoch: binding.bindingEpoch,
        }) : null;
        if (requiresAudience && (!queueFence || queueFence.head?.state === "dispatching")) continue;
        calls++;
        const result = await input.provider.readConversationState({ installId: install.id, providerAppId: install.providerAppId,
          providerAuthorityId: install.providerAuthorityId, botUserId: install.botUserId!,
          connectionEpoch: install.connectionEpoch, credentialRevision: install.credentialRevision,
          providerConversationId: binding.providerConversationId, now, isRunHeld: input.isRunHeld });
        if (result.kind === "unverified" && result.retryAfterMs !== undefined) {
          await deferSlackLifecycleInstall(input.db, install.id, result.retryAfterMs, input.clock?.() ?? now);
        }
        if (result.kind !== "fact" || result.fact.id !== binding.providerConversationId || result.fact.isArchived) continue;
        if (input.isRunHeld && !await input.isRunHeld()) return;
        let verifiedAudience: { bindingEpoch: number; credentialRevision: number; audienceEventRevision: number; revision: number;
          queueFence: SlackPairRecoveryFence } | undefined;
        if (requiresAudience && queueFence) {
          const receipt = await refreshSlackConversationAuthority({ db: input.db, provider: input.provider,
            bindingId: binding.id, now: input.clock?.() ?? now, allowBotRemovedPause: true, isRunHeld: input.isRunHeld });
          if (receipt.retryAfterMs !== undefined) {
            await deferSlackLifecycleInstall(input.db, install.id, receipt.retryAfterMs, input.clock?.() ?? now);
          }
          if (!result.fact.isMember) continue;
          if (receipt.audienceStatus !== "matched" || receipt.revision === undefined || receipt.bindingEpoch === undefined
            || receipt.credentialRevision === undefined || receipt.audienceEventRevision === undefined) continue;
          verifiedAudience = { revision: receipt.revision, bindingEpoch: receipt.bindingEpoch,
            credentialRevision: receipt.credentialRevision, audienceEventRevision: receipt.audienceEventRevision, queueFence };
        }
        if (!result.fact.isMember) continue;
        if (input.isRunHeld && !await input.isRunHeld()) return;
        const verifiedAt = input.clock?.() ?? now;
        await reconcileSlackChannelLifecycle({ db: input.db, serverId: binding.serverId, registrationId: binding.registrationId,
          installId: install.id, bindingId: binding.id, providerAuthorityId: install.providerAuthorityId,
          providerConversationId: binding.providerConversationId, expectedConnectionEpoch: install.connectionEpoch,
          expectedBindingEpoch: binding.bindingEpoch, event: { kind: "available", name: result.fact.name },
          eventClock: slackLifecycleClockAt(verifiedAt), now: verifiedAt, ...(verifiedAudience ? { verifiedAudience } : {}) });
      } catch (error) { input.onError?.(error); }
    }
  } catch (error) { input.onError?.(error); }
}
