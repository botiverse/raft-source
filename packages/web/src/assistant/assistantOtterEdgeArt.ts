// The otter's own pose for each kind of edge (#proj-assistant:#24, Cody's
// artwork #proj-assistant:#26): leaning out of a vertical edge it stands
// upright, its body toward the content; under a pane's top edge it hangs by
// both paws, face forward. Never the lying pose turned on its side. On a
// composer, or lying on a pane's bottom edge, it keeps the lying poses
// (AssistantOtter.tsx POSES).
//
// Each image sits on Cody's 128x128 CSS px canvas by its own box (manifest
// `css`), the edge at the canvas's anchor; only the visible otter (manifest
// `visibleBoundsCss`) takes the pointer. Awake (a new message, or something
// to confirm) it waves; otherwise it rests.
//
// Motion (Artea, #24): a flight along an arc to a new place and a small
// squash where it lands (here); something new pops it out from behind its
// edge with two small bobs away from it (index.css assistant-otter-wake, its
// direction from TOWARD_EDGE). Never a sideways sway. With reduced motion only
// the place changes.

import type { OtterFacing } from "./assistantOtterDock";
import type { OtterMood } from "./assistantOtterState";
import leftIdleUrl from "./otter/edge/left-idle.webp";
import leftNewUrl from "./otter/edge/left-new.webp";
import rightIdleUrl from "./otter/edge/right-idle.webp";
import rightNewUrl from "./otter/edge/right-new.webp";
import topIdleUrl from "./otter/edge/top-idle.webp";
import topNewUrl from "./otter/edge/top-new.webp";

/** One pose on the 128px canvas: the edge point, the image's box and the visible otter's, in canvas px. */
export type EdgeArt = {
  src: string;
  anchor: readonly [number, number];
  css: readonly [left: number, top: number, width: number, height: number];
  visible: readonly [x1: number, y1: number, x2: number, y2: number];
};

// Cody's "left" poses have the edge on the canvas's left (the otter right of
// it, `facing: "right"`), his "right" ones the reverse; "top" hangs down.
const ART: Record<Exclude<OtterFacing, "up">, { rest: EdgeArt; awake: EdgeArt }> = {
  right: {
    rest: { src: leftIdleUrl, anchor: [12, 64], css: [-18.45, -3.2, 131.67, 131.67], visible: [7.07, 10.24, 75.63, 118.08] },
    awake: { src: leftNewUrl, anchor: [12, 64], css: [-18.45, -3.2, 131.67, 131.67], visible: [7.91, 10.24, 80.25, 118.18] },
  },
  left: {
    rest: { src: rightIdleUrl, anchor: [116, 64], css: [16.25, -3.2, 131.67, 131.67], visible: [50.59, 10.45, 121.98, 117.97] },
    awake: { src: rightNewUrl, anchor: [116, 64], css: [16.25, -3.2, 131.67, 131.67], visible: [45.12, 10.24, 120.41, 118.08] },
  },
  down: {
    rest: { src: topIdleUrl, anchor: [64, 12], css: [-1.1, -2.17, 131.67, 131.67], visible: [33.97, 7.7, 92.77, 114.27] },
    awake: { src: topNewUrl, anchor: [64, 12], css: [-1.1, -2.17, 131.67, 131.67], visible: [29.88, 8.43, 92.77, 115.64] },
  },
};

/** The pose for an edge it is docked on; null where it lies (a composer, a pane's bottom edge). */
export function edgeArtFor(facing: OtterFacing, mood: OtterMood): EdgeArt | null {
  if (facing === "up") return null;
  return mood === "new" || mood === "confirm" ? ART[facing].awake : ART[facing].rest;
}

/** The visible otter's box, from the edge point (its anchor). */
export function edgeArtBox(art: EdgeArt): { left: number; top: number; width: number; height: number } {
  const [x1, y1, x2, y2] = art.visible;
  return { left: x1 - art.anchor[0], top: y1 - art.anchor[1], width: x2 - x1, height: y2 - y1 };
}

/** One step toward the edge it is on, in px: where it pops out from. */
export const TOWARD_EDGE: Record<OtterFacing, readonly [number, number]> = { up: [0, 1], right: [-1, 0], left: [1, 0], down: [0, -1] };

function motionAllowed(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * From where it was (`dx`, `dy` from its new place) along an arc to its new
 * place, then a squash across the edge it lands on. `el` is the otter's
 * layer, its origin the edge point.
 */
export function playOtterFlight(el: HTMLElement | null, dx: number, dy: number, facing: OtterFacing): void {
  if (!el || !motionAllowed() || typeof el.animate !== "function" || Math.hypot(dx, dy) < 2) return;
  const lift = Math.min(70, 20 + Math.hypot(dx, dy) * 0.12);
  for (const running of el.getAnimations?.() ?? []) running.cancel();
  const flight = el.animate([
    { transform: `translate(${dx}px, ${dy}px)` },
    { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - lift}px)`, offset: 0.5 },
    { transform: "none" },
  ], { duration: 420, easing: "cubic-bezier(0.25, 0.8, 0.3, 1)" });
  flight.onfinish = () => playOtterLanding(el, facing);
}

/** Squashed against the edge it lands on, then a little stretch away from it. */
export function playOtterLanding(el: HTMLElement | null, facing: OtterFacing): void {
  if (!el || !motionAllowed() || typeof el.animate !== "function") return;
  const across = facing === "up" || facing === "down";
  const [a, b, c, d] = across ? [1.08, 0.88, 0.97, 1.05] : [0.88, 1.08, 1.05, 0.97];
  el.animate([
    { transform: `scale(${a}, ${b})` },
    { transform: `scale(${c}, ${d})`, offset: 0.55 },
    { transform: "none" },
  ], { duration: 380, easing: "ease-out" });
}
