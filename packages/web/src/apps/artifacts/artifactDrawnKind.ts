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

/**
 * Whether what the viewer shows is full-bleed media, cut on a hard line where a clipped column
 * ends rather than faded (index.css Rule 2, `data-clip-edge="cut"`; raft-design spacing.md
 * "Edges fade", #proj-raft-ui:#270): an HTML page or a PDF in the frame, or an image. A Markdown
 * page (a document, read as text), a csv, text and No preview fade like the rest of the column.
 * `entry`: the file shown is the version's entry (drawn by `entryKind`), else it is `fileKind`'s,
 * as ArtifactContent draws it.
 */
export function cutsAtClipEdge(entryKind: ArtifactKind, fileKind: ArtifactKind | null, entry: boolean): boolean {
  const shown = entry || fileKind === null ? entryKind : fileKind;
  if (!entry && fileKind !== null && !isArtifactDrawnKind(fileKind) && !opensInFrame(entryKind, fileKind)) return false;
  return shown === "html" || shown === "pdf" || shown === "image";
}
