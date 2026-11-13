// A question card answered on the card itself (question-card spec §5.9, the
// form's `placement: "inline"`, which the server gives only 1-3 short choice
// questions): each question in the body, numbered when there are several,
// over its options (ActionCardChoiceField: radios or checkboxes, Other… last,
// opening a one-line input), then the card's one button, the label of the
// button that would open the sheet ("Answer Question(s)"), which submits the
// form through execute as the sheet does. No pages, no Back or Next.
//
// The sheet's rules hold: A′ disables the button with "Choose an option
// first." / "Write your answer first." under the question; the client checks
// and a 422 put each issue under its question, anything else in a banner;
// the choices are kept as the sheet's draft (same key, actionCardFormState),
// so they survive a scroll away or a reload. A tap moves on (§5.10,
// questionAdvance.ts): to the next question, or after the last one it
// submits; a lone single choice has no button until Other… is chosen. A
// question of one option is a confirm: one button with the option's label
// (ActionCardChoiceField), in the card's actions row when it is the card's
// only question (where the submit would be), else under its question. A
// submit waits 1.5 s with "Submitted · Undo" (questionSubmitUndo.ts). Someone
// other than the person asked sees the options disabled and no button (the
// header says whom the card waits for). Answered, the card is rebuilt
// without a form and this is no longer drawn.

import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { FormEvent, ReactNode } from "react";
import { Button, MessageActionCardActions } from "@botiverse/raft-ui";
import { checkActionCardFormValues } from "@botiverse/raft-shared";
import type { ActionCardFormIssue, ActionCardFormSubmission, ActionCardFormValue } from "@botiverse/raft-shared";
import { removeActionCardFormDraft } from "../../store/actionCardFormDrafts";
import Banner from "../ui/Banner";
import type { ActionCardFormSubmitFailure } from "./actionCardCommon";
import { NO_CHOICE, firstPendingChoice, focusFieldControl, hasPendingChoice, ignoreRepeatedKey, isConfirmChoice, tapSubmitsForm } from "./actionCardChoice";
import { ChoiceFieldControl } from "./ActionCardChoiceField";
import { isChoiceValue, useActionCardFormState } from "./actionCardFormState";
import type { InlineQuestionForm } from "./actionCardTreeParts";
import { ActionCardPlainText, useActionCardMsgText } from "./ActionCardSpecRenderer";
import { useQuestionAdvance } from "./questionAdvance";
import { QuestionSubmitStatus, QuestionSubmittedUndo } from "./QuestionSubmittedUndo";
import { useUndoableSubmit } from "./questionSubmitUndo";

interface Props {
  inline: InlineQuestionForm;
  /** Whether this viewer may answer now (the person asked, the card open): else the options are disabled. */
  canSubmit: boolean;
  /** Whether the button is drawn at all: not for someone else than the person asked (spec §3.1). */
  showSubmit: boolean;
  /** Executes with the form; resolves null on success, else why it failed (the card applied what it could). */
  submit: (submission: ActionCardFormSubmission, options?: { leaving?: boolean }) => Promise<ActionCardFormSubmitFailure | null>;
  /** Where the choices are kept (actionCardFormDraftKey, the sheet's), or none. */
  draftKey: string | null;
}

export function QuestionInlineForm({ inline, canSubmit, showSubmit, submit, draftKey }: Props) {
  const { formId, form, fields } = inline;
  const baseId = useId();
  // One page whatever the steps say: the card never pages.
  const { values, setValues } = useActionCardFormState({ steps: undefined, fields, draftKey, canSubmit });
  const [issues, setIssues] = useState<readonly ActionCardFormIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // A second submit before the first one's state renders sends nothing.
  const inFlightRef = useRef(false);
  // Pressed submit with a required choice still empty: from then on, each empty one says so.
  const [attempted, setAttempted] = useState(false);
  // A field to focus once the render that draws its line has committed (see handleSubmit).
  const focusAfterDraw = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusAfterDraw.current === null) return;
    focusFieldControl(formRef.current, focusAfterDraw.current);
    focusAfterDraw.current = null;
  });
  const label = useActionCardMsgText(inline.buttonLabel);
  const fieldNames = useMemo(() => fields.map((field) => field.name), [fields]);
  const formIssues = issues.filter((issue) => issue.field === null || !fieldNames.includes(issue.field));

  // An answer the card changed under while it waited (froze, then thawed): not sent; the banner (a live region) says so.
  const notSentText = useIntl().formatMessage({ id: "actionCard.question.notSent" });
  const send = useCallback(async (submission: ActionCardFormSubmission, leaving: boolean) => {
    setSubmitting(true);
    inFlightRef.current = true;
    const failure = await submit(submission, { leaving });
    inFlightRef.current = false;
    setSubmitting(false);
    if (!failure) {
      // The card is answered now: it draws its summary instead of this.
      if (draftKey) removeActionCardFormDraft(draftKey);
      return;
    }
    // "Verify it's you" closed: as it was. Someone else answered first: the card says who.
    if (failure.kind === "cancelled" || failure.kind === "already_executed") return;
    if (failure.kind === "invalid") setIssues(failure.issues);
    else setNotice(failure.kind === "card_changed" ? notSentText : failure.message);
  }, [draftKey, notSentText, submit]);
  // No Undo while the card can't be answered (ended, frozen); the frame won't send it then (card_changed).
  const sendLater = useUndoableSubmit(send, true, canSubmit);
  const busy = submitting || sendLater.waiting;
  const pendingChoice = hasPendingChoice(fields, values);
  const tapSubmits = tapSubmitsForm(fields, values);
  const advance = useQuestionAdvance({ fieldNames, values, container: formRef, submit: () => formRef.current?.requestSubmit() });

  const setValue = useCallback((name: string, value: ActionCardFormValue) => {
    if (busy || !canSubmit) return;
    setValues((current) => ({ ...current, [name]: value }));
    setIssues((current) => current.filter((issue) => issue.field !== name));
  }, [busy, canSubmit, setValues]);

  // The button, Enter in Other's input on the last question, or a tap on the last single choice.
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlightRef.current || busy || !canSubmit) return;
    // A required choice still empty: say which, send nothing.
    if (pendingChoice) {
      // Focus the first unanswered question once its line is drawn, so its control
      // already names the line in aria-describedby: a screen reader reads the
      // description when focus lands, not when it changes later (Jasper, #13748).
      const first = firstPendingChoice(fields, values);
      if (attempted) focusFieldControl(formRef.current, first);
      else {
        focusAfterDraw.current = first;
        setAttempted(true);
      }
      return;
    }
    const clientIssues = checkActionCardFormValues(form, values, { mode: "client" });
    setIssues(clientIssues);
    setNotice(null);
    if (clientIssues.length > 0) return;
    sendLater.start({ id: formId, values });
  }, [attempted, busy, canSubmit, fields, form, formId, pendingChoice, sendLater, values]);

  // The card's one question is a confirm: its button is the card's button, and shows the send's wait itself.
  const loneConfirm = fields.length === 1 && isConfirmChoice(fields[0]!);
  let footer: ReactNode = null;
  if (showSubmit && sendLater.waiting) {
    footer = <QuestionSubmittedUndo onUndo={sendLater.undo} scope={formRef} />;
  } else if (showSubmit && !loneConfirm && (!tapSubmits || submitting)) {
    // Primary is the ink-edged default style, as the card's other buttons (ActionCardSpecCard).
    footer = (
      <MessageActionCardActions>
        <Button type="submit" variant="outline" size="md" className="max-w-full" loading={submitting} disabled={!canSubmit || busy}
          onKeyDown={ignoreRepeatedKey}
          data-action-card-inline-submit="">
          <span className="min-w-0 truncate">{label}</span>
        </Button>
      </MessageActionCardActions>
    );
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate className="flex min-w-0 flex-col gap-4" data-action-card-inline-form={formId}>
      {notice || formIssues.length > 0 ? (
        <Banner intent="warning" density="sm" data-action-card-form-notice="">
          {notice ?? formIssues.map((issue, index) => <span key={index} className="block"><ActionCardPlainText value={issue.message} /></span>)}
        </Banner>
      ) : null}
      <QuestionSubmitStatus waiting={sendLater.waiting} />
      {fields.map((field, index) => {
        const value = values[field.name];
        return (
          <ChoiceFieldControl
            key={field.name}
            id={`${baseId}-${field.name}`}
            field={field}
            value={isChoiceValue(value) ? value : NO_CHOICE}
            issue={issues.find((issue) => issue.field === field.name) ?? null}
            disabled={busy || !canSubmit}
            onChange={setValue}
            advance={canSubmit ? advance : null}
            number={fields.length > 1 ? index + 1 : undefined}
            attempted={attempted}
            confirmInActions={loneConfirm}
            confirmLoading={loneConfirm && submitting}
          />
        );
      })}
      {footer}
    </form>
  );
}
