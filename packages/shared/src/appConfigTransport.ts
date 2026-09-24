/**
 * Generic Server→Computer app-config transport (task #204).
 *
 * Carries durable app configuration snapshots to the Computer/daemon. This file
 * is app-agnostic BY CONSTRUCTION: it contains no declared app name, no app id,
 * and no app-specific limit. Per-app identity, keys, defaults, and bounds live
 * in that app's own directory — e.g. `src/apps/<app>/configProtocol.ts` — and
 * are passed in as data.
 *
 * Keep it that way. If something here seems to need an app name, that is a
 * finding about the contract, not a reason to add one: this module stays in the
 * generic root only for as long as it stays nameless.
 *
 * Not re-exported from the package root barrel. Consumers deep-import
 * `@botiverse/raft-shared/src/appConfigTransport.js`.
 *
 * Delivers config only — no notifications, timers, measurement results, or raw
 * command/argv.
 */

export type AppConfigValue = boolean | number;

/**
 * Typed config envelope for one (appId, ownerAgentId) binding.
 * `effective` is the closed map of validated keys after defaults+overrides.
 */
export type AppConfigWireSnapshot = {
  appId: string;
  ownerAgentId: string;
  revision: number;
  effective: Readonly<Record<string, AppConfigValue>>;
};

/** Inclusive numeric bound pair for one config key. */
export type AppConfigNumericBounds = { min: number; max: number };

/** Declared bounds for the numeric keys of one app's config. */
export type AppConfigBoundsMap = Readonly<Record<string, AppConfigNumericBounds>>;

export function isAppConfigValue(value: unknown): value is AppConfigValue {
  return typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value));
}

export type AppConfigBoundsCheck = { ok: true } | { ok: false; errors: string[] };

/**
 * Reject — never silently clamp — a config map whose numeric keys fall outside
 * their declared bounds. Both the Server manifest validator and the daemon
 * parser call this so an illegal wire value is refused identically on each side.
 *
 * Keys absent from `bounds` are not range-checked here; keys absent from
 * `effective` are not invented.
 */
export function validateAppConfigWithinBounds(
  effective: Readonly<Record<string, AppConfigValue>>,
  bounds: AppConfigBoundsMap,
): AppConfigBoundsCheck {
  const errors: string[] = [];
  for (const [key, bound] of Object.entries(bounds)) {
    if (!(key in effective)) continue;
    const value = effective[key];
    if (typeof value !== "number") {
      errors.push(`${key}: expected number, got ${typeof value}`);
      continue;
    }
    if (value < bound.min || value > bound.max) {
      errors.push(`${key}: ${value} outside [${bound.min}, ${bound.max}]`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Structural normalizer for an untrusted inbound envelope.
 *
 * Returns null on any shape violation. When `bounds` is supplied the numeric
 * range check is applied too, so a structurally valid but out-of-range envelope
 * is rejected rather than accepted and clamped downstream.
 */
export function normalizeAppConfigWireSnapshot(
  raw: unknown,
  bounds?: AppConfigBoundsMap,
): AppConfigWireSnapshot | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.appId !== "string" || !o.appId.trim()) return null;
  if (typeof o.ownerAgentId !== "string" || !o.ownerAgentId.trim()) return null;
  if (typeof o.revision !== "number" || !Number.isSafeInteger(o.revision) || o.revision < 0) {
    return null;
  }
  if (o.effective === null || typeof o.effective !== "object" || Array.isArray(o.effective)) {
    return null;
  }
  const effective: Record<string, AppConfigValue> = {};
  for (const [key, value] of Object.entries(o.effective as Record<string, unknown>)) {
    if (!key || !isAppConfigValue(value)) return null;
    effective[key] = value;
  }
  if (bounds && !validateAppConfigWithinBounds(effective, bounds).ok) return null;
  return {
    appId: o.appId.trim(),
    ownerAgentId: o.ownerAgentId.trim(),
    revision: o.revision,
    effective,
  };
}
