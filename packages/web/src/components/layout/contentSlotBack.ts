import { createContext, useContext } from "react";

/**
 * Back for a conversation opened from Activity on a phone, where it is a page
 * pushed in place of the list. It closes the opened slot and returns to the
 * list, so the conversation's header Back stays inside Activity rather than
 * leaving for the chat home. Provided only there; null everywhere else, where
 * a surface keeps its own Back.
 */
export const ContentSlotBackContext = createContext<(() => void) | null>(null);

export function useContentSlotBack(): (() => void) | null {
  return useContext(ContentSlotBackContext);
}
