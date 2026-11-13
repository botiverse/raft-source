// "Submitted · Undo" (question-card spec §5.10): where a question card's
// submit was, while its answer waits to be sent (questionSubmitUndo.ts). No
// countdown: the wait is short and a number would only hurry the person.
//
// The Undo button takes focus when the row appears, if focus was in the form
// or had fallen to the page (the tapped radio, or the pressed submit, is
// disabled or gone while the answer waits). A key press is the rest of the
// one that submitted, and does nothing, when it repeats (a held Enter or
// Space) or comes within UNDO_SETTLE_MS of the row appearing, as does the
// second click of a double click on the submit (Undo takes its place, under
// the pointer); a single click or tap always counts (a person who clicks it
// means it). After Undo, focus returns to the form: its submit, else the
// question last answered (its chosen option, or a confirm's button).
//
// "Submitted" is said aloud through QuestionSubmitStatus, a polite live
// region mounted with the form and filled when the answer waits: a region
// mounted together with its text may not be announced. ("Not sent" is the
// form's banner, a live region: said once.)

import { useCallback, useRef } from "react";
import type { MouseEvent } from "react";
import { ignoreRepeatedKey } from "./actionCardChoice";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";

/** How long after the row appears a press still belongs to the one that submitted. */
const UNDO_SETTLE_MS = 500;

export function QuestionSubmittedUndo({ onUndo, scope, className }: {
  onUndo: () => void;
  /** The form: focus comes from it, and goes back to it after Undo. */
  scope: { readonly current: HTMLElement | null };
  className?: string;
}) {
  const { formatMessage } = useIntl();
  const shownAt = useRef(0);
  // As the button is drawn: when it appeared, and focus on it if focus was in the form or fell to the page.
  const buttonRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    shownAt.current = Date.now();
    const active = document.activeElement;
    if (!active || active === document.body || scope.current?.contains(active)) button.focus();
  }, [scope]);
  const undo = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    // Right after it appeared: a click a key made (detail 0: Enter, Space) or a double click's second
    // (detail 2+: the submit's place, under the pointer) is the press that submitted. A single click counts.
    if (event.detail !== 1 && Date.now() - shownAt.current < UNDO_SETTLE_MS) return;
    onUndo();
    // Once the form is answering again (enabled, its submit back).
    queueMicrotask(() => focusAfterUndo(scope.current));
  }, [onUndo, scope]);
  return (
    <div className={`flex min-w-0 items-center text-callout text-foreground-muted ${className ?? ""}`} data-question-submit-waiting="">
      <span>{formatMessage({ id: "actionCard.question.submitted" })}</span>
      {/* The `·` is drawn (CSS), as CommittedByLine's: punctuation, not copy, and not read aloud. */}
      <span aria-hidden="true" className="mx-1 before:content-['·']" data-question-submit-dot="" />
      <Button ref={buttonRef} type="button" variant="ghost" size="sm" onClick={undo} onKeyDown={ignoreRepeatedKey} data-question-submit-undo="">
        {formatMessage({ id: "actionCard.question.undo" })}
      </Button>
    </div>
  );
}

/** A polite live region, mounted with the form: says "Submitted" while the answer waits. */
export function QuestionSubmitStatus({ waiting }: { waiting: boolean }) {
  const { formatMessage } = useIntl();
  const text = waiting ? formatMessage({ id: "actionCard.question.submitted" }) : "";
  return <span role="status" aria-live="polite" className="sr-only" data-question-submit-status="">{text}</span>;
}

function focusAfterUndo(scope: HTMLElement | null) {
  if (!scope) return;
  const submit = scope.querySelector<HTMLButtonElement>("[data-action-card-inline-submit], [data-action-card-form-submit]");
  if (submit && !submit.disabled) {
    submit.focus();
    return;
  }
  // A confirm's button (ActionCardChoiceField) is its question's answer, as a chosen radio is.
  const chosen = [...scope.querySelectorAll<HTMLElement>("[role='radio'][aria-checked='true'], [role='checkbox'][aria-checked='true'], [data-action-card-choice-confirm][aria-pressed='true']")].at(-1);
  (chosen ?? scope.querySelector<HTMLElement>("[role='radio'], [role='checkbox'], [data-action-card-choice-confirm]"))?.focus();
}
