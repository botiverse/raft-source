import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Skeleton } from "@botiverse/raft-ui";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { ArtifactKind } from "@botiverse/raft-shared";

import { useMediaQuery } from "../../hooks/effectPrimitives";
import {
  ARTIFACT_SPLASH_CYCLE_MS,
  ARTIFACT_SPLASH_DIM_OPACITY,
  ARTIFACT_SPLASH_FADE_EASING,
  ARTIFACT_SPLASH_FADE_MS,
  ARTIFACT_SPLASH_FILL_MS,
  ARTIFACT_SPLASH_GAP_PX,
  ARTIFACT_SPLASH_GRID,
  ARTIFACT_SPLASH_HOLD_MS,
  ARTIFACT_SPLASH_PIXEL_PX,
  ARTIFACT_SPLASH_REDUCED_MOTION_QUERY,
  artifactSplashCells,
  artifactSplashIcon,
  artifactSplashLitAt,
  artifactSplashPhase,
  SplashScopeContext,
  useArtifactSplashAppeared,
  useArtifactSplashAppearedAt,
  useArtifactSplashStart,
} from "./artifactSplash";
import type { ArtifactSplashIcon, ArtifactSplashSize, ArtifactSplashStage } from "./artifactSplash";

/**
 * The Artifact's loading splash: ONE cover over the content area from the moment the viewer (or the
 * Artifact's own page) opens until the page in the frame says it loaded, whichever part is loading
 * (the viewer's data, the frame's code, the frame route's ticket, the sandboxed page starting).
 *
 * A TRIAL (#proj-workspace:#145, xxchan approved Kirby's direction 1 "像素拼图", the mockup Artifact
 * GviuJRSsa1cRKnxHuraP9j): it is not a Raft Design System rule yet. motion.md still says the pixel
 * spinner is the only loop; this is the second, scoped to an Artifact's content area and to loading
 * only. If the trial holds, the rule and a raft-ui component go upstream (raft-design), and the native
 * App mirrors its parameters (artifactSplash.ts).
 *
 * - The pixels draw the Artifact's kind (the card the viewer opened from knows it before anything
 *   loads): a web page is a window with a title bar, a document a sheet with a folded corner, an
 *   image mountains and a sun. 8×8 cells, 1px apart, in the text's ink (`currentColor`, the
 *   `foreground` token) with unlit cells at 0.2, as the Spinner's pixels.
 * - Layout A: the header is drawn first, in its final place; the cover lies over the content area
 *   only, a sibling over the frame's box (never in it, never resizing it: the box places what the
 *   frame reports, ArtifactFrame), opaque `layer-canvas`, the icon in the middle and one line under
 *   it (`text-callout`, `foreground-muted`): the stage's words, or a screen's own `label`.
 * - Nothing shows for the first ARTIFACT_SPLASH_APPEAR_AFTER_MS (the Spinner's 1-second rule): a
 *   fast open goes from nothing to the page, with no ending played. Measured from the opening
 *   (ArtifactSplashScope), not from each part's mount, so the parts handing over to each other never
 *   restart the wait or the animation.
 * - Then the icon assembles cell by cell, holds, disperses and rests, a cycle of
 *   ARTIFACT_SPLASH_CYCLE_MS; every cell jumps (`steps(1)`), only opacity moves. The phase comes
 *   from the same clock, so a cover that mounts again (stage 0 → 1 → 2 are different parts) picks
 *   the cycle up where it was.
 * - Loaded: the cells still unlit fill in within ARTIFACT_SPLASH_FILL_MS, the whole icon holds
 *   ARTIFACT_SPLASH_HOLD_MS, then the cover fades out over ARTIFACT_SPLASH_FADE_MS (`ease-out`).
 * - A failure never waits for it: the part that failed draws its own screen in its place.
 * - `prefers-reduced-motion`: the complete icon, still, with its line; loaded removes it at once.
 * - The cover is `role="status"`, named by its line ("Getting the page"); the pixels are
 *   `aria-hidden`.
 *
 * The parameters (named constants, for the native App to mirror), the icons and the clock are in
 * artifactSplash.ts.
 */

/**
 * One opening, for the splashes inside it: the shell that opens an Artifact (the viewer, the
 * Artifact's own page) wraps its parts in it, keyed by what it shows, so every part's cover counts
 * from the same moment and draws at the same size.
 */
export function ArtifactSplashScope({ openingKey, size, initialStart, children }: {
  openingKey: string;
  size?: ArtifactSplashSize;
  /** Where the wait began before this mounted (the canonical link's loading screen: artifactLinkWaitStarted). */
  initialStart?: () => number | null;
  children: ReactNode;
}) {
  const outer = useContext(SplashScopeContext);
  const startedAt = useArtifactSplashStart(openingKey, initialStart);
  const shownSize = size ?? outer?.size ?? "page";
  const value = useMemo(() => ({ startedAt, size: shownSize }), [startedAt, shownSize]);
  return <SplashScopeContext.Provider value={value}>{children}</SplashScopeContext.Provider>;
}

const canAnimate = (): boolean => typeof Element !== "undefined" && typeof Element.prototype.animate === "function";

type PixelMotion = "loop" | "still" | "settle";

/** The pixel icon. `loop` assembles and disperses; `settle` fills in what is unlit; `still` is complete. */
function SplashPixels({ icon, size, motion, startedAt }: { icon: ArtifactSplashIcon; size: ArtifactSplashSize; motion: PixelMotion; startedAt: number }) {
  const cells = artifactSplashCells(icon);
  const pixel = ARTIFACT_SPLASH_PIXEL_PX[size];
  const box = ARTIFACT_SPLASH_GRID * pixel + (ARTIFACT_SPLASH_GRID - 1) * ARTIFACT_SPLASH_GAP_PX;
  const refs = useRef<Array<HTMLSpanElement | null>>([]);
  // Without the Web Animations API, the icon is complete and still.
  const shown: PixelMotion = motion === "still" || !canAnimate() ? "still" : motion;
  useLayoutEffect(() => {
    if (shown === "still") return;
    const phase = artifactSplashPhase(startedAt, currentTimeMs());
    const running: Animation[] = [];
    cells.forEach((cell, index) => {
      const element = refs.current[index];
      if (!element) return;
      if (shown === "loop") {
        const animation = element.animate([
          { offset: 0, opacity: ARTIFACT_SPLASH_DIM_OPACITY, easing: "steps(1, end)" },
          { offset: cell.on, opacity: 1, easing: "steps(1, end)" },
          { offset: cell.off, opacity: ARTIFACT_SPLASH_DIM_OPACITY, easing: "steps(1, end)" },
          { offset: 1, opacity: ARTIFACT_SPLASH_DIM_OPACITY },
        ], { duration: ARTIFACT_SPLASH_CYCLE_MS, iterations: Infinity });
        animation.currentTime = phase;
        running.push(animation);
      } else if (!artifactSplashLitAt(cell, phase) && cell.fill > 0) {
        // Unlit when loaded: dim until its moment within ARTIFACT_SPLASH_FILL_MS, then lit (the style's 1).
        running.push(element.animate([{ opacity: ARTIFACT_SPLASH_DIM_OPACITY }, { opacity: ARTIFACT_SPLASH_DIM_OPACITY }], { duration: cell.fill }));
      }
    });
    return () => running.forEach((animation) => animation.cancel());
  }, [cells, shown, startedAt]);
  return (
    <span
      aria-hidden="true"
      className="relative grid shrink-0 text-foreground"
      style={{ width: box, height: box, gap: ARTIFACT_SPLASH_GAP_PX, gridTemplateColumns: `repeat(${ARTIFACT_SPLASH_GRID}, ${pixel}px)`, gridTemplateRows: `repeat(${ARTIFACT_SPLASH_GRID}, ${pixel}px)` }}
      data-splash-icon={icon}
      data-splash-motion={shown}
      data-testid="artifact-splash-pixels"
    >
      {cells.map((cell, index) => (
        <span
          key={`${cell.row}-${cell.col}`}
          ref={(element) => { refs.current[index] = element; }}
          className="block rounded-[1px] bg-current"
          style={{ gridRow: cell.row + 1, gridColumn: cell.col + 1, width: pixel, height: pixel, opacity: shown === "loop" ? ARTIFACT_SPLASH_DIM_OPACITY : 1 }}
        />
      ))}
    </span>
  );
}

/**
 * The cover. Its parent is `relative` and is the content area (ArtifactLoadingArea where nothing else
 * is there yet; ArtifactFrame lays it over the frame's box). `done`: what it covers has loaded; it
 * plays its ending (or goes at once) and then renders nothing.
 */
export function ArtifactLoadingSplash({ stage, kind, done = false, startedAt: ownStart, label, prerendered = false, testId = "artifact-loading-splash" }: {
  stage: ArtifactSplashStage;
  kind: ArtifactKind | null | undefined;
  done?: boolean;
  /** When this load started, where the part knows better than the opening (a retry, the link's wait). */
  startedAt?: number;
  /** The line, drawn under the icon, where the stage's isn't the one (the canonical link's screen, which says nothing yet of what it opens). */
  label?: string;
  /**
   * Static markup for the boot shell (prerenderShell): no clock and no script, so the icon (complete,
   * still) and a `label` are always drawn and the shell's CSS holds them hidden for the first
   * ARTIFACT_SPLASH_APPEAR_AFTER_MS of the page (`data-splash-static`, bootShellPlugin BOOT_SHELL_CSS).
   */
  prerendered?: boolean;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const scope = useContext(SplashScopeContext);
  const [mountedAt] = useState(currentTimeMs);
  const startedAt = ownStart ?? scope?.startedAt ?? mountedAt;
  const size = scope?.size ?? "page";
  const reduced = useMediaQuery(ARTIFACT_SPLASH_REDUCED_MOTION_QUERY);
  const appeared = useArtifactSplashAppearedAt(startedAt, done) || prerendered;
  // The ending plays only where the splash was seen and may move; otherwise loaded removes it at once.
  // The page is there under it by then: the ending takes no taps or scrolls.
  const ending = done && appeared && !reduced;
  const [end, setEnd] = useState<"filling" | "fading" | "gone">("filling");
  useEffect(() => {
    if (!ending) return;
    const fade = window.setTimeout(() => setEnd("fading"), ARTIFACT_SPLASH_FILL_MS + ARTIFACT_SPLASH_HOLD_MS);
    const gone = window.setTimeout(() => setEnd("gone"), ARTIFACT_SPLASH_FILL_MS + ARTIFACT_SPLASH_HOLD_MS + ARTIFACT_SPLASH_FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [ending]);
  if ((done && !ending) || (ending && end === "gone")) return null;
  const line = label ?? formatMessage({ id: stage === "starting" ? "artifacts.viewer.startingPage" : "artifacts.viewer.gettingPage" });
  const fading = ending && end === "fading";
  const style: CSSProperties | undefined = fading
    ? { opacity: 0, transition: `opacity ${ARTIFACT_SPLASH_FADE_MS}ms ${ARTIFACT_SPLASH_FADE_EASING}` }
    : undefined;
  return (
    <div
      role="status"
      aria-label={appeared ? line : undefined}
      className={`absolute inset-0 z-raised flex flex-col items-center justify-center gap-3.5 overflow-hidden bg-layer-canvas p-4 ${ending ? "pointer-events-none" : ""}`}
      style={style}
      data-splash-stage={stage}
      data-splash-state={!appeared ? "waiting" : ending ? end : "loading"}
      data-splash-static={prerendered ? "" : undefined}
      data-testid={testId}
    >
      {appeared ? (
        <>
          <SplashPixels icon={artifactSplashIcon(kind)} size={size} motion={reduced || prerendered ? "still" : ending ? "settle" : "loop"} startedAt={startedAt} />
          {/* The line is drawn under the icon, a stage's ("Getting the page", "Starting the page") or a screen's
              own: it says which step the opening is at, so a slow one doesn't look stuck (xxchan, Kirby; not
              helper text, so not #250's cut). */}
          <span className="text-center text-callout text-foreground-muted">{line}</span>
        </>
      ) : null}
    </div>
  );
}

/** A content area with only the splash in it: where nothing is there yet to lay it over (stage 0, a file Raft draws loading). */
export function ArtifactLoadingArea({ stage = "getting", kind, testId }: { stage?: ArtifactSplashStage; kind: ArtifactKind | null | undefined; testId?: string }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-busy="true" data-testid={testId}>
      <ArtifactLoadingSplash stage={stage} kind={kind} />
    </div>
  );
}

/**
 * The header's title while nothing is known about the Artifact (opened from a link, with no card):
 * a still placeholder in the title's place from the splash's first second on. Still, not raft-ui's
 * pulsing Skeleton: the splash is already the one loop on screen (motion.md).
 */
export function ArtifactSplashTitlePlaceholder() {
  const appeared = useArtifactSplashAppeared();
  return (
    <span className="flex h-6 w-40 min-w-0 max-w-full items-center" data-testid="artifact-splash-title-placeholder">
      {appeared ? <Skeleton variant="line" className="w-full animate-none" /> : null}
    </span>
  );
}

/** The meta line's placeholder (where it lives), as ArtifactSplashTitlePlaceholder. */
export function ArtifactSplashMetaPlaceholder() {
  const appeared = useArtifactSplashAppeared();
  return (
    <span className="flex h-[18px] w-28 min-w-0 max-w-full items-center" data-testid="artifact-splash-meta-placeholder">
      {appeared ? <Skeleton variant="line" className="w-full animate-none" /> : null}
    </span>
  );
}
