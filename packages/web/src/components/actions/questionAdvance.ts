// A question card answered one tap at a time (question-card spec §5.10), the
// same in the sheet and on the card (§5.9): a single choice tapped (a click,
// Space or Enter on an option; an arrow key only moves) is shown chosen for
// CHOICE_PICK_HIGHLIGHT_MS, then the next question takes focus; after the
// last one, the form submits (in a paged sheet: the page's last question
// turns the page, as Next does). Other… chosen waits for its typed answer:
// Enter in it, or Enter on a multiple choice's boxes, moves on at once. The
// submit is the form's own, so A′ and the client checks still hold it.

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ActionCardFormValue } from "@botiverse/raft-shared";
import { focusFieldStart, isChoiceValue } from "./actionCardFormState";

/** How long a tapped option shows chosen before the form moves on, so the person sees what they tapped. */
export const CHOICE_PICK_HIGHLIGHT_MS = 150;

/** What a Choice reports to move on: an option tapped (after the highlight), or an answer confirmed (at once). */
export interface ChoiceAdvance {
  picked: (name: string) => void;
  confirmed: (name: string) => void;
}

export function useQuestionAdvance({ fieldNames, values, container, submit }: {
  /** The questions shown, in order (a paged sheet: this page's). */
  fieldNames: readonly string[];
  values: Record<string, ActionCardFormValue>;
  /** Holds the questions' boxes (data-action-card-form-field). */
  container: { readonly current: HTMLElement | null };
  /** After the last question: the form's submit (in a paged sheet, Next). */
  submit: () => void;
}): ChoiceAdvance {
  const latest = useRef({ fieldNames, values, submit });
  latest.current = { fieldNames, values, submit };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const advance = useCallback((name: string) => {
    const { fieldNames: names, submit: submitNow } = latest.current;
    const index = names.indexOf(name);
    // A question no longer shown (the page turned meanwhile): nothing to do.
    if (index < 0) return;
    const next = names[index + 1];
    if (next === undefined) {
      submitNow();
      return;
    }
    const box = [...(container.current?.querySelectorAll<HTMLElement>("[data-action-card-form-field]") ?? [])]
      .find((candidate) => candidate.getAttribute("data-action-card-form-field") === next);
    if (box) focusFieldStart(box);
  }, [container]);

  const picked = useCallback((name: string) => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      // Other… chosen: the person is typing their own answer.
      const value = latest.current.values[name];
      if (isChoiceValue(value) && value.other !== undefined) return;
      advance(name);
    }, CHOICE_PICK_HIGHLIGHT_MS);
  }, [advance, cancel]);
  const confirmed = useCallback((name: string) => {
    cancel();
    advance(name);
  }, [advance, cancel]);
  return useMemo(() => ({ picked, confirmed }), [confirmed, picked]);
}
