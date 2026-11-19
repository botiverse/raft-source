import { createContext, useContext, useEffect, useState } from "react";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { ArtifactKind } from "@botiverse/raft-shared";

/**
 * The Artifact loading splash's parameters, icons and clock (the components: ArtifactLoadingSplash.tsx).
 * A TRIAL (#proj-workspace:#145), not a Raft Design System rule yet: the values are Kirby's mockup's
 * (Artifact GviuJRSsa1cRKnxHuraP9j, direction 1 "像素拼图"), named so the native App can mirror them.
 */

/** Nothing shows before this, from the opening (the Spinner's rule). */
export const ARTIFACT_SPLASH_APPEAR_AFTER_MS = 1000;
/** One cycle: assemble (0–40%), hold (40–60%), disperse (60–85%), rest (85–100%). */
export const ARTIFACT_SPLASH_CYCLE_MS = 2400;
/** On loaded: the cells still unlit fill in within this. */
export const ARTIFACT_SPLASH_FILL_MS = 120;
/** On loaded: the complete icon holds this long once filled (the mockup's `motion-artifact-loader-hold`). */
export const ARTIFACT_SPLASH_HOLD_MS = 240;
/** Then the cover fades out over this, with ARTIFACT_SPLASH_FADE_EASING. */
export const ARTIFACT_SPLASH_FADE_MS = 120;
/** raft-design's `ease-out`. */
export const ARTIFACT_SPLASH_FADE_EASING = "cubic-bezier(0, 0, 0.58, 1)";
/** An unlit cell's opacity (the Spinner's). */
export const ARTIFACT_SPLASH_DIM_OPACITY = 0.2;
/** The icon's grid: cells a side, and the gap between cells (px). */
export const ARTIFACT_SPLASH_GRID = 8;
export const ARTIFACT_SPLASH_GAP_PX = 1;
/** A cell's size (px): the viewer's side card, the Artifact's own page (and the public page). */
export const ARTIFACT_SPLASH_PIXEL_PX = { side: 4, page: 5 } as const;
/** The seed of the cells' order: every instance (and the App) assembles alike. */
export const ARTIFACT_SPLASH_SEED = 7;

export type ArtifactSplashSize = keyof typeof ARTIFACT_SPLASH_PIXEL_PX;
export type ArtifactSplashIcon = "web" | "doc" | "img";
/**
 * Which part is loading: `getting` the viewer's data, the frame's code, the frame route's ticket, or a
 * file Raft draws itself; `starting` the sandboxed page, from its frame mounting until it loaded.
 */
export type ArtifactSplashStage = "getting" | "starting";

/** `#` a cell of the icon, `.` none (the mockup's). */
export const ARTIFACT_SPLASH_ICONS: Record<ArtifactSplashIcon, readonly string[]> = {
  web: ["########", "#.#.#..#", "########", "#......#", "#.####.#", "#......#", "#.##...#", "########"],
  doc: ["#####...", "#...##..", "#....##.", "#.....#.", "#.###.#.", "#.....#.", "#.###.#.", "#######."],
  img: ["........", "########", "#......#", "#....#.#", "#......#", "#..#...#", "#.###.##", "########"],
};

/** The icon for a kind: html a web page, image (and video) a picture, the rest a document, unknown (no card yet) included. */
export function artifactSplashIcon(kind: ArtifactKind | null | undefined): ArtifactSplashIcon {
  if (kind === "image" || kind === "video") return "img";
  if (kind === "html") return "web";
  return "doc";
}

/** A seeded generator (the mockup's LCG), so the cells' order is the same everywhere. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface SplashCell {
  row: number;
  col: number;
  /** When it lights and goes dim again, as fractions of the cycle. */
  on: number;
  off: number;
  /** On loaded, when an unlit cell fills in (ms). */
  fill: number;
}

const cellsByIcon = new Map<ArtifactSplashIcon, SplashCell[]>();

/** The icon's cells with their timing: by row a little (top first), mostly at random. */
export function artifactSplashCells(icon: ArtifactSplashIcon): SplashCell[] {
  const known = cellsByIcon.get(icon);
  if (known) return known;
  const random = seeded(ARTIFACT_SPLASH_SEED);
  const fillRandom = seeded(ARTIFACT_SPLASH_SEED + 1);
  const cells: SplashCell[] = [];
  ARTIFACT_SPLASH_ICONS[icon].forEach((line, row) => {
    line.split("").forEach((char, col) => {
      if (char !== "#") return;
      const on = (0.45 * (row / ARTIFACT_SPLASH_GRID) + 0.55 * random()) * 0.4;
      const off = 0.6 + random() * 0.25;
      cells.push({ row, col, on, off, fill: Math.round(fillRandom() * ARTIFACT_SPLASH_FILL_MS) });
    });
  });
  cellsByIcon.set(icon, cells);
  return cells;
}

/** Where in its cycle the icon is at `now` (ms into the cycle): the cycle starts as the splash appears. */
export function artifactSplashPhase(startedAt: number, now: number): number {
  const elapsed = now - startedAt - ARTIFACT_SPLASH_APPEAR_AFTER_MS;
  return ((elapsed % ARTIFACT_SPLASH_CYCLE_MS) + ARTIFACT_SPLASH_CYCLE_MS) % ARTIFACT_SPLASH_CYCLE_MS;
}

/**
 * How long until the cycle running at `now` ends (ms; 0 on a boundary, or before the splash appears): where a new
 * icon may take over (Kirby, #proj-workspace:#302). The icon drawn while the kind was unknown (`doc`) is never
 * swapped mid-assembly for the kind's: it finishes its cycle and the next one draws the new icon, so the change
 * reads as the next picture, not a flicker. The native App follows the same rule.
 */
export function artifactSplashUntilNextCycle(startedAt: number, now: number): number {
  if (now - startedAt < ARTIFACT_SPLASH_APPEAR_AFTER_MS) return 0;
  const phase = artifactSplashPhase(startedAt, now);
  return phase === 0 ? 0 : ARTIFACT_SPLASH_CYCLE_MS - phase;
}

/**
 * The icon each opening (by its start) shows now, so the part that takes over from another (the link's
 * screen, then the page's; stage 0, then 1) keeps it until the cycle ends rather than restarting on its own.
 * Only the latest few openings are kept.
 */
const shownIcons = new Map<number, ArtifactSplashIcon>();
const SHOWN_ICONS_KEPT = 8;

function rememberShownIcon(startedAt: number, icon: ArtifactSplashIcon): void {
  shownIcons.delete(startedAt);
  shownIcons.set(startedAt, icon);
  while (shownIcons.size > SHOWN_ICONS_KEPT) shownIcons.delete(shownIcons.keys().next().value as number);
}

/**
 * The icon to draw for `wanted`: while the icon `moving` (looping, on screen), a change waits for the cycle's end
 * (artifactSplashUntilNextCycle); otherwise (still, reduced motion, the ending, not yet appeared) it is at once.
 */
export function useArtifactSplashShownIcon(wanted: ArtifactSplashIcon, startedAt: number, moving: boolean): ArtifactSplashIcon {
  const [shown, setShown] = useState<ArtifactSplashIcon>(() => {
    const held = shownIcons.get(startedAt);
    return moving && held !== undefined && artifactSplashUntilNextCycle(startedAt, currentTimeMs()) > 0 ? held : wanted;
  });
  useEffect(() => {
    // Only a looping icon is handed on; one that stopped (its ending, still) is the opening's last word.
    if (!moving) {
      shownIcons.delete(startedAt);
      return;
    }
    rememberShownIcon(startedAt, shown);
    if (shown === wanted) return;
    const wait = artifactSplashUntilNextCycle(startedAt, currentTimeMs());
    if (wait === 0) {
      setShown(wanted);
      return;
    }
    const timer = window.setTimeout(() => setShown(wanted), wait);
    return () => window.clearTimeout(timer);
  }, [moving, shown, startedAt, wanted]);
  // Not moving: the wanted icon at once, in this very render (an ending never settles the old one first).
  return moving ? shown : wanted;
}

export function artifactSplashLitAt(cell: SplashCell, phaseMs: number): boolean {
  const at = phaseMs / ARTIFACT_SPLASH_CYCLE_MS;
  return at >= cell.on && at < cell.off;
}

export interface SplashScope {
  /** When the opening started: the 1-second wait and the cycle's phase count from here. */
  startedAt: number;
  size: ArtifactSplashSize;
}

export const SplashScopeContext = createContext<SplashScope | null>(null);

/**
 * When the loading of `key` started: for the first key, `initialStart`'s answer (a wait that began
 * before this mounted: the canonical link's loading screen, artifactLinkWait) or else the enclosing
 * scope's start (an opening the shell around already started counting); a new start each time the
 * key changes (a version picked, a retry).
 */
export function useArtifactSplashStart(key: string | number, initialStart?: () => number | null): number {
  const outer = useContext(SplashScopeContext);
  const [state, setState] = useState(() => ({ key, startedAt: initialStart?.() ?? outer?.startedAt ?? currentTimeMs() }));
  if (state.key === key) return state.startedAt;
  const next = { key, startedAt: currentTimeMs() };
  setState(next);
  return next.startedAt;
}

export const ARTIFACT_SPLASH_REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Whether `startedAt` is ARTIFACT_SPLASH_APPEAR_AFTER_MS behind; it stops counting once `stopped`. */
export function useArtifactSplashAppearedAt(startedAt: number, stopped: boolean): boolean {
  const [appearedFor, setAppearedFor] = useState<number | null>(() => (currentTimeMs() - startedAt >= ARTIFACT_SPLASH_APPEAR_AFTER_MS ? startedAt : null));
  const appeared = appearedFor === startedAt;
  useEffect(() => {
    if (appeared || stopped) return;
    const timer = window.setTimeout(() => setAppearedFor(startedAt), Math.max(0, startedAt + ARTIFACT_SPLASH_APPEAR_AFTER_MS - currentTimeMs()));
    return () => window.clearTimeout(timer);
  }, [appeared, stopped, startedAt]);
  return appeared;
}

/**
 * Whether the splash of the opening around has appeared (1 second in): for the header's placeholders
 * (ArtifactSplashTitlePlaceholder), which follow the same wait.
 */
export function useArtifactSplashAppeared(): boolean {
  const scope = useContext(SplashScopeContext);
  const [mountedAt] = useState(currentTimeMs);
  return useArtifactSplashAppearedAt(scope?.startedAt ?? mountedAt, false);
}

