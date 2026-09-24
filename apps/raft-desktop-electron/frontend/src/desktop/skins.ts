// Desktop skin system.
//
// First-principles model (see notes/skin-system-design.md). The neo-brutalist
// STRUCTURE (ink/black, hard shadow, borders) is invariant — the brand skeleton.
// The color personality is TWO roles, both real design tokens:
//   - CHROME  = `--color-soft-signal`   → surfaces (top bar, rail, headers).
//   - SIGNAL  = `--color-brutal-yellow`  → the accent for selected states
//                (raft-ui's active tab / segmented toggle) and busy status.
// They are genuinely two colors, but they should stay in the SAME family: a skin
// is defined by ONE chrome color, and the signal is DERIVED as a deeper, richer
// shade of that chrome. So "selected" always reads as an intensified version of
// the current skin (green skin → deeper green selected), never a foreign hue —
// one rule, every skin harmonizes automatically.
//
// A skin is applied by overriding just the two root tokens (+ their RGB
// channels). Every derived usage — all surfaces AND every selected/busy accent —
// re-skins from that single change. No per-class overrides, no !important.
// Desktop only, persisted; architected to graduate to raft-ui.

export interface Skin {
  id: string;
  name: string;
  /** Surface color (hex). The signal accent is derived from it. */
  chrome: string;
}

// One chrome per skin — confident, black-legible, mutually harmonious. The
// signal (selected/busy accent) is computed from chrome, so it always matches.
// Ordered around the hue wheel (warm → cool) then neutrals, so the swatch row
// reads as a coherent palette rather than a random pile. Every chrome is light
// enough that black text + 2px black borders stay legible, and each sits in the
// same soft-but-confident register as the original Signal yellow.
// A designed palette, not experimental picks: one bold signature (Signal, the
// brand yellow) plus a coherent ring of confident pastels held at a consistent
// light register (so black text + 2px black borders always read) and walked
// around the hue wheel, closing with two neutrals. No muddy/dark tones — each is
// a clean, saturated-but-soft hue. The selected/busy accent is derived per skin
// (deeper same-family), so the whole set stays harmonious automatically.
export const SKINS: readonly Skin[] = [
  { id: "signal", name: "Signal", chrome: "#FFD440" }, // bold brand yellow (signature)
  { id: "amber", name: "Amber", chrome: "#FBE08C" }, // soft warm yellow
  { id: "peach", name: "Peach", chrome: "#FBCB9C" }, // warm peach
  { id: "coral", name: "Coral", chrome: "#F9B4A0" }, // coral
  { id: "blush", name: "Blush", chrome: "#F7BBCB" }, // blush pink
  { id: "rose", name: "Rose", chrome: "#EFA9C6" }, // rose
  { id: "lilac", name: "Lilac", chrome: "#D6C4F0" }, // lilac
  { id: "iris", name: "Iris", chrome: "#BFC4F0" }, // periwinkle
  { id: "sky", name: "Sky", chrome: "#A9D6F2" }, // sky blue
  { id: "aqua", name: "Aqua", chrome: "#A6E0DA" }, // aqua
  { id: "sage", name: "Sage", chrome: "#C2E0AC" }, // sage green
  { id: "sand", name: "Sand", chrome: "#E9DDC4" }, // warm neutral
  { id: "cloud", name: "Cloud", chrome: "#D9E0E8" }, // cool neutral
];

export const DEFAULT_SKIN_ID = "amber";
const STORAGE_KEY = "raft-desktop-skin";

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function skinById(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS.find((s) => s.id === DEFAULT_SKIN_ID) ?? SKINS[0];
}

export function currentSkinId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SKIN_ID;
  } catch {
    return DEFAULT_SKIN_ID;
  }
}

// raft-ui's `--color-brutal-yellow-*` scale (OKLCH lightness% + chroma per step,
// read from its compiled tokens). raft-ui's OWN selected states — tabs, segmented
// toggles — resolve to THIS scale (not the `--color-brutal-yellow` alias the top
// bar chrome uses), which is why skinning only the alias left them yellow. We
// re-hue the whole scale to the current skin, keeping each step's lightness AND
// chroma so the fills stay light enough for black text and the contrast ramp is
// preserved — only the hue moves to the skin's family. One rule, every raft-ui
// accent follows the skin.
const YELLOW_SCALE: ReadonlyArray<readonly [step: number, l: string, c: string]> = [
  [50, "98.4%", "0.017"],
  [100, "97.5%", "0.027"],
  [200, "94%", "0.066"],
  [300, "91.3%", "0.103"],
  [400, "88.3%", "0.162"],
  [500, "75.9%", "0.155"],
  [600, "63.7%", "0.13"],
  [700, "50.8%", "0.104"],
  [800, "38.8%", "0.08"],
  [900, "26%", "0.053"],
  [950, "19.9%", "0.041"],
];

export function applySkin(id: string): void {
  const skin = skinById(id);
  const [cr, cg, cb] = hexToRgb(skin.chrome);
  const root = document.documentElement;
  root.dataset.raftSkin = skin.id;
  // Inline styles on <html> outrank the @theme :root / :where(:root) defaults.
  // Chrome (surfaces):
  root.style.setProperty("--color-soft-signal", skin.chrome);
  root.style.setProperty("--soft-signal-rgb", `${cr} ${cg} ${cb}`);
  // Signal (selected/busy): re-hue raft-ui's scale, keeping OKLCH lightness +
  // chroma per step, swapping only the hue to this chrome. `oklch(from …)`
  // relative color does the hue swap with no JS colour maths.
  for (const [step, l, c] of YELLOW_SCALE) {
    root.style.setProperty(`--color-brutal-yellow-${step}`, `oklch(from ${skin.chrome} ${l} ${c} h)`);
  }
  // The alias + its RGB channels follow the re-hued 400 (raft-ui's canonical
  // fill), so both scale-based (raft-ui) and alias-based (web `bg-brutal-yellow`,
  // plus the baked alpha variants rebound in index.css) usages re-skin together.
  root.style.setProperty("--color-brutal-yellow", "var(--color-brutal-yellow-400)");
  root.style.setProperty("--brutal-yellow-rgb", `${cr} ${cg} ${cb}`);
}

// One shared "current skin" so every surface (top-bar switcher, Settings →
// Appearance) stays in sync from a single source.
const listeners = new Set<(id: string) => void>();
export function subscribeSkin(listener: (id: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSkin(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal: the skin still applies for this session.
  }
  applySkin(id);
  for (const l of listeners) l(id);
}

export function initSkin(): void {
  applySkin(currentSkinId());
}

// Skin lives only in the desktop top bar (DesktopTopBar's SkinSwitcher), by
// @WAWQAQ's call (2026-09-09): Settings does not need a skin control. An earlier
// installSkinBridge published a global for a reused-web Settings panel that never
// consumed it — removed so no dead seam remains.
