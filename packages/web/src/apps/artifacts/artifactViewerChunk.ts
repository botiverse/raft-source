// The Artifact viewer and frame (with Porthole) are their own chunks, off the
// first screen: ArtifactSideCard declares the viewer with lazyDeferred (kept
// out of the startup bundle by scripts/check-entry-chunk-structure.ts) and
// ArtifactContent loads the frame lazily. Both are fetched once the first
// screen is done; an open before that (a press or hover on an opener, a
// boot-time open) starts the load here so the viewer does not wait for it.
// Every load is importHandledLocally: a failed download shows the card's own
// Try again (artifactLazyChunk.tsx), not the app-wide refresh prompt.

import { importHandledLocally } from "../../boot/appChunkLoading";

export const loadArtifactViewer = () => importHandledLocally(() => import("./ArtifactViewer"));
export const loadArtifactFrame = () => importHandledLocally(() => import("./ArtifactFrame"));

/** Start loading the viewer's code (and the frame's, for a framed kind); a failure is left to the lazy render to retry. */
export function preloadArtifactViewerCode(framed = true): void {
  void loadArtifactViewer().catch(() => {});
  if (framed) void loadArtifactFrame().catch(() => {});
}

/** The standalone Artifact page (`/artifacts/:id`) draws the frame without the viewer: its code alone. */
export function preloadArtifactFrameCode(): void {
  void loadArtifactFrame().catch(() => {});
}
