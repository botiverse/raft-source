import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, Suspense } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ImageZoomLayoutSettleRequest } from "../src/components/ImageZoom";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const DATA_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAA2CAIAAAC3LQuFAAAAZ0lEQVR42u3QQQkAQAgAMKOZ6/rYyD5eCsHHYAkW03nLq1NCkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBggQJEiRIkCBBuz50p3KXsCdByQAAAABJRU5ErkJggg==";

function rect(init: { left: number; top: number; right: number; bottom: number }): DOMRect {
  const width = init.right - init.left;
  const height = init.bottom - init.top;
  return {
    ...init,
    x: init.left,
    y: init.top,
    width,
    height,
    toJSON: () => ({ ...init, x: init.left, y: init.top, width, height }),
  } as DOMRect;
}

function setRect(el: Element, box: DOMRect) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => box,
  });
}

function ensureLocalStorage() {
  if (typeof globalThis.localStorage?.getItem === "function") return;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

async function loadLightboxModules() {
  ensureLocalStorage();
  const [{ default: ImageLightbox }, { useImageLightboxStore }] = await Promise.all([
    import("../src/components/ImageLightbox"),
    import("../src/store/imageLightboxStore"),
  ]);
  return { ImageLightbox, useImageLightboxStore };
}

afterEach(async () => {
  cleanup();
  const { useImageLightboxStore } = await loadLightboxModules();
  act(() => {
    useImageLightboxStore.getState().close();
  });
});

test("ImageLightbox only dismisses stage clicks that are outside the transformed image rect", async () => {
  const { ImageLightbox, useImageLightboxStore } = await loadLightboxModules();
  act(() => {
    useImageLightboxStore.getState().open([
      {
        id: "proof-image",
        filename: "proof.png",
        mimeType: "image/png",
        sizeBytes: 1,
        directUrl: DATA_IMAGE,
      },
    ], 0);
  });

  render(<ImageLightbox />);

  const image = await screen.findByTestId("image-lightbox-image");
  const stage = screen.getByTestId("image-lightbox-stage");
  setRect(image, rect({ left: 100, top: 100, right: 200, bottom: 200 }));

  for (const [clientX, clientY] of [
    [100, 150],
    [200, 150],
    [150, 100],
    [150, 200],
    [150, 150],
  ] as const) {
    fireEvent.click(stage, { clientX, clientY });
    assert.ok(screen.queryByTestId("image-lightbox"), `stage click at ${clientX},${clientY} should stay open`);
  }

  fireEvent.click(image, { clientX: 50, clientY: 50 });
  assert.ok(screen.queryByTestId("image-lightbox"), "image-originated clicks must not dismiss, even outside the rect");

  fireEvent.click(stage, { clientX: 99, clientY: 150 });
  await waitFor(() => assert.equal(screen.queryByTestId("image-lightbox"), null));
});

test("ImageLightbox mounts a flow header, flexible stage, bounded image, and compact working controls", async () => {
  const { ImageLightbox, useImageLightboxStore } = await loadLightboxModules();
  act(() => {
    useImageLightboxStore.getState().open([
      {
        id: "layout-proof",
        filename: "layout-proof.png",
        mimeType: "image/png",
        sizeBytes: 1,
        directUrl: DATA_IMAGE,
      },
    ], 0);
  });

  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const downloads: Array<{ href: string; download: string }> = [];
  HTMLAnchorElement.prototype.click = function click() {
    downloads.push({ href: this.href, download: this.download });
  };

  try {
    render(<ImageLightbox />);

    const root = screen.getByTestId("image-lightbox");
    assert.ok(root.classList.contains("flex"));
    assert.ok(root.classList.contains("flex-col"));
    assert.equal(root.classList.contains("items-center"), false);
    assert.equal(root.classList.contains("justify-center"), false);

    const header = root.firstElementChild;
    assert.ok(header instanceof HTMLDivElement, "the title bar must be the first child in normal flow");
    for (const token of ["safe-top", "safe-left", "safe-right", "shrink-0"]) {
      assert.ok(header.classList.contains(token), `title bar is missing ${token}`);
    }
    assert.equal(header.classList.contains("absolute"), false);

    const stage = screen.getByTestId("image-lightbox-stage");
    for (const token of ["relative", "flex", "min-w-0", "flex-1", "overflow-hidden"]) {
      assert.ok(stage.classList.contains(token), `image stage is missing ${token}`);
    }

    const image = await screen.findByTestId("image-lightbox-image");
    for (const token of ["max-h-full", "max-w-full", "object-contain"]) {
      assert.ok(image.classList.contains(token), `image is missing ${token}`);
    }

    const download = screen.getByRole("button", { name: "Download" });
    const close = screen.getByRole("button", { name: "Close" });
    for (const control of [download, close]) {
      assert.ok(control.classList.contains("size-7"));
      const icon = control.querySelector("svg");
      assert.ok(icon, "compact control must render its Lucide icon");
      assert.equal(icon.getAttribute("width"), "14");
      assert.equal(icon.getAttribute("height"), "14");
    }

    fireEvent.click(download);
    assert.deepEqual(downloads, [{ href: DATA_IMAGE, download: "layout-proof.png" }]);

    fireEvent.click(close);
    await waitFor(() => assert.equal(screen.queryByTestId("image-lightbox"), null));
  } finally {
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
});

test("useImageZoom containsImagePoint is false without an image and inclusive inside the image rect", async () => {
  const { useImageZoom } = await import("../src/components/ImageZoom");
  let noImageController: ReturnType<typeof useImageZoom> | null = null;
  function NoImageProbe() {
    noImageController = useImageZoom({ resetKey: "empty" });
    return null;
  }

  render(<NoImageProbe />);
  assert.equal(noImageController?.containsImagePoint(0, 0), false);
  cleanup();

  let imageController: ReturnType<typeof useImageZoom> | null = null;
  function ImageProbe() {
    imageController = useImageZoom({ resetKey: "image" });
    return <img alt="" data-testid="probe-image" ref={imageController.imageRef} />;
  }

  render(<ImageProbe />);
  const image = screen.getByTestId("probe-image");
  setRect(image, rect({ left: 10, top: 20, right: 30, bottom: 40 }));

  assert.equal(imageController?.containsImagePoint(10, 30), true);
  assert.equal(imageController?.containsImagePoint(30, 30), true);
  assert.equal(imageController?.containsImagePoint(20, 20), true);
  assert.equal(imageController?.containsImagePoint(20, 40), true);
  assert.equal(imageController?.containsImagePoint(9, 30), false);
  assert.equal(imageController?.containsImagePoint(31, 30), false);
  assert.equal(imageController?.containsImagePoint(20, 19), false);
  assert.equal(imageController?.containsImagePoint(20, 41), false);
});

test("an aborted resetKey render cannot cancel or invalidate a committed layout settle", async () => {
  const { useImageZoom } = await import("../src/components/ImageZoom");
  const suspended = new Promise<never>(() => {});
  let controller: ReturnType<typeof useImageZoom> | null = null;
  let pendingRequest: ImageZoomLayoutSettleRequest | null = null;
  let cancelCount = 0;

  function ZoomProbe({ resetKey, suspend }: { resetKey: string; suspend: boolean }) {
    controller = useImageZoom({ resetKey, scaleMode: "layout" });
    if (suspend) throw suspended;
    return <button type="button" onClick={() => controller?.zoomBy(2)}>Zoom</button>;
  }

  const view = render(
    <Suspense fallback={<div>Loading</div>}>
      <ZoomProbe resetKey="alpha" suspend={false} />
    </Suspense>,
  );
  act(() => {
    controller?.layoutSettleRef((request) => {
      pendingRequest = request;
      return () => {
        cancelCount += 1;
      };
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Zoom" }));
  assert.ok(pendingRequest, "the committed alpha identity must own one pending layout settle");

  view.rerender(
    <Suspense fallback={<div>Loading</div>}>
      <ZoomProbe resetKey="beta" suspend />
    </Suspense>,
  );

  assert.equal(cancelCount, 0, "an uncommitted identity must not cancel committed settle work");
  let completed = false;
  act(() => {
    completed = pendingRequest?.complete() ?? false;
  });
  assert.equal(completed, true,
    "an uncommitted identity must not invalidate the committed settle completion gate");
});

test("a committed resetKey change cancels its pending layout settle", async () => {
  const { useImageZoom } = await import("../src/components/ImageZoom");
  let controller: ReturnType<typeof useImageZoom> | null = null;
  let pendingRequest: ImageZoomLayoutSettleRequest | null = null;
  let transitionActive = false;
  let cancelCount = 0;

  function ZoomProbe({ resetKey }: { resetKey: string }) {
    controller = useImageZoom({ resetKey, scaleMode: "layout" });
    return <button type="button" onClick={() => controller?.zoomBy(2)}>Zoom</button>;
  }

  const view = render(<ZoomProbe resetKey="alpha" />);
  act(() => {
    controller?.layoutSettleRef((request) => {
      pendingRequest = request;
      transitionActive = true;
      return () => {
        cancelCount += 1;
        transitionActive = false;
      };
    });
  });
  fireEvent.click(screen.getByRole("button", { name: "Zoom" }));
  assert.ok(pendingRequest);
  assert.equal(transitionActive, true, "alpha must enter the two-frame settle transition");

  view.rerender(<ZoomProbe resetKey="beta" />);

  assert.equal(cancelCount, 1, "the committed beta identity must cancel alpha exactly once");
  assert.equal(transitionActive, false, "committed reset cancellation must return the host to one frame");
  assert.equal(pendingRequest.complete(), false, "the cancelled alpha request must stay stale");
});

test("ImageLightbox native wheel zoom keeps the media point beneath the cursor", async () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  let queuedFrame: FrameRequestCallback | null = null;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    queuedFrame = callback;
    return 41;
  }) as typeof requestAnimationFrame;
  window.cancelAnimationFrame = ((handle: number) => {
    if (handle === 41) queuedFrame = null;
  }) as typeof cancelAnimationFrame;

  try {
    const { ImageLightbox, useImageLightboxStore } = await loadLightboxModules();
    act(() => {
      useImageLightboxStore.getState().open([
        {
          id: "wheel-anchor-proof",
          filename: "wheel-anchor.png",
          mimeType: "image/png",
          sizeBytes: 1,
          directUrl: DATA_IMAGE,
        },
      ], 0);
    });

    render(<ImageLightbox />);
    const image = await screen.findByTestId("image-lightbox-image");
    const stage = screen.getByTestId("image-lightbox-stage");
    setRect(image, rect({ left: 100, top: 100, right: 500, bottom: 500 }));

    const wheel = new WheelEvent("wheel", {
      clientX: 400,
      clientY: 200,
      ctrlKey: true,
      deltaY: -100,
      deltaMode: 0,
      cancelable: true,
    });
    stage.dispatchEvent(wheel);

    assert.equal(wheel.defaultPrevented, true, "the active native listener must own explicit zoom");
    assert.ok(queuedFrame, "wheel momentum should remain scheduled after the live frame");
    const transform = image.style.transform.match(
      /^translate\(([-+\d.e]+)px, ([-+\d.e]+)px\) scale\(([-+\d.e]+)\)$/,
    );
    assert.ok(transform, `unexpected live transform: ${image.style.transform}`);
    const translateX = Number(transform[1]);
    const translateY = Number(transform[2]);
    const scale = Number(transform[3]);
    const expectedScale = 2 ** 0.45;
    const expectedTranslateX = (400 - 300) * (1 - expectedScale);
    const expectedTranslateY = (200 - 300) * (1 - expectedScale);
    assert.ok(Math.abs(scale - expectedScale) < 1e-12, `scale ${scale}`);
    assert.ok(Math.abs(translateX - expectedTranslateX) < 1e-10, `translateX ${translateX}`);
    assert.ok(Math.abs(translateY - expectedTranslateY) < 1e-10, `translateY ${translateY}`);

    const nextCenterX = 300 + translateX;
    const nextCenterY = 300 + translateY;
    assert.ok(Math.abs((400 - 300) - ((400 - nextCenterX) / scale)) < 1e-10);
    assert.ok(Math.abs((200 - 300) - ((200 - nextCenterY) / scale)) < 1e-10);
  } finally {
    cleanup();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("useImageZoom pinch scales around the two-finger midpoint while following midpoint movement", async () => {
  const { useImageZoom } = await import("../src/components/ImageZoom");
  function PinchProbe() {
    const zoom = useImageZoom({ resetKey: "pinch-proof" });
    return (
      <div
        data-testid="pinch-stage"
        onTouchStart={zoom.onTouchStart}
        onTouchMove={zoom.onTouchMove}
        onTouchEnd={zoom.onTouchEnd}
      >
        <div data-testid="pinch-media" ref={zoom.imageRef} style={{ transform: zoom.style.transform }} />
      </div>
    );
  }

  render(<PinchProbe />);
  const stage = screen.getByTestId("pinch-stage");
  const media = screen.getByTestId("pinch-media");
  setRect(media, rect({ left: 100, top: 100, right: 500, bottom: 500 }));

  fireEvent.touchStart(stage, {
    touches: [
      { clientX: 350, clientY: 250 },
      { clientX: 450, clientY: 350 },
    ],
  });
  fireEvent.touchMove(stage, {
    touches: [
      { clientX: 320, clientY: 190 },
      { clientX: 520, clientY: 390 },
    ],
  });

  assert.equal(
    media.style.transform,
    "translate(-80px, -10px) scale(2)",
    "the start midpoint anchors scale, then its +20/-10 movement pans the anchored result",
  );
});

test("ImageLightbox stage double-click toggles zoom after pointer capture and exposes directional cursors", async () => {
  const { ImageLightbox, useImageLightboxStore } = await loadLightboxModules();
  act(() => {
    useImageLightboxStore.getState().open([
      {
        id: "double-click-proof",
        filename: "double-click.png",
        mimeType: "image/png",
        sizeBytes: 1,
        directUrl: DATA_IMAGE,
      },
    ], 0);
  });

  render(<ImageLightbox />);
  const image = await screen.findByTestId("image-lightbox-image");
  const stage = screen.getByTestId("image-lightbox-stage");
  let capturedPointer: number | null = null;
  Object.defineProperties(stage, {
    setPointerCapture: {
      configurable: true,
      value: (pointerId: number) => { capturedPointer = pointerId; },
    },
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => capturedPointer === pointerId,
    },
    releasePointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        if (capturedPointer === pointerId) capturedPointer = null;
      },
    },
  });

  assert.equal(image.style.cursor, "zoom-in");
  fireEvent.doubleClick(image);
  await waitFor(() => assert.match(image.style.transform, /scale\(2\)/));
  assert.equal(image.style.cursor, "zoom-out");
  assert.equal(stage.style.cursor, "grab");

  fireEvent.pointerDown(stage, { pointerId: 7, pointerType: "mouse", clientX: 10, clientY: 10 });
  await waitFor(() => assert.equal(image.style.cursor, "grabbing"));
  assert.equal(stage.style.cursor, "grabbing");
  fireEvent.pointerUp(stage, { pointerId: 7, pointerType: "mouse", clientX: 10, clientY: 10 });

  // The reset event deliberately targets the pointer-capturing stage, not
  // the child image. This is the exact post-zoom failure mode from r16.
  fireEvent.doubleClick(stage);
  await waitFor(() => assert.equal(image.style.transform, "none"));
  assert.equal(image.style.cursor, "zoom-in");
  assert.equal(stage.style.cursor, "default");
});
