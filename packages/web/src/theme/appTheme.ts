import type { ThemeMode } from "@botiverse/raft-ui";

// Raft web runs on the Raft Design System in a light and a dark mode; the only
// appearance choice is the mode.

/**
 * Storage keys. Older builds persisted a mixed family+mode preset under
 * `slock-theme-preset` (and per account under the prefix), then a two-axis
 * `{ mode, lightThemeId, darkThemeId }` record under the preferences key. Both
 * stay readable so an existing device keeps its light/dark choice.
 */
export const APP_THEME_STORAGE_KEY = "slock-theme-preset";
export const APP_THEME_PREFERENCES_STORAGE_KEY = "slock-theme-preferences-v2";
export const APP_THEME_PRESET_STORAGE_KEY_PREFIX = "raft:theme-preset:v1:";

export type AppAppearanceMode = ThemeMode;
export type AppResolvedMode = Exclude<AppAppearanceMode, "system">;

export interface AppThemePreferences {
  mode: AppAppearanceMode;
}

export const DEFAULT_APP_THEME_PREFERENCES: AppThemePreferences = { mode: "system" };

// The default (system) first (stdrc, 2026-11-05).
export const APP_APPEARANCE_MODES = ["system", "light", "dark"] as const satisfies readonly AppAppearanceMode[];

/** Legacy mixed presets and the mode each one meant. */
const LEGACY_PRESET_MODES: Record<string, AppAppearanceMode> = {
  brutal: "light",
  "elegant-light": "light",
  "elegant-dark": "dark",
  "elegant-system": "system",
};

export function isAppAppearanceMode(value: unknown): value is AppAppearanceMode {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * A stored record is usable when it names a mode. Records written by the
 * two-axis build also carry theme ids; those no longer select anything.
 */
export function isAppThemePreferences(value: unknown): value is AppThemePreferences {
  return !!value && typeof value === "object" && isAppAppearanceMode((value as { mode?: unknown }).mode);
}

export function normalizeAppThemePreferences(value: unknown): AppThemePreferences | null {
  return isAppThemePreferences(value) ? { mode: value.mode } : null;
}

export function preferencesFromLegacyPreset(preset: unknown): AppThemePreferences | null {
  if (typeof preset !== "string") return null;
  const mode = LEGACY_PRESET_MODES[preset];
  return mode ? { mode } : null;
}

export function readSystemThemeMode(): AppResolvedMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function resolveAppThemeMode(
  preferences: AppThemePreferences,
  systemMode: AppResolvedMode = "light",
): AppResolvedMode {
  return preferences.mode === "system" ? systemMode : preferences.mode;
}
