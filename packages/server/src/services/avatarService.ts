import { createHash } from "node:crypto";
import sharp from "sharp";
import { withImageDecodeSlot } from "../lib/imageDecodeLimit";

import { getCdnStorage, getStorage } from "./storageService";
import type { StorageBackend } from "./storageService";
import type { Express } from "express";
import type { Request } from "express";
import multer from "multer";
import { getThumbnailUrl } from "../routes/attachments";
import { MAX_PROFILE_AVATAR_BYTES } from "@botiverse/raft-shared";
import { isHumanAvatarUrl } from "@botiverse/raft-shared/src/humanAvatar";
import { and, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";

export { MAX_PROFILE_AVATAR_BYTES };

export const PROFILE_AVATAR_MAX_SIZE_LABEL = "5 MB";
export const PROFILE_AVATAR_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const PROFILE_AVATAR_BAD_FORMAT_MESSAGE = "Only image files are allowed (JPEG, PNG, GIF, WebP)";
export const PROFILE_AVATAR_TOO_LARGE_MESSAGE = `Avatar image must be ${PROFILE_AVATAR_MAX_SIZE_LABEL} or smaller`;
const USER_PROVIDER_AVATAR_FETCH_TIMEOUT_MS = 10_000;
const STORED_USER_AVATAR_PATH_PATTERN = /^\/(?:api\/)?avatars\/users\/[0-9a-f]{32}\.webp$/i;

type AvatarFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function avatarPathname(avatarUrl: string): string | null {
  if (avatarUrl.startsWith("/")) return avatarUrl;
  try {
    return new URL(avatarUrl).pathname;
  } catch {
    return null;
  }
}

export function isStoredUserAvatarUrl(avatarUrl: string | null | undefined): boolean {
  if (!avatarUrl) return false;
  const pathname = avatarPathname(avatarUrl);
  return pathname ? STORED_USER_AVATAR_PATH_PATTERN.test(pathname) : false;
}

/**
 * The content hash naming a stored user avatar's image (lowercase), the same
 * for every spelling of its URL (`/api/avatars/...`, a CDN origin, a query
 * string); null when the URL is not a stored user avatar.
 */
export function storedUserAvatarContentHash(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl || !isStoredUserAvatarUrl(avatarUrl)) return null;
  return /\/avatars\/users\/([0-9a-f]{32})\.webp$/i.exec(avatarPathname(avatarUrl) ?? "")?.[1]?.toLowerCase() ?? null;
}

/**
 * A person's avatar that may be shown to others: an image Raft stores
 * (isStoredUserAvatarUrl) or a built pixel avatar (`pixel-human:v1:...`, the
 * options they chose; shared humanAvatar.ts). Anything else a person's
 * avatarUrl may hold (an old social-provider URL) is not shown. For the
 * projections only: storage questions (delete, replace, materialize) ask
 * isStoredUserAvatarUrl, since a built avatar has no stored image.
 */
export function isShownUserAvatarUrl(avatarUrl: string | null | undefined): boolean {
  return isStoredUserAvatarUrl(avatarUrl) || isHumanAvatarUrl(avatarUrl);
}

/**
 * Deletes a stored user avatar's image when no live user or agent still shows
 * it (account deletion: the avatar goes with the account; Tenny, #triage:d10ace06).
 * User avatars share one namespace keyed by content hash, so the same image
 * uploaded by two people is one object, and one object has several spellings
 * (`/api/avatars/...`, an old or a new CDN origin, a query string): "still
 * shown" is asked by that hash, never by the exact URL. Best effort: someone
 * uploading the same image between the check and the delete loses it. True
 * when deleted.
 */
export async function deleteStoredUserAvatarIfUnused(
  avatarUrl: string | null | undefined,
  isHashStillShown: (contentHash: string) => Promise<boolean>,
): Promise<boolean> {
  if (!avatarUrl || !isStoredUserAvatarUrl(avatarUrl)) return false;
  const contentHash = storedUserAvatarContentHash(avatarUrl);
  const storage = getAvatarStorage();
  if (!storage || !contentHash) return false;
  if (await isHashStillShown(contentHash)) return false;
  await storage.delete(`avatars/users/${contentHash}.webp`);
  return true;
}

/**
 * After a person's avatar changed away from a photo Raft stores (a built
 * avatar saved, PATCH /me to null): delete that image unless someone still shows it,
 * so a photo they took down is no longer served and doesn't outlive their
 * account. Best effort: the change itself is already saved.
 */
export async function deleteReplacedUserAvatar(previousAvatarUrl: string | null | undefined, currentAvatarUrl: string | null | undefined): Promise<void> {
  if (!previousAvatarUrl || previousAvatarUrl === currentAvatarUrl || !isStoredUserAvatarUrl(previousAvatarUrl)) return;
  try {
    await deleteStoredUserAvatarIfUnused(previousAvatarUrl, isUserAvatarHashStillShown);
  } catch (err) {
    console.warn("[Avatar] Failed to delete a replaced user avatar:", err);
  }
}

/**
 * A live account or agent still shows the user avatar with this content hash,
 * in any spelling of its URL (origin, `/api/`, query string). The hash is 32
 * hex characters (checked by the caller's pattern), so it is safe inside LIKE.
 */
export async function isUserAvatarHashStillShown(contentHash: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(contentHash)) return true;
  const db = getDb();
  const pattern = `%/avatars/users/${contentHash}.webp%`;
  const [user] = await db.select({ id: users.id }).from(users)
    .where(and(sql`lower(${users.avatarUrl}) like ${pattern}`, isNull(users.retiredAt))).limit(1);
  if (user) return true;
  const [agent] = await db.select({ id: agents.id }).from(agents)
    .where(and(sql`lower(${agents.avatarUrl}) like ${pattern}`, isNull(agents.deletedAt))).limit(1);
  return Boolean(agent);
}

export function isStoredServerScopedAvatarUrl(
  avatarUrl: string | null | undefined,
  serverId: string,
): boolean {
  if (!avatarUrl) return false;
  const pathname = avatarPathname(avatarUrl);
  if (!pathname) return false;
  const escapedServerId = serverId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^/(?:api/)?avatars/${escapedServerId}/[0-9a-f]{32}\\.webp$`, "i").test(pathname);
}

/** Reads an image response body, refusing more than MAX_PROFILE_AVATAR_BYTES (the upload limit). */
export async function readBoundedAvatarResponse(response: Response): Promise<Buffer> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_PROFILE_AVATAR_BYTES) {
    throw new Error(PROFILE_AVATAR_TOO_LARGE_MESSAGE);
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_PROFILE_AVATAR_BYTES) {
      throw new Error(PROFILE_AVATAR_TOO_LARGE_MESSAGE);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > MAX_PROFILE_AVATAR_BYTES) {
        throw new Error(PROFILE_AVATAR_TOO_LARGE_MESSAGE);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // The original read error is more useful than a best-effort cancel error.
    }
    throw err;
  }

  return Buffer.concat(chunks, total);
}

export function createAvatarUpload(): multer.Multer {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PROFILE_AVATAR_BYTES },
    fileFilter: (_req, file, cb) => {
      if (!PROFILE_AVATAR_MIME_TYPES.has(file.mimetype)) {
        cb(new Error(PROFILE_AVATAR_BAD_FORMAT_MESSAGE));
        return;
      }
      cb(null, true);
    },
  });
}

export async function runSingleAvatarUpload(
  upload: multer.Multer,
  req: Request,
): Promise<Express.Multer.File | null> {
  return new Promise((resolve, reject) => {
    upload.single("avatar")(req, {} as never, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(req.file ?? null);
    });
  });
}

function getAvatarStorage(): StorageBackend | null {
  return getCdnStorage() || getStorage();
}

export async function storeProfileAvatar(
  namespace: string,
  existingAvatarUrl: string | null,
  fileBuffer: Buffer,
): Promise<string> {
  const storage = getAvatarStorage();
  if (!storage) {
    throw new Error("Storage not configured");
  }

  const processed = await withImageDecodeSlot(() => sharp(fileBuffer)
    .resize(256, 256, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer());

  const contentHash = createHash("sha256").update(processed).digest("hex").slice(0, 32);
  const storageKey = `avatars/${namespace}/${contentHash}.webp`;
  const avatarUrl = getThumbnailUrl(storageKey) ?? `/api/avatars/${namespace}/${contentHash}.webp`;

  if (existingAvatarUrl !== avatarUrl) {
    await storage.put(storageKey, processed, "image/webp");
  }

  return avatarUrl;
}

export async function storeAgentAvatar(
  serverId: string,
  existingAvatarUrl: string | null,
  fileBuffer: Buffer,
): Promise<string> {
  return storeProfileAvatar(serverId, existingAvatarUrl, fileBuffer);
}

export async function storeServerAvatar(
  serverId: string,
  existingAvatarUrl: string | null,
  fileBuffer: Buffer,
): Promise<string> {
  return storeProfileAvatar(`server-${serverId}`, existingAvatarUrl, fileBuffer);
}

export async function storeUserAvatar(
  existingAvatarUrl: string | null,
  fileBuffer: Buffer,
): Promise<string> {
  return storeProfileAvatar("users", existingAvatarUrl, fileBuffer);
}

export async function materializeUserProviderAvatar(input: {
  existingAvatarUrl: string | null;
  providerAvatarUrl: string | null | undefined;
  fetchImpl?: AvatarFetch;
}): Promise<string | null> {
  const providerAvatarUrl = input.providerAvatarUrl?.trim();
  if (!providerAvatarUrl) return null;
  if (isStoredUserAvatarUrl(input.existingAvatarUrl)) return null;
  if (isStoredUserAvatarUrl(providerAvatarUrl)) return providerAvatarUrl;
  if (!getAvatarStorage()) return null;

  let url: URL;
  try {
    url = new URL(providerAvatarUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USER_PROVIDER_AVATAR_FETCH_TIMEOUT_MS);
  try {
    const fetchImpl = input.fetchImpl ?? (globalThis.fetch.bind(globalThis) as AvatarFetch);
    const response = await fetchImpl(url.toString(), {
      headers: { Accept: "image/jpeg,image/png,image/gif,image/webp" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const fileBuffer = await readBoundedAvatarResponse(response);
    return storeUserAvatar(input.existingAvatarUrl, fileBuffer);
  } catch (err) {
    console.warn("[Avatar] Failed to materialize provider avatar for user:", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
