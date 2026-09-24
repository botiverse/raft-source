import { createHash, randomUUID } from "node:crypto";

import { currentDate } from "@botiverse/raft-shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import sharp from "sharp";

import type { Database, DatabaseTransaction } from "../db/index.js";
import {
  agents,
  externalActorProjections,
  externalAuthorPolicies,
  externalProjectionAvatarArtifacts,
  users,
} from "../db/schema.js";
import type { StorageBackend } from "./storageService.js";

export const EXTERNAL_AVATAR_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const EXTERNAL_AVATAR_MAX_DIMENSION = 4096;
const EXTERNAL_AVATAR_OUTPUT_DIMENSION = 256;
const STALE_PENDING_MS = 10 * 60_000;

type OwnerType = "user" | "agent" | "external_projection";
type Artifact = typeof externalProjectionAvatarArtifacts.$inferSelect;

export type ExternalAvatarMaterializationResult =
  | { kind: "activated"; artifact: Artifact }
  | { kind: "unchanged"; artifact: Artifact }
  | { kind: "cleared" }
  | { kind: "deferred" }
  | { kind: "authority_stale" }
  | { kind: "source_unavailable"; reason: string };

export interface ExternalAvatarSourceAdapter {
  readonly provider: string;
  readSource(input: { locator: string; signal: AbortSignal }): Promise<Buffer>;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicOrigin(raw: string): string {
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.origin !== raw.replace(/\/$/u, "")
  ) throw new Error("External avatar public origin must be an exact HTTPS origin");
  return parsed.origin;
}

export async function normalizeExternalAvatarRaster(source: Buffer): Promise<{
  bytes: Buffer;
  sourceDigest: string;
  mimeType: "image/webp";
  width: number;
  height: number;
}> {
  if (source.length <= 0 || source.length > EXTERNAL_AVATAR_MAX_SOURCE_BYTES) {
    throw new Error("avatar_source_size_invalid");
  }
  const decoder = sharp(source, {
    animated: true,
    limitInputPixels: EXTERNAL_AVATAR_MAX_DIMENSION * EXTERNAL_AVATAR_MAX_DIMENSION,
  });
  const metadata = await decoder.metadata();
  if (
    !metadata.width
    || !metadata.height
    || metadata.width > EXTERNAL_AVATAR_MAX_DIMENSION
    || metadata.height > EXTERNAL_AVATAR_MAX_DIMENSION
    || !(["jpeg", "png", "webp", "gif"] as Array<typeof metadata.format>).includes(metadata.format)
    || (metadata.pages ?? 1) !== 1
  ) throw new Error("avatar_source_raster_invalid");
  const { data, info } = await sharp(source, {
    animated: false,
    limitInputPixels: EXTERNAL_AVATAR_MAX_DIMENSION * EXTERNAL_AVATAR_MAX_DIMENSION,
  })
    .rotate()
    .resize(EXTERNAL_AVATAR_OUTPUT_DIMENSION, EXTERNAL_AVATAR_OUTPUT_DIMENSION, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  if (
    info.format !== "webp"
    || info.width !== EXTERNAL_AVATAR_OUTPUT_DIMENSION
    || info.height !== EXTERNAL_AVATAR_OUTPUT_DIMENSION
    || data.length <= 0
    || data.length > EXTERNAL_AVATAR_MAX_SOURCE_BYTES
  ) throw new Error("avatar_normalization_invalid");
  return {
    bytes: data,
    sourceDigest: sha256(data),
    mimeType: "image/webp",
    width: info.width,
    height: info.height,
  };
}

async function activeArtifact(
  tx: DatabaseTransaction,
  ownerType: OwnerType,
  ownerId: string,
): Promise<Artifact | null> {
  const rows = await tx.select().from(externalProjectionAvatarArtifacts).where(and(
    eq(externalProjectionAvatarArtifacts.ownerType, ownerType),
    eq(externalProjectionAvatarArtifacts.ownerId, ownerId),
    eq(externalProjectionAvatarArtifacts.state, "active"),
  )).orderBy(desc(externalProjectionAvatarArtifacts.artifactRevision)).for("update").limit(2);
  if (rows.length > 1) throw new Error("External avatar active artifact is ambiguous");
  return rows[0] ?? null;
}

async function safelyDelete(storage: StorageBackend, key: string | null): Promise<void> {
  if (!key) return;
  try {
    await storage.delete(key);
  } catch {
    // DB state is the serving authority. Cleanup remains best-effort and a
    // later materialization can reclaim a stale pending object's exact key.
  }
}

async function materializeAvatar(input: {
  db: Database;
  storage: StorageBackend;
  ownerType: OwnerType;
  ownerId: string;
  sourceLocator: string;
  source: ExternalAvatarSourceAdapter;
  expectedProvider?: string;
  publicOrigin: string;
  signal?: AbortSignal;
  now?: () => Date;
  lockAuthority(tx: DatabaseTransaction): Promise<boolean>;
  bindArtifact(tx: DatabaseTransaction, artifact: Artifact): Promise<boolean>;
}): Promise<ExternalAvatarMaterializationResult> {
  const now = input.now ?? currentDate;
  const firstNow = now();
  if (
    !Number.isFinite(firstNow.getTime())
    || !input.ownerId.trim()
    || !input.sourceLocator.trim()
    || (input.expectedProvider && input.source.provider !== input.expectedProvider)
  ) return { kind: "authority_stale" };
  const origin = publicOrigin(input.publicOrigin);
  const locatorDigest = sha256(input.sourceLocator);

  const fast = await input.db.transaction(async (tx) => {
    if (!await input.lockAuthority(tx)) return { kind: "authority_stale" as const };
    const active = await activeArtifact(tx, input.ownerType, input.ownerId);
    if (active?.sourceLocatorDigest !== locatorDigest) return null;
    if (!await input.bindArtifact(tx, active)) return { kind: "authority_stale" as const };
    return { kind: "unchanged" as const, artifact: active };
  });
  if (fast) return fast;

  let raw: Buffer;
  try {
    raw = await input.source.readSource({
      locator: input.sourceLocator,
      signal: input.signal ?? new AbortController().signal,
    });
  } catch (error) {
    return {
      kind: "source_unavailable",
      reason: error instanceof Error && /^avatar_[a-z_]+$/u.test(error.message)
        ? error.message
        : "avatar_source_unavailable",
    };
  }
  let normalized: Awaited<ReturnType<typeof normalizeExternalAvatarRaster>>;
  try {
    normalized = await normalizeExternalAvatarRaster(raw);
  } catch (error) {
    return {
      kind: "source_unavailable",
      reason: error instanceof Error && /^avatar_[a-z_]+$/u.test(error.message)
        ? error.message
        : "avatar_source_raster_invalid",
    };
  }

  const allocationNow = now();
  const allocation = await input.db.transaction(async (tx) => {
    if (!await input.lockAuthority(tx)) return { kind: "authority_stale" as const };
    const active = await activeArtifact(tx, input.ownerType, input.ownerId);
    if (active?.sourceDigest === normalized.sourceDigest) {
      const [refreshed] = await tx.update(externalProjectionAvatarArtifacts).set({
        sourceLocatorDigest: locatorDigest,
        updatedAt: allocationNow,
      }).where(and(
        eq(externalProjectionAvatarArtifacts.id, active.id),
        eq(externalProjectionAvatarArtifacts.state, "active"),
      )).returning();
      if (!refreshed || !await input.bindArtifact(tx, refreshed)) {
        return { kind: "authority_stale" as const };
      }
      return { kind: "unchanged" as const, artifact: refreshed };
    }

    const pendingRows = await tx.select().from(externalProjectionAvatarArtifacts).where(and(
      eq(externalProjectionAvatarArtifacts.ownerType, input.ownerType),
      eq(externalProjectionAvatarArtifacts.ownerId, input.ownerId),
      eq(externalProjectionAvatarArtifacts.state, "pending"),
    )).orderBy(asc(externalProjectionAvatarArtifacts.createdAt)).for("update").limit(2);
    if (pendingRows.length > 1) throw new Error("External avatar pending artifact is ambiguous");
    const pending = pendingRows[0] ?? null;
    if (pending && pending.updatedAt >= new Date(allocationNow.getTime() - STALE_PENDING_MS)) {
      return { kind: "deferred" as const };
    }
    if (pending) {
      await tx.update(externalProjectionAvatarArtifacts).set({
        state: "revoked",
        updatedAt: allocationNow,
      }).where(eq(externalProjectionAvatarArtifacts.id, pending.id));
    }
    const [latest] = await tx.select({
      revision: externalProjectionAvatarArtifacts.artifactRevision,
    }).from(externalProjectionAvatarArtifacts).where(and(
      eq(externalProjectionAvatarArtifacts.ownerType, input.ownerType),
      eq(externalProjectionAvatarArtifacts.ownerId, input.ownerId),
    )).orderBy(desc(externalProjectionAvatarArtifacts.artifactRevision)).limit(1);
    const artifactId = randomUUID();
    const storageKey = `external-avatars/${input.ownerType}/${input.ownerId}/${artifactId}.webp`;
    const [created] = await tx.insert(externalProjectionAvatarArtifacts).values({
      id: artifactId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      sourceDigest: normalized.sourceDigest,
      sourceLocatorDigest: locatorDigest,
      storageKey,
      publicUrl: `${origin}/api/external-avatars/${artifactId}.webp`,
      mimeType: normalized.mimeType,
      byteSize: normalized.bytes.length,
      width: normalized.width,
      height: normalized.height,
      artifactRevision: (latest?.revision ?? 0) + 1,
      state: "pending",
      createdAt: allocationNow,
      updatedAt: allocationNow,
    }).returning();
    if (!created) throw new Error("External avatar pending artifact was not created");
    return { kind: "allocated" as const, artifact: created, staleStorageKey: pending?.storageKey ?? null };
  });
  if (allocation.kind !== "allocated") return allocation;
  await safelyDelete(input.storage, allocation.staleStorageKey);

  try {
    await input.storage.put(allocation.artifact.storageKey!, normalized.bytes, normalized.mimeType);
  } catch {
    await input.db.update(externalProjectionAvatarArtifacts).set({
      state: "revoked",
      updatedAt: now(),
    }).where(and(
      eq(externalProjectionAvatarArtifacts.id, allocation.artifact.id),
      eq(externalProjectionAvatarArtifacts.state, "pending"),
    ));
    await safelyDelete(input.storage, allocation.artifact.storageKey);
    return { kind: "source_unavailable", reason: "avatar_storage_unavailable" };
  }

  const finalizedAt = now();
  const finalized = await input.db.transaction(async (tx) => {
    if (!await input.lockAuthority(tx)) {
      await tx.update(externalProjectionAvatarArtifacts).set({
        state: "revoked",
        updatedAt: finalizedAt,
      }).where(and(
        eq(externalProjectionAvatarArtifacts.id, allocation.artifact.id),
        eq(externalProjectionAvatarArtifacts.state, "pending"),
      ));
      return { kind: "authority_stale" as const, oldStorageKey: null as string | null };
    }
    const [pending] = await tx.select().from(externalProjectionAvatarArtifacts).where(and(
      eq(externalProjectionAvatarArtifacts.id, allocation.artifact.id),
      eq(externalProjectionAvatarArtifacts.state, "pending"),
    )).for("update").limit(1);
    if (!pending) return { kind: "authority_stale" as const, oldStorageKey: null as string | null };
    const active = await activeArtifact(tx, input.ownerType, input.ownerId);
    if (!await input.bindArtifact(tx, { ...pending, state: "active" })) {
      await tx.update(externalProjectionAvatarArtifacts).set({ state: "revoked", updatedAt: finalizedAt })
        .where(eq(externalProjectionAvatarArtifacts.id, pending.id));
      return { kind: "authority_stale" as const, oldStorageKey: null as string | null };
    }
    if (active) {
      await tx.update(externalProjectionAvatarArtifacts).set({
        state: "revoked",
        updatedAt: finalizedAt,
      }).where(eq(externalProjectionAvatarArtifacts.id, active.id));
    }
    const [activated] = await tx.update(externalProjectionAvatarArtifacts).set({
      state: "active",
      updatedAt: finalizedAt,
    }).where(and(
      eq(externalProjectionAvatarArtifacts.id, pending.id),
      eq(externalProjectionAvatarArtifacts.state, "pending"),
    )).returning();
    if (!activated) throw new Error("External avatar activation lost its pending authority");
    return { kind: "activated" as const, artifact: activated, oldStorageKey: active?.storageKey ?? null };
  });
  if (finalized.kind === "authority_stale") {
    await safelyDelete(input.storage, allocation.artifact.storageKey);
    return { kind: "authority_stale" };
  }
  await safelyDelete(input.storage, finalized.oldStorageKey);
  return { kind: "activated", artifact: finalized.artifact };
}

export async function materializeExternalProjectionAvatar(input: {
  db: Database;
  storage: StorageBackend;
  source: ExternalAvatarSourceAdapter;
  projectionId: string;
  expectedProjectionRevision: number;
  expectedObservedAt?: Date;
  sourceLocator: string | null;
  publicOrigin: string;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<ExternalAvatarMaterializationResult> {
  if (input.sourceLocator === null) {
    const cleared = await input.db.transaction(async (tx) => {
      const [projection] = await tx.select().from(externalActorProjections).where(and(
        eq(externalActorProjections.id, input.projectionId),
        eq(externalActorProjections.provider, input.source.provider),
        eq(externalActorProjections.projectionRevision, input.expectedProjectionRevision),
        ...(input.expectedObservedAt ? [eq(externalActorProjections.observedAt, input.expectedObservedAt)] : []),
        eq(externalActorProjections.state, "active"),
        eq(externalActorProjections.deactivated, false),
      )).for("update").limit(1);
      if (!projection) return null;
      const artifacts = await tx.select().from(externalProjectionAvatarArtifacts).where(and(
        eq(externalProjectionAvatarArtifacts.ownerType, "external_projection"),
        eq(externalProjectionAvatarArtifacts.ownerId, projection.id),
        inArray(externalProjectionAvatarArtifacts.state, ["active", "pending"]),
      )).for("update");
      if (!projection.avatarArtifactId && artifacts.length === 0) return [];
      const now = input.now?.() ?? currentDate();
      await tx.update(externalActorProjections).set({
        avatarArtifactId: null,
        projectionRevision: projection.projectionRevision + 1,
        updatedAt: now,
      }).where(eq(externalActorProjections.id, projection.id));
      if (artifacts.length > 0) await tx.update(externalProjectionAvatarArtifacts).set({
        state: "revoked", updatedAt: now,
      }).where(inArray(externalProjectionAvatarArtifacts.id, artifacts.map((artifact) => artifact.id)));
      return artifacts.flatMap((artifact) => artifact.storageKey ? [artifact.storageKey] : []);
    });
    if (cleared === null) return { kind: "authority_stale" };
    for (const key of cleared) await safelyDelete(input.storage, key);
    return { kind: "cleared" };
  }
  return materializeAvatar({
    ...input,
    sourceLocator: input.sourceLocator,
    ownerType: "external_projection",
    ownerId: input.projectionId,
    expectedProvider: input.source.provider,
    lockAuthority: async (tx) => {
      const [projection] = await tx.select().from(externalActorProjections).where(and(
        eq(externalActorProjections.id, input.projectionId),
        eq(externalActorProjections.provider, input.source.provider),
        eq(externalActorProjections.projectionRevision, input.expectedProjectionRevision),
        ...(input.expectedObservedAt ? [eq(externalActorProjections.observedAt, input.expectedObservedAt)] : []),
        eq(externalActorProjections.state, "active"),
        eq(externalActorProjections.deactivated, false),
      )).for("update").limit(1);
      return Boolean(projection);
    },
    bindArtifact: async (tx, artifact) => {
      const [projection] = await tx.select().from(externalActorProjections)
        .where(eq(externalActorProjections.id, input.projectionId)).for("update").limit(1);
      if (
        !projection
        || projection.provider !== input.source.provider
        || projection.state !== "active"
        || projection.deactivated
        || (input.expectedObservedAt !== undefined
          && projection.observedAt.getTime() !== input.expectedObservedAt.getTime())
        || (
          projection.avatarArtifactId !== artifact.id
          && projection.projectionRevision !== input.expectedProjectionRevision
        )
      ) return false;
      if (projection.avatarArtifactId === artifact.id) return true;
      const [updated] = await tx.update(externalActorProjections).set({
        avatarArtifactId: artifact.id,
        projectionRevision: projection.projectionRevision + 1,
        updatedAt: input.now?.() ?? currentDate(),
      }).where(and(
        eq(externalActorProjections.id, projection.id),
        eq(externalActorProjections.projectionRevision, projection.projectionRevision),
      )).returning({ id: externalActorProjections.id });
      return Boolean(updated);
    },
  });
}

export async function materializeRaftAuthorPolicyAvatar(input: {
  db: Database;
  storage: StorageBackend;
  source: ExternalAvatarSourceAdapter;
  policyId: string;
  sourceLocator: string;
  publicOrigin: string;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<ExternalAvatarMaterializationResult> {
  const [policy] = await input.db.select().from(externalAuthorPolicies)
    .where(eq(externalAuthorPolicies.id, input.policyId)).limit(1);
  if (!policy || policy.state !== "granted") return { kind: "authority_stale" };
  return materializeAvatar({
    ...input,
    ownerType: policy.authorType,
    ownerId: policy.authorId,
    lockAuthority: async (tx) => {
      const [currentPolicy] = await tx.select().from(externalAuthorPolicies).where(and(
        eq(externalAuthorPolicies.id, policy.id),
        eq(externalAuthorPolicies.authorType, policy.authorType),
        eq(externalAuthorPolicies.authorId, policy.authorId),
        eq(externalAuthorPolicies.consentRevision, policy.consentRevision),
        eq(externalAuthorPolicies.state, "granted"),
      )).for("update").limit(1);
      if (!currentPolicy) return false;
      if (policy.authorType === "user") {
        const [owner] = await tx.select({ avatarUrl: users.avatarUrl }).from(users)
          .where(eq(users.id, policy.authorId)).for("update").limit(1);
        return owner?.avatarUrl === input.sourceLocator;
      }
      const [owner] = await tx.select({ avatarUrl: agents.avatarUrl }).from(agents)
        .where(eq(agents.id, policy.authorId)).for("update").limit(1);
      return owner?.avatarUrl === input.sourceLocator;
    },
    bindArtifact: async (tx, artifact) => {
      const updated = await tx.update(externalAuthorPolicies).set({
        avatarArtifactId: artifact.id,
        updatedAt: input.now?.() ?? currentDate(),
      }).where(and(
        eq(externalAuthorPolicies.authorType, policy.authorType),
        eq(externalAuthorPolicies.authorId, policy.authorId),
        eq(externalAuthorPolicies.state, "granted"),
      )).returning({ id: externalAuthorPolicies.id });
      return updated.some((row) => row.id === policy.id);
    },
  });
}
