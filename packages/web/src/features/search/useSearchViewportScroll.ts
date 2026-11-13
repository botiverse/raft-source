import { useCallback, useLayoutEffect, useRef } from "react";
import { cachedSearchScrolls } from "./searchSnapshot";

/**
 * Results scroll survives the page unmounting: a phone result opened from
 * here replaces the list, and switching tabs unmounts it. Coming back to
 * the same search puts the list where it was.
 */
export function useSearchViewportScroll(searchSurface: string, searchScrollKey: string) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportScrollTopRef = useRef(0);
  const rememberViewportScroll = useCallback(() => {
    viewportScrollTopRef.current = viewportRef.current?.scrollTop ?? 0;
  }, []);
  const searchScrollKeyRef = useRef(searchScrollKey);
  searchScrollKeyRef.current = searchScrollKey;
  const searchSurfaceRef = useRef(searchSurface);
  useLayoutEffect(() => {
    const surface = searchSurfaceRef.current;
    const saved = cachedSearchScrolls.get(surface);
    if (saved && saved.key === searchScrollKeyRef.current && viewportRef.current) {
      viewportRef.current.scrollTop = saved.top;
      viewportScrollTopRef.current = saved.top;
    }
    return () => {
      cachedSearchScrolls.set(surface, { key: searchScrollKeyRef.current, top: viewportScrollTopRef.current });
    };
  }, []);
  return { viewportRef, rememberViewportScroll, searchSurfaceRef };
}
