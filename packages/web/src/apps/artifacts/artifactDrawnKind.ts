import { isArtifactFramedKind } from "@botiverse/raft-shared";
import type { ArtifactFramedKind, ArtifactKind } from "@botiverse/raft-shared";

/** The kinds Raft draws itself from the entry file's own bytes: no frame, no content origin. */
export type ArtifactDrawnKind = "image" | "csv" | "text";

export const isArtifactDrawnKind = (kind: ArtifactKind): kind is ArtifactDrawnKind => kind === "image" || kind === "csv" || kind === "text";

/**
 * Whether a file that isn't the entry opens in the version's frame, at its own page
 * (#proj-workspace:#272): an HTML page, a Markdown file or a PDF, of a version whose entry is
 * framed. The content origin opens a version only when its entry is a page, so a file beside an
 * entry Raft draws itself (a csv, text, an image) has no preview.
 */
export function opensInFrame(entryKind: ArtifactKind, fileKind: ArtifactKind): fileKind is ArtifactFramedKind {
  return isArtifactFramedKind(fileKind) && isArtifactFramedKind(entryKind);
}
