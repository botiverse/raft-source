// A comment box the page opened is armed for a moment (P108), wired to the box: whether it is
// arming now, and whether a press or a key that began before it was armed may post.
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { currentTimeMs } from "@botiverse/raft-shared";

import { PAGE_COMMENT_ARM_MS } from "./artifactPageComments";

/**
 * Armed once the page opened it (P108; the panel mounts a box per open): until `armedUntil`,
 * nothing sends; a press or a key that began before then (the second click of a double click
 * on the page's button, a held Enter) never sends either. The latest press decides.
 */
export function useCommentBoxArming(fromPage: boolean) {
  const armedUntil = useRef<number | null>(null);
  if (armedUntil.current === null) armedUntil.current = fromPage ? currentTimeMs() + PAGE_COMMENT_ARM_MS : 0;
  const pressBeganArming = useRef(fromPage);
  const [arming, setArming] = useState(fromPage);
  useEffect(() => {
    const timer = window.setTimeout(() => setArming(false), Math.max(0, (armedUntil.current ?? 0) - currentTimeMs()));
    return () => window.clearTimeout(timer);
  }, []);
  const stillArming = useCallback(() => currentTimeMs() < (armedUntil.current ?? 0), []);
  const notePress = useCallback(() => { pressBeganArming.current = stillArming(); }, [stillArming]);
  const noteKey = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!event.repeat) pressBeganArming.current = stillArming();
    // Armed, Enter and Tab reach nothing in the box (not the @ picker either).
    if (stillArming() && (event.key === "Enter" || event.key === "Tab")) {
      if (event.key === "Enter") event.preventDefault();
      event.stopPropagation();
    }
  }, [stillArming]);
  /** Past arming, and the latest press or key began after it (the box's own `theirs` aside). */
  const armedOut = useCallback(() => !stillArming() && (!fromPage || !pressBeganArming.current), [stillArming, fromPage]);
  return { arming, notePress, noteKey, armedOut };
}
