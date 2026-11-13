import { useCallback, useRef } from "react";
import type { ReactNode } from "react";

import { useDismissable } from "./useArtifactDismiss";

/**
 * A comment box the person opened in place (the comment list's Reply and Edit, a draft's Edit),
 * with no card of its own to close it: on the dismissal layer (artifactDismissLayer), so a press
 * outside it in Raft leaves it (`onDismiss`) while it holds no typed words: it is empty, or an
 * edit as the comment reads. With typed words it stays open. Its Esc is the box's own and follows
 * the same rule (ArtifactCommentBox). A press in the Artifact's page is not its to hear.
 */
export function ArtifactDismissableBox({ onDismiss, children }: { onDismiss: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement | null>(null);
  const element = useCallback(() => root.current, []);
  useDismissable(true, { element, close: onDismiss, inFlow: true });
  // `contents`: no box of its own, so the card's column lays the comment box out as before.
  return <div ref={root} className="contents" data-testid="artifact-dismissable-box">{children}</div>;
}
