import assert from "node:assert/strict";
import { STEADY_TITLE_BAR_START_VAR, installSteadyMacTitleBarArea } from "../src/components/topbar/windowControlsOverlayGeometry";

// Raft Desktop on macOS (#proj-deskop:#12): while the window is resized,
// Electron sometimes reads the overlay's geometry with the traffic lights at
// AppKit's default spot, 9px left of where the app puts them, and the top bar
// jumped 9px left and back on those frames. The bar must keep the corner of a
// reading that spans the window (lights where the app put them) and ignore the
// others.
function fakeRoot() {
  const props = new Map<string, string>();
  return {
    dataset: {} as Record<string, string>,
    style: {
      getPropertyValue: (name: string) => props.get(name) ?? "",
      setProperty: (name: string, value: string) => { props.set(name, value); },
      removeProperty: (name: string) => { props.delete(name); },
    },
    props,
  };
}

function fakeWindow(innerWidth: number, rect: { x: number; width: number }) {
  const listeners = new Set<() => void>();
  const ratioListeners = new Set<() => void>();
  const overlay = {
    getTitlebarAreaRect: () => ({ ...rect, y: 0, height: 44 }),
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  };
  return {
    win: {
      innerWidth,
      devicePixelRatio: 2,
      navigator: { windowControlsOverlay: overlay },
      matchMedia: () => ({
        addEventListener: (_type: string, listener: () => void) => { ratioListeners.add(listener); },
        removeEventListener: (_type: string, listener: () => void) => { ratioListeners.delete(listener); },
      }),
    } as unknown as Window,
    /** The ratio changed with no geometry update (zoom while in full screen). */
    changeRatio(ratio: number) {
      (this.win as { devicePixelRatio: number }).devicePixelRatio = ratio;
      for (const listener of [...ratioListeners]) listener();
    },
    ratioListeners,
    move(next: { x: number; width: number }, width = innerWidth, ratio?: number) {
      rect.x = next.x;
      rect.width = next.width;
      (this.win as { innerWidth: number }).innerWidth = width;
      if (ratio !== undefined) (this.win as { devicePixelRatio: number }).devicePixelRatio = ratio;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

// Lights at the app's x=16 (14px buttons, 6px apart): the area starts at 16 + 54 + 16 = 86.
const GOOD = 86;
// Lights at AppKit's x≈7: the box is the same width, so the area starts 9px early and ends 9px short.
const MID_MOVE = 77;

test("a mid-move reading (area 9px short of the right edge) leaves the traffic lights' corner where it was", () => {
  const root = fakeRoot();
  const w = fakeWindow(1200, { x: GOOD, width: 1200 - GOOD });
  installSteadyMacTitleBarArea(root as unknown as HTMLElement, w.win);
  assert.equal(root.props.get(STEADY_TITLE_BAR_START_VAR), `${GOOD}px`);
  assert.equal(root.dataset.titleBarSteady, "");

  w.move({ x: MID_MOVE, width: 1180 - GOOD }, 1180);
  assert.equal(root.props.get(STEADY_TITLE_BAR_START_VAR), `${GOOD}px`);

  w.move({ x: GOOD, width: 1160 - GOOD }, 1160);
  assert.equal(root.props.get(STEADY_TITLE_BAR_START_VAR), `${GOOD}px`);
});

test("until a consistent reading arrives the live overlay geometry is used, and the corner follows a real change (zoom)", () => {
  const root = fakeRoot();
  const w = fakeWindow(1200, { x: MID_MOVE, width: 1200 - GOOD });
  installSteadyMacTitleBarArea(root as unknown as HTMLElement, w.win);
  assert.equal(root.dataset.titleBarSteady, undefined);
  assert.equal(root.props.has(STEADY_TITLE_BAR_START_VAR), false);

  // Zoomed in to 125%: the same corner is fewer CSS px in a narrower page
  // (Blink hands over whole CSS px: 86 / 1.25 floors to 68).
  w.move({ x: 68, width: 960 - 68 }, 960, 2.5);
  assert.equal(root.props.get(STEADY_TITLE_BAR_START_VAR), "68px");
});

test("disposing removes the listener and the published corner", () => {
  const root = fakeRoot();
  const w = fakeWindow(1200, { x: GOOD, width: 1200 - GOOD });
  const dispose = installSteadyMacTitleBarArea(root as unknown as HTMLElement, w.win);
  dispose();
  assert.equal(w.listeners.size, 0);
  assert.equal(w.ratioListeners.size, 0);
  assert.equal(root.dataset.titleBarSteady, undefined);
  assert.equal(root.props.has(STEADY_TITLE_BAR_START_VAR), false);
});

test("a stale mid-move reading that happens to span the page (window shrank by ~9px) is still ignored", () => {
  const root = fakeRoot();
  const w = fakeWindow(1200, { x: GOOD, width: 1200 - GOOD });
  installSteadyMacTitleBarArea(root as unknown as HTMLElement, w.win);
  // Read for the 1209px window (9px short of it), delivered once the page is 1200px.
  w.move({ x: MID_MOVE, width: 1209 - 9 - MID_MOVE }, 1200);
  assert.equal(root.props.get(STEADY_TITLE_BAR_START_VAR), `${GOOD}px`);
});

test("a ratio change no reading saw (zoom in full screen) still lets a smaller corner through afterwards", () => {
  const root = fakeRoot();
  const w = fakeWindow(1200, { x: GOOD, width: 1200 - GOOD });
  installSteadyMacTitleBarArea(root as unknown as HTMLElement, w.win);
  // Full screen: Electron reports an empty area, so no reading is held meanwhile.
  w.move({ x: 0, width: 0 }, 1200);
  w.changeRatio(4);
  w.changeRatio(2);
  // Same ratio as before, but a real, smaller corner (e.g. 200% zoom on a 1x display).
  w.move({ x: 43, width: 600 - 43 }, 600);
  assert.equal(root.props.get(STEADY_TITLE_BAR_START_VAR), "43px");
});
