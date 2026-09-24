import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import "./helpers/domSetup";
import { jumpToAnchor } from "../src/components/message/attachmentCommentAnchors.ts";
import { VideoAttachmentPreviewModal } from "../src/components/message/attachmentPreviewSurfaces.tsx";
import { createVideoSeekCoalescer } from "../src/components/message/videoTimestampSeekCoalesce.ts";
import { TestIntlProvider } from "./helpers/intl.tsx";

afterEach(() => {
  cleanup();
});

test("the mounted video preview coalesces timestamp jumps and cancels pending work on close", () => {
  const frames = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let nextFrameId = 0;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  };
  window.cancelAnimationFrame = (frameId) => {
    cancelled.push(frameId);
    frames.delete(frameId);
  };

  try {
    const view = render(createElement(
      TestIntlProvider,
      null,
      createElement(VideoAttachmentPreviewModal, {
        filename: "demo.mp4",
        url: "https://preview.test/demo.mp4",
        onClose: () => undefined,
        onDownload: () => undefined,
      }),
    ));
    const video = document.querySelector("video");
    assert.ok(video, "the real video preview must mount its media element");
    let pauseCalls = 0;
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    Object.defineProperty(video, "pause", {
      configurable: true,
      value: () => {
        pauseCalls += 1;
      },
    });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 0 });

    assert.equal(jumpToAnchor({ type: "video-timestamp", data: { time: 1.5 } }), true);
    assert.equal(jumpToAnchor({ type: "video-timestamp", data: { time: 3.25 } }), true);
    assert.equal(jumpToAnchor({ type: "video-timestamp", data: { time: 9.75 } }), true);
    assert.equal(frames.size, 1, "the mounted preview must schedule one coalesced frame");
    assert.equal(video.currentTime, 0, "the preview must not write currentTime before the frame");

    const firstFrame = [...frames.entries()][0];
    assert.ok(firstFrame);
    frames.delete(firstFrame[0]);
    firstFrame[1](0);
    assert.equal(pauseCalls, 1);
    assert.equal(video.currentTime, 9.75, "the mounted preview must apply only the latest target");

    assert.equal(jumpToAnchor({ type: "video-timestamp", data: { time: 4 } }), true);
    const pendingFrameId = [...frames.keys()][0];
    assert.notEqual(pendingFrameId, undefined);
    view.unmount();
    assert.deepEqual(cancelled, [pendingFrameId]);
    assert.equal(frames.size, 0);
    assert.equal(
      jumpToAnchor({ type: "video-timestamp", data: { time: 7 } }),
      false,
      "unmount must unregister the live video jump handler",
    );
  } finally {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test("three rapid seeks collapse to one rAF write of the latest target", () => {
  const writes: number[] = [];
  const frames: FrameRequestCallback[] = [];
  let video = {
    paused: false,
    pause() { this.paused = true; },
    setCurrentTime(time: number) { writes.push(time); },
  };
  const coalescer = createVideoSeekCoalescer(
    () => video,
    {
      requestAnimationFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelAnimationFrame: () => {
        frames.length = 0;
      },
    },
  );

  assert.equal(coalescer.seek(1.5), true);
  assert.equal(coalescer.seek(3.25), true);
  assert.equal(coalescer.seek(9.75), true);
  assert.equal(frames.length, 1, "in-flight guard must schedule only one rAF");
  assert.deepEqual(writes, [], "currentTime must not write before rAF");

  frames[0]!(0 as unknown as DOMHighResTimeStamp);
  assert.deepEqual(writes, [9.75]);
  assert.equal(video.paused, true);
});

test("cancel drops the pending rAF without writing", () => {
  const writes: number[] = [];
  let cancelled = 0;
  const frames: FrameRequestCallback[] = [];
  const coalescer = createVideoSeekCoalescer(
    () => ({
      paused: true,
      pause() {},
      setCurrentTime(time: number) { writes.push(time); },
    }),
    {
      requestAnimationFrame: (cb) => {
        frames.push(cb);
        return 7;
      },
      cancelAnimationFrame: () => {
        cancelled += 1;
        frames.length = 0;
      },
    },
  );
  coalescer.seek(4);
  coalescer.cancel();
  assert.equal(cancelled, 1);
  assert.deepEqual(writes, []);
});
