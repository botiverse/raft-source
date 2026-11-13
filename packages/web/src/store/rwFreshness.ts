import { create } from "zustand";

// Task #164. The unread and Activity reads come from RisingWave. While it is
// overloaded the server answers either with a remembered body marked
// `X-Raft-Stale` (routes/rwStaleRead.ts) or, with nothing remembered, 503
// `rw_overloaded`. Either way the client keeps what it shows and says, once,
// that it may be out of date (StaleCountsNotice). This store is that state,
// per read:
// - `summary`: the cross-server unread summary (rail / switcher dots);
// - `unread`: this server's channel unread counts;
// - `inbox`: the Activity list;
// - `followed`: the followed threads with unread replies.
//
// `fresh`: the last answer was a clean 200. `stale`: what is shown may be old
// (an `X-Raft-Stale` answer, or values seeded from the last saved copy before
// any answer). `unavailable`: the read failed (a 503 that survived the retry,
// a 5xx, no network); whatever was shown before stays. An unavailable answer
// that says RisingWave is not configured (503 `rw_unconfigured`) also keeps its
// code: that read will not catch up on its own, so the notice says the counts
// are temporarily unavailable rather than "may be out of date".

export type RwSurface = "summary" | "unread" | "inbox" | "followed";
export type RwFreshness = "fresh" | "stale" | "unavailable";
/** The typed RisingWave failure codes of a 5xx body (server routes/errorResponse.ts). */
export type RwUnavailableCode = "rw_overloaded" | "rw_unconfigured" | "rw_read_failed";

export type RwSurfaceState = {
  freshness: RwFreshness;
  /** The server said so (a stale or failed answer), not only "seeded from the saved copy, no answer yet". */
  confirmed: boolean;
  /** The server's `Retry-After` hint (ms) from the last stale or failed answer. */
  retryAfterMs: number | null;
  /** The RisingWave code of the last failed answer, when it carried one. */
  code: RwUnavailableCode | null;
};

export const RW_SURFACES: readonly RwSurface[] = ["summary", "unread", "inbox", "followed"];

const FRESH: RwSurfaceState = { freshness: "fresh", confirmed: false, retryAfterMs: null, code: null };

type RwFreshnessState = {
  surfaces: Record<RwSurface, RwSurfaceState>;
};

const initialSurfaces = (): Record<RwSurface, RwSurfaceState> => ({
  summary: FRESH,
  unread: FRESH,
  inbox: FRESH,
  followed: FRESH,
});

export const useRwFreshnessStore = create<RwFreshnessState>(() => ({ surfaces: initialSurfaces() }));

function setSurface(surface: RwSurface, next: RwSurfaceState): void {
  useRwFreshnessStore.setState((state) => {
    const current = state.surfaces[surface];
    if (
      current.freshness === next.freshness
      && current.confirmed === next.confirmed
      && current.retryAfterMs === next.retryAfterMs
      && current.code === next.code
    ) return state;
    return { surfaces: { ...state.surfaces, [surface]: next } };
  });
}

/** A clean 200: what is shown is current. */
export function markRwFresh(surface: RwSurface): void {
  setSurface(surface, { freshness: "fresh", confirmed: true, retryAfterMs: null, code: null });
}

/** An answer the server marked `X-Raft-Stale`. */
export function markRwStale(surface: RwSurface, retryAfterMs: number | null = null): void {
  setSurface(surface, { freshness: "stale", confirmed: true, retryAfterMs, code: null });
}

/** The read failed; the last values stay. */
export function markRwUnavailable(
  surface: RwSurface,
  retryAfterMs: number | null = null,
  code: RwUnavailableCode | null = null,
): void {
  setSurface(surface, { freshness: "unavailable", confirmed: true, retryAfterMs, code });
}

/** Values seeded from the saved copy, before any answer: stale, but not confirmed (no notice yet). */
export function markRwSeeded(surface: RwSurface): void {
  const current = useRwFreshnessStore.getState().surfaces[surface];
  if (current.confirmed) return;
  setSurface(surface, { freshness: "stale", confirmed: false, retryAfterMs: null, code: null });
}

/** A server switch or sign-out: the server-scoped reads start over (the cross-server summary only on sign-out). */
export function resetRwFreshness(surfaces: readonly RwSurface[] = RW_SURFACES): void {
  useRwFreshnessStore.setState((state) => {
    const next = { ...state.surfaces };
    for (const surface of surfaces) next[surface] = FRESH;
    return { surfaces: next };
  });
}

/** True when the server said one of these reads may be out of date or failed: the notice shows. */
export function isRwOutOfDate(surfaces: Record<RwSurface, RwSurfaceState>, of: readonly RwSurface[]): boolean {
  return of.some((surface) => surfaces[surface].confirmed && surfaces[surface].freshness !== "fresh");
}

export function useRwOutOfDate(of: readonly RwSurface[]): boolean {
  return useRwFreshnessStore((state) => isRwOutOfDate(state.surfaces, of));
}

/** True when one of these reads failed because RisingWave is not configured (503 `rw_unconfigured`). */
export function isRwUnconfigured(surfaces: Record<RwSurface, RwSurfaceState>, of: readonly RwSurface[]): boolean {
  return of.some((surface) => surfaces[surface].freshness === "unavailable" && surfaces[surface].code === "rw_unconfigured");
}

export function useRwUnconfigured(of: readonly RwSurface[]): boolean {
  return useRwFreshnessStore((state) => isRwUnconfigured(state.surfaces, of));
}
