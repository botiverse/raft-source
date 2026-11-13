import type { ArtifactComment } from "@botiverse/raft-shared";

import { anchorOf, isShellAnchor, shellAnchorFound } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { fakeArtifactStandIns } from "./artifactSource";

/**
 * Is the place a comment points at still in what the viewer shows (E9)?
 *
 * - Lines and rows (text, csv: drawn by the shell): checked here against the
 *   shown file's lines or rows (in range, and the quote still reads the same).
 * - Places a page names (`page`, P108): the page alone knows its names;
 *   TODO(S4): the frame reports whether an element with that id is there.
 *   Until then they count as found, as annotations do.
 * - Page annotations (html, markdown, pdf in the content-origin frame):
 *   TODO(S4, Porthole P104): the frame reports whether it found each anchor.
 *   Until then they count as found, except where the fake data says the page
 *   lost them.
 * - A comment on another file, or on the whole file or Artifact: found.
 */
export function useAnchorFound(comment: ArtifactComment): boolean {
  const comments = useArtifactComments();
  const anchor = anchorOf(comment);
  if (!anchor) return true;
  if (anchor.type === "annotation" || anchor.type === "page") return !(fakeArtifactStandIns()?.annotationLost(comment.id) ?? false);
  const shell = comments?.shellUnits;
  if (!isShellAnchor(anchor) || !shell || comment.target.scope !== "file" || comment.target.path !== shell.path) return true;
  return shellAnchorFound(anchor, shell.units);
}
