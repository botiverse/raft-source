/**
 * Canonical Cleaner config spec (task #204).
 *
 * App-owned path (`packages/shared/src/apps/cleaner/**`), so the product app
 * name is legal here and the APP-name ratchet exempts this file.
 *
 * This module is a PURE LEAF: it imports nothing but types from the generic
 * transport, and it is the single declaration of the Cleaner config numbers.
 * Everything else derives from it —
 *
 *   - the Server App manifest consumes `CLEANER_CONFIG_CANONICAL` statically,
 *     in the product's own units (bytes, seconds);
 *   - the Computer wire spec below is COMPUTED from the same constant, so the
 *     ms values are never hand-written and cannot drift.
 *
 * There is deliberately no second hand-copied table and no "mirror" to keep in
 * sync. If a bound changes, change `CLEANER_CONFIG_CANONICAL` and every
 * consumer follows.
 *
 * Config truth only — no timer, measurement, notification, or raw command/argv.
 */

import type {
  AppConfigBoundsMap,
  AppConfigValue,
} from "../../appConfigTransport.js";

/** Closed product app id for the Cleaner built-in. */
export const CLEANER_APP_ID = "system.cleaner" as const;
/** Closed notification-class identity for the Computer-local hint. */
export const CLEANER_NOTIFICATION_CLASS = "memory_size_hint" as const;

export const SECONDS_TO_MS = 1000;

/**
 * The canonical spec, in SERVER units — bytes and seconds, matching the App
 * manifest and the durable config store.
 */
export const CLEANER_CONFIG_CANONICAL = {
  enabled: { default: true },
  thresholdBytes: { default: 65_536, min: 4_096, max: 1_073_741_824 },
  intervalSeconds: { default: 3_600, min: 900, max: 604_800 },
} as const;

/** Durable store / manifest key ↔ wire key. The wire carries no snake_case. */
export const CLEANER_STORE_KEYS = {
  enabled: "enabled",
  thresholdBytes: "threshold_bytes",
  intervalMs: "interval_seconds",
} as const;

export type CleanerConfigKey = keyof typeof CLEANER_STORE_KEYS;

/** Closed effective-map keys carried on the Computer wire. */
export const CLEANER_CONFIG_KEYS = {
  enabled: "enabled",
  thresholdBytes: "thresholdBytes",
  intervalMs: "intervalMs",
} as const satisfies Record<CleanerConfigKey, string>;

/**
 * Wire bounds, DERIVED. `thresholdBytes` carries across unconverted;
 * `intervalMs` is the canonical seconds window × 1000.
 *
 * `thresholdBytes.max` (1 GiB) is the ceiling the primary "raise threshold ×2"
 * action clamps against. `intervalMs.min` (15 min) also keeps a `>0`-only check
 * from admitting a 1ms interval, which would let measurement passes overlap.
 */
export const CLEANER_CONFIG_BOUNDS = {
  thresholdBytes: {
    min: CLEANER_CONFIG_CANONICAL.thresholdBytes.min,
    max: CLEANER_CONFIG_CANONICAL.thresholdBytes.max,
  },
  intervalMs: {
    min: CLEANER_CONFIG_CANONICAL.intervalSeconds.min * SECONDS_TO_MS,
    max: CLEANER_CONFIG_CANONICAL.intervalSeconds.max * SECONDS_TO_MS,
  },
} as const satisfies AppConfigBoundsMap;

/** Wire defaults, DERIVED from the same canonical spec. */
export const CLEANER_CONFIG_DEFAULTS = {
  enabled: CLEANER_CONFIG_CANONICAL.enabled.default,
  thresholdBytes: CLEANER_CONFIG_CANONICAL.thresholdBytes.default,
  intervalMs: CLEANER_CONFIG_CANONICAL.intervalSeconds.default * SECONDS_TO_MS,
} as const satisfies Record<CleanerConfigKey, AppConfigValue>;
