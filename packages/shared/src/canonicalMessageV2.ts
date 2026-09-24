import { CANONICAL_MESSAGE_MANIFEST_VERSION } from "./canonicalMessageManifest.js";
import type { SyncScopeKey } from "@botiverse/raft-sync-core";

/**
 * RFC 043 Appendix B normalized message envelope.
 *
 * V1 remains the wire-faithful shadow contract. Its reaction roster is an
 * ingress DTO only and is never eligible to become the authoritative
 * sole-apply fact.
 */
export const CANONICAL_FACT_SOLE_APPLY_ELIGIBLE = false as const;
export const CANONICAL_MESSAGE_V2_SCHEMA_VERSION = 5 as const;
export const CANONICAL_MESSAGE_V2_ENVELOPE_KIND = "normalized-message-v2" as const;
export const CANONICAL_REACTION_PREVIEW_LIMIT = 3 as const;
export const CANONICAL_REACTION_LIMIT = 30 as const;

/** Current server wire. Keep this name at ingress so roster fields cannot be
 * mistaken for the normalized canonical model. */
export interface LegacyReactionRosterDto {
  emoji: string;
  count: number;
  reactorIds: readonly string[];
  reactorNames: readonly string[];
}

export interface ReactionActorRef {
  id: string;
  displayName: string;
}

/** Shared message fact. Full actor rosters and viewer identity are excluded. */
export interface CanonicalReactionFact {
  emoji: string;
  count: number;
  previewK: readonly ReactionActorRef[];
}

/** Receiver-private complete snapshot for one message. `null` at normalization
 * means unknown/not-authoritative (for example a channel-room frame). */
export interface ReactionViewerOverlaySnapshot {
  serverId: string;
  messageId: string;
  completeness: "complete";
  reactedEmojis: readonly string[];
}

/** Compatibility seed only. This is bounded/evictable read-cache material,
 * not part of the canonical message fact. */
export interface ReactionActorsReadCacheSeed {
  parentScopeKey: SyncScopeKey;
  messageId: string;
  emoji: string;
  actors: readonly ReactionActorRef[];
  completeness: "complete";
}

export type LegacyReactionNormalizationSource =
  | "channel-room"
  | "receiver-private";

export interface NormalizeLegacyReactionRosterInput {
  serverId: string;
  parentScopeKey: SyncScopeKey;
  messageId: string;
  source: LegacyReactionNormalizationSource;
  viewerUserId?: string | null;
  reactions: readonly LegacyReactionRosterDto[];
}

export interface NormalizeLegacyReactionRosterResult {
  sharedFact: readonly CanonicalReactionFact[];
  viewerOverlay: ReactionViewerOverlaySnapshot | null;
  readCacheSeed: readonly ReactionActorsReadCacheSeed[];
  violations: readonly ReactionNormalizationViolation[];
}

export type ReactionNormalizationViolationKind =
  | "duplicate_emoji"
  | "empty_emoji"
  | "invalid_count"
  | "parallel_roster_length_mismatch"
  | "empty_actor_id"
  | "duplicate_actor_id"
  | "empty_actor_display_name"
  | "actor_count_mismatch";

export interface ReactionNormalizationViolation {
  kind: ReactionNormalizationViolationKind;
  emoji: string;
}

/** Machine-readable normalized contract. The V1 producer manifest remains a
 * separate raw-wire ledger until the server dual-track cut lands. */
export const CANONICAL_MESSAGE_V2_MANIFEST = Object.freeze({
  schemaVersion: CANONICAL_MESSAGE_V2_SCHEMA_VERSION,
  envelopeKind: CANONICAL_MESSAGE_V2_ENVELOPE_KIND,
  legacyIngressManifestVersion: CANONICAL_MESSAGE_MANIFEST_VERSION,
  soleApplyEligible: true,
  reactions: Object.freeze({
    mergePolicy: "present-overwrite",
    maxItems: CANONICAL_REACTION_LIMIT,
    fields: Object.freeze(["count", "emoji", "previewK"] as const),
    previewFields: Object.freeze(["displayName", "id"] as const),
    previewLimit: CANONICAL_REACTION_PREVIEW_LIMIT,
    legacyCompatibilityPreviewPolicy: "empty-without-room-common-provenance",
    deterministicOrder: "emoji-code-unit/actor-id-code-unit",
  }),
  viewerOverlayFields: Object.freeze(["reactions.reactedByMe"] as const),
  readCacheRelations: Object.freeze(["Message.ReactionActors"] as const),
  forbiddenCanonicalPaths: Object.freeze([
    "reactions[].reactorIds",
    "reactions[].reactorNames",
  ] as const),
});

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function validateActorRoster(reaction: LegacyReactionRosterDto): {
  actors: ReactionActorRef[] | null;
  violations: ReactionNormalizationViolation[];
} {
  const violations: ReactionNormalizationViolation[] = [];
  if (reaction.reactorIds.length !== reaction.reactorNames.length) {
    violations.push({ kind: "parallel_roster_length_mismatch", emoji: reaction.emoji });
  }

  const actors: ReactionActorRef[] = [];
  const actorIds = new Set<string>();
  for (let index = 0; index < reaction.reactorIds.length; index += 1) {
    const id = reaction.reactorIds[index]?.trim();
    if (!id) {
      violations.push({ kind: "empty_actor_id", emoji: reaction.emoji });
      continue;
    }
    if (actorIds.has(id)) {
      violations.push({ kind: "duplicate_actor_id", emoji: reaction.emoji });
      continue;
    }
    actorIds.add(id);
    const displayName = reaction.reactorNames[index]?.trim();
    if (!displayName) {
      violations.push({ kind: "empty_actor_display_name", emoji: reaction.emoji });
      continue;
    }
    actors.push({ id, displayName });
  }
  if (actors.length !== reaction.count) {
    violations.push({ kind: "actor_count_mismatch", emoji: reaction.emoji });
  }
  if (violations.length > 0) return { actors: null, violations };
  return { actors: actors.sort((a, b) => compareCodeUnits(a.id, b.id)), violations: [] };
}

function compareReactionFacts(a: CanonicalReactionFact, b: CanonicalReactionFact): number {
  const emojiOrder = compareCodeUnits(a.emoji, b.emoji);
  if (emojiOrder !== 0) return emojiOrder;
  if (a.count !== b.count) return a.count - b.count;
  return compareCodeUnits(JSON.stringify(a.previewK), JSON.stringify(b.previewK));
}

/**
 * Split the V1 roster in one pure ingress operation. Channel-room input may
 * seed shared facts and actor detail, but can never write receiver-private
 * viewer state.
 */
export function normalizeLegacyReactionRoster(
  input: NormalizeLegacyReactionRosterInput,
): NormalizeLegacyReactionRosterResult {
  const emojiCounts = new Map<string, number>();
  for (const reaction of input.reactions) {
    const emoji = reaction.emoji.trim();
    emojiCounts.set(emoji, (emojiCounts.get(emoji) ?? 0) + 1);
  }
  const violations: ReactionNormalizationViolation[] = [];
  const rows = input.reactions.flatMap((rawReaction) => {
    const reaction = { ...rawReaction, emoji: rawReaction.emoji.trim() };
    if (!reaction.emoji) {
      violations.push({ kind: "empty_emoji", emoji: reaction.emoji });
      return [];
    }
    if (emojiCounts.get(reaction.emoji) !== 1) {
      if (!violations.some((violation) => (
        violation.kind === "duplicate_emoji" && violation.emoji === reaction.emoji
      ))) {
        violations.push({ kind: "duplicate_emoji", emoji: reaction.emoji });
      }
      return [];
    }
    if (!Number.isSafeInteger(reaction.count) || reaction.count < 0) {
      violations.push({ kind: "invalid_count", emoji: reaction.emoji });
      return [];
    }
    const actorValidation = validateActorRoster(reaction);
    violations.push(...actorValidation.violations);
    const actors = actorValidation.actors;
    return {
      fact: {
        emoji: reaction.emoji,
        count: reaction.count,
        // A per-receiver legacy roster has no proof that actor names are safe
        // for every principal in the room. Only a future producer-provided
        // room-common preview may populate the shared canonical preview.
        previewK: [],
      } satisfies CanonicalReactionFact,
      viewerReacted: !!(
        actors
        && input.viewerUserId
        && actors.some((actor) => actor.id === input.viewerUserId)
      ),
      readCache: actors
        ? {
            parentScopeKey: { ...input.parentScopeKey },
            messageId: input.messageId,
            emoji: reaction.emoji,
            actors,
            completeness: "complete",
          } satisfies ReactionActorsReadCacheSeed
        : null,
    };
  });

  rows.sort((a, b) => compareReactionFacts(a.fact, b.fact));
  return {
    sharedFact: rows.map((row) => row.fact),
    viewerOverlay: input.source === "receiver-private"
      && !!input.viewerUserId
      && violations.length === 0
      ? {
          serverId: input.serverId,
          messageId: input.messageId,
          completeness: "complete",
          reactedEmojis: rows.filter((row) => row.viewerReacted).map((row) => row.fact.emoji),
        }
      : null,
    readCacheSeed: rows.flatMap((row) => row.readCache ? [row.readCache] : []),
    violations,
  };
}

/** Explicit field projection makes roster leakage impossible even if a caller
 * passes structurally wider runtime objects. */
export function canonicalReactionFactsJson(
  reactions: readonly CanonicalReactionFact[],
): string {
  const projected = reactions.map((reaction) => ({
    emoji: reaction.emoji,
    count: reaction.count,
    previewK: reaction.previewK.slice(0, CANONICAL_REACTION_PREVIEW_LIMIT).map((actor) => ({
      id: actor.id,
      displayName: actor.displayName,
    })),
  })).sort(compareReactionFacts);
  return `${JSON.stringify(projected)}\n`;
}

/** Neutral cross-platform receiver projection. `null` serializes explicitly so
 * channel-room/invalid unknown can never be confused with an authoritative
 * receiver-private empty snapshot. */
export function reactionViewerOverlaySnapshotJson(
  snapshot: ReactionViewerOverlaySnapshot | null,
): string {
  const projected = snapshot === null
    ? null
    : {
        serverId: snapshot.serverId,
        messageId: snapshot.messageId,
        completeness: snapshot.completeness,
        reactedEmojis: [...snapshot.reactedEmojis],
      };
  return `${JSON.stringify(projected)}\n`;
}

export interface CanonicalMessageV2Envelope {
  schemaVersion: typeof CANONICAL_MESSAGE_V2_SCHEMA_VERSION;
  kind: typeof CANONICAL_MESSAGE_V2_ENVELOPE_KIND;
  fact: {
    reactions?: readonly CanonicalReactionFact[];
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  return actual.length === keys.length
    && actual.every((key, index) => key === [...keys].sort(compareCodeUnits)[index]);
}

function isReactionActorRef(value: unknown): value is ReactionActorRef {
  const record = value as Record<string, unknown>;
  return !!value
    && typeof value === "object"
    && hasExactKeys(record, ["displayName", "id"])
    && typeof record.id === "string"
    && record.id.length > 0
    && record.id === record.id.trim()
    && typeof record.displayName === "string"
    && record.displayName.length > 0
    && record.displayName === record.displayName.trim();
}

function isCanonicalReactionFact(value: unknown): value is CanonicalReactionFact {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, ["count", "emoji", "previewK"])
    && typeof record.emoji === "string"
    && record.emoji.length > 0
    && record.emoji === record.emoji.trim()
    && typeof record.count === "number"
    && Number.isSafeInteger(record.count)
    && record.count >= 0
    && Array.isArray(record.previewK)
    && record.previewK.length <= CANONICAL_REACTION_PREVIEW_LIMIT
    && record.previewK.length <= record.count
    && record.previewK.every(isReactionActorRef);
}

function isStrictlyIncreasing(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareCodeUnits(values[index - 1]!, value) < 0);
}

/** Sole-apply tripwire: a V1/raw envelope or a wider reaction object is never
 * eligible merely because the legacy shadow feature flag is on. */
export function isCanonicalMessageV2SoleApplyEligible(
  value: unknown,
): value is CanonicalMessageV2Envelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  if (!hasExactKeys(envelope, ["fact", "kind", "schemaVersion"])) return false;
  if (envelope.schemaVersion !== CANONICAL_MESSAGE_V2_SCHEMA_VERSION) return false;
  if (envelope.kind !== CANONICAL_MESSAGE_V2_ENVELOPE_KIND) return false;
  if (!envelope.fact || typeof envelope.fact !== "object") return false;
  const fact = envelope.fact as Record<string, unknown>;
  if (!hasExactKeys(fact, ["reactions"])) return false;
  const reactions = fact.reactions;
  if (!Array.isArray(reactions) || reactions.length > CANONICAL_REACTION_LIMIT) return false;
  if (!reactions.every(isCanonicalReactionFact)) return false;
  const facts = reactions as CanonicalReactionFact[];
  if (!isStrictlyIncreasing(facts.map((reaction) => reaction.emoji))) return false;
  return facts.every((reaction) => isStrictlyIncreasing(reaction.previewK.map((actor) => actor.id)));
}
