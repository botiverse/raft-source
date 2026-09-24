// PostHog analytics — the SINGLE module that touches the PostHog SDK.
//
// Everything else in the app imports the small typed surface below
// (`initAnalytics` / `identifyUser` / `resetAnalytics` / `trackEvent` /
// `useFeatureVariant`) and never `posthog-js` directly. Keeping the vendor
// import behind one boundary means: (a) feature code is decoupled from the SDK,
// (b) the privacy/enablement policy lives in one place, (c) swapping or
// reverse-proxying PostHog later is a one-file change.
//
// **Enablement is env-gated and OFF by default.** Analytics initialises only
// when `VITE_POSTHOG_KEY` is present (set on staging/prod web env). With no key
// — local dev, self-hosted deployments, CI, tests — `initAnalytics()` is a
// no-op, every helper below no-ops, and `useFeatureVariant` returns its caller
// default. So nothing is sent off-domain unless an operator deliberately
// configures a key (stdrc #proj-activity:171042a3 2026-06-25). We also disable
// `autocapture` + automatic pageviews: only the curated events this app calls
// `trackEvent` with are ever sent — never message bodies or PII.
import posthog from "posthog-js";
import { useEffect, useState } from "react";

let enabled = false;

/**
 * Initialise PostHog once at app boot. No-op (and leaves analytics disabled)
 * unless `VITE_POSTHOG_KEY` is configured. Safe to call when already inited.
 */
export function initAnalytics(): void {
  if (enabled) return;
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key) return; // disabled: no key → no analytics, no network, no flags
  const apiHost =
    (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || "https://us.i.posthog.com";
  posthog.init(key, {
    api_host: apiHost,
    // Curated-events-only: do not auto-capture DOM interactions or pageviews,
    // so the only data leaving the app is what we explicitly `trackEvent`.
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    // We call identify() explicitly post-login; until then events are anon.
    person_profiles: "identified_only",
  });
  enabled = true;
}

export function isAnalyticsEnabled(): boolean {
  return enabled;
}

// ── Local feature-flag overrides ────────────────────────────────────────────
// A per-browser override of a flag's resolved variant, used by the Dev tools
// panel (and the `?<flag>=` URL convenience). This is a LOCAL RENDER override
// only: it changes what this browser shows, not server-side bucketing or
// experiment exposure (real exposure events still fire from the true flags), so
// it's safe to use even against a live experiment for previewing.
const FLAG_OVERRIDE_PREFIX = "slock:flagOverride:";

export function getFlagOverride(flagKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(FLAG_OVERRIDE_PREFIX + flagKey);
  } catch {
    return null;
  }
}

/** Set (value) or clear (null) the local override for a flag. */
export function setFlagOverride(flagKey: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(FLAG_OVERRIDE_PREFIX + flagKey);
    else window.localStorage.setItem(FLAG_OVERRIDE_PREFIX + flagKey, value);
  } catch {
    // ignore (private mode / quota)
  }
}

/** Tie subsequent events + feature-flag bucketing to a stable user id. */
export function identifyUser(userId: string, traits?: Record<string, string | number | boolean>): void {
  if (!enabled) return;
  posthog.identify(userId, traits);
}

/** Clear identity on logout so the next user doesn't inherit the prior bucket. */
export function resetAnalytics(): void {
  if (!enabled) return;
  posthog.reset();
}

/**
 * Capture a curated product event. No-op when analytics is disabled.
 * Keep `props` low-cardinality + PII-free (ids/enums/counts only).
 */
export function trackEvent(event: string, props?: Record<string, string | number | boolean | undefined>): void {
  if (!enabled) return;
  posthog.capture(event, props);
}

/**
 * Read a multivariate feature-flag variant, reactively. Returns `fallback`
 * when analytics is disabled or the flag is unresolved/absent — so a missing
 * PostHog config never changes behaviour (callers get the default variant).
 *
 * Subscribes to `onFeatureFlags` so the value updates once flags load (they
 * arrive async after init). PostHog does deterministic per-distinct-id
 * bucketing server-side, so no client-side hashing is needed.
 */
export function useFeatureVariant<T extends string>(flagKey: string, fallback: T): T {
  // Local override (Dev tools) wins, regardless of analytics state — it's a
  // deliberate per-browser render override.
  const override = getFlagOverride(flagKey);
  const [flagValue, setFlagValue] = useState<T | null>(null);

  useEffect(() => {
    // Override / disabled-analytics: nothing to subscribe to; the derived
    // return below (override ?? flagValue ?? fallback) covers both, and
    // flagValue stays null. Only subscribe when we actually read PostHog.
    // (`enabled` is set once at init; override changes trigger a page reload via
    // the Dev tools panel, so we never need to reset flagValue here.)
    if (override || !enabled) return;
    const read = () => {
      const v = posthog.getFeatureFlag(flagKey);
      setFlagValue(typeof v === "string" ? (v as T) : null);
    };
    read();
    // onFeatureFlags fires when flags (re)load; returns an unsubscribe fn.
    const unsub = posthog.onFeatureFlags(read);
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [flagKey, override]);

  // Precedence: local override → live PostHog value → caller fallback.
  return (override as T) ?? flagValue ?? fallback;
}

export function getFeatureVariant<T extends string>(flagKey: string, fallback: T): T {
  const override = getFlagOverride(flagKey);
  if (override) return override as T;
  if (!enabled) return fallback;
  const value = posthog.getFeatureFlag(flagKey);
  return typeof value === "string" ? (value as T) : fallback;
}
