import { useCallback, useMemo, useState } from "react";

/**
 * What a comment box says of itself (ArtifactCommentBox): whether it holds the person's own words,
 * has focus, is the list's foot box (`standing`: always there, so its being open says nothing), and
 * is in the open thread's card (`inCard`).
 */
export interface CommentBoxState {
  words: boolean;
  focused: boolean;
  standing: boolean;
  inCard: boolean;
}

const same = (a: CommentBoxState, b: CommentBoxState) => a.words === b.words && a.focused === b.focused && a.standing === b.standing && a.inCard === b.inCard;

/**
 * The comment boxes of one Artifact's comments (ArtifactCommentsProvider), by box id, as each says:
 * state, so the surface hears when the last one empties or loses focus.
 *
 * - `holdsOwnWords`: some box holds the person's own words.
 * - `boxEngaged`: some box is focused, or open on the person's act (a reply's, an edit's, a card's:
 *   any but the list's foot), even empty: words spoken into it may not have landed yet
 *   (#proj-workspace:#144). Either keeps a newer version behind its strip (useFollowLatest).
 * - `cardBoxBusy`: the open thread card's box holds words or focus: the card stays when the page
 *   says its passage is gone.
 */
export function useCommentBoxes() {
  const [boxes, setBoxes] = useState<ReadonlyMap<string, CommentBoxState>>(() => new Map());
  const reportBox = useCallback((box: string, state: CommentBoxState | null) => setBoxes((current) => {
    const was = current.get(box);
    if (state ? was && same(was, state) : !was) return current;
    const next = new Map(current);
    if (state) next.set(box, state);
    else next.delete(box);
    return next;
  }), []);
  return useMemo(() => {
    const states = [...boxes.values()];
    return {
      reportBox,
      holdsOwnWords: states.some((b) => b.words),
      boxEngaged: states.some((b) => b.focused || !b.standing),
      cardBoxBusy: states.some((b) => b.inCard && (b.words || b.focused)),
    };
  }, [boxes, reportBox]);
}
