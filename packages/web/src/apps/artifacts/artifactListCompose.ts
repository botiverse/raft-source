import { createContext, useCallback, useContext, useRef } from "react";
import type { RefObject } from "react";

import { useMediaQuery } from "../../hooks/effectPrimitives";

import type { ArtifactCommentTarget } from "./ArtifactCommentsContext";
import { TOUCH_QUERY } from "./ArtifactReviewContext";

/** The list's foot box's own target: the whole Artifact. */
export const LIST_ON_ARTIFACT: ArtifactCommentTarget = { scope: "artifact" };

/**
 * The comment list's foot box (ListComposer in ArtifactCommentsPanel): words handed to it. It always posts on the whole
 * Artifact (LIST_ON_ARTIFACT; #proj-workspace:#250: no target picker); a file or a place is commented on from the page.
 */
export interface ArtifactListComposeState {
  /**
   * Words for it (Doesn't display well here's lines, #proj-workspace:#243), new for each ask (`key`),
   * the box putting each in once; null once the list closes. While set, the foot box is there in
   * comment mode too.
   */
  compose: { key: number; text: string } | null;
  /**
   * Open the list (the phone's comments sheet), as Show All Comments does, with its foot box focused,
   * `text` after the words it holds (useArtifactDisplayReport).
   */
  composeInList: (text: string) => void;
}

/** ArtifactListComposeProvider's. */
export const ArtifactListComposeContext = createContext<ArtifactListComposeState | null>(null);

export function useArtifactListCompose(): ArtifactListComposeState | null {
  return useContext(ArtifactListComposeContext);
}

/**
 * The phone's comments sheet's first focus (its `initialFocus`): the foot box, in the sheet's content
 * (`sheetRef`), where the list was opened to write in it (`compose`); else the sheet's own default.
 * Never the box on touch (focus plan rule 5: a focused field opens the keyboard over half the sheet;
 * the person taps into it to write), as ArtifactFilterCombobox's list.
 */
export function useListComposeFocus(): { sheetRef: RefObject<HTMLDivElement | null>; initialFocus: () => HTMLElement | true } {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const composing = useArtifactListCompose()?.compose != null;
  const coarse = useMediaQuery(TOUCH_QUERY);
  const initialFocus = useCallback(
    () => (composing && !coarse ? sheetRef.current?.querySelector<HTMLElement>("[data-testid='artifact-list-composer'] textarea") ?? true : true),
    [composing, coarse],
  );
  return { sheetRef, initialFocus };
}
