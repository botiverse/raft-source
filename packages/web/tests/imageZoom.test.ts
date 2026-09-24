import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Pin the lightbox zoom contract end-to-end at the source level. Behavior
// (transform math, gesture handler shapes) is exercised in unit tests below
// against the exported pure helpers; layout integration is pinned via source
// regex against ImageLightbox.tsx so a future refactor that drops the wiring
// gets a loud red here.
//
// Origin: @tygg #proj-uiux:32aba11a 2026-06-17 — "lightbox 图片预览不支持 zoom
// in/out, PC + 移动端都该支持. 实现一下, 然后自己拿浏览器测试确认 work".

const repoRoot = resolve(import.meta.dirname, "..");

test("ImageZoom hook exports stable contract surface", async () => {
  const mod = await import("../src/components/ImageZoom");
  assert.equal(typeof mod.useImageZoom, "function");
  assert.equal(typeof mod.imageZoomStateAroundPoint, "function");
  assert.equal(typeof mod.wheelDeltaToZoomFactor, "function");
  assert.equal(typeof mod.wheelDeltaToZoomExponent, "function");
  assert.equal(mod.MIN_SCALE, 1, "MIN_SCALE never zooms below fit-to-viewport");
  assert.ok(mod.MAX_SCALE >= 2 && mod.MAX_SCALE <= 8, "MAX_SCALE in sane range");
  assert.ok(mod.MAX_DYNAMIC_SCALE >= mod.MAX_SCALE, "dynamic max scale preserves the normal-image floor");
});

test("ImageZoom keeps the same media-space point beneath the wheel or pinch anchor", async () => {
  const { imageZoomStateAroundPoint } = await import("../src/components/ImageZoom");
  const current = { scale: 2, translateX: 30, translateY: -10 };
  const anchor = {
    clientX: 500,
    clientY: 200,
    visualCenterX: 400,
    visualCenterY: 300,
  };
  const next = imageZoomStateAroundPoint(current, 3, anchor);

  assert.deepEqual(next, { scale: 3, translateX: -20, translateY: 40 });

  const nextCenterX = anchor.visualCenterX + (next.translateX - current.translateX);
  const nextCenterY = anchor.visualCenterY + (next.translateY - current.translateY);
  assert.equal(
    (anchor.clientX - anchor.visualCenterX) / current.scale,
    (anchor.clientX - nextCenterX) / next.scale,
    "zoom must preserve the horizontal media coordinate under the pointer",
  );
  assert.equal(
    (anchor.clientY - anchor.visualCenterY) / current.scale,
    (anchor.clientY - nextCenterY) / next.scale,
    "zoom must preserve the vertical media coordinate under the pointer",
  );
  assert.deepEqual(
    imageZoomStateAroundPoint(current, current.scale, anchor),
    current,
    "a clamped/no-op scale must not move the media",
  );
});

test("programmatic zoom exposes a bounded ease-out transition contract", async () => {
  const { PROGRAMMATIC_ZOOM_ANIMATION_MS, PROGRAMMATIC_ZOOM_TIMING_FUNCTION } = await import(
    "../src/components/ImageZoom"
  );
  assert.equal(PROGRAMMATIC_ZOOM_ANIMATION_MS, 200);
  assert.equal(PROGRAMMATIC_ZOOM_TIMING_FUNCTION, "cubic-bezier(0.33, 1, 0.68, 1)");
});

test("ImageLightbox wires the zoom hook + applies gesture handlers + transform style", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/ImageLightbox.tsx"),
    "utf8",
  );
  const zoomSource = readFileSync(resolve(repoRoot, "src/components/ImageZoom.ts"), "utf8");

  // Hook is imported + invoked with the resetKey = current image id contract.
  // resetKey is what makes prev/next/close all reset zoom state to fit.
  assert.match(source, /import\s*\{\s*useImageZoom\s*\}\s*from\s*"\.\/ImageZoom"/);
  assert.match(source, /useImageZoom\(\{\s*resetKey:\s*current\?\.id/);

  // Wheel goes through a NATIVE listener (not React's JSX onWheel). React 19
  // forces JSX onWheel to passive:true, so preventDefault() silently no-ops
  // and Mac trackpad pinch never reaches us — the browser does page zoom
  // first. The hook exposes wheelTargetRef which attaches an
  // addEventListener('wheel', …, { passive: false }). MUST NOT regress to
  // onWheel={…} in JSX or trackpad pinch breaks again.
  assert.match(source, /ref=\{zoom\.wheelTargetRef\}/);
  assert.doesNotMatch(source, /onWheel=\{zoom\.onWheel\}/);

  // All other gesture inputs, including double-click, are wired on the stage
  // div. Pointer capture retargets an enlarged image's second double-click to
  // the stage, so putting this only on <img> breaks reset after zooming.
  assert.match(source, /onPointerDown=\{zoom\.onPointerDown\}/);
  assert.match(source, /onPointerMove=\{zoom\.onPointerMove\}/);
  assert.match(source, /onPointerUp=\{zoom\.onPointerUp\}/);
  assert.match(source, /onTouchStart=\{zoom\.onTouchStart\}/);
  assert.match(source, /onTouchMove=\{zoom\.onTouchMove\}/);
  assert.match(source, /onTouchEnd=\{zoom\.onTouchEnd\}/);
  const stageMarkup = source.match(/<div\s+ref=\{zoom\.wheelTargetRef\}[\s\S]*?\n      >/);
  assert.ok(stageMarkup, "image lightbox stage markup not found");
  assert.match(stageMarkup[0], /onDoubleClick=\{zoom\.onDoubleClick\}/);

  // Image element gets the transform/cursor style + ref for active rAF
  // gesture updates, but double-click ownership stays on the stage.
  assert.match(source, /ref=\{zoom\.imageRef\}/);
  assert.match(source, /transform:\s*zoom\.style\.transform/);
  assert.match(source, /cursor:\s*zoom\.style\.cursor/);
  assert.match(source, /transition:\s*"none"/);
  const imageMarkup = source.match(/<img\s+ref=\{zoom\.imageRef\}[\s\S]*?\/>/);
  assert.ok(imageMarkup, "image lightbox image markup not found");
  assert.doesNotMatch(imageMarkup[0], /onDoubleClick=/);

  // Empty mask/stage clicks close even when zoomed; image clicks and pan
  // gestures stay inside. The bounds check covers zoomed visual pixels that
  // can fall outside the image's original layout box.
  assert.match(source, /e\.target === e\.currentTarget && !zoom\.containsImagePoint\(e\.clientX,\s*e\.clientY\)/);
  assert.match(zoomSource, /containsImagePoint:\s*\(clientX:\s*number,\s*clientY:\s*number\)\s*=>\s*boolean/);
  assert.match(zoomSource, /clientX >= rect\.left && clientX <= rect\.right && clientY >= rect\.top && clientY <= rect\.bottom/);
  assert.doesNotMatch(source, /isLiveZoomed/);

  // Arrow keys pan — when zoomed, ArrowLeft/Right do NOT navigate (would
  // feel like image-jump mid-pan).
  assert.match(source, /e\.key === "ArrowLeft"[\s\S]{0,160}zoom\.isZoomed/);
  assert.match(source, /e\.key === "ArrowRight"[\s\S]{0,160}zoom\.isZoomed/);

  // "0" resets zoom from keyboard.
  assert.match(source, /e\.key === "0"[\s\S]{0,80}zoom\.reset\(\)/);
});

test("ImageZoom transform and cursor output cover fit, under-fit, zoomed, and dragging states", async () => {
  // Pure math sanity — invoke the controller via a fake-React render pass.
  // We can't run real hooks here without a renderer; instead, scan the source
  // to verify the fit-vs-zoomed branch chooses the right transform string.
  const source = readFileSync(resolve(repoRoot, "src/components/ImageZoom.ts"), "utf8");

  // The default transform mode still emits "none" at fit so an unzoomed
  // lightbox doesn't create unnecessary GPU layers. Layout mode has its own
  // translation-only centering branch for sandboxed vector surfaces.
  assert.match(source, /isTransformed\s*=\s*isZoomed\s*\|\|\s*scale < 0\.999/);
  assert.match(source, /scaleMode === "layout"[\s\S]{0,260}:\s*isTransformed[\s\S]{0,160}:\s*"none"/);

  // touch-action:none ONLY when zoomed — otherwise iOS Safari intercepts
  // pinch as system page-zoom + drag as page-scroll, but at fit=1 we want
  // backdrop click + lightbox close to still route through normal touch.
  assert.match(source, /touchAction\s*=\s*isZoomed\s*\?\s*"none"\s*:\s*"auto"/);

  // Media advertises the double-click direction, while the stage advertises
  // pan affordance once enlarged. Active drag wins with grabbing on both.
  assert.match(source, /cursor\s*=\s*isDragging\s*\?\s*"grabbing"\s*:\s*isZoomed\s*\?\s*"zoom-out"\s*:\s*"zoom-in"/);
  assert.match(source, /stageCursor\s*=\s*isDragging\s*\?\s*"grabbing"\s*:\s*isZoomed\s*\?\s*"grab"\s*:\s*"default"/);
  assert.match(source, /image\.style\.cursor = "grabbing"/);
});

test("ImageZoom numeric minimum is opt-in and keeps the classic default", () => {
  const source = readFileSync(resolve(repoRoot, "src/components/ImageZoom.ts"), "utf8");
  assert.match(source, /minScale\?: number/);
  assert.match(source, /if \(minScale === undefined \|\| !Number\.isFinite\(minScale\)\) return MIN_SCALE/);
  assert.match(source, /Math\.max\(Number\.EPSILON, Math\.min\(MIN_SCALE, minScale\)\)/);
  assert.doesNotMatch(source, /minScale\?: "fit"/);
  assert.doesNotMatch(source, /initialFitThreshold/);
});

test("ImageZoom binds wheel via native addEventListener with passive:false (Mac trackpad pinch fix)", () => {
  const source = readFileSync(resolve(repoRoot, "src/components/ImageZoom.ts"), "utf8");

  // The whole point of the wheelTargetRef pattern: React 19's JSX onWheel is
  // forced-passive (preventDefault no-op), so we MUST bind natively with
  // { passive: false }. Trackpad pinch on Mac fires wheel + ctrlKey:true; if
  // we don't preventDefault the browser hijacks it for system page zoom.
  assert.match(source, /addEventListener\(\s*"wheel"[\s\S]{0,200}passive:\s*false/);

  // PhotoSwipe/D3-style logarithmic curve, but through an exponent helper so
  // active wheel gestures can mutate transform via refs/rAF instead of
  // doing one React commit per wheel event.
  assert.match(source, /wheelDeltaToZoomExponent\(event\.deltaY,\s*event\.deltaMode,\s*event\.ctrlKey\s*\|\|\s*event\.metaKey\)/);
  assert.match(source, /wheelAnchorRef\.current = \{ clientX: event\.clientX, clientY: event\.clientY \}/);
  assert.match(source, /zoomAroundClientPoint\(current, nextScale, event\.clientX, event\.clientY\)/);
  assert.match(source, /zoomAroundClientPoint\(current, nextScale, anchor\.clientX, anchor\.clientY\)/);
  assert.match(source, /window\.requestAnimationFrame\(tick\)/);
  assert.match(source, /WHEEL_ZOOM_MOMENTUM_FRICTION/);
  assert.match(source, /commitLiveTransform\(\)/);
  assert.doesNotMatch(source, /setScale\(\(prev\)\s*=>\s*setScaleClamped\(prev\s*\*/);

  // The detached-flow contract: no React onWheel handler exposed for the
  // stage div anymore. Only the imperative ref path.
  assert.doesNotMatch(source, /\bonWheel:/);

  // Cleanup on unmount must remove the native listener.
  assert.match(source, /removeEventListener\(\s*"wheel"/);
});

test("ImageZoom wheel curve: faster trackpad zoom, normalized line-mode deltas, capped mouse-wheel ticks", async () => {
  const mod = await import("../src/components/ImageZoom");

  assert.equal(mod.WHEEL_ZOOM_COEFFICIENT, 0.005);
  assert.equal(mod.WHEEL_ZOOM_ACCELERATED_DELTA_MULTIPLIER, 7);
  assert.equal(mod.WHEEL_ZOOM_MAX_EXPONENT_PER_EVENT, 0.45);
  assert.equal(mod.wheelDeltaYToPixels(3, 1), 54, "Firefox line-mode wheel deltas normalize through line-height");

  // Pixel-mode trackpad deltas are usually small and frequent. The old
  // PhotoSwipe coefficient 0.002 made deltaY=-10 only ~1.014x, which felt
  // visibly slow in our direct native listener. New curve is ~1.035x per
  // event while staying continuous.
  const trackpadZoomIn = mod.wheelDeltaToZoomFactor(-10, 0);
  assert.ok(trackpadZoomIn > 1.03 && trackpadZoomIn < 1.04, `trackpad factor ${trackpadZoomIn}`);

  // D3's default wheelDelta applies a 10x multiplier for ctrlKey wheel events.
  // Browser trackpad pinch gestures are reported as wheel + ctrlKey:true. We
  // keep that accelerated-shape best practice, but tune it just below D3's raw
  // value after preview feedback that 10x was slightly too quick.
  const acceleratedPinchZoomIn = mod.wheelDeltaToZoomFactor(-3, 0, true);
  assert.ok(
    acceleratedPinchZoomIn > 1.075 && acceleratedPinchZoomIn < 1.076,
    `accelerated pinch factor ${acceleratedPinchZoomIn}`,
  );

  // A coarse mouse-wheel notch (often |deltaY|≈100) must not jump too far
  // after the coefficient/accelerated-delta increase. Cap keeps a single event
  // at 2^0.45.
  const mouseNotchZoomIn = mod.wheelDeltaToZoomFactor(-100, 0);
  assert.equal(mouseNotchZoomIn, 2 ** 0.45);

  const acceleratedTrackpadZoomIn = mod.wheelDeltaToZoomFactor(-10, 0, true);
  assert.ok(
    acceleratedTrackpadZoomIn > 1.27 && acceleratedTrackpadZoomIn < 1.28,
    `accelerated trackpad factor ${acceleratedTrackpadZoomIn}`,
  );

  const mouseNotchZoomOut = mod.wheelDeltaToZoomFactor(100, 0);
  assert.equal(mouseNotchZoomOut, 2 ** -0.45);
});

test("ImageZoom dynamic max scale: long screenshots can zoom toward natural pixels", async () => {
  const mod = await import("../src/components/ImageZoom");

  assert.equal(
    mod.imageDimensionsToMaxScale({
      naturalWidth: 1600,
      naturalHeight: 1200,
      clientWidth: 800,
      clientHeight: 600,
    }),
    mod.MAX_SCALE,
    "ordinary images keep the existing 4x floor",
  );

  assert.equal(
    mod.imageDimensionsToMaxScale({
      naturalWidth: 1200,
      naturalHeight: 12000,
      clientWidth: 80,
      clientHeight: 800,
    }),
    15,
    "very tall screenshots can reach roughly 1:1 natural-pixel scale",
  );

  assert.equal(
    mod.imageDimensionsToMaxScale({
      naturalWidth: 2000,
      naturalHeight: 30000,
      clientWidth: 50,
      clientHeight: 500,
    }),
    mod.MAX_DYNAMIC_SCALE,
    "pathological dimensions are capped",
  );
});

test("ImageZoom resets state via render-phase comparator (no useEffect chain)", () => {
  // react-doctor: no useEffect for resetKey-driven reset. Render-phase
  // adjustment with prev/next state pattern instead.
  const source = readFileSync(resolve(repoRoot, "src/components/ImageZoom.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /useEffect\([^)]*\[\s*resetKey/,
    "must NOT use useEffect on resetKey — react-doctor no-effect-chain",
  );
  assert.match(
    source,
    /if\s*\(prevResetKey\s*!==\s*resetKey\)/,
    "must use render-phase comparator pattern instead",
  );
});
