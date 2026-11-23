// Render-why probe entry — bundled to an IIFE by `buildProbe.ts why` and
// attached with Playwright's `addInitScript({ path })` BEFORE react-dom loads,
// like renderPerfProbe.ts. Where that probe counts a row's renders, this one
// records why each happened: changed props, hook slots and contexts of every
// component at and under the row's boundary (renderWhyRecorder.ts), and where
// in the tree the render started. Diagnostic only; nothing in CI loads it.
//
// A page may set `window.__RAFT_RENDER_WHY_SERIES__` (name -> { selector,
// idAttribute }) in an earlier init script to watch other rows.
import { instrument } from "bippy";
import { createWhyRecorder } from "./renderWhyRecorder";
import type { WhyFiber, WhyReading, WhySeries } from "./renderWhyRecorder";

export interface RenderWhyHandle {
  /** `injected` once React registered with the hook. */
  renderer: () => "injected" | "not-injected";
  read: () => WhyReading;
  reset: () => void;
}

declare global {
  interface Window {
    __RAFT_RENDER_WHY__?: RenderWhyHandle;
    __RAFT_RENDER_WHY_SERIES__?: Record<string, WhySeries>;
  }
}

const recorder = createWhyRecorder({ series: window.__RAFT_RENDER_WHY_SERIES__ });
let renderer: "injected" | "not-injected" = "not-injected";

instrument({
  name: "raft-render-why-probe",
  onActive: () => {
    renderer = "injected";
  },
  onCommitFiberRoot: (_rendererId, root) => {
    recorder.onCommit(root as unknown as { current: WhyFiber });
  },
});

window.__RAFT_RENDER_WHY__ = {
  renderer: () => renderer,
  read: () => recorder.read(),
  reset: () => recorder.reset(),
};
