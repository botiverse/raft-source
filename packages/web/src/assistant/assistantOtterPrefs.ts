// The otter's account settings (#proj-assistant:#21): whether it shows over
// every page, and its hide/show shortcut (shared assistantOtterShortcut.ts:
// null = the default, "off" = none; read by the shortcut registry,
// features/shortcuts/overridesState.ts, and cleared once the keyboard
// shortcuts panel holds the otter's keys). GET/PATCH /auth/me carry them on the
// account's profile; they live here rather than in authStore, which reads the
// same profile, so the otter's code stays with the otter.

import api from "../api/client";
import { useAuthStore } from "../store/authStore";
import type { User } from "../store/authStore";

export type AssistantOtterPrefs = {
  /** Absent (an older server) = shown. */
  assistantOtterVisible?: boolean;
  /** null/absent = the default shortcut, "off" = none. */
  assistantOtterShortcut?: string | null;
};

type UserWithOtterPrefs = User & AssistantOtterPrefs;

function currentUser(): UserWithOtterPrefs | null {
  return useAuthStore.getState().user as UserWithOtterPrefs | null;
}

/** The account's switch: on unless the person turned it off. */
export function useOtterVisiblePref(): boolean {
  return useAuthStore((state) => (state.user as UserWithOtterPrefs | null)?.assistantOtterVisible !== false);
}

/**
 * Shows the change at once and saves it to the account; a failed save puts
 * the previous value back (unless a later change replaced it) and rethrows.
 */
export async function saveAssistantOtterPrefs(prefs: AssistantOtterPrefs): Promise<void> {
  const user = currentUser();
  if (!user) return;
  const previous: AssistantOtterPrefs = {};
  if (prefs.assistantOtterVisible !== undefined) previous.assistantOtterVisible = user.assistantOtterVisible ?? true;
  if (prefs.assistantOtterShortcut !== undefined) previous.assistantOtterShortcut = user.assistantOtterShortcut ?? null;
  useAuthStore.setState({ user: { ...user, ...prefs } });
  const stillThis = (current: UserWithOtterPrefs | null): current is UserWithOtterPrefs => !!current
    && (prefs.assistantOtterVisible === undefined || current.assistantOtterVisible === prefs.assistantOtterVisible)
    && (prefs.assistantOtterShortcut === undefined || current.assistantOtterShortcut === prefs.assistantOtterShortcut);
  try {
    const { data } = await api.patch("/auth/me", prefs);
    const current = currentUser();
    if (!stillThis(current)) return;
    const saved: AssistantOtterPrefs = {};
    if (typeof data?.assistantOtterVisible === "boolean") saved.assistantOtterVisible = data.assistantOtterVisible;
    if (data && "assistantOtterShortcut" in data) saved.assistantOtterShortcut = data.assistantOtterShortcut ?? null;
    useAuthStore.setState({ user: { ...current, ...saved } });
  } catch (err) {
    const current = currentUser();
    if (stillThis(current)) useAuthStore.setState({ user: { ...current, ...previous } });
    throw err;
  }
}
