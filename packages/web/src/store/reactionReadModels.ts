import {
  messageReactionActorsDiscussion,
  messageRef,
  normalizeLegacyReactionRoster,
  reactionActorsDiscussionKey,
  syncScopeKeyString,
} from "@botiverse/raft-shared";
import type {
  CanonicalReactionFact,
  LegacyReactionRosterDto,
  MessageReactionActorsDiscussion,
  NormalizeLegacyReactionRosterResult,
  ReactionActorRef,
  ReactionNormalizationViolation,
  ReactionViewerOverlaySnapshot,
  SyncScopeKey,
} from "@botiverse/raft-shared";
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { registerServerReset } from "./serverResetRegistry";

export interface ReactionActorsCacheEntry {
  principalId: string;
  discussion: MessageReactionActorsDiscussion;
  actors: readonly ReactionActorRef[];
  completeness: "complete";
  discussionVersion: string | null;
  nextPageCursor: string | null;
  source: "legacy-roster" | "read-port";
}

export type ReactionActorsCacheRead =
  | { status: "missing" }
  | { status: "loaded"; entry: ReactionActorsCacheEntry };

export type ReactionViewerOverlayRead =
  | { status: "unknown" }
  | { status: "loaded"; reactedByMe: boolean };

interface ApplyLegacyReactionIngressInput {
  principalId: string;
  serverId: string;
  parentScopeKey: SyncScopeKey;
  messageId: string;
  source: "channel-room" | "receiver-private";
  viewerUserId?: string | null;
  reactions: readonly LegacyReactionRosterDto[];
}

export interface StagedLegacyReactionIngress {
  principalId: string;
  messageId: string;
  normalized: NormalizeLegacyReactionRosterResult;
}

export interface VersionedReactionViewerSnapshot {
  serverId: string;
  messageId: string;
  viewerVersion: number;
  reactedEmojis: readonly string[];
}

export type VersionedReactionViewerSnapshotOutcome =
  | { kind: "applied" }
  | { kind: "duplicate" }
  | { kind: "stale" }
  | { kind: "conflict"; reason: "malformed" | "equal-version-different-payload" | "principal-mismatch" };

export interface ReactionViewerSnapshotConflict {
  principalId: string;
  serverId: string;
  messageId: string;
  viewerVersion: number;
  reason: "malformed" | "equal-version-different-payload";
}

interface ReactionReadModelData {
  activePrincipalId: string | null;
  viewerOverlay: ReadonlyMap<string, boolean>;
  viewerCompleteMessages: ReadonlySet<string>;
  viewerVersions: ReadonlyMap<string, number>;
  viewerSnapshotEmojis: ReadonlyMap<string, readonly string[]>;
  actorCache: ReadonlyMap<string, ReactionActorsCacheEntry>;
  cacheOrder: readonly string[];
  parentIndex: ReadonlyMap<string, ReadonlySet<string>>;
  normalizationViolations: readonly ReactionNormalizationViolation[];
  viewerSnapshotConflicts: readonly ReactionViewerSnapshotConflict[];
}

export interface ReactionReadModelState extends ReactionReadModelData {
  activatePrincipal(principalId: string | null): void;
  stageLegacyIngress(input: ApplyLegacyReactionIngressInput): {
    sharedFact: readonly CanonicalReactionFact[];
    staged: StagedLegacyReactionIngress;
  };
  applyStagedLegacyIngressBatch(staged: readonly StagedLegacyReactionIngress[]): void;
  applyLegacyIngress(input: ApplyLegacyReactionIngressInput): readonly CanonicalReactionFact[];
  applyViewerOverlaySnapshot(principalId: string, snapshot: ReactionViewerOverlaySnapshot): void;
  applyVersionedViewerOverlaySnapshot(
    principalId: string,
    snapshot: VersionedReactionViewerSnapshot,
  ): VersionedReactionViewerSnapshotOutcome;
  applyViewerReactionPatch(principalId: string, serverId: string, messageId: string, emoji: string, reactedByMe: boolean): void;
  clearViewerReactionPatch(principalId: string, serverId: string, messageId: string, emoji: string): void;
  readViewerOverlay(principalId: string, serverId: string, messageId: string, emoji: string): ReactionViewerOverlayRead;
  readActors(principalId: string, discussion: MessageReactionActorsDiscussion): ReactionActorsCacheRead;
  clearParentScope(principalId: string, parentScopeKey: SyncScopeKey): void;
  reset(): void;
}

function viewerOverlayKey(principalId: string, serverId: string, messageId: string, emoji: string): string {
  return JSON.stringify([principalId, serverId, messageId, emoji]);
}

function viewerMessageKey(principalId: string, serverId: string, messageId: string): string {
  return JSON.stringify([principalId, serverId, messageId]);
}

function overlayKeyMatchesMessage(
  key: string,
  principalId: string,
  serverId: string,
  messageId: string,
): boolean {
  const parsed = JSON.parse(key) as unknown;
  return Array.isArray(parsed)
    && parsed[0] === principalId
    && parsed[1] === serverId
    && parsed[2] === messageId;
}

function actorCacheKey(principalId: string, discussion: MessageReactionActorsDiscussion): string {
  return JSON.stringify([principalId, reactionActorsDiscussionKey(discussion)]);
}

function parentIndexKey(principalId: string, parentScopeKey: SyncScopeKey): string {
  return JSON.stringify([principalId, syncScopeKeyString(parentScopeKey)]);
}

export function selectReactionViewerOverlay(
  viewerOverlay: ReadonlyMap<string, boolean>,
  viewerCompleteMessages: ReadonlySet<string>,
  principalId: string,
  serverId: string,
  messageId: string,
  emoji: string,
): ReactionViewerOverlayRead {
  const value = viewerOverlay.get(viewerOverlayKey(principalId, serverId, messageId, emoji));
  if (value !== undefined) return { status: "loaded", reactedByMe: value };
  return viewerCompleteMessages.has(viewerMessageKey(principalId, serverId, messageId))
    ? { status: "loaded", reactedByMe: false }
    : { status: "unknown" };
}

export function selectReactionActors(
  actorCache: ReadonlyMap<string, ReactionActorsCacheEntry>,
  principalId: string,
  discussion: MessageReactionActorsDiscussion,
): ReactionActorsCacheRead {
  const entry = actorCache.get(actorCacheKey(principalId, discussion));
  return entry ? { status: "loaded", entry } : { status: "missing" };
}

function emptyData(): ReactionReadModelData {
  return {
    activePrincipalId: null,
    viewerOverlay: new Map(),
    viewerCompleteMessages: new Set(),
    viewerVersions: new Map(),
    viewerSnapshotEmojis: new Map(),
    actorCache: new Map(),
    cacheOrder: [],
    parentIndex: new Map(),
    normalizationViolations: [],
    viewerSnapshotConflicts: [],
  };
}

function removeFromParentIndex(
  parentIndex: Map<string, ReadonlySet<string>>,
  entry: ReactionActorsCacheEntry | undefined,
  cacheKey: string,
): void {
  if (!entry) return;
  const parentKey = parentIndexKey(entry.principalId, entry.discussion.parentScopeKey);
  const indexed = new Set(parentIndex.get(parentKey) ?? []);
  indexed.delete(cacheKey);
  if (indexed.size === 0) parentIndex.delete(parentKey);
  else parentIndex.set(parentKey, indexed);
}

export function createReactionReadModelStore(options: {
  capacity?: number;
} = {}): StoreApi<ReactionReadModelState> {
  const capacity = options.capacity ?? 200;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError("reaction actor cache capacity must be a positive safe integer");
  }

  return createStore<ReactionReadModelState>((set, get) => ({
    ...emptyData(),

    activatePrincipal(principalId) {
      if (get().activePrincipalId === principalId) return;
      set({ ...emptyData(), activePrincipalId: principalId });
    },

    stageLegacyIngress(input) {
      const normalized = normalizeLegacyReactionRoster({
        serverId: input.serverId,
        parentScopeKey: input.parentScopeKey,
        messageId: input.messageId,
        source: input.source,
        viewerUserId: input.viewerUserId,
        reactions: input.reactions,
      });
      return {
        sharedFact: normalized.sharedFact,
        staged: {
          principalId: input.principalId,
          messageId: input.messageId,
          normalized,
        },
      };
    },

    applyStagedLegacyIngressBatch(stagedBatch) {
      if (stagedBatch.length === 0) return;
      const principals = new Set(stagedBatch.map((staged) => staged.principalId));
      if (principals.size !== 1) {
        throw new Error("reaction ingress batch must belong to one principal");
      }
      const principalId = stagedBatch[0]!.principalId;
      if (get().activePrincipalId !== principalId) {
        throw new Error("reaction ingress principal mismatch");
      }

      set((state) => {
        const viewerOverlay = new Map(state.viewerOverlay);
        const viewerCompleteMessages = new Set(state.viewerCompleteMessages);
        const viewerSnapshotEmojis = new Map(state.viewerSnapshotEmojis);
        const actorCache = new Map(state.actorCache);
        let cacheOrder = [...state.cacheOrder];
        const parentIndex = new Map(state.parentIndex);
        const normalizationViolations: ReactionNormalizationViolation[] = [];

        for (const staged of stagedBatch) {
          const normalized = staged.normalized;
          normalizationViolations.push(...normalized.violations);
          const snapshot = normalized.viewerOverlay;
          const versionKey = snapshot
            ? viewerMessageKey(principalId, snapshot.serverId, snapshot.messageId)
            : null;
          if (snapshot && !state.viewerVersions.has(versionKey!)) {
            for (const key of viewerOverlay.keys()) {
              if (overlayKeyMatchesMessage(
                key,
                principalId,
                snapshot.serverId,
                snapshot.messageId,
              )) {
                viewerOverlay.delete(key);
              }
            }
            for (const emoji of snapshot.reactedEmojis) {
              viewerOverlay.set(
                viewerOverlayKey(principalId, snapshot.serverId, snapshot.messageId, emoji),
                true,
              );
            }
            viewerCompleteMessages.add(versionKey!);
            viewerSnapshotEmojis.set(versionKey!, [...snapshot.reactedEmojis]);
          }

          for (const seed of normalized.readCacheSeed) {
            const discussion = messageReactionActorsDiscussion(
              messageRef(seed.parentScopeKey.serverId, seed.messageId),
              seed.emoji,
              seed.parentScopeKey,
            );
            const cacheKey = actorCacheKey(principalId, discussion);
            const previous = actorCache.get(cacheKey);
            removeFromParentIndex(parentIndex, previous, cacheKey);
            actorCache.set(cacheKey, {
              principalId,
              discussion,
              actors: seed.actors,
              completeness: seed.completeness,
              discussionVersion: null,
              nextPageCursor: null,
              source: "legacy-roster",
            });
            cacheOrder = [...cacheOrder.filter((key) => key !== cacheKey), cacheKey];
            const parentKey = parentIndexKey(principalId, seed.parentScopeKey);
            const indexed = new Set(parentIndex.get(parentKey) ?? []);
            indexed.add(cacheKey);
            parentIndex.set(parentKey, indexed);
          }
        }

        while (cacheOrder.length > capacity) {
          const evictedKey = cacheOrder.shift();
          if (!evictedKey) break;
          const evicted = actorCache.get(evictedKey);
          actorCache.delete(evictedKey);
          removeFromParentIndex(parentIndex, evicted, evictedKey);
        }

        return {
          viewerOverlay,
          viewerCompleteMessages,
          viewerSnapshotEmojis,
          actorCache,
          cacheOrder,
          parentIndex,
          normalizationViolations,
        };
      });
    },

    applyLegacyIngress(input) {
      const { sharedFact, staged } = get().stageLegacyIngress(input);
      get().applyStagedLegacyIngressBatch([staged]);
      return sharedFact;
    },

    applyViewerOverlaySnapshot(principalId, snapshot) {
      set((state) => {
        if (state.activePrincipalId !== principalId) return state;
        const viewerOverlay = new Map(state.viewerOverlay);
        for (const key of viewerOverlay.keys()) {
          if (overlayKeyMatchesMessage(key, principalId, snapshot.serverId, snapshot.messageId)) {
            viewerOverlay.delete(key);
          }
        }
        for (const emoji of snapshot.reactedEmojis) {
          viewerOverlay.set(
            viewerOverlayKey(principalId, snapshot.serverId, snapshot.messageId, emoji),
            true,
          );
        }
        const viewerCompleteMessages = new Set(state.viewerCompleteMessages);
        const messageKey = viewerMessageKey(principalId, snapshot.serverId, snapshot.messageId);
        viewerCompleteMessages.add(messageKey);
        const viewerSnapshotEmojis = new Map(state.viewerSnapshotEmojis);
        viewerSnapshotEmojis.set(messageKey, [...snapshot.reactedEmojis]);
        return { viewerOverlay, viewerCompleteMessages, viewerSnapshotEmojis };
      });
    },

    applyVersionedViewerOverlaySnapshot(principalId, snapshot) {
      const canonicalEmojis = Array.isArray(snapshot.reactedEmojis)
        ? [...snapshot.reactedEmojis]
        : [];
      const isCanonical = Array.isArray(snapshot.reactedEmojis)
        && typeof snapshot.serverId === "string"
        && snapshot.serverId.trim() === snapshot.serverId
        && snapshot.serverId.length > 0
        && typeof snapshot.messageId === "string"
        && snapshot.messageId.trim() === snapshot.messageId
        && snapshot.messageId.length > 0
        && Number.isSafeInteger(snapshot.viewerVersion)
        && snapshot.viewerVersion >= 0
        && canonicalEmojis.every((emoji, index) => (
          typeof emoji === "string"
          && emoji.length > 0
          && emoji.trim() === emoji
          && (index === 0 || canonicalEmojis[index - 1]! < emoji)
        ));
      if (!isCanonical) {
        set((state) => ({
          viewerSnapshotConflicts: [...state.viewerSnapshotConflicts, {
            principalId,
            serverId: snapshot.serverId,
            messageId: snapshot.messageId,
            viewerVersion: snapshot.viewerVersion,
            reason: "malformed" as const,
          }],
        }));
        return { kind: "conflict", reason: "malformed" };
      }
      const state = get();
      if (state.activePrincipalId !== principalId) {
        return { kind: "conflict", reason: "principal-mismatch" };
      }
      const messageKey = viewerMessageKey(principalId, snapshot.serverId, snapshot.messageId);
      const currentVersion = state.viewerVersions.get(messageKey);
      if (currentVersion !== undefined && snapshot.viewerVersion < currentVersion) {
        return { kind: "stale" };
      }
      if (currentVersion === snapshot.viewerVersion) {
        const currentEmojis = state.viewerSnapshotEmojis.get(messageKey) ?? [];
        if (JSON.stringify(currentEmojis) === JSON.stringify(canonicalEmojis)) {
          return { kind: "duplicate" };
        }
        set((current) => ({
          viewerSnapshotConflicts: [...current.viewerSnapshotConflicts, {
            principalId,
            serverId: snapshot.serverId,
            messageId: snapshot.messageId,
            viewerVersion: snapshot.viewerVersion,
            reason: "equal-version-different-payload" as const,
          }],
        }));
        return { kind: "conflict", reason: "equal-version-different-payload" };
      }

      set((current) => {
        if (current.activePrincipalId !== principalId) return current;
        const viewerOverlay = new Map(current.viewerOverlay);
        for (const key of viewerOverlay.keys()) {
          if (overlayKeyMatchesMessage(
            key,
            principalId,
            snapshot.serverId,
            snapshot.messageId,
          )) {
            viewerOverlay.delete(key);
          }
        }
        for (const emoji of canonicalEmojis) {
          viewerOverlay.set(
            viewerOverlayKey(principalId, snapshot.serverId, snapshot.messageId, emoji),
            true,
          );
        }
        const viewerCompleteMessages = new Set(current.viewerCompleteMessages);
        viewerCompleteMessages.add(messageKey);
        const viewerVersions = new Map(current.viewerVersions);
        viewerVersions.set(messageKey, snapshot.viewerVersion);
        const viewerSnapshotEmojis = new Map(current.viewerSnapshotEmojis);
        viewerSnapshotEmojis.set(messageKey, canonicalEmojis);
        return {
          viewerOverlay,
          viewerCompleteMessages,
          viewerVersions,
          viewerSnapshotEmojis,
        };
      });
      return { kind: "applied" };
    },

    applyViewerReactionPatch(principalId, serverId, messageId, emoji, reactedByMe) {
      set((state) => {
        if (state.activePrincipalId !== principalId) return state;
        const viewerOverlay = new Map(state.viewerOverlay);
        viewerOverlay.set(
          viewerOverlayKey(principalId, serverId, messageId, emoji),
          reactedByMe,
        );
        return { viewerOverlay };
      });
    },

    clearViewerReactionPatch(principalId, serverId, messageId, emoji) {
      set((state) => {
        if (state.activePrincipalId !== principalId) return state;
        const key = viewerOverlayKey(principalId, serverId, messageId, emoji);
        if (!state.viewerOverlay.has(key)) return state;
        const viewerOverlay = new Map(state.viewerOverlay);
        viewerOverlay.delete(key);
        return { viewerOverlay };
      });
    },

    readViewerOverlay(principalId, serverId, messageId, emoji) {
      const state = get();
      return selectReactionViewerOverlay(
        state.viewerOverlay,
        state.viewerCompleteMessages,
        principalId,
        serverId,
        messageId,
        emoji,
      );
    },

    readActors(principalId, discussion) {
      return selectReactionActors(get().actorCache, principalId, discussion);
    },

    clearParentScope(principalId, parentScopeKey) {
      set((state) => {
        const parentKey = parentIndexKey(principalId, parentScopeKey);
        const indexed = state.parentIndex.get(parentKey);
        if (!indexed) return state;
        const actorCache = new Map(state.actorCache);
        for (const cacheKey of indexed) actorCache.delete(cacheKey);
        const parentIndex = new Map(state.parentIndex);
        parentIndex.delete(parentKey);
        const cacheOrder = state.cacheOrder.filter((key) => !indexed.has(key));
        return { actorCache, parentIndex, cacheOrder };
      });
    },

    reset() {
      set(emptyData());
    },
  }));
}

export const reactionReadModelStore = createReactionReadModelStore();

registerServerReset(() => reactionReadModelStore.getState().reset());
