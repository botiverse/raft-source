// The one size limit for uploaded avatars (user, agent and server profiles).
// The Server enforces it; the web, the CLI and the SDK check it before
// uploading, so they all import it from here.

/** Largest accepted avatar upload, in bytes (5 MB). */
export const MAX_PROFILE_AVATAR_BYTES = 5 * 1024 * 1024;
