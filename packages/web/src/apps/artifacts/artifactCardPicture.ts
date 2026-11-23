import { useMemo, useState } from "react";
import type { ArtifactCard, ArtifactExcerptBlock } from "@botiverse/raft-shared";

import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useArtifactImageSrc } from "./artifactImageSrc";
import { PHONE_QUERY } from "./artifactPhoneHistory";
import { artifactScreenshotFile, useArtifactScreenshotSrc } from "./artifactScreenshot";

/**
 * A publisher cover is a file of the Artifact (`{ kind: "image", path }`):
 * its bytes come from Raft's API at an address built from the card's id,
 * version and that path, shown only as an inline image type.
 */
function coverPathOf(card: ArtifactCard): string | null {
  return card.preview.kind === "image" && card.preview.path ? card.preview.path : null;
}

/**
 * What useArtifactCardPicture draws: a `blob:` URL (null with `loading`, while a
 * screenshot's place is kept), or the text of an `excerpt` and the blocks it has
 * (src null; drawn by ArtifactCardExcerpt, as text nodes and nothing else).
 */
export interface ArtifactCardPicture {
  src: string | null;
  screenshot: boolean;
  loading?: boolean;
  /** The card said it has a picture that couldn't be read: its place stays (an empty box), so nothing moves. */
  unreadable?: boolean;
  excerpt?: string;
  excerptBlocks?: readonly ArtifactExcerptBlock[] | undefined;
}

/**
 * The picture a card shows, on the home page's tile (ArtifactTile) and in a
 * message (ArtifactMessageCard) alike (design D4, D13): the publish check's
 * screenshot of the version it shows (the phone shot on a phone when there is
 * one; artifactScreenshot.ts), else a publisher's cover, read only without a
 * screenshot, else a Markdown version's excerpt, which reads nothing. Null
 * without any of them and when it can't be read: no spinner, no error. Until a screenshot or a cover is read, `src` is null and `loading` true;
 * one that can't be read is `unreadable`. Either way the card keeps the
 * picture's place (a message card growing or shrinking as it arrives would
 * move the conversation; #proj-uiux:#1311).
 *
 * With the picture, the ref of the element that stands for the card on screen
 * (the card itself, the tile's cover): its screenshot is read only once that
 * comes near the screen (useArtifactScreenshotSrc, #proj-workspace:#182).
 */
export function useArtifactCardPicture(card: ArtifactCard): [picture: ArtifactCardPicture | null, ref: (element: HTMLElement | null) => void] {
  const phone = useMediaQuery(PHONE_QUERY);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const { src: screenshot, loading } = useArtifactScreenshotSrc(card, phone, target);
  const coverPath = artifactScreenshotFile(card, phone) === null ? coverPathOf(card) : null;
  const cover = useArtifactImageSrc(useMemo(
    () => (coverPath ? { id: card.id, version: card.version, path: coverPath } : null),
    [card.id, card.version, coverPath],
  ));
  if (screenshot) return [{ src: screenshot, screenshot: true }, setTarget];
  if (loading) return [{ src: null, screenshot: true, loading: true }, setTarget];
  // A screenshot the card names that couldn't be read keeps its place, as one still loading does (#proj-uiux:#1311).
  if (artifactScreenshotFile(card, phone) !== null) return [{ src: null, screenshot: true, unreadable: true }, setTarget];
  if (cover) return [{ src: cover, screenshot: false }, setTarget];
  // A publisher's cover keeps its place while it is read and when it can't be (#proj-uiux:#1311).
  if (coverPath) return [{ src: null, screenshot: false, ...(cover === null ? { loading: true } : { unreadable: true }) }, setTarget];
  // One kind at a time from the server, so an excerpt never waits for or replaces a picture.
  return [card.preview.kind === "excerpt" && card.preview.text ? { src: null, screenshot: false, excerpt: card.preview.text, excerptBlocks: card.preview.blocks } : null, setTarget];
}
