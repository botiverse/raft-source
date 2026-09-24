// Persist and restore the server window's geometry, so the app reopens where
// the user left it. Lessons applied from cumora:
// - persist getNormalBounds() (the pre-maximize rect), not getBounds(), so a
//   maximized window doesn't overwrite the user's chosen size;
// - persist and restore maximized/fullscreen separately, applied after
//   ready-to-show (constructor restoration is unreliable on macOS);
// - debounce writes so a drag doesn't write on every pixel;
// - reject bounds that no longer land on a connected display.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, screen } from "electron";
import type { BrowserWindow } from "electron";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: WindowBounds | null;
  maximized: boolean;
  fullscreen: boolean;
}

const STORE_FILE = "window-state.json";
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;
const SAVE_DEBOUNCE_MS = 300;
const MIN_ON_SCREEN = 80; // px of the window that must remain on some display

function storePath(): string {
  return path.join(app.getPath("userData"), STORE_FILE);
}

function boundsOnScreen(bounds: WindowBounds): boolean {
  // Require at least MIN_ON_SCREEN px visible on each axis on some display so
  // the window can't open effectively off-screen after a monitor is unplugged.
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= MIN_ON_SCREEN && overlapY >= MIN_ON_SCREEN;
  });
}

export function loadWindowState(): WindowState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(storePath(), "utf8"));
  } catch {
    return { bounds: null, maximized: false, fullscreen: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { bounds: null, maximized: false, fullscreen: false };
  }
  const record = parsed as Record<string, unknown>;
  const b = record.bounds as Record<string, unknown> | undefined;
  let bounds: WindowBounds | null = null;
  if (
    b &&
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height) &&
    (b.width as number) >= MIN_WIDTH &&
    (b.height as number) >= MIN_HEIGHT
  ) {
    const candidate = { x: b.x, y: b.y, width: b.width, height: b.height } as WindowBounds;
    if (boundsOnScreen(candidate)) bounds = candidate;
  }
  return {
    bounds,
    maximized: record.maximized === true,
    fullscreen: record.fullscreen === true,
  };
}

export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;

  const write = () => {
    if (window.isDestroyed()) return;
    const state: WindowState = {
      // getNormalBounds() is the pre-maximize/fullscreen rect.
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
    };
    try {
      writeFileSync(storePath(), JSON.stringify(state));
    } catch {
      // Best-effort: losing window state is not worth surfacing an error.
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(write, SAVE_DEBOUNCE_MS);
    timer.unref();
  };

  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("enter-full-screen", schedule);
  window.on("leave-full-screen", schedule);
  window.on("close", () => {
    if (timer) clearTimeout(timer);
    write(); // flush synchronously before the window goes away
  });
}
