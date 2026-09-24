import type { MessageId } from "../i18n/messages/en";

export const MAX_PROFILE_AVATAR_BYTES = 5 * 1024 * 1024;
/** Catalog id for the localized "5 MB" max-size label used in avatar.tooLarge. */
export const PROFILE_AVATAR_MAX_SIZE_LABEL_ID = "common.fileSize.maxLabel5mb" satisfies MessageId;
/**
 * Thrown by the store when an oversized file reaches it. The message is a CODE,
 * not a sentence: this module cannot reach the catalog, and the moment it
 * returns English every consumer renders English however migrated it is.
 */
export const AVATAR_TOO_LARGE_CODE = "AVATAR_TOO_LARGE";

export function isAvatarTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message === AVATAR_TOO_LARGE_CODE;
}
export const PROFILE_AVATAR_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

/**
 * Size predicate with NO copy attached — the localized form of the message is
 * the calling surface's job (`avatar.tooLarge`).
 *
 * This replaced `getAvatarFileSizeError()`, which RETURNED an English sentence.
 * Three surfaces already counted as migrated rendered that value directly, so
 * they displayed English without containing a single English literal for a
 * scanner to find. The old function is DELETED rather than deprecated: while it
 * exists, the next caller reaches for it and reintroduces the bug for free.
 */
export function isAvatarFileTooLarge(file: File): boolean {
  return file.size > MAX_PROFILE_AVATAR_BYTES;
}

export function avatarUploadApiErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const response = (error as { response?: { data?: { error?: unknown } } }).response;
    if (typeof response?.data?.error === "string" && response.data.error.trim()) {
      return response.data.error;
    }
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}
