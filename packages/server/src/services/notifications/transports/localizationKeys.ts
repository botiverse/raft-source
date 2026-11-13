/**
 * Which localization keys a mobile app is sent (contract §3.1): only keys of
 * the preview key set its registration declares. iOS without a service
 * extension shows an unknown `loc-key` verbatim, so a key outside the set is
 * left out and its field travels as the English text alone.
 */
import { notificationCopyKeyInSet } from "@botiverse/raft-shared";
import type { NotificationAlertLocalization } from "../types";

const HIDDEN_TITLE_KEY = "push.preview.hidden.title";

/**
 * The part of `localization` an app of preview key set `keySet` ships. The
 * hidden title goes only with its body key, as before key set 3: an app of
 * set 1 gets no key at all for a hidden task update, exactly as it did.
 */
export function localizationInKeySet(
  localization: NotificationAlertLocalization | undefined,
  keySet: number,
): NotificationAlertLocalization | undefined {
  if (!localization) return undefined;
  const kept: NotificationAlertLocalization = {};
  for (const part of ["title", "subtitle", "body"] as const) {
    const key = localization[`${part}Key`];
    if (!key || !notificationCopyKeyInSet(key, keySet)) continue;
    kept[`${part}Key`] = key;
    const args = localization[`${part}Args`];
    if (args) kept[`${part}Args`] = args;
  }
  if (kept.titleKey === HIDDEN_TITLE_KEY && !kept.bodyKey) {
    delete kept.titleKey;
    delete kept.titleArgs;
  }
  return kept.titleKey || kept.subtitleKey || kept.bodyKey ? kept : undefined;
}
