// What a Choice field (field.choice, a question card's) shares between the
// form sheet (ActionCardFormSheet) and the card it is answered on
// (QuestionInlineForm, question-card spec §5.9): what an unanswered Choice
// still lacks (A′, §5.3), and the classes of the lines under a field.

import { ACTION_CARD_CHOICE_RESERVED_VALUE } from "@botiverse/raft-shared";
import type { ActionCardChoiceValue, ActionCardFormValue, ActionCardSpecField } from "@botiverse/raft-shared";
import { isChoiceValue } from "./actionCardFormState";

/** The ChoiceList value of Other…: the reserved option value no option may take. */
export const OTHER = ACTION_CARD_CHOICE_RESERVED_VALUE;
export const NO_CHOICE: ActionCardChoiceValue = { selected: [] };

/** What a scrolled-to problem keeps above it: the dialog body's top inset. */
export const PROBLEM_SCROLL_MARGIN = "scroll-mt-4";
// A label's help or error line outside a raft-ui Field (a picker, a Choice):
// the Field recipe's type and colours, by hand.
export const PICKER_HELP_CLASS = "wrap-anywhere text-caption text-foreground-hint";
export const PICKER_ERROR_CLASS = "wrap-anywhere text-caption font-semibold text-danger-strong";
export const PICKER_FRAME_INVALID = "border-danger-strong";

/** Blank as checkActionCardFormValues reads it (shared actionCardSpec BLANK, the same characters): nothing but whitespace. */
const BLANK = /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/;

/**
 * What a Choice still lacks before it can be answered (A′): `choose` while
 * nothing is chosen, `write` while Other… is chosen and empty; null once it
 * has an answer. Only a required Choice holds the submit back.
 */
export function choicePending(value: ActionCardFormValue | undefined): "choose" | "write" | null {
  const choice: ActionCardChoiceValue = isChoiceValue(value) ? value : NO_CHOICE;
  if (choice.other !== undefined && BLANK.test(choice.other)) return "write";
  return choice.selected.length === 0 && choice.other === undefined ? "choose" : null;
}

/**
 * Whether a Choice is a confirm: a single one of exactly one option and no
 * Other… (a question card's one-option question, shared isQuestionAskConfirm
 * and questionField). There is nothing to choose between, so it is drawn as
 * one button with the option's label instead of a list of one row.
 */
export function isConfirmChoice(field: Extract<ActionCardSpecField, { type: "Choice" }>): boolean {
  return !field.multiple && field.options.length === 1 && field.other === undefined;
}

/** A′ over some fields: a required Choice among them still unanswered. */
export function hasPendingChoice(fields: readonly ActionCardSpecField[], values: Record<string, ActionCardFormValue>): boolean {
  return fields.some((field) => field.type === "Choice" && field.required === true && choicePending(values[field.name]) !== null);
}

/**
 * Whether tapping an option answers the whole form (question-card spec
 * §5.10): its one question is a single Choice and Other… isn't chosen (a typed
 * answer keeps the confirm button). Such a form shows no submit button.
 */
export function tapSubmitsForm(fields: readonly ActionCardSpecField[], values: Record<string, ActionCardFormValue>): boolean {
  const only = fields.length === 1 ? fields[0]! : null;
  if (!only || only.type !== "Choice" || only.multiple) return false;
  const value = values[only.name];
  return !(isChoiceValue(value) && value.other !== undefined);
}

/**
 * A held key repeats (OS key repeat, from about 500 ms): on a question card's
 * submit or Undo its repeats press nothing, so holding Enter is one press
 * (it doesn't submit, undo, submit again).
 */
export function ignoreRepeatedKey(event: { repeat: boolean; preventDefault: () => void }): void {
  if (event.repeat) event.preventDefault();
}

const PROBLEM_FIELD = "[data-action-card-form-issue], [data-action-card-form-pending]";
const FOCUSABLE = "[role=radio][tabindex='0'], [role=radio]:not([tabindex='-1']), [role=checkbox], button[data-action-card-choice-confirm]:not([disabled]), input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [role=combobox]";

/**
 * After a submit that sent nothing, focus the first field that says why (its
 * error or "Choose an option first."), so a screen reader reads the line its
 * control's aria-describedby points at. A form-wide notice is a live region and
 * takes no focus. Returns whether it moved focus.
 */
export function focusFirstProblem(form: HTMLElement | null): boolean {
  const line = form?.querySelector(PROBLEM_FIELD);
  const field = line?.closest<HTMLElement>("[data-action-card-form-field]");
  const control = field?.querySelector<HTMLElement>(FOCUSABLE);
  if (!control) return false;
  control.focus({ preventScroll: true });
  return true;
}

/** The first required Choice of `fields` still unanswered, by name (focusFieldControl). */
export function firstPendingChoice(fields: readonly ActionCardSpecField[], values: Record<string, ActionCardFormValue>): string | null {
  const field = fields.find((candidate) => candidate.type === "Choice" && candidate.required === true && choicePending(values[candidate.name]) !== null);
  return field ? field.name : null;
}

/** Focus a field's first control by name (it is drawn before its line is). */
export function focusFieldControl(form: HTMLElement | null, name: string | null): void {
  if (!form || name === null) return;
  const field = [...form.querySelectorAll<HTMLElement>("[data-action-card-form-field]")].find((node) => node.dataset.actionCardFormField === name);
  field?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
}
