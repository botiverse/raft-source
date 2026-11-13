import assert from "node:assert/strict";

// The lightbox zoom contract, exercised against the exported pure helpers
// (transform math, wheel curve, dynamic max scale).
//
// Origin: @tygg #proj-uiux:32aba11a 2026-06-17 — "lightbox 图片预览不支持 zoom
// in/out, PC + 移动端都该支持. 实现一下, 然后自己拿浏览器测试确认 work".

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
