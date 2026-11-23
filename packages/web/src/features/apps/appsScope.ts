import type { ConnectedAppsTab } from "../../components/settings/SettingsSegmentedControls";

/**
 * The Apps page's scope by name, the old tab names included: Installed and
 * Developer (`installed`, `myapps`) are Yours now, the Marketplace
 * (`marketplace`) is Discover. Own-property lookups only, so a name such as
 * `constructor` is unknown.
 */
const SCOPE_BY_NAME = new Map<string, ConnectedAppsTab>([
  ["yours", "yours"],
  ["installed", "yours"],
  ["myapps", "yours"],
  ["discover", "discover"],
  ["marketplace", "discover"],
]);

/** The address parameter a link names the scope with. `useAppsScopeLink` uses it once and removes it. */
export const APPS_SCOPE_PARAM = "tab";

/** The scope a `?tab=` value names, or null when it names none (the page keeps the scope it has). */
export function appsScopeFromTab(value: string | null | undefined): ConnectedAppsTab | null {
  if (!value) return null;
  return SCOPE_BY_NAME.get(value.trim().toLowerCase()) ?? null;
}
