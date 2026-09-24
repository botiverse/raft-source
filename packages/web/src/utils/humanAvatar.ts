const SLOCK_USER_AVATAR_PATH_RE = /^\/(?:api\/)?avatars\/users\/[0-9a-f]+\.webp$/i;

/**
 * Human `avatarUrl` can contain older social-provider profile URLs. Those are
 * not Slock-uploaded custom avatars and may render provider default initials;
 * only Slock's own uploaded user avatar URLs should preempt Gravatar.
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
