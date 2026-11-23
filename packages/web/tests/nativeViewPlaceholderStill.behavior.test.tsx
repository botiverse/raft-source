// The overlay rule without a blank frame (#proj-deskop:#15): on shells that
// capture without hiding, the view hides only after the still is painted in
// the placeholder. Older shells (no capture) keep setVisible(false), which
// snapshots and hides at once.
import assert from "node:assert/strict";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, test, vi } from "vitest";

const overlay = vi.hoisted(() => ({ covered: false }));
vi.mock("../src/features/webPreview/webPreviewOverlays", () => ({ useOverlayCovers: () => overlay.covered }));

import { useNativeViewPlaceholder } from "../src/features/webPreview/useNativeViewPlaceholder";

const STILL = "data:image/jpeg;base64,AAAA";
let frames: Array<FrameRequestCallback> = [];
const realRequestAnimationFrame = globalThis.requestAnimationFrame;

beforeEach(() => {
  overlay.covered = false;
  frames = [];
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => frames.push(callback);
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = realRequestAnimationFrame;
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function runFrames(): Promise<void> {
  while (frames.length) {
    const pending = frames;
    frames = [];
    await act(async () => {
      for (const frame of pending) frame(0);
    });
    await flush();
  }
}

function setup(withCapture: boolean, capture: () => Promise<string | null> = async () => STILL) {
  const element = document.createElement("div");
  document.body.append(element);
  const calls: string[] = [];
  const view = {
    setBounds: () => {},
    setVisible: async (visible: boolean, options?: { snapshot?: boolean }) => {
      calls.push(`setVisible:${visible}${options?.snapshot === false ? ":no-snapshot" : ""}`);
      return visible ? null : STILL;
    },
    ...(withCapture ? { capture: async () => { calls.push("capture"); return capture(); } } : {}),
  };
  const hook = renderHook(() => useNativeViewPlaceholder({ current: element }, view));
  calls.length = 0; // the first, uncovered setVisible(true)
  return { calls, hook };
}

test("with capture, the view hides only after the still is shown and a frame has painted", async () => {
  const { calls, hook } = setup(true);
  overlay.covered = true;
  hook.rerender();
  await flush();
  assert.deepEqual(calls, ["capture"]);
  assert.equal(hook.result.current.snapshot, STILL, "the still is in the placeholder while the view still shows");
  await runFrames();
  assert.deepEqual(calls, ["capture", "setVisible:false:no-snapshot"]);
  assert.equal(hook.result.current.snapshot, STILL);
});

test("with capture, an overlay gone before the still is painted never hides the view", async () => {
  const { calls, hook } = setup(true);
  overlay.covered = true;
  hook.rerender();
  await flush();
  overlay.covered = false;
  hook.rerender();
  await runFrames();
  assert.deepEqual(calls, ["capture", "setVisible:true"]);
});

test("with capture, a failed capture still hides the view (the overlay must not stay under it)", async () => {
  const { calls, hook } = setup(true, async () => { throw new Error("gone"); });
  overlay.covered = true;
  hook.rerender();
  await flush();
  await runFrames();
  assert.deepEqual(calls, ["capture", "setVisible:false:no-snapshot"]);
  assert.equal(hook.result.current.snapshot, null);
});

test("without capture (older shells), hiding snapshots and hides at once", async () => {
  const { calls, hook } = setup(false);
  overlay.covered = true;
  hook.rerender();
  await flush();
  assert.deepEqual(calls, ["setVisible:false"]);
  assert.equal(hook.result.current.snapshot, STILL);
});
