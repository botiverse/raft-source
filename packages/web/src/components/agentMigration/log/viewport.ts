import { useEffect, useLayoutEffect, useState } from "react";

/** The migration log page's view of the screen: its size, its input, and a sideways scroller's hidden sides. */

export function useIsDesktop() {
  const query = "(min-width: 768px)";
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

/** The window's width, kept current on resize (the phone chart fits it). */
export function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** A touch screen (DS Responsive › Touch screens: decide by the input, not the width). */
export function useCoarsePointer() {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

type Overflow = "none" | "start" | "end" | "both";
const FADE = "24px";
export const FADE_MASK: Record<Overflow, string | undefined> = {
  none: undefined,
  start: `linear-gradient(to right, transparent, black ${FADE})`,
  end: `linear-gradient(to right, black calc(100% - ${FADE}), transparent)`,
  both: `linear-gradient(to right, transparent, black ${FADE}, black calc(100% - ${FADE}), transparent)`,
};

/** Which sides of a sideways scroller hide content, kept current on scroll and resize (DS Spacing › fades). */
export function useScrollOverflow(enabled: boolean, contentKey: string) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<Overflow>("none");
  useLayoutEffect(() => {
    if (!el || !enabled) { setOverflow("none"); return; }
    const measure = () => {
      const start = el.scrollLeft > 1, end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setOverflow(start && end ? "both" : start ? "start" : end ? "end" : "none");
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => { el.removeEventListener("scroll", measure); ro.disconnect(); };
  }, [el, enabled, contentKey]);
  return { ref: setEl, overflow };
}
