import type { ExternalAvatarSourceAdapter } from "./externalAvatarMaterializerService.js";
import { EXTERNAL_AVATAR_MAX_SOURCE_BYTES } from "./externalAvatarMaterializerService.js";
import { materializeRaftAuthorPolicyAvatar } from "./externalAvatarMaterializerService.js";
import type { StorageBackend } from "./storageService.js";
import type { Database } from "../db/index.js";
import { agents, externalAuthorPolicies, externalProjectionAvatarArtifacts, users } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

const HASH = "[0-9a-f]{32}";

export function resolveRaftAvatarStorageKey(input: {
  locator: string;
  namespace: string;
  cdnBaseUrl?: string | null;
}): string {
  if (!/^(?:users|[0-9a-f-]{36})$/iu.test(input.namespace)) {
    throw new Error("avatar_source_locator_invalid");
  }
  const expectedPath = new RegExp(`^/api/avatars/${input.namespace}/(${HASH})\\.webp$`, "iu");
  const relative = expectedPath.exec(input.locator);
  if (relative) return `avatars/${input.namespace}/${relative[1]!.toLowerCase()}.webp`;

  const base = input.cdnBaseUrl?.trim().replace(/\/$/u, "");
  if (!base) throw new Error("avatar_source_locator_invalid");
  let parsedBase: URL;
  let parsedLocator: URL;
  try {
    parsedBase = new URL(base);
    parsedLocator = new URL(input.locator);
  } catch {
    throw new Error("avatar_source_locator_invalid");
  }
  if (
    parsedBase.protocol !== "https:"
    || parsedLocator.protocol !== "https:"
    || parsedBase.username
    || parsedBase.password
    || parsedLocator.username
    || parsedLocator.password
    || parsedLocator.hash
  ) throw new Error("avatar_source_locator_invalid");
  const prefix = `${parsedBase.pathname.replace(/\/$/u, "")}/avatars/${input.namespace}/`;
  const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(${HASH})\\.webp$`, "iu")
    .exec(parsedLocator.pathname);
  if (parsedLocator.origin !== parsedBase.origin || !match || parsedLocator.search) {
    throw new Error("avatar_source_locator_invalid");
  }
  return `avatars/${input.namespace}/${match[1]!.toLowerCase()}.webp`;
}

export function createRaftAvatarSourceAdapter(input: {
  storage: StorageBackend;
  namespace: string;
  cdnBaseUrl?: string | null;
}): ExternalAvatarSourceAdapter {
  return {
    provider: "raft",
    async readSource({ locator, signal }) {
      if (signal.aborted) throw new Error("avatar_source_unavailable");
      const stream = await input.storage.get(resolveRaftAvatarStorageKey({
        locator,
        namespace: input.namespace,
        cdnBaseUrl: input.cdnBaseUrl,
      }));
      const chunks: Buffer[] = [];
      let byteSize = 0;
      for await (const raw of stream) {
        if (signal.aborted) throw new Error("avatar_source_unavailable");
        const chunk = Buffer.from(raw);
        byteSize += chunk.length;
        if (byteSize > EXTERNAL_AVATAR_MAX_SOURCE_BYTES) throw new Error("avatar_source_size_invalid");
        chunks.push(chunk);
      }
      if (byteSize <= 0) throw new Error("avatar_source_size_invalid");
      return Buffer.concat(chunks, byteSize);
    },
  };
}

async function revokeRaftAuthorAvatar(input: {
  db: Database;
  storage: StorageBackend;
  authorType: "user" | "agent";
  authorId: string;
  now?: () => Date;
}) {
  const now = input.now?.() ?? new Date();
  const storageKeys = await input.db.transaction(async (tx) => {
    const policies = await tx.select().from(externalAuthorPolicies).where(and(
      eq(externalAuthorPolicies.authorType, input.authorType),
      eq(externalAuthorPolicies.authorId, input.authorId),
      eq(externalAuthorPolicies.state, "granted"),
    )).for("update");
    const artifacts = await tx.select().from(externalProjectionAvatarArtifacts).where(and(
      eq(externalProjectionAvatarArtifacts.ownerType, input.authorType),
      eq(externalProjectionAvatarArtifacts.ownerId, input.authorId),
      eq(externalProjectionAvatarArtifacts.state, "active"),
    )).for("update");
    if (policies.length > 0) {
      await tx.update(externalAuthorPolicies).set({ avatarArtifactId: null, updatedAt: now }).where(and(
        eq(externalAuthorPolicies.authorType, input.authorType),
        eq(externalAuthorPolicies.authorId, input.authorId),
        eq(externalAuthorPolicies.state, "granted"),
      ));
    }
    if (artifacts.length > 0) {
      await tx.update(externalProjectionAvatarArtifacts).set({ state: "revoked", updatedAt: now }).where(and(
        eq(externalProjectionAvatarArtifacts.ownerType, input.authorType),
        eq(externalProjectionAvatarArtifacts.ownerId, input.authorId),
        eq(externalProjectionAvatarArtifacts.state, "active"),
      ));
    }
    return artifacts.flatMap((artifact) => artifact.storageKey ? [artifact.storageKey] : []);
  });
  for (const key of storageKeys) {
    try { await input.storage.delete(key); } catch { /* DB revocation remains authoritative. */ }
  }
  return { kind: "unchanged" as const };
}

export async function materializeCurrentRaftAuthorPolicyAvatar(input: {
  db: Database;
  storage: StorageBackend;
  policyId: string;
  publicOrigin: string;
  cdnBaseUrl?: string | null;
  now?: () => Date;
}) {
  const [policy] = await input.db.select().from(externalAuthorPolicies)
    .where(eq(externalAuthorPolicies.id, input.policyId)).limit(1);
  if (!policy || policy.state !== "granted") return { kind: "authority_stale" as const };
  if (policy.authorType === "user") {
    const [owner] = await input.db.select({ avatarUrl: users.avatarUrl }).from(users)
      .where(eq(users.id, policy.authorId)).limit(1);
    if (!owner?.avatarUrl) return revokeRaftAuthorAvatar({
      db: input.db,
      storage: input.storage,
      authorType: "user",
      authorId: policy.authorId,
      now: input.now,
    });
    try {
      resolveRaftAvatarStorageKey({
        locator: owner.avatarUrl,
        namespace: "users",
        cdnBaseUrl: input.cdnBaseUrl,
      });
    } catch {
      return revokeRaftAuthorAvatar({
        db: input.db,
        storage: input.storage,
        authorType: "user",
        authorId: policy.authorId,
        now: input.now,
      });
    }
    return materializeRaftAuthorPolicyAvatar({
      ...input,
      sourceLocator: owner.avatarUrl,
      source: createRaftAvatarSourceAdapter({
        storage: input.storage,
        namespace: "users",
        cdnBaseUrl: input.cdnBaseUrl,
      }),
    });
  }
  const [owner] = await input.db.select({ avatarUrl: agents.avatarUrl, serverId: agents.serverId }).from(agents)
    .where(eq(agents.id, policy.authorId)).limit(1);
  if (!owner?.avatarUrl || owner.avatarUrl.startsWith("pixel:")) {
    return revokeRaftAuthorAvatar({
      db: input.db,
      storage: input.storage,
      authorType: "agent",
      authorId: policy.authorId,
      now: input.now,
    });
  }
  try {
    resolveRaftAvatarStorageKey({
      locator: owner.avatarUrl,
      namespace: owner.serverId,
      cdnBaseUrl: input.cdnBaseUrl,
    });
  } catch {
    return revokeRaftAuthorAvatar({
      db: input.db,
      storage: input.storage,
      authorType: "agent",
      authorId: policy.authorId,
      now: input.now,
    });
  }
  return materializeRaftAuthorPolicyAvatar({
    ...input,
    sourceLocator: owner.avatarUrl,
    source: createRaftAvatarSourceAdapter({
      storage: input.storage,
      namespace: owner.serverId,
      cdnBaseUrl: input.cdnBaseUrl,
    }),
  });
}

export async function syncCurrentRaftAuthorAvatar(input: {
  db: Database;
  storage: StorageBackend;
  authorType: "user" | "agent";
  authorId: string;
  publicOrigin: string;
  cdnBaseUrl?: string | null;
  now?: () => Date;
}) {
  const [policy] = await input.db.select({ id: externalAuthorPolicies.id }).from(externalAuthorPolicies).where(and(
    eq(externalAuthorPolicies.authorType, input.authorType),
    eq(externalAuthorPolicies.authorId, input.authorId),
    eq(externalAuthorPolicies.state, "granted"),
  )).limit(1);
  if (!policy) return { kind: "authority_stale" as const };
  return materializeCurrentRaftAuthorPolicyAvatar({ ...input, policyId: policy.id });
}
