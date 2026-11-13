// The generic form sheet of an `open_form` button (form.v1, shared
// actionCardSpec.ts): the server describes the form, this lays its fields out
// in order and submits them through execute. New form cards need no client
// change; a new field type does (and a `field.*` capability).
//
// Raft Design System: a dialog with several fields, a sheet on a phone
// (raft-ui Dialog + DialogSheetContent: the commit moves to the head, × is
// Cancel); labels above, help or the error under each field; required fields
// take the asterisk, optional ones "(optional)". Checks run on submit, not
// while typing (Forms › Validation): the client's are only required and
// lengths (checkActionCardFormValues), the server's come back as 422 issues
// under their field, or in an orange banner for the whole form, as does any
// other failure. The values stay as typed through every failure, including
// a 409 when someone else completed the card first. Closing with edits asks
// first. A form with submitLabels names the choice on its submit button
// ("Approve this call" / "Deny this call") once its Select has one. A Choice
// (field.choice, a question card's) lays every option out as radios or
// checkboxes (ActionCardChoiceField), its Other… last, opening a one-line input.
// Nothing is chosen at first, so a required Choice not yet answered disables
// the submit with a line under it saying what is missing (question-card spec
// §5.3, A′): "Choose an option first.", or with Other… chosen and empty,
// "Write your answer first.".
//
// A form with steps pages (question-card spec §5.3): a step a page under
// "Question {n} of {total}", Next checking only that page (A′ holds it as it
// holds the submit), Back keeping every value, one submit on the last page;
// a problem elsewhere turns to its page. With a `draftKey`, a local draft
// (actionCardFormState.ts) means closing asks nothing.
//
// A question card's form (`question`, spec §5.10): a single choice tapped
// moves on (questionAdvance.ts: the next question, the next page, or the
// submit), a lone single choice has no submit button until Other… is chosen,
// and a submit waits 1.5 s with "Submitted · Undo" before it is sent
// (questionSubmitUndo.ts); closing the sheet meanwhile sends it at once.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Banner,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogBody,
  DialogClose,
  DialogCommit,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSheetBack,
  DialogSheetContent,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldItem,
  FieldLabel,
  Input,
  Label,
  LabelAsterisk,
  ScrollArea,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@botiverse/raft-ui";
import { ComboboxSelect } from "@botiverse/raft-ui/wip";
import { ACTION_CARD_SPEC_LIMITS, checkActionCardFormValues } from "@botiverse/raft-shared";
import type {
  ActionCardFormIssue,
  ActionCardFormSubmission,
  ActionCardFormValue,
  ActionCardSpecEntityRef,
  ActionCardSpecField,
  ActionCardSpecForm,
  ActionCardSpecMsg,
  ActionCardSpecUnsupportedField,
} from "@botiverse/raft-shared";
import type { Channel } from "../../store/channelStore";
import ChannelPicker, { useChannelPickerCandidates } from "../pickers/ChannelPicker";
import MemberPicker, { useMemberPickerCandidates } from "../pickers/MemberPicker";
import type { MemberKind, MemberPickerCandidate } from "../pickers/MemberPicker";
import type { ActionCardFormSubmitFailure } from "./actionCardCommon";
import { removeActionCardFormDraft } from "../../store/actionCardFormDrafts";
import { initialFieldValue, isChoiceValue, useActionCardFormState } from "./actionCardFormState";
import { NO_CHOICE, PICKER_ERROR_CLASS, PICKER_FRAME_INVALID, PICKER_HELP_CLASS, PROBLEM_SCROLL_MARGIN, focusFirstProblem, hasPendingChoice, ignoreRepeatedKey, tapSubmitsForm } from "./actionCardChoice";
import { ChoiceFieldControl, OptionalMark } from "./ActionCardChoiceField";
import { useQuestionAdvance } from "./questionAdvance";
import type { ChoiceAdvance } from "./questionAdvance";
import { QuestionSubmitStatus, QuestionSubmittedUndo } from "./QuestionSubmittedUndo";
import { useUndoableSubmit } from "./questionSubmitUndo";
import { ActionCardPlainText, useActionCardMsgText, useActionCardMsgTextResolver } from "./ActionCardSpecRenderer";

type PickerField = Extract<ActionCardSpecField, { type: "MemberPicker" | "ChannelPicker" | "AgentPicker" }>;

/** What the sheet shows at the top: a failure, or that someone else completed the card. */
type Notice = { kind: "failed"; message: string } | { kind: "already_executed"; by: string | null };

interface Props {
  formId: string;
  form: ActionCardSpecForm<ActionCardSpecField | ActionCardSpecUnsupportedField>;
  /** The card's channel: a member picker's `scope: "channel"`. */
  channelId: string;
  /** False once the card is done, frozen or out of this viewer's hands: the commit is disabled. */
  canSubmit: boolean;
  /** Executes with the form; resolves null on success, else why it failed (the card applied what it could). */
  submit: (submission: ActionCardFormSubmission, options?: { leaving?: boolean }) => Promise<ActionCardFormSubmitFailure | null>;
  /** `submitted`: closed by a successful submit, not dismissed. */
  onClose: (submitted: boolean) => void;
  /**
   * Where the sheet keeps its local draft (actionCardFormDraftKey), or none:
   * then closing with edits asks first, as it always did.
   */
  draftKey?: string | null;
  /** A question card's form: a tap moves on, a submit can be undone (spec §5.10). */
  question?: boolean;
}

export function ActionCardFormSheet({ formId, form, channelId, canSubmit, submit, onClose, draftKey = null, question = false }: Props) {
  const { formatMessage } = useIntl();
  const baseId = useId();
  // Strip leaves an open_form only when every field is one this build renders.
  const fields = useMemo(() => form.fields.filter((field): field is ActionCardSpecField => field.type !== "unsupported"), [form]);
  // The values, the page, and the local draft that follows them (actionCardFormState.ts).
  const { pages, page, turnPage, justTurned, pageRef, values, setValues, dirty, saveDraft } = useActionCardFormState({ steps: form.steps, fields, draftKey, canSubmit });
  const paged = pages.length > 1;
  const [issues, setIssues] = useState<readonly ActionCardFormIssue[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A question card's answer the card changed under while it waited (froze): not sent; the banner (a live region) says so.
  const notSentText = formatMessage({ id: "actionCard.question.notSent" });
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Counts failed submits: after each, the first problem is scrolled into view.
  const [failedSubmits, setFailedSubmits] = useState(0);
  // The page whose Next or submit was pressed with a required choice still empty: its empty ones say so.
  const [attemptedPage, setAttemptedPage] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // A second submit before the first one's state renders (a double click, Enter then click) sends nothing.
  const inFlightRef = useRef(false);

  // The body may be scrolled past the banner or the field in error (a phone
  // sheet reveals a new banner itself; a desktop dialog doesn't). Only a
  // target not already in full view moves, and it keeps the body's inset
  // (PROBLEM_SCROLL_MARGIN on the banner and each field).
  useEffect(() => {
    if (failedSubmits === 0) return;
    const problem = formRef.current?.querySelector("[data-action-card-form-notice], [data-action-card-form-issue], [data-action-card-form-pending]");
    const target = problem?.closest<HTMLElement>("[data-action-card-form-notice], [data-action-card-form-field]");
    if (target && !isFullyInView(target)) target.scrollIntoView?.({ block: "nearest" });
    focusFirstProblem(formRef.current);
  }, [failedSubmits]);

  const lastPage = page === pages.length - 1;
  const pageFields = pages[page]!.fields;
  const fieldNames = new Set(fields.map((field) => field.name));
  const issueFor = (name: string) => issues.find((issue) => issue.field === name) ?? null;
  // A problem with the whole form: no field, or a name this form doesn't have.
  const formIssues = issues.filter((issue) => issue.field === null || !fieldNames.has(issue.field));
  const title = useActionCardMsgText(form.title);
  // The submit button says what pressing does once the labelled Select has a choice (submitLabels).
  const labelled = form.submitLabels;
  const chosen = labelled ? values[labelled.field] : undefined;
  const chosenLabel = labelled && typeof chosen === "string" && Object.hasOwn(labelled.labels, chosen) ? labelled.labels[chosen] : undefined;
  const submitLabel = useActionCardMsgText(chosenLabel ?? form.submitLabel);
  const formElementId = `${baseId}-form`;
  const backLabel = formatMessage({ id: "actionCard.question.back" });
  // A′: a required Choice of this page still unanswered (nothing chosen, or
  // Other… chosen and empty) holds Next or the submit back.
  const pendingChoice = hasPendingChoice(pageFields, values);
  // A lone single choice answers the form when tapped: no submit to press (§5.10).
  const tapSubmits = question && tapSubmitsForm(fields, values);

  // The first page with a problem under one of its fields (none: the page stays, the banner says it).
  const showIssues = useCallback((next: readonly ActionCardFormIssue[]) => {
    setIssues(next);
    const first = pages.findIndex((candidate) => candidate.fields.some((field) => next.some((issue) => issue.field === field.name)));
    if (first >= 0 && first !== page) turnPage(first);
  }, [page, pages, turnPage]);

  // Sends the checked values (after the undo wait, for a question card's).
  const send = useCallback(async (submission: ActionCardFormSubmission, leaving: boolean) => {
    setSubmitting(true);
    inFlightRef.current = true;
    const failure = await submit(submission, { leaving });
    inFlightRef.current = false;
    if (!failure) {
      if (draftKey) removeActionCardFormDraft(draftKey);
      onClose(true);
      return;
    }
    setSubmitting(false);
    // "Verify it's you" closed: the sheet stays as it was, with no failure.
    if (failure.kind === "cancelled") return;
    if (failure.kind === "card_changed") {
      setNotice({ kind: "failed", message: notSentText });
      return;
    }
    setFailedSubmits((count) => count + 1);
    if (failure.kind === "invalid") showIssues(failure.issues);
    else if (failure.kind === "already_executed") setNotice({ kind: "already_executed", by: failure.metadata.executedByUserName ?? null });
    else setNotice(failure);
  }, [draftKey, notSentText, onClose, showIssues, submit]);
  const sendLater = useUndoableSubmit(send, question, canSubmit);
  const busy = submitting || sendLater.waiting;
  const advanced = useQuestionAdvance({ fieldNames: pageFields.map((field) => field.name), values, container: formRef, submit: () => formRef.current?.requestSubmit() });
  // A tap within a page turn's settle time is the rest of the press that turned it: it chooses, nothing more.
  const advance = useMemo<ChoiceAdvance | null>(() => (question ? {
    picked: (name) => { if (!justTurned()) advanced.picked(name); },
    confirmed: advanced.confirmed,
  } : null), [advanced, justTurned, question]);

  const setValue = useCallback((name: string, value: ActionCardFormValue) => {
    if (busy) return;
    setValues((current) => ({ ...current, [name]: value }));
    // An edited field's error goes; the next submit checks again.
    setIssues((current) => current.filter((issue) => issue.field !== name));
  }, [busy, setValues]);

  const requestClose = useCallback(() => {
    // Closing while an answer waits for Undo sends it now; the sheet closes once it is in.
    if (sendLater.waiting) {
      sendLater.flush();
      return;
    }
    if (submitting) return;
    // A kept draft is not lost by closing: nothing to confirm.
    if (dirty && !saveDraft()) setConfirmDiscard(true);
    else onClose(false);
  }, [dirty, onClose, saveDraft, sendLater, submitting]);
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) requestClose();
  }, [requestClose]);


  const goBack = useCallback(() => {
    if (!busy && page > 0) turnPage(page - 1);
  }, [busy, page, turnPage]);

  // Enter in a field and the commit both come here: Next before the last page, the submit on it.
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // justTurned: the rest of the press that turned the page (a double click on Next is not a submit).
    if (inFlightRef.current || busy || !canSubmit || justTurned()) return;
    if (pendingChoice) {
      // One press shows every problem of the page: each empty required choice says so
      // (attemptedPage), and the page's other fields their own errors.
      setAttemptedPage(page);
      const names = new Set(pageFields.map((field) => field.name));
      const choices = new Set(pageFields.filter((field) => field.type === "Choice").map((field) => field.name));
      const others = checkActionCardFormValues({ ...form, fields: pageFields }, values, { mode: "client" })
        .filter((issue) => issue.field === null || !choices.has(issue.field));
      setIssues((current) => [...current.filter((issue) => issue.field === null || !names.has(issue.field)), ...others]);
      setFailedSubmits((count) => count + 1);
      return;
    }
    if (!lastPage) {
      // Next checks only this page; the problems of other pages stay as they were.
      const names = new Set(pageFields.map((field) => field.name));
      const pageIssues = checkActionCardFormValues({ ...form, fields: pageFields }, values, { mode: "client" });
      setIssues((current) => [...current.filter((issue) => issue.field === null || !names.has(issue.field)), ...pageIssues]);
      if (pageIssues.length > 0) {
        setFailedSubmits((count) => count + 1);
        return;
      }
      turnPage(page + 1);
      return;
    }
    const clientIssues = checkActionCardFormValues(form, values, { mode: "client" });
    showIssues(clientIssues);
    setNotice(null);
    if (clientIssues.length > 0) {
      setFailedSubmits((count) => count + 1);
      return;
    }
    sendLater.start({ id: formId, values });
  }, [busy, canSubmit, form, formId, justTurned, lastPage, page, pageFields, pendingChoice, sendLater, showIssues, turnPage, values]);

  const handleDiscardOpenChange = useCallback((open: boolean) => {
    if (!open) setConfirmDiscard(false);
  }, []);
  const handleDiscard = useCallback(() => {
    setConfirmDiscard(false);
    onClose(false);
  }, [onClose]);

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogSheetContent data-action-card-form={formId}>
        <DialogHeader>
          {paged && page > 0 ? <DialogSheetBack aria-label={backLabel} disabled={busy} onClick={goBack} /> : null}
          <DialogTitle className="min-w-0 break-words">{title}</DialogTitle>
          <DialogClose aria-label={formatMessage({ id: "common.close" })} />
        </DialogHeader>
        <form ref={formRef} id={formElementId} className="contents" onSubmit={handleSubmit} noValidate>
          <DialogBody className="grid gap-4">
            {paged ? (
              <p className={PICKER_HELP_CLASS} aria-live="polite" tabIndex={-1} data-action-card-form-page={page + 1}>
                {formatMessage({ id: "actionCard.question.page" }, { n: page + 1, total: pages.length })}
              </p>
            ) : null}
            {form.description ? (
              <DialogDescription><ActionCardPlainText value={form.description} /></DialogDescription>
            ) : null}
            {notice || formIssues.length > 0 ? (
              <Banner status="warning" size="sm" role="alert" className={PROBLEM_SCROLL_MARGIN} data-action-card-form-notice={notice?.kind ?? "issues"}>
                {notice?.kind === "already_executed"
                  ? formatMessage(
                    { id: notice.by ? "actionCard.form.alreadySubmitted" : "actionCard.form.alreadySubmittedUnknown" },
                    { user: notice.by ?? "" },
                  )
                  : notice?.kind === "failed"
                    ? notice.message
                    : formIssues.map((issue, index) => (
                      <span key={index} className="block"><ActionCardPlainText value={issue.message} /></span>
                    ))}
              </Banner>
            ) : null}
            <div key={page} ref={pageRef} className="contents" data-action-card-form-step={page + 1}>
              {paged && pages[page]!.title ? <StepTitle value={pages[page]!.title!} /> : null}
              {pageFields.map((field) => (
                <FormFieldControl
                  key={field.name}
                  id={`${baseId}-${field.name}`}
                  field={field}
                  value={values[field.name] ?? initialFieldValue(field)}
                  issue={issueFor(field.name)}
                  channelId={channelId}
                  disabled={busy}
                  onChange={setValue}
                  advance={advance}
                  attempted={attemptedPage === page}
                />
              ))}
            </div>
          </DialogBody>
          <DialogFooter>
            {question ? <QuestionSubmitStatus waiting={sendLater.waiting} /> : null}
            {sendLater.waiting ? <QuestionSubmittedUndo onUndo={sendLater.undo} scope={formRef} className="mr-auto" /> : null}
            {sendLater.waiting ? null : paged && page > 0 ? (
              <Button type="button" variant="ghost" size="lg" disabled={submitting} onClick={goBack} data-action-card-form-back="">
                {backLabel}
              </Button>
            ) : (
              <Button type="button" variant="ghost" size="lg" disabled={submitting} onClick={requestClose}>
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
            )}
            {/* A lone single choice has none to press, but shows the spinner while its answer is sent. */}
            {sendLater.waiting || (tapSubmits && !submitting) ? null : (
              <DialogCommit
                type="submit"
                variant="primary"
                size="lg"
                form={formElementId}
                loading={submitting}
                disabled={!canSubmit}
                onKeyDown={ignoreRepeatedKey}
                data-action-card-form-submit=""
              >
                {lastPage ? submitLabel : formatMessage({ id: "actionCard.question.next" })}
              </DialogCommit>
            )}
          </DialogFooter>
        </form>
        <AlertDialog open={confirmDiscard} onOpenChange={handleDiscardOpenChange}>
          <AlertDialogContent data-action-card-form-discard="">
            <AlertDialogHeader>
              <AlertDialogTitle>{formatMessage({ id: "message.chatPanel.overflow.unsavedTitle" })}</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogBody>{formatMessage({ id: "agent.detail.editProfile.discardBody" })}</AlertDialogBody>
            <AlertDialogFooter>
              <AlertDialogCancel size="lg">{formatMessage({ id: "message.chatPanel.overflow.keepEditing" })}</AlertDialogCancel>
              <AlertDialogAction variant="danger" size="lg" onClick={handleDiscard}>
                {formatMessage({ id: "message.chatPanel.overflow.discardChanges" })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogSheetContent>
    </Dialog>
  );
}

/** Whether `element` is wholly inside its scrolling ancestor's visible box. */
function isFullyInView(element: HTMLElement): boolean {
  let scroller = element.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (!scroller) return true;
  const box = element.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return box.top >= view.top && box.bottom <= view.bottom;
}

function StepTitle({ value }: { value: ActionCardSpecMsg }) {
  return <p className="wrap-anywhere text-body font-semibold" data-action-card-form-step-title=""><ActionCardPlainText value={value} /></p>;
}

interface ControlProps {
  id: string;
  field: ActionCardSpecField;
  value: ActionCardFormValue;
  issue: ActionCardFormIssue | null;
  channelId: string;
  disabled: boolean;
  onChange: (name: string, value: ActionCardFormValue) => void;
  /** A question card's Choice: a tap moves on (questionAdvance.ts). */
  advance: ChoiceAdvance | null;
  /** Next or submit was pressed on this page with a required choice still empty. */
  attempted: boolean;
}

/** One field: its label (asterisk or "(optional)"), the control, then its help or its error. */
function FormFieldControl({ id, field, value, issue, channelId, disabled, onChange, advance, attempted }: ControlProps) {
  const invalid = issue !== null;
  const helpId = `${id}-help`;
  const help = <FieldHelp id={helpId} issue={issue} description={field.description} />;
  const describedBy = issue || field.description ? helpId : undefined;
  const placeholder = useOptionalMsgText(field.placeholder);
  const label = <FormFieldLabel htmlFor={id} label={field.label} required={field.type === "Toggle" ? undefined : field.required ?? false} />;

  switch (field.type) {
    case "TextInput":
    case "TextArea":
      return (
        <Field invalid={invalid} className={PROBLEM_SCROLL_MARGIN} data-action-card-form-field={field.name}>
          {label}
          <TextFieldControl id={id} field={field} value={typeof value === "string" ? value : ""} placeholder={placeholder} invalid={invalid}
            disabled={disabled} describedBy={describedBy} onChange={onChange} />
          {help}
        </Field>
      );
    case "Select":
      return (
        <Field invalid={invalid} className={PROBLEM_SCROLL_MARGIN} data-action-card-form-field={field.name}>
          {label}
          <SelectFieldControl id={id} field={field} value={typeof value === "string" ? value : ""} placeholder={placeholder} invalid={invalid}
            disabled={disabled} describedBy={describedBy} onChange={onChange} />
          {help}
        </Field>
      );
    case "Toggle":
      // A yes or no saved with the form is a checkbox, not a switch (DS Forms › Settings saved together).
      return (
        <Field invalid={invalid} className={PROBLEM_SCROLL_MARGIN} data-action-card-form-field={field.name}>
          <FieldItem>
            <ToggleFieldControl id={id} name={field.name} checked={value === true} disabled={disabled} describedBy={describedBy} onChange={onChange} />
            {label}
          </FieldItem>
          {help}
        </Field>
      );
    case "Choice":
      return <ChoiceFieldControl id={id} field={field} value={isChoiceValue(value) ? value : NO_CHOICE} issue={issue} disabled={disabled} onChange={onChange} advance={advance} attempted={attempted} />;
    default:
      return <PickerFieldControl id={id} field={field} value={Array.isArray(value) ? value : NO_IDS} issue={issue} channelId={channelId}
        disabled={disabled} onChange={onChange} />;
  }
}

const NO_IDS: string[] = [];
const AGENT_KINDS: readonly MemberKind[] = ["agent"];

interface TextControlProps {
  id: string;
  field: Extract<ActionCardSpecField, { type: "TextInput" | "TextArea" }>;
  value: string;
  placeholder: string | undefined;
  invalid: boolean;
  disabled: boolean;
  describedBy: string | undefined;
  onChange: (name: string, value: ActionCardFormValue) => void;
}

/** No native maxLength: an over-long value stays visible and its error says the limit. */
function TextFieldControl({ id, field, value, placeholder, invalid, disabled, describedBy, onChange }: TextControlProps) {
  const change = useCallback((event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(field.name, event.target.value), [field.name, onChange]);
  const common = { id, value, onChange: change, placeholder, readOnly: disabled, "aria-describedby": describedBy, "data-invalid": invalid || undefined };
  return field.type === "TextInput"
    ? <Input {...common} autoComplete="off" />
    : <Textarea {...common} rows={field.rows ?? 4} />;
}

function ToggleFieldControl({ id, name, checked, disabled, describedBy, onChange }: {
  id: string;
  name: string;
  checked: boolean;
  disabled: boolean;
  describedBy: string | undefined;
  onChange: (name: string, value: ActionCardFormValue) => void;
}) {
  const change = useCallback((next: boolean) => onChange(name, next), [name, onChange]);
  return <Checkbox id={id} checked={checked} disabled={disabled} aria-describedby={describedBy} onCheckedChange={change} />;
}

function FormFieldLabel({ htmlFor, label, required }: { htmlFor: string; label: ActionCardSpecMsg; required: boolean | undefined }) {
  return (
    <FieldLabel htmlFor={htmlFor} required={required === true || undefined}>
      <ActionCardPlainText value={label} />
      {required === false ? <OptionalMark /> : null}
    </FieldLabel>
  );
}

/** The line under a field: its error while it has one, else its help text. */
function FieldHelp({ id, issue, description }: { id: string; issue: ActionCardFormIssue | null; description: ActionCardSpecMsg | undefined }) {
  if (issue) return <FieldError match id={id} data-action-card-form-issue={issue.code}><ActionCardPlainText value={issue.message} /></FieldError>;
  if (description) return <FieldDescription id={id}><ActionCardPlainText value={description} /></FieldDescription>;
  return null;
}

function useOptionalMsgText(msg: ActionCardSpecMsg | undefined): string | undefined {
  const text = useActionCardMsgText(msg ?? "");
  return msg ? text : undefined;
}

/** DS Select: one of up to 10 values; past that, the searchable ComboboxSelect. */
const SELECT_MAX_OPTIONS = 10;
/** No choice: an empty value, and the None item (Base UI's null) of an optional Select. */
const NONE = "";

function SelectFieldControl({ id, field, value, placeholder, invalid, disabled, describedBy, onChange }: {
  id: string;
  field: Extract<ActionCardSpecField, { type: "Select" }>;
  value: string;
  placeholder: string | undefined;
  invalid: boolean;
  disabled: boolean;
  describedBy: string | undefined;
  onChange: (name: string, value: ActionCardFormValue) => void;
}) {
  const { formatMessage } = useIntl();
  const textOf = useActionCardMsgTextResolver();
  const optional = !field.required;
  const noneLabel = formatMessage({ id: "actionCard.form.none" });
  // The trigger shows the chosen option's label as text; an optional field starts on None.
  const options = useMemo(() => field.options.map((option) => ({ value: option.value, label: textOf(option.label) })), [field.options, textOf]);
  const items = useMemo(() => (optional ? [{ value: null, label: noneLabel }, ...options] : options), [noneLabel, optional, options]);
  const change = useCallback((next: string | number | null) => onChange(field.name, next === null ? NONE : String(next)), [field.name, onChange]);
  const placeholderText = placeholder ?? formatMessage({ id: "actionCard.form.selectPlaceholder" });
  const comboboxMessages = useMemo(() => ({ clear: formatMessage({ id: "ui.selectionPopover.clear" }) }), [formatMessage]);

  if (field.options.length > SELECT_MAX_OPTIONS) {
    // An optional one clears with the combobox's own ×, not a None row.
    return (
      <ComboboxSelect
        id={id}
        options={options}
        value={value === NONE ? null : value}
        onValueChange={change}
        disabled={disabled}
        clearable={optional}
        placeholder={placeholderText}
        status={invalid ? "error" : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        emptyContent={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
        messages={comboboxMessages}
        showArrow
        autoHighlight
      />
    );
  }
  return (
    <Select
      chrome="field"
      value={value === NONE ? null : value}
      onValueChange={change}
      items={items}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-describedby={describedBy} data-invalid={invalid || undefined}>
        {/* An optional Select shows None when empty; a required one asks to choose. */}
        <SelectValue placeholder={optional ? noneLabel : placeholderText} />
        <SelectIcon />
      </SelectTrigger>
      <SelectContent>
        <SelectList>
          {items.map((item) => (
            <SelectItem key={item.value ?? "none"} value={item.value}>
              <SelectItemText>{item.label}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

/**
 * A picker field over the viewer's own stores (no extra request). A default
 * the viewer's stores don't hold (not visible to them, or a channel roster
 * still loading) is listed under its server name, so it can be seen and
 * unticked before it is sent; the server checks every id.
 */
function PickerFieldControl({ id, field, value, issue, channelId, disabled, onChange }: {
  id: string;
  field: PickerField;
  value: string[];
  issue: ActionCardFormIssue | null;
  channelId: string;
  disabled: boolean;
  onChange: (name: string, value: ActionCardFormValue) => void;
}) {
  const change = useCallback((next: string[]) => onChange(field.name, next), [field.name, onChange]);
  const invalid = issue !== null;
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const describedBy = issue || field.description ? helpId : undefined;
  let help: ReactNode = null;
  if (issue) {
    help = <p id={helpId} role="alert" className={PICKER_ERROR_CLASS} data-action-card-form-issue={issue.code}><ActionCardPlainText value={issue.message} /></p>;
  } else if (field.description) {
    help = <p id={helpId} className={PICKER_HELP_CLASS}><ActionCardPlainText value={field.description} /></p>;
  }
  return (
    // Not a raft-ui Field: inside one, every row's checkbox or radio would be named by the field's
    // label (Base UI), not by its row. The label names the group instead.
    <div className={`flex flex-col gap-1.5 ${PROBLEM_SCROLL_MARGIN}`} data-action-card-form-field={field.name} data-invalid={invalid || undefined}>
      <Label render={<span id={labelId} />} className="block cursor-auto">
        <ActionCardPlainText value={field.label} />
        {field.required ? <LabelAsterisk className="ml-1" /> : <OptionalMark />}
      </Label>
      {field.type === "ChannelPicker" ? (
        <ChannelPickerField field={field} value={value} invalid={invalid} disabled={disabled} labelId={labelId} describedBy={describedBy} onChange={change} />
      ) : (
        <MemberPickerField field={field} value={value} invalid={invalid} channelId={channelId} disabled={disabled} labelId={labelId}
          describedBy={describedBy} onChange={change} />
      )}
      {help}
    </div>
  );
}

function MemberPickerField({ field, value, invalid, channelId, disabled, labelId, describedBy, onChange }: {
  field: Extract<ActionCardSpecField, { type: "MemberPicker" | "AgentPicker" }>;
  value: string[];
  invalid: boolean;
  channelId: string;
  disabled: boolean;
  labelId: string;
  describedBy: string | undefined;
  onChange: (next: string[]) => void;
}) {
  const noneLabel = useIntl().formatMessage({ id: "actionCard.form.none" });
  const kinds: readonly MemberKind[] = field.type === "AgentPicker" ? AGENT_KINDS : field.kinds;
  const candidates = useMemberPickerCandidates(field.type === "MemberPicker" && field.scope === "channel" ? { scope: "channel", channelId } : { scope: "server" });
  const listed = useMemo(() => {
    const known = new Set(candidates.map((candidate) => candidate.id));
    const unresolved = (field.default ?? []).filter((ref) => !known.has(ref.id)).flatMap((ref): MemberPickerCandidate[] => {
      const kind = memberKindOf(ref);
      return kind ? [{ kind, id: ref.id, name: ref.fallback, secondary: null, avatarUrl: null }] : [];
    });
    return [...candidates, ...unresolved].filter((candidate) => kinds.includes(candidate.kind));
  }, [candidates, field.default, kinds]);
  if (listed.length === 0) return <PickerEmpty field={field} />;
  return (
    <MemberPicker
      presentation="selectable"
      candidates={listed}
      kinds={kinds}
      value={value}
      onChange={onChange}
      {...(field.multiple
        ? { multiple: true as const, maxItems: field.maxItems ?? ACTION_CARD_SPEC_LIMITS.maxPickerItems }
        : { multiple: false as const, ...(field.required ? {} : { noneLabel }) })}
      disabled={disabled}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      className={invalid ? PICKER_FRAME_INVALID : undefined}
    />
  );
}

function memberKindOf(ref: ActionCardSpecEntityRef): MemberKind | null {
  if (ref.kind === "user") return "human";
  return ref.kind === "agent" ? "agent" : null;
}

function ChannelPickerField({ field, value, invalid, disabled, labelId, describedBy, onChange }: {
  field: Extract<ActionCardSpecField, { type: "ChannelPicker" }>;
  value: string[];
  invalid: boolean;
  disabled: boolean;
  labelId: string;
  describedBy: string | undefined;
  onChange: (next: string[]) => void;
}) {
  const noneLabel = useIntl().formatMessage({ id: "actionCard.form.none" });
  const candidates = useChannelPickerCandidates(field.scope);
  const listed = useMemo(() => {
    const known = new Set(candidates.map((channel) => channel.id));
    const unresolved = (field.default ?? []).filter((ref) => ref.kind === "channel" && !known.has(ref.id))
      .map((ref): Channel => ({ id: ref.id, name: ref.fallback, description: null, type: "channel", createdAt: "" }));
    return [...candidates, ...unresolved];
  }, [candidates, field.default]);
  if (listed.length === 0) return <PickerEmpty field={field} />;
  const picker = field.multiple ? (
    <div role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
      <ChannelPicker channels={listed} value={value} onChange={onChange} multiple maxItems={field.maxItems ?? ACTION_CARD_SPEC_LIMITS.maxPickerItems} disabled={disabled} />
    </div>
  ) : (
    <ChannelPicker channels={listed} value={value} onChange={onChange} multiple={false} single="radio" disabled={disabled}
      {...(field.required ? {} : { noneLabel })} aria-labelledby={labelId} aria-describedby={describedBy} />
  );
  // The card is the frame (max height, border); the rows scroll in a raft-ui
  // ScrollArea that fills it, padded on its content. The rows take focus. It
  // sits in the form's scroller, so a scroll at its end carries on (auto).
  return (
    <Card className={`max-h-72 ${invalid ? PICKER_FRAME_INVALID : ""}`}>
      <ScrollArea tabIndex={-1} overscroll="auto" className="min-h-0 flex-1" contentClassName="p-1">{picker}</ScrollArea>
    </Card>
  );
}

function PickerEmpty({ field }: { field: PickerField }) {
  const { formatMessage } = useIntl();
  return (
    <Card className="p-3 text-callout text-foreground-hint" data-action-card-form-empty="">
      {field.emptyText ? <ActionCardPlainText value={field.emptyText} /> : formatMessage({ id: "actionCard.form.pickerEmpty" })}
    </Card>
  );
}
