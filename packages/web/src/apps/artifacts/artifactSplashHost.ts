import { markHostPageShown } from "../../embed";

/**
 * The App's half of one splash (#proj-workspace:#302): with the host shell, the App draws the splash natively over
 * the WebView and waits for `hostLoaded=1` (embed.ts markHostPageShown) to play its ending. The page says so when
 * its loading is over:
 * - a splash is `done` (the page in the frame says it loaded, or the file Raft draws arrived): at once;
 * - or no splash is on screen any more, after ARTIFACT_SPLASH_HOST_SETTLE_MS: a part that failed drew its own screen
 *   in the splash's place. The wait bridges parts handing over to each other (stage 0, then 1), which normally
 *   happens within one render.
 * Outside the host shell nothing is written (markHostPageShown is a no-op there).
 */
export const ARTIFACT_SPLASH_HOST_SETTLE_MS = 150;

let covering = 0;
let settle: ReturnType<typeof setTimeout> | null = null;

/** A splash cover on screen that is not done; the returned function lets it go (once). */
export function holdArtifactSplashCover(): () => void {
  covering += 1;
  if (settle !== null) {
    clearTimeout(settle);
    settle = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    covering -= 1;
    if (covering > 0) return;
    if (settle !== null) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      if (covering === 0) markHostPageShown();
    }, ARTIFACT_SPLASH_HOST_SETTLE_MS);
  };
}

/** A splash is done: what it covered is on screen. */
export function artifactSplashDone(): void {
  markHostPageShown();
}

/** Test seam. */
export function resetArtifactSplashHostForTests(): void {
  covering = 0;
  if (settle !== null) clearTimeout(settle);
  settle = null;
}
