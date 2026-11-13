import { useCallback, useState } from "react";
import { currentTimeMs } from "@botiverse/raft-shared";

import { createPageOpenGate } from "./artifactPageOpenGate";
import { useCommentBoxes } from "./useCommentBoxes";
import type { CommentBoxState } from "./useCommentBoxes";

/**
 * An Artifact's comment boxes (useCommentBoxes) with one count of the page's own opens beside
 * them (artifactPageOpenGate): the person's cursor or words in any box say what the page opened
 * wasn't in their way. `reportBox` is the boxes' report, heard here on its way; `askPageOpen` is
 * asked as the page's button opens its box, in A and in comment mode alike.
 */
export function useCommentBoxesAndPageOpens() {
  const { reportBox: noteBox, ...boxes } = useCommentBoxes();
  const [gate] = useState(createPageOpenGate);
  const reportBox = useCallback((box: string, state: CommentBoxState | null) => {
    if (state && (state.words || state.focused)) gate.acted();
    noteBox(box, state);
  }, [noteBox, gate]);
  const askPageOpen = useCallback((stillOpen: boolean) => gate.ask(currentTimeMs(), stillOpen), [gate]);
  return { ...boxes, reportBox, askPageOpen };
}
