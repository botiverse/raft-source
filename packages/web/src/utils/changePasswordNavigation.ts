export const CHANGE_PASSWORD_INTENT_PATH = "/change-password";
export const CHANGE_PASSWORD_SETTINGS_OPEN_VALUE = "change-password";

export function isChangePasswordIntentPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return normalized === CHANGE_PASSWORD_INTENT_PATH;
}

export function changePasswordSettingsPath(serverSlug: string): string {
  return `/s/${encodeURIComponent(serverSlug)}/settings/account?open=${CHANGE_PASSWORD_SETTINGS_OPEN_VALUE}`;
}

/** Entering a server from `/`: its place (placeMemory), unless the password intent asks for Settings › Account. */
export function serverEntryPath({
  serverSlug,
  place,
  changePasswordIntent,
}: {
  serverSlug: string;
  place: string;
  changePasswordIntent: boolean;
}): string {
  if (changePasswordIntent) return changePasswordSettingsPath(serverSlug);
  return place;
}

export function isChangePasswordSettingsIntent(search: string): boolean {
  return new URLSearchParams(search).get("open") === CHANGE_PASSWORD_SETTINGS_OPEN_VALUE;
}
