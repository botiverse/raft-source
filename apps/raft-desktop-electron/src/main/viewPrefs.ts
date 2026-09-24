// Persist the user's chosen zoom level so it survives restarts, like every
// browser-based desktop app.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

const STORE_FILE = "view-prefs.json";
const ZOOM_MIN = -3;
const ZOOM_MAX = 4;

function storePath(): string {
  return path.join(app.getPath("userData"), STORE_FILE);
}

// Cached in memory so the frequent read path (every page load) never touches
// disk; disk is read once on first access and written only on change.
let cachedZoom: number | null = null;

export function loadZoomLevel(): number {
  if (cachedZoom !== null) return cachedZoom;
  let zoom = 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(), "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const value = (parsed as Record<string, unknown>).zoom;
      if (typeof value === "number" && value >= ZOOM_MIN && value <= ZOOM_MAX) {
        zoom = value;
      }
    }
  } catch {
    // no stored preference
  }
  cachedZoom = zoom;
  return zoom;
}

export function saveZoomLevel(zoom: number): void {
  cachedZoom = zoom;
  try {
    writeFileSync(storePath(), JSON.stringify({ zoom }));
  } catch {
    // best effort
  }
}
