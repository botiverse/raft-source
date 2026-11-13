import { isHumanAvatarUrl } from "@botiverse/raft-shared/src/humanAvatar";

const SLOCK_USER_AVATAR_PATH_RE = /^\/(?:api\/)?avatars\/users\/[0-9a-f]+\.webp$/i;

/**
 * Human `avatarUrl` can contain older social-provider profile URLs. Those are
 * not Slock-uploaded custom avatars and may render provider default initials;
 * only Slock's own stored user avatar URLs are drawn (else the User
 * placeholder). The web twin of the server's `isStoredUserAvatarUrl`.
 */
export function isRaftUploadedHumanAvatarUrl(avatarUrl: string | null | undefined): avatarUrl is string {
  if (!avatarUrl) return false;
  if (SLOCK_USER_AVATAR_PATH_RE.test(avatarUrl)) return true;

  try {
    const parsed = new URL(avatarUrl);
    return SLOCK_USER_AVATAR_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** A person's built pixel avatar (`pixel-human:v1:...`): the options they
 *  chose, drawn here (HumanPixelAvatar), never fetched. */
export function isHumanPixelAvatarUrl(avatarUrl: string | null | undefined): avatarUrl is string {
  return typeof avatarUrl === "string" && isHumanAvatarUrl(avatarUrl);
}

/** How a person's avatar is drawn: their uploaded photo, their built pixel
 *  avatar, or the User placeholder (none, or one Raft doesn't draw). */
export function humanAvatarSource(avatarUrl: string | null | undefined): "uploaded" | "pixel" | "placeholder" {
  if (isRaftUploadedHumanAvatarUrl(avatarUrl)) return "uploaded";
  if (isHumanPixelAvatarUrl(avatarUrl)) return "pixel";
  return "placeholder";
}
