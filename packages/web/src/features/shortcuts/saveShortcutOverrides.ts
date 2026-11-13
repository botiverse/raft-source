import type { StoredShortcutCombo, StoredShortcutOverrides } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import type { ShortcutOverrides } from "./overridesState";

function storedOf(combo: ShortcutCombo): StoredShortcutCombo {
  const stored: StoredShortcutCombo = { key: combo.key };
  if (combo.mod) stored.mod = true;
  if (combo.ctrl) stored.ctrl = true;
  if (combo.alt) stored.alt = true;
  if (combo.shift) stored.shift = true;
  return stored;
}

/**
 * Shows the change at once and saves it to the account (PATCH /auth/me, the whole map); a failed save puts the
 * previous state back (unless a later change replaced it) and rethrows. Saving the otter's change also clears its
 * Settings-era field, so this map alone holds it from then on.
 */
export async function saveShortcutOverrides(next: ShortcutOverrides): Promise<void> {
  const user = useAuthStore.getState().user;
  if (!user) return;
  const stored: StoredShortcutOverrides = {};
  for (const [id, combos] of Object.entries(next)) stored[id] = combos.map(storedOf);
  const body: Record<string, unknown> = { shortcutOverrides: Object.keys(stored).length > 0 ? stored : null };
  const clearsOtter = user.assistantOtterShortcut != null;
  if (clearsOtter) body.assistantOtterShortcut = null;
  const previous = { shortcutOverrides: user.shortcutOverrides ?? null, assistantOtterShortcut: user.assistantOtterShortcut ?? null };
  const written = body.shortcutOverrides as StoredShortcutOverrides | null;
  useAuthStore.setState({ user: { ...user, shortcutOverrides: written, ...(clearsOtter ? { assistantOtterShortcut: null } : {}) } });
  const stillThis = () => {
    const current = useAuthStore.getState().user;
    return current && (current.shortcutOverrides ?? null) === written ? current : null;
  };
  try {
    const { data } = await api.patch("/auth/me", body);
    const current = stillThis();
    if (current && data && "shortcutOverrides" in data) {
      useAuthStore.setState({ user: { ...current, shortcutOverrides: data.shortcutOverrides ?? null } });
    }
  } catch (err) {
    const current = stillThis();
    if (current) useAuthStore.setState({ user: { ...current, ...previous } });
    throw err;
  }
}
