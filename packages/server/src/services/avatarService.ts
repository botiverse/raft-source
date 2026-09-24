import { createHash } from "node:crypto";
import sharp from "sharp";

import { getCdnStorage, getStorage } from "./storageService.js";
import type { StorageBackend } from "./storageService.js";
import type { Express } from "express";
import type { Request } from "express";
import multer from "multer";
import { getThumbnailUrl } from "../routes/attachments.js";

export const MAX_PROFILE_AVATAR_BYTES = 5 * 1024 * 1024;
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

async function readBoundedAvatarResponse(response: Response): Promise<Buffer> {
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

  const processed = await sharp(fileBuffer)
    .resize(256, 256, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer();

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
