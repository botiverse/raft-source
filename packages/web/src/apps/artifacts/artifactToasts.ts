/**
 * An error toast as the app's showToast bridge showed it before the viewer used the nearest provider's toasts
 * (useToast, #337 PR3): announced politely. raft-ui's `toast.error` announces assertively ("high") unless told, and
 * showToast added an error with no priority (Base UI's "low"); the same time on screen either way (8 s).
 */
export const POLITE_ERROR = { priority: "low" } as const;
