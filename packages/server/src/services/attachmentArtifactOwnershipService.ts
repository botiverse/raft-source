import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index.js";
import {
  attachmentObjectArtifacts,
  attachmentStorageArtifacts,
} from "../db/schema.js";
import type {
  AttachmentTransferArtifactBackend,
  AttachmentTransferArtifactRole,
} from "./attachmentTransferIntentService.js";

export type AttachmentArtifactIdentity = Readonly<{
  backend: AttachmentTransferArtifactBackend;
  storageKey: string;
}>;

export type AttachmentArtifactOwnership = AttachmentArtifactIdentity & Readonly<{
  objectId: string;
  role: AttachmentTransferArtifactRole | "future_derived";
}>;

const WRITE_CHUNK_SIZE = 500;

export const attachmentArtifactIdentityKey = (artifact: AttachmentArtifactIdentity): string =>
  `${artifact.backend}\0${artifact.storageKey}`;

function chunks<T>(values: readonly T[], size = WRITE_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

/**
 * Converge physical identities and immutable object ownership without changing
 * lifecycle or byte-evidence state on an existing artifact.
 */
export async function ensureAttachmentArtifactOwnershipWithExecutor(
  executor: DatabaseExecutor,
  identities: readonly AttachmentArtifactIdentity[],
  ownerships: readonly AttachmentArtifactOwnership[],
  now: Date,
): Promise<Map<string, string>> {
  const uniqueIdentities = new Map<string, AttachmentArtifactIdentity>();
  for (const identity of identities) uniqueIdentities.set(attachmentArtifactIdentityKey(identity), identity);
  for (const ownership of ownerships) uniqueIdentities.set(attachmentArtifactIdentityKey(ownership), ownership);

  const artifactIds = new Map<string, string>();
  for (const batch of chunks([...uniqueIdentities.values()])) {
    await executor.insert(attachmentStorageArtifacts).values(batch.map((artifact) => ({
      id: randomUUID(),
      backend: artifact.backend,
      storageKey: artifact.storageKey,
      availabilityState: "unverified" as const,
      createdAt: now,
      updatedAt: now,
    }))).onConflictDoNothing();

    for (const backend of ["attachment", "cdn"] as const) {
      const keys = batch.filter((artifact) => artifact.backend === backend).map((artifact) => artifact.storageKey);
      if (keys.length === 0) continue;
      const rows = await executor.select({
        id: attachmentStorageArtifacts.id,
        backend: attachmentStorageArtifacts.backend,
        storageKey: attachmentStorageArtifacts.storageKey,
      }).from(attachmentStorageArtifacts).where(and(
        eq(attachmentStorageArtifacts.backend, backend),
        inArray(attachmentStorageArtifacts.storageKey, keys),
      ));
      for (const row of rows) artifactIds.set(attachmentArtifactIdentityKey(row), row.id);
    }
  }
  if (artifactIds.size !== uniqueIdentities.size) {
    throw new Error("Attachment artifact identity convergence left an unresolved physical key.");
  }

  const expectedOwnership = new Map<string, string>();
  for (const ownership of ownerships) {
    const artifactId = artifactIds.get(attachmentArtifactIdentityKey(ownership));
    if (!artifactId) throw new Error(`Artifact identity missing for object ${ownership.objectId} role ${ownership.role}`);
    expectedOwnership.set(`${ownership.objectId}\0${ownership.role}`, artifactId);
  }
  for (const batch of chunks(ownerships)) {
    if (batch.length === 0) continue;
    await executor.insert(attachmentObjectArtifacts).values(batch.map((ownership) => ({
      objectId: ownership.objectId,
      artifactId: artifactIds.get(attachmentArtifactIdentityKey(ownership))!,
      role: ownership.role,
      createdAt: now,
    }))).onConflictDoNothing();
  }
  for (const objectIds of chunks([...new Set(ownerships.map((ownership) => ownership.objectId))])) {
    if (objectIds.length === 0) continue;
    const rows = await executor.select({
      objectId: attachmentObjectArtifacts.objectId,
      role: attachmentObjectArtifacts.role,
      artifactId: attachmentObjectArtifacts.artifactId,
    }).from(attachmentObjectArtifacts).where(inArray(attachmentObjectArtifacts.objectId, objectIds));
    for (const row of rows) {
      const expected = expectedOwnership.get(`${row.objectId}\0${row.role}`);
      if (expected !== undefined && expected !== row.artifactId) {
        throw new Error(`Attachment artifact ownership conflict for object ${row.objectId} role ${row.role}`);
      }
      if (expected === row.artifactId) expectedOwnership.delete(`${row.objectId}\0${row.role}`);
    }
  }
  if (expectedOwnership.size > 0) {
    throw new Error("Attachment artifact ownership convergence left an unresolved object role.");
  }
  return artifactIds;
}
