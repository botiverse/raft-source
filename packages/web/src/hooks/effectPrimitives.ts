/**
 * Sanctioned view-effect primitives — RFC 037 L4.
 *
 * These are the named escape hatches for the ONLY legitimate component-side
 * effects: DOM measurement/sync, animation retriggering, and external event
 * bridges. As slices land, their component directories get an oxlint override
 * banning raw `useEffect` imports; view effects go through these instead, so
 * every remaining effect in a migrated directory is greppable and declares
 * its category in its name.
 *
 * Data-flow glue (fetching, store sync, prop mirroring) must NOT be expressed
 * with these — that belongs to L1/L2 (RFC 037 §1).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * DOM measurement/synchronization effect. Runs before paint (layout effect)
 * so measured writes don't flash. `measure` receives no arguments — read the
 * DOM via refs captured in the closure; return a cleanup like useEffect.
 */
export function useDomMeasureEffect(
  measure: () => void | (() => void),
  deps: readonly unknown[],
): void {
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's contract
  useLayoutEffect(measure, deps as unknown[]);
}

/**
 * Animation retrigger: returns a monotonically increasing key that bumps
 * whenever `value` changes (after the first render). Use the key on the
 * animated element (`key={bump}`) to restart a CSS animation on change.
 * Replaces the ad-hoc previousRef + setState-in-effect pattern
 * (e.g. MessageItem's ReactionCount).
 */
export function useAnimationRetrigger(value: unknown): number {
  const previousRef = useRef(value);
  const [bump, setBump] = useState(0);
  // Documented FP family "animation-key bump" (see .oxlintrc.json history —
  // same as MessageItem's ReactionCount): the counter is animation state,
  // not derived data; the ref guard ensures only real transitions bump.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (previousRef.current === value) return;
    previousRef.current = value;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setBump((key) => key + 1);
  }, [value]);
  return bump;
}

type EventBridgeTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * External event bridge: subscribes `handler` to `eventName` on `target`
 * (window / document / media query list / any EventTarget) with automatic
 * cleanup. The latest handler is always invoked without re-subscribing, so
 * callers do not need to memoize it (and cannot cause teardown gaps by
 * forgetting to — the MainLayout mega-effect lesson).
 */
export function useEventBridge<E extends Event>(
  target: EventBridgeTarget | null | undefined,
  eventName: string,
  handler: (event: E) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!target) return;
    const listener = (event: Event) => handlerRef.current(event as E);
    target.addEventListener(eventName, listener);
    return () => target.removeEventListener(eventName, listener);
  }, [target, eventName]);
}

/**
 * The canonical media-query subscription (kills the 6 hand-rolled
 * matchMedia effects found in Phase A, including the one that forgot to
 * subscribe). SSR-safe: returns `fallback` when `window` is unavailable.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : fallback,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);
  return matches;
}
