/**
 * The avatar upload limit's label, in a leaf module with no imports:
 * routes/agentRouteRefusals.ts builds refusal sentences from it at load, and
 * importing avatarService there closed an import cycle (avatarService →
 * routes/attachments → … → routes/messages.ts → agentRouteRefusals) that
 * failed the server boot (staging red after #15493).
 */
export const PROFILE_AVATAR_MAX_SIZE_LABEL = "5 MB";
