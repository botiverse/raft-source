import { useLayoutEffect, useRef } from "react";
import type { ResolvedThemeMode } from "@botiverse/raft-ui";
import {
  RAFT_DARK_PAPER_CHROME_COLOR,
  RAFT_DARK_THEME_CHROME_COLOR,
  RAFT_LIGHT_PAPER_CHROME_COLOR,
  RAFT_LIGHT_THEME_CHROME_COLOR,
} from "./appThemeChrome";

/**
 * The top system bar (status bar, title bar, Android task bar tint) continues
 * whatever surface meets the top edge of the screen: the frame under a tab
 * root's or the desktop's top bar and on the auth pages, paper under a phone's
 * pushed-page header.
 *
 * This module is the only runtime writer of `meta[name="theme-color"]` (the
 * pre-paint bootstrap in public/app-theme-bootstrap.js sets the initial
 * value). Surfaces declare what meets the top edge; AppThemeProvider supplies
 * the mode; the colour is resolved from both, so a mode switch re-resolves the
 * declared surface instead of resetting it to the frame. A server theme
 * re-resolves it too (serverTheme.ts calls refreshSystemBarColor), so an
 * installed app's title bar wears the theme's frame, not Raft Yellow.
 */
export type SystemBarSurface = "frame" | "paper";

const SYSTEM_BAR_COLORS: Record<SystemBarSurface, Record<ResolvedThemeMode, string>> = {
  frame: { light: RAFT_LIGHT_THEME_CHROME_COLOR, dark: RAFT_DARK_THEME_CHROME_COLOR },
  paper: { light: RAFT_LIGHT_PAPER_CHROME_COLOR, dark: RAFT_DARK_PAPER_CHROME_COLOR },
};

/** The layer token that paints the surface (for the safe-area strip itself). */
const SYSTEM_BAR_FILLS: Record<SystemBarSurface, string> = {
  frame: "var(--layer-frame)",
  paper: "var(--layer-canvas)",
};

/**
 * With no surface declared the system bar falls back to the frame. Screens that
 * don't declare yet (the cream loading screens, the error fallback) keep this
 * fallback; they can declare a surface when they need their own.
 */
const DEFAULT_SURFACE: SystemBarSurface = "frame";

export function systemBarColor(surface: SystemBarSurface, mode: ResolvedThemeMode): string {
  return SYSTEM_BAR_COLORS[surface][mode];
}

type SurfaceColorResolver = (fill: string) => string | null;

/** `#rrggbb` from the red, green and blue bytes of a canvas pixel. */
export function hexFromRgb(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

let canvasContext: CanvasRenderingContext2D | null | undefined;

function pixelContext(): CanvasRenderingContext2D | null {
  if (canvasContext !== undefined) return canvasContext;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    canvasContext = canvas.getContext("2d", { willReadFrequently: true });
  } catch {
    canvasContext = null;
  }
  return canvasContext;
}

/**
 * A server theme (`data-theme` on <html>) repaints the frame and paper, so the
 * system bar takes the colour the surface's token resolves to there. The
 * browser resolves it: a 1px canvas fill turns any CSS colour (the tokens are
 * oklch) into sRGB, which every `theme-color` reader understands. Null when
 * the token is missing, the canvas can't take the colour, or there is no
 * canvas; the Raft Yellow constants stand in.
 */
function resolveWithCanvas(fill: string): string | null {
  const token = /^var\((--[\w-]+)\)$/.exec(fill)?.[1];
  if (!token || !getComputedStyle(document.documentElement).getPropertyValue(token).trim()) return null;
  const context = pixelContext();
  if (!context) return null;
  const probe = document.createElement("span");
  probe.style.color = fill;
  probe.style.display = "none";
  document.documentElement.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  // A colour the canvas can't parse leaves fillStyle as it was.
  context.fillStyle = "#010203";
  context.fillStyle = resolved;
  if (context.fillStyle === "#010203") return null;
  context.clearRect(0, 0, 1, 1);
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return hexFromRgb(red, green, blue);
}

let resolveSurfaceColor: SurfaceColorResolver = resolveWithCanvas;
// Theme, mode and surface decide the colour, so each is resolved once.
const resolvedColors = new Map<string, string>();

/** Test seam: replace how a themed surface's fill becomes a colour. */
export function __setSurfaceColorResolverForTests(resolver: SurfaceColorResolver | null): void {
  resolveSurfaceColor = resolver ?? resolveWithCanvas;
  resolvedColors.clear();
}

function surfaceColor(surface: SystemBarSurface, mode: ResolvedThemeMode): string {
  const theme = document.documentElement.dataset.theme;
  if (theme) {
    const key = `${theme}|${mode}|${surface}`;
    let themed = resolvedColors.get(key) ?? null;
    if (!themed) {
      themed = resolveSurfaceColor(SYSTEM_BAR_FILLS[surface]);
      // Only a colour is kept: a miss (no stylesheet yet) is tried again next time.
      if (themed) resolvedColors.set(key, themed);
    }
    if (themed) return themed;
  }
  return systemBarColor(surface, mode);
}

export function systemBarFill(surface: SystemBarSurface): string {
  return SYSTEM_BAR_FILLS[surface];
}

interface SystemBarDeclaration {
  surface: SystemBarSurface;
}

// Mounted declarations in mount order; the latest one meets the top edge.
const declarations: SystemBarDeclaration[] = [];
// A shell whose own strip always meets the top edge, whatever the route
// declares (pinSystemBarSurface).
let pinnedSurface: SystemBarSurface | null = null;
let declaredMode: ResolvedThemeMode | null = null;

function currentMode(): ResolvedThemeMode {
  if (declaredMode) return declaredMode;
  // Before AppThemeProvider reports a mode, follow what the bootstrap applied.
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function writeSystemBarColor(): void {
  if (typeof document === "undefined") return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const surface = pinnedSurface ?? declarations.at(-1)?.surface ?? DEFAULT_SURFACE;
  const color = surfaceColor(surface, currentMode());
  if (meta.content !== color) meta.content = color;
}

/**
 * Pins the surface at the top edge while a shell's own strip is always there,
 * over every route's declaration: under the Window Controls Overlay the row
 * behind the browser's controls is always the app's title bar or its stand-in
 * strip, both the frame, so a phone route's paper header must not paint the
 * controls' backdrop white. Returns the unpin.
 */
export function pinSystemBarSurface(surface: SystemBarSurface): () => void {
  pinnedSurface = surface;
  writeSystemBarColor();
  return () => {
    if (pinnedSurface === surface) pinnedSurface = null;
    writeSystemBarColor();
  };
}

const rootThemeListeners = new Set<() => void>();

function notifyRootTheme(): void {
  for (const listener of [...rootThemeListeners]) listener();
}

/**
 * Called after <html> takes a new mode or server theme (both arrive here), so
 * other colours painted outside the page follow too: the desktop app's
 * caption-button overlay (desktopTitleBar.ts). Returns the unsubscribe.
 */
export function onRootThemeChange(listener: () => void): () => void {
  rootThemeListeners.add(listener);
  return () => {
    rootThemeListeners.delete(listener);
  };
}

/** A server theme went on or off <html>: the declared surface is re-resolved in it. */
export function refreshSystemBarColor(): void {
  writeSystemBarColor();
  notifyRootTheme();
}

/** AppThemeProvider reports the resolved mode; the declared surface is re-resolved in it. */
export function setSystemBarMode(mode: ResolvedThemeMode): void {
  declaredMode = mode;
  writeSystemBarColor();
  notifyRootTheme();
}

/**
 * Declares the surface that meets the top edge while the caller is mounted.
 * The most recently mounted declaration wins; a changed surface keeps its
 * place, and unmounting hands the edge back to the one below. Declarers must
 * not nest: in one commit a child mounts before its parent, so a parent's
 * declaration would win over the child's.
 */
export function useSystemBarSurface(surface: SystemBarSurface): void {
  const declarationRef = useRef<SystemBarDeclaration | null>(null);
  declarationRef.current ??= { surface };
  const declaration = declarationRef.current;

  useLayoutEffect(() => {
    declarations.push(declaration);
    writeSystemBarColor();
    return () => {
      const index = declarations.indexOf(declaration);
      if (index !== -1) declarations.splice(index, 1);
      writeSystemBarColor();
    };
  }, [declaration]);

  useLayoutEffect(() => {
    if (declaration.surface === surface) return;
    declaration.surface = surface;
    if (declarations.includes(declaration)) writeSystemBarColor();
  }, [declaration, surface]);
}
