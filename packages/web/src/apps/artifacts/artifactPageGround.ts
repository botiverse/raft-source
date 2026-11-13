import { useLayoutEffect, useState } from "react";
import { ARTIFACT_PAGE_CARD_MIN_WIDTH_PX } from "@botiverse/raft-shared/src/artifactPageTheme";

/**
 * The ground a Markdown Artifact's page shows around its document, as a Raft layer token: what the
 * margin of comment cards beside the page paints, so the page and its margin read as one surface
 * and not two pages side by side (#proj-workspace:#245, xxchan). The cards keep their own
 * `layer-card` (raft-ui CommentCard) and sit on it as the document's card does.
 *
 * The page is the content Worker's template (packages/content-worker/src/markdown.ts), drawn in
 * Raft's colours as the host's theme sends them (useArtifactPageTheme): from
 * ARTIFACT_PAGE_CARD_MIN_WIDTH_PX wide its document is a `layer-card` card on the `layer-sidebar`
 * ground (`data-raft-card`, the attachment Markdown preview's look); narrower, it is on
 * `layer-canvas` with no card. Every theme, light and dark, keeps its sidebar apart from its card
 * (raft-ui themes.css), which is what the template checks before it draws the card, so its width
 * is all that decides here. The tokens resolve on the host as the page's variables were read
 * (the server's theme, the mode), so the margin follows a theme change with the page, by CSS.
 *
 * The page's word is never read: no colour comes from the frame. A frame of unknown width (not laid
 * out yet, or no layout at all) is on the canvas, the template's ground at its narrowest.
 */
export type ArtifactPageGround = "sidebar" | "canvas";

/** The ground of a Markdown page whose frame is `width` px wide (null: not measured). */
export function markdownPageGround(width: number | null): ArtifactPageGround {
  return width !== null && width >= ARTIFACT_PAGE_CARD_MIN_WIDTH_PX ? "sidebar" : "canvas";
}

/** The raft-ui utility that paints a ground. */
export const PAGE_GROUND_CLASS: Readonly<Record<ArtifactPageGround, string>> = {
  sidebar: "bg-layer-sidebar",
  canvas: "bg-layer-canvas",
};

/**
 * The ground of the Markdown page `page` holds (the element the frame fills), watched for a new
 * width while `watching`. Read as it is laid out, then on each resize; no ResizeObserver, read once.
 */
export function useMarkdownPageGround(page: HTMLElement | null, watching: boolean): ArtifactPageGround {
  const [ground, setGround] = useState<ArtifactPageGround>("canvas");
  useLayoutEffect(() => {
    if (!page || !watching) return;
    const read = () => {
      const width = page.getBoundingClientRect().width;
      setGround(markdownPageGround(width > 0 ? width : null));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(page);
    return () => observer.disconnect();
  }, [page, watching]);
  return ground;
}
