import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  externalAppInstalls,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
} from "../db/schema.js";

export type SlackBindingProductState = "connected" | "paused" | "disconnected";

export type SlackBindingRecoveryAction =
  | "none"
  | "unarchive_slack_channel"
  | "select_replacement_slack_channel"
  | "reinstall_slack_app"
  | "reauthorize_slack_app"
  | "review_and_resume_binding";

export interface SlackBindingLifecycleProjection {
  state: SlackBindingProductState;
  reason: string | null;
  recoveryAction: SlackBindingRecoveryAction;
}

export type SlackChannelLifecycleEvent = "channel_archived" | "channel_deleted";

export type SlackChannelLifecycleResult =
  | {
      kind: "applied" | "unchanged";
      bindingId: string;
      bindingEpoch: number;
      projection: SlackBindingLifecycleProjection;
    }
  | { kind: "fence_mismatch" };

export type SlackAudienceObservation =
  | {
      kind: "observed";
      /** Slack member ids returned by the provider for this exact channel. */
      externalMemberIds: readonly string[];
      /**
       * Slack member ids mapped one-to-one from current Raft channel principals
       * by an explicit identity authority. External actor/addressability
       * projections only validate those mapped provider identities; they never
       * grant Raft access. Raft principal ids are never compared to Slack ids.
       */
      raftAuthorizedProviderMemberIds: readonly string[];
    }
  | {
      kind: "unavailable";
      reason:
        | "authority_quarantined"
        | "credential_unavailable"
        | "identity_mapping_unavailable"
        | "provider_rate_limited"
        | "provider_unavailable";
    };

export type SlackAudienceReconciliationResult =
  | {
      kind: "recorded";
      status: "matched" | "mismatch" | "unavailable";
      audienceRevision: number;
      externalMemberCount: number;
      raftMemberCount: number;
    }
  | { kind: "fence_mismatch" | "not_private" | "invalid_observation" };

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function canonicalMemberIds(values: readonly string[]): string[] | null {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value.length === 0 || value.length > 160)) return null;
  return [...new Set(normalized)].sort();
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function projectSlackBindingLifecycle(input: {
  installState: typeof externalAppInstalls.$inferSelect["state"];
  installStateReason: string | null;
  bindingState: typeof externalChannelBindings.$inferSelect["state"];
  bindingStateReason: string | null;
}): SlackBindingLifecycleProjection {
  if (input.installState !== "active") {
    const recoveryAction = input.installState === "reauth_required"
      ? "reauthorize_slack_app"
      : input.installState === "revoked" || input.installState === "disconnected"
        ? "reinstall_slack_app"
        : "review_and_resume_binding";
    return {
      state: "disconnected",
      reason: input.installStateReason,
      recoveryAction,
    };
  }
  if (input.bindingState === "revoked") {
    return {
      state: "disconnected",
      reason: input.bindingStateReason,
      recoveryAction: input.bindingStateReason === "provider_app_uninstalled"
        ? "reinstall_slack_app"
        : "review_and_resume_binding",
    };
  }
  if (input.bindingState === "paused" || input.bindingState === "quarantined") {
    const recoveryAction = input.bindingStateReason === "provider_channel_archived"
      ? "unarchive_slack_channel"
      : input.bindingStateReason === "provider_channel_deleted"
        ? "select_replacement_slack_channel"
        : "review_and_resume_binding";
    return {
      state: "paused",
      reason: input.bindingStateReason,
      recoveryAction,
    };
  }
  return { state: "connected", reason: null, recoveryAction: "none" };
}

/**
 * Applies a signed Slack channel lifecycle fact to one exact binding epoch.
 * The Raft channel and channel membership rows are intentionally outside this
 * write set: a provider-side archive/delete may pause the bridge only.
 */
export async function reconcileSlackChannelLifecycle(input: {
  serverId: string;
  registrationId: string;
  installId: string;
  bindingId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  expectedConnectionEpoch: number;
  expectedBindingEpoch: number;
  event: SlackChannelLifecycleEvent;
  now: Date;
}): Promise<SlackChannelLifecycleResult> {
  if (
    !Number.isFinite(input.now.getTime())
    || !Number.isSafeInteger(input.expectedConnectionEpoch)
    || input.expectedConnectionEpoch <= 0
    || !Number.isSafeInteger(input.expectedBindingEpoch)
    || input.expectedBindingEpoch <= 0
  ) return { kind: "fence_mismatch" };

  return getDb().transaction(async (tx) => {
    const [binding] = await tx.select().from(externalChannelBindings).where(and(
      eq(externalChannelBindings.id, input.bindingId),
      eq(externalChannelBindings.serverId, input.serverId),
      eq(externalChannelBindings.registrationId, input.registrationId),
      eq(externalChannelBindings.installId, input.installId),
      eq(externalChannelBindings.providerConversationId, input.providerConversationId),
      eq(externalChannelBindings.connectionEpoch, input.expectedConnectionEpoch),
      eq(externalChannelBindings.bindingEpoch, input.expectedBindingEpoch),
    )).for("update").limit(1);
    if (!binding) return { kind: "fence_mismatch" } as const;

    const [install] = await tx.select().from(externalAppInstalls).where(and(
      eq(externalAppInstalls.id, input.installId),
      eq(externalAppInstalls.registrationId, input.registrationId),
      eq(externalAppInstalls.serverId, input.serverId),
      eq(externalAppInstalls.providerAuthorityId, input.providerAuthorityId),
      eq(externalAppInstalls.connectionEpoch, input.expectedConnectionEpoch),
    )).for("update").limit(1);
    if (!install) return { kind: "fence_mismatch" } as const;

    const reason = input.event === "channel_archived"
      ? "provider_channel_archived"
      : "provider_channel_deleted";
    const appliesToActive = binding.state === "active";
    const strengthensArchivedToDeleted = binding.state === "paused"
      && binding.stateReason === "provider_channel_archived"
      && reason === "provider_channel_deleted";
    if (install.state !== "active" || (!appliesToActive && !strengthensArchivedToDeleted)) {
      return {
        kind: "unchanged",
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
        projection: projectSlackBindingLifecycle({
          installState: install.state,
          installStateReason: install.stateReason,
          bindingState: binding.state,
          bindingStateReason: binding.stateReason,
        }),
      } as const;
    }

    const nextBindingEpoch = binding.bindingEpoch + 1;
    const [updated] = await tx.update(externalChannelBindings).set({
      state: "paused",
      stateReason: reason,
      bindingEpoch: nextBindingEpoch,
      updatedAt: input.now,
    }).where(and(
      eq(externalChannelBindings.id, binding.id),
      eq(externalChannelBindings.state, binding.state),
      binding.stateReason === null
        ? isNull(externalChannelBindings.stateReason)
        : eq(externalChannelBindings.stateReason, binding.stateReason),
      eq(externalChannelBindings.connectionEpoch, input.expectedConnectionEpoch),
      eq(externalChannelBindings.bindingEpoch, input.expectedBindingEpoch),
    )).returning({ id: externalChannelBindings.id });
    if (!updated) return { kind: "fence_mismatch" } as const;

    return {
      kind: "applied",
      bindingId: binding.id,
      bindingEpoch: nextBindingEpoch,
      projection: projectSlackBindingLifecycle({
        installState: install.state,
        installStateReason: install.stateReason,
        bindingState: "paused",
        bindingStateReason: reason,
      }),
    } as const;
  });
}

/**
 * Appends one exact private-channel audience observation and advances the
 * binding to that revision under an epoch/revision compare-and-set. The input
 * already contains provider ids resolved by the identity authority; this
 * function only compares and records them and cannot mutate either system's
 * membership.
 */
export async function reconcileSlackPrivateAudience(input: {
  serverId: string;
  bindingId: string;
  expectedConnectionEpoch: number;
  expectedBindingEpoch: number;
  expectedAudienceRevision: number;
  observation: SlackAudienceObservation;
  observedAt: Date;
  expiresAt: Date;
}): Promise<SlackAudienceReconciliationResult> {
  if (
    !Number.isFinite(input.observedAt.getTime())
    || !Number.isFinite(input.expiresAt.getTime())
    || input.expiresAt <= input.observedAt
    || !Number.isSafeInteger(input.expectedAudienceRevision)
    || input.expectedAudienceRevision <= 0
  ) return { kind: "invalid_observation" };

  let status: "matched" | "mismatch" | "unavailable";
  let externalMemberCount: number;
  let raftMemberCount: number;
  let externalAudienceDigest: string;
  let raftAudienceDigest: string;
  if (input.observation.kind === "unavailable") {
    status = "unavailable";
    externalMemberCount = 0;
    raftMemberCount = 0;
    externalAudienceDigest = sha256([
      "slack-external-audience-unavailable",
      input.observation.reason,
    ]);
    raftAudienceDigest = sha256([
      "raft-authorized-audience-unavailable",
      input.observation.reason,
    ]);
  } else {
    const external = canonicalMemberIds(input.observation.externalMemberIds);
    const authorized = canonicalMemberIds(
      input.observation.raftAuthorizedProviderMemberIds,
    );
    if (!external || !authorized) return { kind: "invalid_observation" };
    status = exactStrings(external, authorized) ? "matched" : "mismatch";
    externalMemberCount = external.length;
    raftMemberCount = authorized.length;
    externalAudienceDigest = sha256(["slack-external-audience", external]);
    raftAudienceDigest = sha256(["raft-authorized-provider-audience", authorized]);
  }

  const nextAudienceRevision = input.expectedAudienceRevision + 1;
  return getDb().transaction(async (tx) => {
    const [binding] = await tx.select({
      privacyClass: externalChannelBindings.privacyClass,
      audienceRevision: externalChannelBindings.audienceRevision,
    }).from(externalChannelBindings).where(and(
      eq(externalChannelBindings.id, input.bindingId),
      eq(externalChannelBindings.serverId, input.serverId),
      eq(externalChannelBindings.connectionEpoch, input.expectedConnectionEpoch),
      eq(externalChannelBindings.bindingEpoch, input.expectedBindingEpoch),
      eq(externalChannelBindings.audienceRevision, input.expectedAudienceRevision),
    )).for("update").limit(1);
    if (!binding) return { kind: "fence_mismatch" } as const;
    if (binding.privacyClass !== "private") return { kind: "not_private" } as const;

    const [updated] = await tx.update(externalChannelBindings).set({
      audienceRevision: nextAudienceRevision,
      audienceFreshUntil: input.expiresAt,
      updatedAt: input.observedAt,
    }).where(and(
      eq(externalChannelBindings.id, input.bindingId),
      eq(externalChannelBindings.connectionEpoch, input.expectedConnectionEpoch),
      eq(externalChannelBindings.bindingEpoch, input.expectedBindingEpoch),
      eq(externalChannelBindings.audienceRevision, input.expectedAudienceRevision),
    )).returning({ id: externalChannelBindings.id });
    if (!updated) return { kind: "fence_mismatch" } as const;

    await tx.insert(externalBindingAudienceSnapshots).values({
      bindingId: input.bindingId,
      bindingEpoch: input.expectedBindingEpoch,
      audienceRevision: nextAudienceRevision,
      externalMemberCount,
      externalAudienceDigest,
      raftMemberCount,
      raftAudienceDigest,
      status,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
    });
    return {
      kind: "recorded",
      status,
      audienceRevision: nextAudienceRevision,
      externalMemberCount,
      raftMemberCount,
    } as const;
  });
}

export async function readSlackBindingLifecycleProjection(input: {
  serverId: string;
  bindingId: string;
}, db: DatabaseExecutor = getDb()): Promise<SlackBindingLifecycleProjection | null> {
  const [row] = await db.select({
    installState: externalAppInstalls.state,
    installStateReason: externalAppInstalls.stateReason,
    bindingState: externalChannelBindings.state,
    bindingStateReason: externalChannelBindings.stateReason,
  }).from(externalChannelBindings).innerJoin(
    externalAppInstalls,
    eq(externalAppInstalls.id, externalChannelBindings.installId),
  ).where(and(
    eq(externalChannelBindings.id, input.bindingId),
    eq(externalChannelBindings.serverId, input.serverId),
  )).limit(1);
  return row ? projectSlackBindingLifecycle(row) : null;
}
