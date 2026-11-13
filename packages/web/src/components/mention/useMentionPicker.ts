import { useCallback, useEffect, useId, useMemo } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useAutocomplete } from "../../hooks/useAutocomplete";
import { MENTION_TRIGGER } from "../message/autocompleteTriggers";
import type { MentionCandidate } from "../message/mentionCandidates";
import type { MentionSource } from "./mentionAudience";
import { useMentionCandidates } from "./useMentionCandidates";

/** A row of the list: the candidate and how its row is drawn. */
export interface MentionSuggestionItem {
  candidate: MentionCandidate;
  /** Drawn faded (e.g. not in this conversation). */
  muted?: boolean;
  /** A second small icon after the avatar. */
  auxiliary?: ReactNode;
  className?: string;
}

/** A labelled run of rows. Rows are numbered in list order across groups. */
export interface MentionSuggestionGroup {
  key: string;
  /** Visible heading; none when omitted. */
  label?: ReactNode;
  /** The group's accessible name (listbox mode). */
  ariaLabel?: string;
  /** A separator above, and the group's top padding. */
  separated?: boolean;
  items: MentionSuggestionItem[];
}

export interface UseMentionPickerOptions {
  source: MentionSource;
  /** Groups the ranked candidates for display. Keep it stable (useCallback). */
  group: (ranked: MentionCandidate[]) => MentionSuggestionGroup[];
  /**
   * ARIA listbox semantics, driven from the textarea (aria-activedescendant):
   * the list gets this accessible name, its rows are options. Off by default.
   */
  listboxLabel?: string;
}

/**
 * The @ picker every composer uses: it opens on `@` before the caret, ranks
 * the source's candidates as the name is typed, moves with the arrows, picks
 * with Enter or Tab, closes with Esc, and builds the text a pick inserts.
 * The composer calls `detect` as its text or caret changes, `handleKeyDown`
 * first in its key handler, and renders `MentionSuggestionList`.
 */
export function useMentionPicker({ source, group, listboxLabel }: UseMentionPickerOptions) {
  const autocomplete = useAutocomplete(MENTION_TRIGGER, "@");
  const { show, query, index, startPos, popupRef, detect, dismiss, clampIndex, buildInsert, handleKeyDown: handleAutocompleteKeyDown } = autocomplete;
  const ranked = useMentionCandidates(source, { open: show, query });
  const groups = useMemo(() => group(ranked), [group, ranked]);
  const flat = useMemo(() => groups.flatMap((g) => g.items.map((item) => item.candidate)), [groups]);
  const listId = useId();

  // Clamp the highlighted row when the list shrinks.
  useEffect(() => { clampIndex(flat.length); }, [clampIndex, flat.length]);

  const handleKeyDown = useCallback((event: KeyboardEvent, onSelect: (candidate: MentionCandidate) => void): boolean =>
    handleAutocompleteKeyDown(event, flat.length, () => {
      const item = flat[index];
      if (item) onSelect(item);
    }), [handleAutocompleteKeyDown, flat, index]);

  const visible = show && flat.length > 0;
  const optionId = (flatIndex: number) => `${listId}-option-${flatIndex}`;
  const listbox = listboxLabel === undefined ? null : {
    label: listboxLabel,
    listId,
    optionId,
    inputProps: {
      "aria-autocomplete": "list" as const,
      "aria-controls": visible ? listId : undefined,
      "aria-activedescendant": visible && flat[index] ? optionId(index) : undefined,
    },
  };

  return { show, visible, query, index, startPos, popupRef, detect, dismiss, buildInsert, handleKeyDown, groups, flat, listbox };
}

export type MentionPicker = ReturnType<typeof useMentionPicker>;
