/**
 * Activity cutover gate — a LEAF module by contract.
 *
 * This file must not import anything from the activity panel (consumer, host,
 * runtime, generated schema) or from sync-core: it is consulted by the
 * gate-off initial bundle on every inbox load, and its entire purpose is to
 * let that bundle decide "do nothing" without paying for the machinery it is
 * not running. The runtime and its dependency tree load through a dynamic
 * import in `bootstrap.ts` only after this gate says shadow/on.
 * (task #393 — PR #5678 shipped the runtime statically and gate-off users
 * paid ~50KB brotli for code that never executed.)
 */

export type ActivityCutoverGate = "off" | "shadow" | "on";

/**
 * Gate resolution is fail-closed: anything that is not exactly `shadow` or `on`
 * is `off`. Same shape as the RFC056 serving-mode guard — an unrecognised or
 * absent value must never authorise serving from a new source.
 */
export function resolveActivityCutoverGate(
  raw: string | undefined | null,
): ActivityCutoverGate {
  const value = raw?.trim().toLowerCase();
  if (value === "shadow" || value === "on") return value;
  return "off";
}

/**
 * Test-only gate override.
 *
 * Needed because the shipped gate reads `import.meta.env`, which a unit test
 * cannot set — without this the only assertable behaviour is the gate-off
 * no-op. Never set from production code. Lives here (not in runtime.ts) so
 * the bootstrap entry and the runtime consult the SAME override.
 */
let gateOverrideForTests: ActivityCutoverGate | null = null;

export function setActivityGateOverrideForTests(
  value: ActivityCutoverGate | null,
): void {
  gateOverrideForTests = value;
}

/** The gate the production wiring consults (override-aware for tests). */
export function resolveActivityGateFromEnv(): ActivityCutoverGate {
  if (gateOverrideForTests !== null) return gateOverrideForTests;
  return resolveActivityCutoverGate(
    (import.meta as { env?: Record<string, string | undefined> }).env
      ?.VITE_ACTIVITY_SYNC_CORE_MODE,
  );
}
