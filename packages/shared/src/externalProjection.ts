/**
 * Provider-neutral external actor/addressability contract.
 *
 * An external projection is display/search/addressability data. It is never a
 * Raft principal, member, role holder, task assignee, inbox recipient, or Agent
 * command authority.
 */

import { currentDate } from "./clock.js";

export const EXTERNAL_PROJECTION_CONTRACT_VERSION = "external-projection.v1" as const;

export type ExternalProjectionState = "active" | "tombstoned";
export type ExternalActorKind = "human" | "guest" | "remote" | "bot" | "unknown";
export type ExternalAddressabilityState = "active" | "removed" | "stale" | "revoked" | "quarantined";

export interface ExternalProjectionIdentity {
  projectionId: string;
  provider: string;
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  externalActorId: string;
}

export interface ExternalActorProjection extends ExternalProjectionIdentity {
  displayName: string;
  handles: readonly string[];
  state: ExternalProjectionState;
  actorKind: ExternalActorKind;
  deactivated: boolean;
}

/**
 * Immutable, human-facing attribution frozen with one canonical external
 * message. It intentionally contains no Raft principal or membership fields.
 */
export interface ExternalMessageAuthorProjection extends ExternalProjectionIdentity {
  externalConversationId: string;
  externalMessageId: string;
  displayName: string;
  actorKind: ExternalActorKind;
  avatarUrl: string | null;
  avatarDigest: string | null;
  actorProjectionRevision: number;
}

/**
 * Agent-visible provenance for ordinary external content. The payload remains
 * inert under sender_type=third_party_app and carries no task/mention/command
 * authority.
 */
export interface AgentVisibleExternalMessageProvenance {
  schema: "external-message-provenance.v1";
  provider: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  actor_id: string;
  actor_kind: ExternalActorKind;
  projection_id: string;
}

export interface ExternalAddressabilityContext {
  provider: string;
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  connectionEpoch: number;
  bindingId: string;
  bindingEpoch: number;
  conversationId: string;
  memberRevision: number;
  contextRevision: number;
}

export interface ExternalAddressabilityProjection {
  actor: ExternalActorProjection;
  context: ExternalAddressabilityContext;
  state: ExternalAddressabilityState;
  observedAt: string;
  expiresAt: string;
}

export type ExternalMentionResolutionReason =
  | "explicit_projection"
  | "unique_dangling_handle";

export type ExternalMentionRejectionReason =
  | "invalid_handle"
  | "raft_principal_collision"
  | "projection_not_found"
  | "projection_ambiguous"
  | "actor_not_active"
  | "actor_not_m0_addressable"
  | "membership_not_active"
  | "projection_stale"
  | "context_mismatch"
  | "no_external_match"
  | "ambiguous_external_match";

/**
 * Immutable send-time fact. Provider dispatch consumes the stable external ID
 * and frozen authority revisions; it must not re-resolve the handle.
 */
export interface ResolvedExternalMentionFact extends ExternalProjectionIdentity {
  connectionEpoch: number;
  bindingId: string;
  bindingEpoch: number;
  conversationId: string;
  memberRevision: number;
  contextRevision: number;
  freshnessObservedAt: string;
  freshnessExpiresAt: string;
  handleAtSendTime: string;
  resolutionReason: ExternalMentionResolutionReason;
}

export type ExternalMentionResolution =
  | {
      kind: "resolved";
      fact: ResolvedExternalMentionFact;
    }
  | {
      kind: "not_resolved";
      reason: ExternalMentionRejectionReason;
    };

export interface ResolveExternalMentionInput {
  rawHandle: string;
  /**
   * A structured external-projection selection. When absent, rawHandle is a
   * dangling handle and may resolve only if there is no Raft principal
   * collision and exactly one fresh external member match.
   */
  explicitProjectionId?: string | null;
  raftPrincipalCollision: boolean;
  context: ExternalAddressabilityContext;
  candidates: readonly ExternalAddressabilityProjection[];
  now?: Date;
}

export function normalizeExternalHandle(rawHandle: string): string | null {
  const normalized = rawHandle
    .normalize("NFKC")
    .trim()
    .replace(/^@+/, "")
    .toLocaleLowerCase("en-US");
  if (normalized.length === 0 || normalized.length > 80) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) return null;
  return normalized;
}

function contextMatches(
  candidate: ExternalAddressabilityProjection,
  expected: ExternalAddressabilityContext,
): boolean {
  const actor = candidate.actor;
  const actual = candidate.context;
  return actor.provider === actual.provider
    && actor.appRegistrationId === actual.appRegistrationId
    && actor.installId === actual.installId
    && actor.workspaceId === actual.workspaceId
    && actual.provider === expected.provider
    && actual.appRegistrationId === expected.appRegistrationId
    && actual.installId === expected.installId
    && actual.workspaceId === expected.workspaceId
    && actual.connectionEpoch === expected.connectionEpoch
    && actual.bindingId === expected.bindingId
    && actual.bindingEpoch === expected.bindingEpoch
    && actual.conversationId === expected.conversationId
    && actual.memberRevision === expected.memberRevision
    && actual.contextRevision === expected.contextRevision;
}

function freshnessReason(
  candidate: ExternalAddressabilityProjection,
  expected: ExternalAddressabilityContext,
  nowMs: number,
): ExternalMentionRejectionReason | null {
  if (!contextMatches(candidate, expected)) return "context_mismatch";
  if (candidate.actor.state !== "active" || candidate.actor.deactivated) return "actor_not_active";
  if (candidate.actor.actorKind !== "human") return "actor_not_m0_addressable";
  if (candidate.state !== "active") return "membership_not_active";

  const observedAtMs = Date.parse(candidate.observedAt);
  const expiresAtMs = Date.parse(candidate.expiresAt);
  if (
    !Number.isFinite(observedAtMs)
    || !Number.isFinite(expiresAtMs)
    || observedAtMs > nowMs
    || expiresAtMs <= nowMs
    || expiresAtMs <= observedAtMs
  ) {
    return "projection_stale";
  }
  return null;
}

function toMentionFact(
  candidate: ExternalAddressabilityProjection,
  rawHandle: string,
  resolutionReason: ExternalMentionResolutionReason,
): ResolvedExternalMentionFact {
  return {
    projectionId: candidate.actor.projectionId,
    provider: candidate.actor.provider,
    appRegistrationId: candidate.actor.appRegistrationId,
    installId: candidate.actor.installId,
    workspaceId: candidate.actor.workspaceId,
    externalActorId: candidate.actor.externalActorId,
    connectionEpoch: candidate.context.connectionEpoch,
    bindingId: candidate.context.bindingId,
    bindingEpoch: candidate.context.bindingEpoch,
    conversationId: candidate.context.conversationId,
    memberRevision: candidate.context.memberRevision,
    contextRevision: candidate.context.contextRevision,
    freshnessObservedAt: candidate.observedAt,
    freshnessExpiresAt: candidate.expiresAt,
    handleAtSendTime: rawHandle,
    resolutionReason,
  };
}

function firstRejectionReason(
  candidates: readonly ExternalAddressabilityProjection[],
  expected: ExternalAddressabilityContext,
  nowMs: number,
): ExternalMentionRejectionReason {
  const reasons = candidates.map((candidate) => freshnessReason(candidate, expected, nowMs));
  const precedence: readonly ExternalMentionRejectionReason[] = [
    "context_mismatch",
    "actor_not_active",
    "actor_not_m0_addressable",
    "membership_not_active",
    "projection_stale",
  ];
  return precedence.find((reason) => reasons.includes(reason)) ?? "projection_stale";
}

export function resolveExternalMention(input: ResolveExternalMentionInput): ExternalMentionResolution {
  const normalizedHandle = normalizeExternalHandle(input.rawHandle);
  if (!normalizedHandle) {
    return { kind: "not_resolved", reason: "invalid_handle" };
  }

  const nowMs = (input.now ?? currentDate()).getTime();
  if (!Number.isFinite(nowMs)) {
    return { kind: "not_resolved", reason: "projection_stale" };
  }

  if (input.explicitProjectionId) {
    const selected = input.candidates.filter(
      (candidate) => candidate.actor.projectionId === input.explicitProjectionId,
    );
    if (selected.length === 0) return { kind: "not_resolved", reason: "projection_not_found" };

    const eligible = selected.filter(
      (candidate) => freshnessReason(candidate, input.context, nowMs) === null,
    );
    if (eligible.length > 1) return { kind: "not_resolved", reason: "projection_ambiguous" };
    if (eligible.length === 0) {
      return {
        kind: "not_resolved",
        reason: firstRejectionReason(selected, input.context, nowMs),
      };
    }
    return {
      kind: "resolved",
      fact: toMentionFact(eligible[0]!, input.rawHandle, "explicit_projection"),
    };
  }

  if (input.raftPrincipalCollision) {
    return { kind: "not_resolved", reason: "raft_principal_collision" };
  }

  const handleMatches = input.candidates.filter((candidate) =>
    candidate.actor.handles.some((handle) => normalizeExternalHandle(handle) === normalizedHandle)
  );
  if (handleMatches.length === 0) {
    return { kind: "not_resolved", reason: "no_external_match" };
  }

  const eligible = handleMatches.filter(
    (candidate) => freshnessReason(candidate, input.context, nowMs) === null,
  );
  if (eligible.length > 1) {
    return { kind: "not_resolved", reason: "ambiguous_external_match" };
  }
  if (eligible.length === 0) {
    return {
      kind: "not_resolved",
      reason: firstRejectionReason(handleMatches, input.context, nowMs),
    };
  }

  return {
    kind: "resolved",
    fact: toMentionFact(eligible[0]!, input.rawHandle, "unique_dangling_handle"),
  };
}
