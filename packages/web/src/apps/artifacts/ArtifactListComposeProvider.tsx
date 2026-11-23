import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useArtifactComments } from "./ArtifactCommentsContext";
import { ArtifactListComposeContext } from "./artifactListCompose";
import type { ArtifactListComposeState } from "./artifactListCompose";

/** Under ArtifactCommentsProvider: the foot box's state, for the list and for what opens it. */
export function ArtifactListComposeProvider({ children }: { children: ReactNode }) {
  const comments = useArtifactComments();
  const panelOpen = comments?.panelOpen ?? false;
  const setPanelOpen = comments?.setPanelOpen;
  const reviewShown = comments?.reviewShown ?? null;
  const showAllComments = comments?.showAllComments;
  const [compose, setCompose] = useState<ArtifactListComposeState["compose"]>(null);
  // The list closed: the words handed to its box go (React's "adjusting state when a prop changes";
  // kept, its next opening would put them in again).
  if (!panelOpen && compose !== null) setCompose(null);
  const composeKey = useRef(0);
  const open = useCallback((text: string, write: boolean) => {
    composeKey.current += 1;
    setCompose(write ? { key: composeKey.current, text, write: true } : { key: composeKey.current, text });
    setPanelOpen?.(true);
    // A list showing one review alone has no foot box (what is sent wouldn't show there): every comment.
    if (reviewShown !== null) showAllComments?.();
  }, [setPanelOpen, reviewShown, showAllComments]);
  const composeInList = useCallback((text: string) => open(text, false), [open]);
  const writeInList = useCallback(() => open("", true), [open]);
  const value = useMemo<ArtifactListComposeState>(() => ({ compose, composeInList, writeInList }), [compose, composeInList, writeInList]);
  return <ArtifactListComposeContext.Provider value={value}>{children}</ArtifactListComposeContext.Provider>;
}
