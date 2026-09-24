import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// ImageLightbox zoom + pan controller (task surfaced 2026-06-17 by @tygg in
// #proj-uiux:32aba11a — "lightbox 图片预览不支持 zoom in/out，PC + 移动都该支持").
//
// React 19 hard-codes `wheel`, `touchstart`, `touchmove` as passive listeners
// (react-dom-bindings/src/events/DOMPluginEventSystem.js ~L846), which silently
// makes `event.preventDefault()` a no-op when set via JSX `onWheel={…}`. That
// breaks Mac trackpad pinch zoom: the browser does its native page-zoom
// before our handler can suppress it, and the lightbox never sees the gesture.
//
// Fix (per @tygg #proj-uiux:32aba11a msg=7dca2fef + research over PhotoSwipe v5
// + OpenSeadragon + anvaka/panzoom): bind `wheel` natively via
// `addEventListener(..., { passive: false })`. Hook exposes `wheelTargetRef` —
// the consumer attaches it to the gesture surface as a ref, the hook owns
// the imperative listener attach/cleanup.
//
// Encapsulated as a hook so ImageLightbox stays declarative and the feature has
// one clean test surface. State lives entirely inside the hook (per-mount React
// state), NOT in `imageLightboxStore` — zoom is a transient interaction, not
// part of the persistent gallery model. Per the render-cost contract this is
// gated + low-freq + short-lived; no hot-path coupling.
//
// Gesture inputs:
//   PC desktop: Ctrl/Cmd + scroll wheel = continuous zoom; double-click =
//               toggle fit ↔ 2x; drag = pan when scale > 1; "0" key = reset.
//   Mac/PC trackpad: pinch-spread (browsers synthesize as wheel + ctrlKey:true)
//                    flows through the same continuous-zoom path.
//   Mobile: pinch (two-finger) = continuous zoom; double-tap = toggle;
//           single-finger drag when zoomed = pan.

export const MIN_SCALE = 1; // never zoom out below fit-to-viewport
export const MAX_SCALE = 4;
export const MAX_DYNAMIC_SCALE = 16;
const ZOOMED_SCALE_TARGET = 2; // double-click target
const DOUBLE_TAP_WINDOW_MS = 350;
const DOUBLE_TAP_RADIUS_PX = 24;
const TAP_MOVEMENT_TOLERANCE_PX = 10;
// OSS reference points:
// - PhotoSwipe v5 maps pixel-mode wheel zoom as `2 ** (-deltaY * 0.002)`,
//   and its documented default zoom path is ctrl-wheel.
// - D3 zoom uses the same `2 ** delta` scale family, normalizes deltaMode,
//   and multiplies ctrl-wheel deltas by 10; browser trackpad pinch gestures
//   also arrive as wheel events with ctrlKey=true.
// - anvaka/panzoom defaults to `zoomSpeed: 0.065` per wheel event and exposes
//   speed as an explicit tuning surface.
// - OpenSeadragon defaults to discrete `zoomPerScroll=1.2`.
//
// We keep the logarithmic curve, tune the coefficient upward from PhotoSwipe
// so small direct trackpad deltas accumulate fast enough, apply D3's ctrl/pinch
// acceleration slightly below D3's raw 10x after preview feedback that 10x was
// a bit too quick, then cap the per-event exponent so a coarse mouse-wheel
// notch still lands below OpenSeadragon's "large step" feel instead of jumping wildly.
export const WHEEL_ZOOM_COEFFICIENT = 0.005;
export const WHEEL_ZOOM_ACCELERATED_DELTA_MULTIPLIER = 7;
export const WHEEL_ZOOM_MAX_EXPONENT_PER_EVENT = 0.45; // 2^0.45 = 1.37x max per event
export const WHEEL_DELTA_LINE_HEIGHT_PX = 18;
export const WHEEL_DELTA_PAGE_HEIGHT_PX = 800;
export const WHEEL_ZOOM_MOMENTUM_INPUT = 0.04;
export const WHEEL_ZOOM_MOMENTUM_FRICTION = 0.82;
export const WHEEL_ZOOM_MOMENTUM_STOP_EXPONENT = 0.001;
export const PROGRAMMATIC_ZOOM_ANIMATION_MS = 200;
export const PROGRAMMATIC_ZOOM_TIMING_FUNCTION = "cubic-bezier(0.33, 1, 0.68, 1)";

export function wheelDeltaYToPixels(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * WHEEL_DELTA_LINE_HEIGHT_PX;
  if (deltaMode === 2) return deltaY * WHEEL_DELTA_PAGE_HEIGHT_PX;
  return deltaY;
}

export function wheelDeltaToZoomExponent(deltaY: number, deltaMode: number, accelerated = false): number {
  const pixelDeltaY = wheelDeltaYToPixels(deltaY, deltaMode);
  const deltaMultiplier = accelerated ? WHEEL_ZOOM_ACCELERATED_DELTA_MULTIPLIER : 1;
  const rawExponent = -pixelDeltaY * WHEEL_ZOOM_COEFFICIENT * deltaMultiplier;
  return Math.max(
    -WHEEL_ZOOM_MAX_EXPONENT_PER_EVENT,
    Math.min(WHEEL_ZOOM_MAX_EXPONENT_PER_EVENT, rawExponent),
  );
}

export function wheelDeltaToZoomFactor(deltaY: number, deltaMode: number, accelerated = false): number {
  const exponent = wheelDeltaToZoomExponent(deltaY, deltaMode, accelerated);
  return 2 ** exponent;
}

export function imageDimensionsToMaxScale(dimensions: {
  naturalWidth: number;
  naturalHeight: number;
  clientWidth: number;
  clientHeight: number;
}): number {
  const { naturalWidth, naturalHeight, clientWidth, clientHeight } = dimensions;
  if (naturalWidth <= 0 || naturalHeight <= 0 || clientWidth <= 0 || clientHeight <= 0) return MAX_SCALE;
  const naturalRatio = Math.max(naturalWidth / clientWidth, naturalHeight / clientHeight);
  return Math.max(MAX_SCALE, Math.min(MAX_DYNAMIC_SCALE, naturalRatio));
}

export interface ImageZoomState {
  scale: number;
  translateX: number;
  translateY: number;
}

export interface ImageZoomAnchor {
  clientX: number;
  clientY: number;
  visualCenterX: number;
  visualCenterY: number;
}

export interface ImageZoomLayoutSettleRequest {
  /** Last iframe geometry that is already sharp. */
  fromScale: number;
  /** New sharp iframe geometry to prepare behind the live compositor frame. */
  toScale: number;
  /** Atomically normalize after the prepared frame is ready; false means stale. */
  complete: () => boolean;
}

export type ImageZoomLayoutSettler = (
  request: ImageZoomLayoutSettleRequest,
) => (() => void) | void;

/**
 * Scale around a viewport point while keeping the same media-space point
 * beneath it. Translation is expressed in post-scale CSS pixels, matching
 * both `translate(...) scale(...)` and Mermaid's layout-settle transform.
 */
export function imageZoomStateAroundPoint(
  current: ImageZoomState,
  nextScale: number,
  anchor: ImageZoomAnchor,
): ImageZoomState {
  if (
    !Number.isFinite(current.scale) ||
    current.scale <= 0 ||
    !Number.isFinite(nextScale) ||
    nextScale <= 0 ||
    !Number.isFinite(anchor.clientX) ||
    !Number.isFinite(anchor.clientY) ||
    !Number.isFinite(anchor.visualCenterX) ||
    !Number.isFinite(anchor.visualCenterY)
  ) {
    return { ...current, scale: nextScale };
  }

  const ratio = nextScale / current.scale;
  return {
    scale: nextScale,
    translateX: current.translateX + (anchor.clientX - anchor.visualCenterX) * (1 - ratio),
    translateY: current.translateY + (anchor.clientY - anchor.visualCenterY) * (1 - ratio),
  };
}

export interface ImageZoomController extends ImageZoomState {
  /** Apply via `style={controller.style}` on the transformed media element. */
  style: {
    transform: string;
    width?: string;
    height?: string;
    touchAction: "none" | "auto";
    cursor: "zoom-in" | "zoom-out" | "grabbing";
    stageCursor: "default" | "grab" | "grabbing";
  };
  /** Attach to the media element so active gestures can mutate transform in rAF. */
  imageRef: (el: HTMLElement | null) => void;
  /**
   * Attach to the gesture surface (the stage div) via `ref={controller.wheelTargetRef}`.
   * The hook installs a NATIVE `wheel` listener with `{ passive: false }` —
   * mandatory because React 19's onWheel is forced-passive and `preventDefault`
   * silently no-ops, which breaks Mac trackpad pinch zoom (Chromium + Safari
   * synthesize trackpad pinch as wheel + ctrlKey:true; without preventDefault
   * the browser does page zoom first and the gesture never reaches us).
   */
  wheelTargetRef: (el: HTMLElement | null) => void;
  /**
   * Optional double-buffer bridge for `layout` mode. A sandboxed iframe paints
   * its resized document asynchronously after its element geometry changes;
   * hosts can prepare a second frame at the target layout size and call
   * `complete` only after that frame is painted.
   */
  layoutSettleRef: (settler: ImageZoomLayoutSettler | null) => void;
  /** Double-click handler — toggles fit ↔ 2x. */
  onDoubleClick: (event: React.MouseEvent<HTMLElement>) => void;
  /** Mouse-drag pan when zoomed. */
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  /** Touch handlers for pinch + pan (two-finger / one-finger). */
  onTouchStart: (event: React.TouchEvent<HTMLElement>) => void;
  onTouchMove: (event: React.TouchEvent<HTMLElement>) => void;
  onTouchEnd: (event: React.TouchEvent<HTMLElement>) => void;
  /** Programmatic reset (called when image changes or close). */
  reset: () => void;
  /** Programmatic relative zoom for toolbar controls. */
  zoomBy: (factor: number) => void;
  /** Commits a toolbar zoom when its CSS transform transition finishes. */
  onTransitionEnd: (event: React.TransitionEvent<HTMLElement>) => void;
  /** True when the viewport point falls inside the current transformed image box. */
  containsImagePoint: (clientX: number, clientY: number) => boolean;
  /** True when the user is actively zoomed past the fit baseline. */
  isZoomed: boolean;
}

export interface UseImageZoomOptions {
  /** When this value changes the controller resets to scale=1, translate=0. */
  resetKey: string | number | null | undefined;
  /** Default true: only Ctrl/Cmd + wheel zooms, leaving page scroll alone. */
  wheelRequiresModifier?: boolean;
  /** Optional lower zoom bound. Default 1 preserves the classic image-lightbox
   *  fit baseline; hosts whose scale=1 layout is already contain-fitted may
   *  opt into smaller values (for example Mermaid fullscreen at 0.05). */
  minScale?: number;
  /** Default `transform` keeps the classic image-lightbox path. Sandboxed
   *  vector surfaces can use `layout`: live gestures temporarily composite,
   *  then commit changes the media element's percentage width/height. That
   *  makes an iframe re-layout its SVG at the settled resolution instead of
   *  leaving Chromium's cached iframe texture magnified and blurry. */
  scaleMode?: "transform" | "layout";
  /** Optional CSS-transition duration for toolbar/programmatic zoom steps. Gesture paths
   *  remain live and unanimated; zero preserves the classic immediate step. */
  programmaticZoomAnimationMs?: number;
}

export function useImageZoom({
  resetKey,
  wheelRequiresModifier = true,
  minScale,
  scaleMode = "transform",
  programmaticZoomAnimationMs = 0,
}: UseImageZoomOptions): ImageZoomController {
  const [scale, setScale] = useState(1);
  const [translateX, setTranslateX] = useState(0);
  const [translateY, setTranslateY] = useState(0);
  const imageElRef = useRef<HTMLElement | null>(null);
  const wheelTargetElRef = useRef<HTMLElement | null>(null);
  const liveTransformRef = useRef<ImageZoomState>({ scale: 1, translateX: 0, translateY: 0 });
  const settledScaleRef = useRef(1);
  const wheelMomentumFrameRef = useRef<number | null>(null);
  const wheelMomentumExponentRef = useRef(0);
  const wheelAnchorRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const programmaticZoomTargetRef = useRef<ImageZoomState | null>(null);
  const layoutSettlerRef = useRef<ImageZoomLayoutSettler | null>(null);
  const layoutSettleCancelRef = useRef<(() => void) | null>(null);
  const layoutSettleVersionRef = useRef(0);
  const committedResetKeyRef = useRef(resetKey);
  const [isDragging, setIsDragging] = useState(false);

  const dragRef = useRef<{ startX: number; startY: number; startTX: number; startTY: number } | null>(null);
  const pinchRef = useRef<{
    startDistance: number;
    startScale: number;
    startMidX: number;
    startMidY: number;
    startVisualCenterX: number;
    startVisualCenterY: number;
    startTX: number;
    startTY: number;
  } | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);

  const getMaxScale = useCallback(() => {
    const el = imageElRef.current;
    if (!el) return MAX_SCALE;
    if (!(el instanceof HTMLImageElement)) return MAX_SCALE;
    return imageDimensionsToMaxScale({
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
    });
  }, []);

  const getMinScale = useCallback(() => {
    if (minScale === undefined || !Number.isFinite(minScale)) return MIN_SCALE;
    return Math.max(Number.EPSILON, Math.min(MIN_SCALE, minScale));
  }, [minScale]);

  const setScaleClamped = useCallback((next: number) => {
    const min = getMinScale();
    if (next < min) return min;
    const maxScale = getMaxScale();
    if (next > maxScale) return maxScale;
    return next;
  }, [getMaxScale, getMinScale]);

  const applyImageTransform = useCallback((next: ImageZoomState) => {
    liveTransformRef.current = next;
    const el = imageElRef.current;
    if (!el) return;
    const nextIsZoomed = next.scale > 1.001;
    const nextIsTransformed = nextIsZoomed || next.scale < 0.999 || next.translateX !== 0 || next.translateY !== 0;
    if (scaleMode === "layout") {
      // Keep wheel/pinch frames on the compositor relative to the last settled
      // iframe size. commitLiveTransform() folds this ratio into real geometry
      // once the gesture ends, forcing a sharp SVG repaint without doing iframe
      // layout work on every animation frame.
      const transientScale = next.scale / settledScaleRef.current;
      el.style.width = `${settledScaleRef.current * 100}%`;
      el.style.height = `${settledScaleRef.current * 100}%`;
      el.style.transform = `translate(-50%, -50%)${next.translateX !== 0 || next.translateY !== 0
        ? ` translate(${next.translateX}px, ${next.translateY}px)`
        : ""}${Math.abs(transientScale - 1) > 0.000_001 ? ` scale(${transientScale})` : ""}`;
    } else {
      el.style.transform = nextIsTransformed
        ? `translate(${next.translateX}px, ${next.translateY}px) scale(${next.scale})`
        : "none";
    }
    el.style.cursor = dragRef.current ? "grabbing" : nextIsZoomed ? "zoom-out" : "zoom-in";
    el.style.willChange = nextIsTransformed ? "transform" : "auto";
  }, [scaleMode]);

  const settleImageTransform = useCallback((next: ImageZoomState) => {
    if (scaleMode === "layout") settledScaleRef.current = next.scale;
    applyImageTransform(next);
  }, [applyImageTransform, scaleMode]);

  const cancelLayoutSettle = useCallback(() => {
    layoutSettleVersionRef.current += 1;
    layoutSettleCancelRef.current?.();
    layoutSettleCancelRef.current = null;
  }, []);

  const finishCommittedTransform = useCallback((next: ImageZoomState) => {
    settleImageTransform(next);
    setScale(next.scale);
    setTranslateX(next.translateX);
    setTranslateY(next.translateY);
  }, [settleImageTransform]);

  const commitTransform = useCallback((next: ImageZoomState) => {
    const fromScale = settledScaleRef.current;
    const settler = scaleMode === "layout" ? layoutSettlerRef.current : null;
    cancelLayoutSettle();
    if (settler && Math.abs(next.scale - fromScale) > 0.000_001) {
      const version = layoutSettleVersionRef.current;
      const cancel = settler({
        fromScale,
        toScale: next.scale,
        complete: () => {
          if (version !== layoutSettleVersionRef.current) return false;
          layoutSettleCancelRef.current = null;
          finishCommittedTransform(next);
          return true;
        },
      });
      if (version === layoutSettleVersionRef.current && cancel) {
        layoutSettleCancelRef.current = cancel;
      }
      return;
    }
    finishCommittedTransform(next);
  }, [cancelLayoutSettle, finishCommittedTransform, scaleMode]);

  const commitLiveTransform = useCallback(() => {
    commitTransform(liveTransformRef.current);
  }, [commitTransform]);

  const zoomAroundClientPoint = useCallback((
    current: ImageZoomState,
    nextScale: number,
    clientX: number,
    clientY: number,
  ) => {
    const el = imageElRef.current;
    if (!el) return { ...current, scale: nextScale };
    const rect = el.getBoundingClientRect();
    return imageZoomStateAroundPoint(current, nextScale, {
      clientX,
      clientY,
      visualCenterX: (rect.left + rect.right) / 2,
      visualCenterY: (rect.top + rect.bottom) / 2,
    });
  }, []);

  const stopWheelMomentum = useCallback(() => {
    if (wheelMomentumFrameRef.current !== null) {
      window.cancelAnimationFrame(wheelMomentumFrameRef.current);
      wheelMomentumFrameRef.current = null;
    }
    wheelMomentumExponentRef.current = 0;
    wheelAnchorRef.current = null;
  }, []);

  const cancelProgrammaticZoom = useCallback(() => {
    programmaticZoomTargetRef.current = null;
    const image = imageElRef.current;
    if (image) image.style.transition = "";
  }, []);

  const reset = useCallback(() => {
    stopWheelMomentum();
    cancelProgrammaticZoom();
    const next = { scale: 1, translateX: 0, translateY: 0 };
    applyImageTransform(next);
    commitTransform(next);
    setIsDragging(false);
  }, [applyImageTransform, cancelProgrammaticZoom, commitTransform, stopWheelMomentum]);

  // Render-phase reset on resetKey change — equivalent to a useEffect that
  // calls reset(), but adjusts state during render (no effect chain). Same
  // pattern as ImageLightbox's `wasOpen` reset.
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    setScale(1);
    setTranslateX(0);
    setTranslateY(0);
    setIsDragging(false);
  }

  // Refs and registered cancellation callbacks describe the committed
  // identity. Mutating them in the render-phase comparator above would let a
  // Suspense-aborted reset invalidate the still-visible identity's settle and
  // orphan its prepared iframe. Reset those imperative resources only after
  // the new key has actually committed; layout timing keeps the old geometry
  // from reaching a browser paint under the new identity.
  useLayoutEffect(() => {
    if (committedResetKeyRef.current === resetKey) return;
    committedResetKeyRef.current = resetKey;
    stopWheelMomentum();
    cancelProgrammaticZoom();
    cancelLayoutSettle();
    settleImageTransform({ scale: 1, translateX: 0, translateY: 0 });
  }, [cancelLayoutSettle, cancelProgrammaticZoom, resetKey, settleImageTransform, stopWheelMomentum]);

  const isZoomed = scale > 1.001;

  const imageRef = useCallback((el: HTMLElement | null) => {
    imageElRef.current = el;
    if (el) settleImageTransform(liveTransformRef.current);
  }, [settleImageTransform]);

  const onTransitionEnd = useCallback((event: React.TransitionEvent<HTMLElement>) => {
    if (
      event.target !== event.currentTarget
      || event.currentTarget !== imageElRef.current
      || event.propertyName !== "transform"
    ) return;
    const target = programmaticZoomTargetRef.current;
    if (!target) return;
    event.currentTarget.style.transition = "";
    programmaticZoomTargetRef.current = null;
    commitTransform(target);
  }, [commitTransform]);

  const containsImagePoint = (clientX: number, clientY: number) => {
    const el = imageElRef.current;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  };

  const startWheelMomentum = useCallback(() => {
    if (wheelMomentumFrameRef.current !== null) return;

    const tick = () => {
      const velocity = wheelMomentumExponentRef.current;
      if (Math.abs(velocity) < WHEEL_ZOOM_MOMENTUM_STOP_EXPONENT) {
        wheelMomentumFrameRef.current = null;
        wheelMomentumExponentRef.current = 0;
        wheelAnchorRef.current = null;
        commitLiveTransform();
        return;
      }

      const current = liveTransformRef.current;
      const nextScale = setScaleClamped(current.scale * (2 ** velocity));
      const anchor = wheelAnchorRef.current;
      applyImageTransform(anchor
        ? zoomAroundClientPoint(current, nextScale, anchor.clientX, anchor.clientY)
        : { ...current, scale: nextScale });
      wheelMomentumExponentRef.current = velocity * WHEEL_ZOOM_MOMENTUM_FRICTION;
      wheelMomentumFrameRef.current = window.requestAnimationFrame(tick);
    };

    wheelMomentumFrameRef.current = window.requestAnimationFrame(tick);
  }, [applyImageTransform, commitLiveTransform, setScaleClamped, zoomAroundClientPoint]);

  const applyCommittedTransform = useCallback((next: ImageZoomState) => {
    stopWheelMomentum();
    cancelProgrammaticZoom();
    applyImageTransform(next);
    commitTransform(next);
  }, [applyImageTransform, cancelProgrammaticZoom, commitTransform, stopWheelMomentum]);

  const zoomBy = useCallback((factor: number) => {
    if (!Number.isFinite(factor) || factor <= 0) return;
    stopWheelMomentum();

    const current = { ...liveTransformRef.current };
    const queuedTarget = programmaticZoomTargetRef.current;
    const nextScale = setScaleClamped((queuedTarget?.scale ?? current.scale) * factor);
    const stageRect = wheelTargetElRef.current?.getBoundingClientRect();
    const target = stageRect
      ? zoomAroundClientPoint(
          current,
          nextScale,
          (stageRect.left + stageRect.right) / 2,
          (stageRect.top + stageRect.bottom) / 2,
        )
      : { ...current, scale: nextScale };

    if (
      Math.abs(target.scale - current.scale) <= 0.000_001 &&
      Math.abs(target.translateX - current.translateX) <= 0.000_001 &&
      Math.abs(target.translateY - current.translateY) <= 0.000_001
    ) return;
    cancelProgrammaticZoom();
    cancelLayoutSettle();

    const animationMs = Number.isFinite(programmaticZoomAnimationMs)
      ? Math.max(0, programmaticZoomAnimationMs)
      : 0;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (animationMs === 0 || reducedMotion) {
      applyImageTransform(target);
      commitTransform(target);
      return;
    }

    const image = imageElRef.current;
    if (!image) {
      applyImageTransform(target);
      commitTransform(target);
      return;
    }
    // Toolbar zoom has one deterministic owner boundary: write the accepted
    // target transform synchronously, then let the element's transitionend
    // event commit layout-mode geometry. A requestAnimationFrame elapsed-time
    // loop can be starved before its first visible tick under a busy host,
    // leaving both the UI and its semantic tooth stuck at the old transform.
    image.getBoundingClientRect();
    programmaticZoomTargetRef.current = target;
    image.style.transition = `transform ${animationMs}ms ${PROGRAMMATIC_ZOOM_TIMING_FUNCTION}`;
    applyImageTransform(target);
  }, [
    applyImageTransform,
    cancelLayoutSettle,
    cancelProgrammaticZoom,
    commitTransform,
    programmaticZoomAnimationMs,
    setScaleClamped,
    stopWheelMomentum,
    zoomAroundClientPoint,
  ]);

  useEffect(() => {
    settleImageTransform({ scale, translateX, translateY });
  }, [scale, settleImageTransform, translateX, translateY]);

  useEffect(() => {
    return () => {
      stopWheelMomentum();
      cancelProgrammaticZoom();
      layoutSettleVersionRef.current += 1;
      layoutSettleCancelRef.current?.();
      layoutSettleCancelRef.current = null;
    };
  }, [cancelProgrammaticZoom, stopWheelMomentum]);

  const layoutSettleRef = useCallback((settler: ImageZoomLayoutSettler | null) => {
    cancelLayoutSettle();
    layoutSettlerRef.current = settler;
  }, [cancelLayoutSettle]);

  // Native wheel listener — bound imperatively because React 19's JSX onWheel
  // is forced-passive (preventDefault silently no-ops). Trackpad pinch on Mac
  // / Chromium synthesizes as wheel + ctrlKey:true; without preventDefault
  // the browser hijacks it for page zoom before we ever see it.
  // (wheelTargetElRef is declared next to imageElRef so the min-scale clamp
  // can measure the gesture surface.)
  // Stash the live setScale/clamp/MAX context so the imperative listener
  // (registered once on mount) doesn't capture stale state.
  const handleWheelRef = useRef<(event: WheelEvent) => void>(() => {});
  handleWheelRef.current = (event: WheelEvent) => {
    if (wheelRequiresModifier && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    cancelProgrammaticZoom();
    cancelLayoutSettle();
    // PhotoSwipe-style logarithmic mapping with our tuned coefficient and
    // deltaMode normalization. Trackpads produce many small pixel deltas;
    // mouse wheels often produce coarse ±100 pixel deltas; Firefox can report
    // line-mode deltas. Normalize before applying the speed curve.
    const exponent = wheelDeltaToZoomExponent(event.deltaY, event.deltaMode, event.ctrlKey || event.metaKey);
    const current = liveTransformRef.current;
    const nextScale = setScaleClamped(current.scale * (2 ** exponent));
    wheelAnchorRef.current = { clientX: event.clientX, clientY: event.clientY };
    applyImageTransform(zoomAroundClientPoint(current, nextScale, event.clientX, event.clientY));
    wheelMomentumExponentRef.current += exponent * WHEEL_ZOOM_MOMENTUM_INPUT;
    startWheelMomentum();
  };

  const wheelTargetRef = useCallback((el: HTMLElement | null) => {
    const prev = wheelTargetElRef.current;
    if (prev === el) return;
    if (prev) {
      prev.removeEventListener("wheel", wheelListenerRef.current);
    }
    wheelTargetElRef.current = el;
    if (el) {
      // passive:false is REQUIRED here, not a perf regression — the handler
      // calls event.preventDefault() to suppress the browser's native
      // page-zoom on trackpad pinch (Chromium + Safari synthesize trackpad
      // pinch as wheel + ctrlKey:true). React 19 hard-codes JSX onWheel as
      // passive:true which silently no-ops preventDefault, hence we bind
      // natively. See file header comment.
      // oxlint-disable-next-line react-doctor/client-passive-event-listeners -- intentional: see Mac trackpad pinch fix above
      el.addEventListener("wheel", wheelListenerRef.current, { passive: false });
    }
  }, []);

  // Singleton listener wrapper that delegates to handleWheelRef (which is
  // refreshed each render with the latest captured state). Using a stable
  // function reference here means addEventListener / removeEventListener
  // pair via the ref callback above always match.
  const wheelListenerRef = useRef<(event: WheelEvent) => void>((event) => {
    handleWheelRef.current(event);
  });

  // Cleanup on unmount: detach from whatever element we last bound to.
  // Capture the listener function in the effect closure so it's stable for
  // the cleanup call (the ref's `.current` would be the same singleton, but
  // capturing avoids the react-hooks/exhaustive-deps ref-in-cleanup warning).
  useEffect(() => {
    const listener = wheelListenerRef.current;
    return () => {
      const el = wheelTargetElRef.current;
      if (el) el.removeEventListener("wheel", listener);
    };
  }, []);

  const onDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      const current = liveTransformRef.current;
      if (Math.abs(current.scale - MIN_SCALE) > 0.001 || current.translateX !== 0 || current.translateY !== 0) {
        reset();
      } else {
        applyCommittedTransform(zoomAroundClientPoint(
          current,
          setScaleClamped(ZOOMED_SCALE_TARGET),
          event.clientX,
          event.clientY,
        ));
      }
    },
    [applyCommittedTransform, reset, setScaleClamped, zoomAroundClientPoint],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      cancelProgrammaticZoom();
      cancelLayoutSettle();
      const current = liveTransformRef.current;
      if (current.scale <= 1.001) return;
      if (event.pointerType === "touch") return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        startTX: current.translateX,
        startTY: current.translateY,
      };
      setIsDragging(true);
      const image = imageElRef.current;
      if (image) image.style.cursor = "grabbing";
    },
    [cancelLayoutSettle, cancelProgrammaticZoom],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    applyImageTransform({
      ...liveTransformRef.current,
      translateX: dragRef.current.startTX + dx,
      translateY: dragRef.current.startTY + dy,
    });
  }, [applyImageTransform]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
    applyImageTransform(liveTransformRef.current);
    commitLiveTransform();
  }, [applyImageTransform, commitLiveTransform]);

  const onTouchStart = useCallback(
    (event: React.TouchEvent<HTMLElement>) => {
      cancelProgrammaticZoom();
      cancelLayoutSettle();
      if (event.touches.length === 2) {
        const current = liveTransformRef.current;
        const t0 = event.touches[0];
        const t1 = event.touches[1];
        const dx = t1.clientX - t0.clientX;
        const dy = t1.clientY - t0.clientY;
        const startMidX = (t0.clientX + t1.clientX) / 2;
        const startMidY = (t0.clientY + t1.clientY) / 2;
        const rect = imageElRef.current?.getBoundingClientRect();
        pinchRef.current = {
          startDistance: Math.hypot(dx, dy),
          startScale: current.scale,
          startMidX,
          startMidY,
          startVisualCenterX: rect ? (rect.left + rect.right) / 2 : startMidX,
          startVisualCenterY: rect ? (rect.top + rect.bottom) / 2 : startMidY,
          startTX: current.translateX,
          startTY: current.translateY,
        };
      } else if (event.touches.length === 1 && liveTransformRef.current.scale > 1.001) {
        const t = event.touches[0];
        const current = liveTransformRef.current;
        dragRef.current = {
          startX: t.clientX,
          startY: t.clientY,
          startTX: current.translateX,
          startTY: current.translateY,
        };
      }
    },
    [cancelLayoutSettle, cancelProgrammaticZoom],
  );

  const onTouchMove = useCallback(
    (event: React.TouchEvent<HTMLElement>) => {
      if (event.touches.length === 2 && pinchRef.current) {
        const t0 = event.touches[0];
        const t1 = event.touches[1];
        const dx = t1.clientX - t0.clientX;
        const dy = t1.clientY - t0.clientY;
        const dist = Math.hypot(dx, dy);
        const ratio = dist / pinchRef.current.startDistance;
        const next = setScaleClamped(pinchRef.current.startScale * ratio);
        const midX = (t0.clientX + t1.clientX) / 2;
        const midY = (t0.clientY + t1.clientY) / 2;
        const anchored = imageZoomStateAroundPoint({
          scale: pinchRef.current.startScale,
          translateX: pinchRef.current.startTX,
          translateY: pinchRef.current.startTY,
        }, next, {
          clientX: pinchRef.current.startMidX,
          clientY: pinchRef.current.startMidY,
          visualCenterX: pinchRef.current.startVisualCenterX,
          visualCenterY: pinchRef.current.startVisualCenterY,
        });
        applyImageTransform({
          ...anchored,
          translateX: anchored.translateX + (midX - pinchRef.current.startMidX),
          translateY: anchored.translateY + (midY - pinchRef.current.startMidY),
        });
      } else if (event.touches.length === 1 && dragRef.current) {
        const t = event.touches[0];
        const dx = t.clientX - dragRef.current.startX;
        const dy = t.clientY - dragRef.current.startY;
        applyImageTransform({
          ...liveTransformRef.current,
          translateX: dragRef.current.startTX + dx,
          translateY: dragRef.current.startTY + dy,
        });
      }
    },
    [applyImageTransform, setScaleClamped],
  );

  const onTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLElement>) => {
      if (event.touches.length < 2) pinchRef.current = null;
      if (event.touches.length === 0) {
        const drag = dragRef.current;
        dragRef.current = null;
        commitLiveTransform();
        const t = event.changedTouches[0];
        if (!t) return;
        const movedFar = drag !== null &&
          (Math.abs(t.clientX - drag.startX) > TAP_MOVEMENT_TOLERANCE_PX ||
           Math.abs(t.clientY - drag.startY) > TAP_MOVEMENT_TOLERANCE_PX);
        if (movedFar) return;

        const now = performance.now();
        const last = lastTapRef.current;
        const isDoubleTap =
          last !== null &&
          now - last.time < DOUBLE_TAP_WINDOW_MS &&
          Math.abs(t.clientX - last.x) < DOUBLE_TAP_RADIUS_PX &&
          Math.abs(t.clientY - last.y) < DOUBLE_TAP_RADIUS_PX;
        if (isDoubleTap) {
          lastTapRef.current = null;
          if (isZoomed) {
            reset();
          } else {
            const current = liveTransformRef.current;
            applyCommittedTransform(zoomAroundClientPoint(
              current,
              setScaleClamped(ZOOMED_SCALE_TARGET),
              t.clientX,
              t.clientY,
            ));
          }
        } else {
          lastTapRef.current = { time: now, x: t.clientX, y: t.clientY };
        }
      } else if (event.touches.length < 2) {
        commitLiveTransform();
      }
    },
    [applyCommittedTransform, commitLiveTransform, isZoomed, reset, setScaleClamped, zoomAroundClientPoint],
  );

  const isTransformed = isZoomed || scale < 0.999 || translateX !== 0 || translateY !== 0;
  const transform = scaleMode === "layout"
    ? `translate(-50%, -50%)${translateX !== 0 || translateY !== 0
      ? ` translate(${translateX}px, ${translateY}px)`
      : ""}`
    : isTransformed
      ? `translate(${translateX}px, ${translateY}px) scale(${scale})`
      : "none";
  const width = scaleMode === "layout" ? `${scale * 100}%` : undefined;
  const height = scaleMode === "layout" ? `${scale * 100}%` : undefined;
  const touchAction = isZoomed ? "none" : "auto";
  const cursor = isDragging ? "grabbing" : isZoomed ? "zoom-out" : "zoom-in";
  const stageCursor = isDragging ? "grabbing" : isZoomed ? "grab" : "default";

  return {
    scale,
    translateX,
    translateY,
    style: { transform, width, height, touchAction, cursor, stageCursor },
    imageRef,
    wheelTargetRef,
    layoutSettleRef,
    onDoubleClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    reset,
    zoomBy,
    onTransitionEnd,
    containsImagePoint,
    isZoomed,
  };
}
