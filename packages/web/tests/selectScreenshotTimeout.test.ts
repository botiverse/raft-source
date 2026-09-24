import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCapturePixelRatio,
  SelectScreenshotTimeoutError,
  waitForDocumentFontsForScreenshot,
  withCaptureTimeout,
} from "../src/utils/selectScreenshot.js";

test("withCaptureTimeout resolves normally before the timeout", async () => {
  const value = await withCaptureTimeout(Promise.resolve("ok"), 50);

  assert.equal(value, "ok");
});

test("withCaptureTimeout rejects stuck captures so UI can leave spinner state", async () => {
  await assert.rejects(
    withCaptureTimeout(new Promise(() => undefined), 5),
    (err) => {
      assert.ok(err instanceof SelectScreenshotTimeoutError);
      assert.equal(err.message, "Rendering timed out after 1s");
      return true;
    },
  );
});

test("waitForDocumentFontsForScreenshot does not let stalled fonts block capture", async () => {
  const started = Date.now();

  await waitForDocumentFontsForScreenshot({
    ready: new Promise(() => undefined),
  } as FontFaceSet, 5);

  assert.ok(Date.now() - started < 100);
});

test("waitForDocumentFontsForScreenshot still waits for ready fonts when available", async () => {
  let resolved = false;
  const ready = new Promise<void>((resolve) => {
    setTimeout(() => {
      resolved = true;
      resolve();
    }, 5);
  });

  await waitForDocumentFontsForScreenshot({ ready } as FontFaceSet, 100);

  assert.equal(resolved, true);
});

test("resolveCapturePixelRatio defaults to at least 2x and caps high-DPR screens", () => {
  const originalWindow = globalThis.window;
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { devicePixelRatio: 1 },
    });
    assert.equal(resolveCapturePixelRatio(), 2);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { devicePixelRatio: 2.5 },
    });
    assert.equal(resolveCapturePixelRatio(), 2.5);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { devicePixelRatio: 4 },
    });
    assert.equal(resolveCapturePixelRatio(), 3);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("resolveCapturePixelRatio preserves explicit capture overrides", () => {
  assert.equal(resolveCapturePixelRatio(1), 1);
  assert.equal(resolveCapturePixelRatio(3), 3);
});
