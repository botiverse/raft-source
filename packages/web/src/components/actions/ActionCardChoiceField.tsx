// A Choice field (field.choice, a question card's), in the form sheet
// (ActionCardFormSheet) and on the card itself (QuestionInlineForm,
// question-card spec §5.9): every option at once (raft-ui ChoiceList), radios
// when single, checkboxes when multiple, each option's description under it;
// Other… is the last row and, chosen, opens a one-line input under the list
// for the person's own answer (the agent's placeholder, else Raft's; at most
// its maxLength), which takes focus. Its value is `{ selected, other? }`:
// `other` is present while Other… is chosen. Not a raft-ui Field, as a picker:
// each row is named by its own label, the question names the group.
//
// A confirm (isConfirmChoice: one option, single, no Other…; a question card's
// one-option question) is not a list of one row: it is one Button with the
// option's label, the card's bordered button (`outline`, `md`, as the card's
// own submit), pressed once chosen (aria-pressed and a check before the
// label). Pressing it chooses the option and, with `advance`, moves on as a
// tapped radio does; pressed again, an optional one is taken back (a required
// one stays chosen and moves on again). Under its question, or with
// `confirmInActions` in the card's actions row.
//
// With `advance` (a question card, §5.10) a tap moves on: an option chosen by
// a click, Space or Enter (an arrow key only moves the choice, as a radio
// group does) reports `picked`; Enter in Other's input, on a chosen radio or
// on a multiple choice's boxes reports `confirmed`.

import { useCallback, useMemo, useRef } from "react";
import type { ChangeEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Check } from "lucide-react";
import { Button, Input, Label, LabelAsterisk, LabelOptional, MessageActionCardActions } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import type { ActionCardChoiceValue, ActionCardFormIssue, ActionCardFormValue, ActionCardSpecField } from "@botiverse/raft-shared";
import { NO_CHOICE, OTHER, PICKER_ERROR_CLASS, PICKER_FRAME_INVALID, PICKER_HELP_CLASS, PROBLEM_SCROLL_MARGIN, choicePending, ignoreRepeatedKey, isConfirmChoice } from "./actionCardChoice";
import { ActionCardPlainText, useActionCardMsgTextResolver } from "./ActionCardSpecRenderer";
import type { ChoiceAdvance } from "./questionAdvance";

const MARK = "[role='radio'], [role='checkbox']";
/** A ChoiceList row (raft-ui: a <label> holding the mark and the option's text). */
const ROW = "[data-slot='choice-list-item']";
/** Keys a radio group moves (and chooses) with: they don't move the form on. */
const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
/** The clicks one press makes on a row (its text, then its mark and input) come within this. */
const SAME_PRESS_MS = 100;

export function ChoiceFieldControl({ id, field, value, issue, disabled, onChange, advance, number, attempted = false, confirmInActions = false, confirmLoading = false }: {
  id: string;
  field: Extract<ActionCardSpecField, { type: "Choice" }>;
  value: ActionCardChoiceValue;
  issue: ActionCardFormIssue | null;
  disabled: boolean;
  onChange: (name: string, value: ActionCardFormValue) => void;
  /** A question card's: a tap moves on (§5.10). */
  advance?: ChoiceAdvance | null;
  /** The question's number before its text, on a card with more than one (§5.9). */
  number?: number;
  /** The person pressed submit (or Next) with this page unanswered: only then does an empty required choice say so. */
  attempted?: boolean;
  /** A confirm's button goes in the card's actions row (the card's one question, answered on the card), not under its question. */
  confirmInActions?: boolean;
  /** A confirm's button shows the wait its press started (the form is being sent). */
  confirmLoading?: boolean;
}) {
  const { formatMessage } = useIntl();
  const textOf = useActionCardMsgTextResolver();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  const lineId = `${id}-help`;
  const otherId = `${id}-other`;
  const other = field.other;
  const otherChosen = other !== undefined && value.other !== undefined;
  // What a deselected Other… had: choosing it again brings the text back.
  const otherDraft = useRef(value.other ?? "");
  const otherInput = useRef<HTMLInputElement | null>(null);
  // Other… was just chosen by a tap (not by an arrow key passing over it): its input takes focus once drawn.
  const focusOther = useRef(false);
  const otherInputRef = useCallback((element: HTMLInputElement | null) => {
    otherInput.current = element;
    if (!element || !focusOther.current) return;
    focusOther.current = false;
    element.focus();
  }, []);
  const items = useMemo<ChoiceListItem[]>(() => [
    ...field.options.map((option) => ({
      value: option.value,
      label: textOf(option.label),
      ...(option.description ? { description: textOf(option.description) } : {}),
    })),
    ...(other ? [{
      value: OTHER,
      // Marked, so a tap on it is told from a tap on an option.
      label: <span data-action-card-choice-other="">{textOf(other.label)}</span>,
      searchText: textOf(other.label),
      ...(other.description ? { description: textOf(other.description) } : {}),
    }] : []),
  ], [field.options, other, textOf]);
  const withOther = useCallback((selected: string[], chosen: boolean): ActionCardChoiceValue => (
    chosen ? { selected, other: value.other ?? otherDraft.current } : { selected }
  ), [value.other]);
  const changeSingle = useCallback((next: string) => {
    onChange(field.name, next === OTHER ? withOther([], true) : { selected: [next] });
  }, [field.name, onChange, withOther]);
  const changeMultiple = useCallback((next: string[]) => {
    // In the options' order, whatever order they were ticked in.
    const selected = field.options.map((option) => option.value).filter((option) => next.includes(option));
    onChange(field.name, withOther(selected, next.includes(OTHER)));
  }, [field.name, field.options, onChange, withOther]);
  const changeOther = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    otherDraft.current = event.target.value;
    onChange(field.name, { selected: value.selected, other: event.target.value });
  }, [field.name, onChange, value.selected]);

  // A click anywhere on a row (its mark, or its text: the row is a <label>, which passes the click on
  // to the mark and its hidden input), or Space (a click) or Enter (below) on it: a choice made.
  // Not an arrow key passing over it: the radio group moves focus in the keydown, and the radio that
  // takes it chooses itself right after (its onFocus clicks its hidden input, in the microtask after
  // the keydown). So `arrowing` is set as the arrow's keydown is captured and stays set until the next
  // pointerdown, keyup or other keydown, all captured (the group stops a moving arrow's keydown, so it
  // never bubbles back out). Captured, so `otherChosen` is still what the click changes. One press
  // reaches here as two or three clicks (the text, the mark, its input): only the first of a row counts.
  const arrowing = useRef(false);
  const lastRowClick = useRef<{ row: Element; at: number } | null>(null);
  const clickRow = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest?.(ROW);
    if (!advance || disabled || !row || arrowing.current || row.hasAttribute("data-disabled")) return;
    const now = Date.now();
    const last = lastRowClick.current;
    lastRowClick.current = { row, at: now };
    if (last && last.row === row && now - last.at < SAME_PRESS_MS) return;
    if (row.querySelector("[data-action-card-choice-other]")) {
      // Other… again while chosen: its input (a box unticked: nothing); first chosen: once it is drawn.
      if (!otherChosen) focusOther.current = true;
      else if (!field.multiple) otherInput.current?.focus();
      return;
    }
    if (!field.multiple) advance.picked(field.name);
  }, [advance, disabled, field.multiple, field.name, otherChosen]);
  const keyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    arrowing.current = ARROW_KEYS.has(event.key);
  }, []);
  const endArrowing = useCallback(() => {
    arrowing.current = false;
  }, []);
  const keyMark = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const mark = (event.target as HTMLElement).closest?.<HTMLElement>(MARK);
    // A held Enter repeats: one press is one answer.
    if (!advance || disabled || !mark || event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat) return;
    // Enter on a radio not chosen chooses it, as Space does (a click, above).
    if (mark.getAttribute("role") === "radio" && mark.getAttribute("aria-checked") !== "true") mark.click();
    else if (!otherChosen || field.multiple) advance.confirmed(field.name);
    else otherInput.current?.focus();
  }, [advance, disabled, field.multiple, field.name, otherChosen]);
  const keyOther = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    // Safari sends the Enter that confirms CJK input with isComposing false and keyCode 229.
    if (!advance || event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.repeat) return;
    advance.confirmed(field.name);
  }, [advance, field.name]);

  const confirmOption = isConfirmChoice(field) ? field.options[0]! : null;
  const confirmValue = confirmOption?.value;
  const confirmChosen = confirmValue !== undefined && value.selected.includes(confirmValue);
  const pressConfirm = useCallback(() => {
    if (confirmValue === undefined || disabled) return;
    // An optional confirm pressed again is taken back: nothing else on the form could unchoose it.
    if (confirmChosen && field.required !== true) {
      onChange(field.name, NO_CHOICE);
      return;
    }
    if (!confirmChosen) onChange(field.name, { selected: [confirmValue] });
    advance?.picked(field.name);
  }, [advance, confirmChosen, confirmValue, disabled, field.name, field.required, onChange]);

  const chosen = useMemo(() => (otherChosen ? [...value.selected, OTHER] : value.selected), [otherChosen, value.selected]);
  // A′ speaks to whoever can answer: a disabled list (someone else's question, a submit under way) says nothing.
  // And only once they tried to send it: before that, a question that opens in a warning reads as a form
  // (DS questions.md: "Choose an option first." is a correction, not an instruction).
  const pending = attempted && field.required === true && !disabled ? choicePending(value) : null;
  const common = {
    items,
    "aria-labelledby": labelId,
    disabled,
    searchLabel: formatMessage({ id: "ui.selectionPopover.searchPlaceholder" }),
    clearSearchLabel: formatMessage({ id: "search.clearSearch" }),
    className: issue ? PICKER_FRAME_INVALID : undefined,
  };
  let line: ReactNode = null;
  const describedBy = [field.description ? descriptionId : null, issue || pending ? lineId : null].filter(Boolean).join(" ") || undefined;
  if (issue) {
    line = <p id={lineId} role="alert" className={PICKER_ERROR_CLASS} data-action-card-form-issue={issue.code}><ActionCardPlainText value={issue.message} /></p>;
  } else if (pending) {
    line = (
      <p id={lineId} className={PICKER_HELP_CLASS} data-action-card-form-pending={pending}>
        {formatMessage({ id: pending === "write" ? "actionCard.question.writeFirst" : "actionCard.question.chooseFirst" })}
      </p>
    );
  }
  let confirm: ReactNode = null;
  if (confirmOption) {
    // The card's bordered button, as its submit (QuestionInlineForm); never the pink one on a card.
    // Loading, it is not natively disabled, so it keeps focus (raft-ui Button) and ignores presses itself.
    const button = (
      <Button type="button" variant="outline" size="md" className="max-w-full" loading={confirmLoading} disabled={disabled && !confirmLoading} aria-pressed={confirmChosen}
        aria-describedby={describedBy} onClick={pressConfirm} onKeyDown={ignoreRepeatedKey}
        data-invalid={issue ? true : undefined} data-action-card-choice-confirm={confirmOption.value}>
        {confirmChosen ? <Check data-icon="inline-start" aria-hidden="true" /> : null}
        <span className="min-w-0 truncate">{textOf(confirmOption.label)}</span>
      </Button>
    );
    confirm = (
      <div role="group" aria-labelledby={labelId} className="min-w-0">
        {confirmInActions ? <MessageActionCardActions>{button}</MessageActionCardActions> : button}
      </div>
    );
  }
  return (
    <div className={`flex flex-col gap-1.5 ${PROBLEM_SCROLL_MARGIN}`} data-action-card-form-field={field.name} data-invalid={issue ? true : undefined}>
      <Label render={<span id={labelId} />} className="block cursor-auto">
        {number !== undefined ? <span className="mr-1 font-mono tabular-nums after:content-['.']" data-action-card-question-number="">{number}</span> : null}
        <ActionCardPlainText value={field.label} />
        {field.required ? <LabelAsterisk className="ml-1" /> : <OptionalMark />}
      </Label>
      {field.description ? <p id={descriptionId} className={PICKER_HELP_CLASS}><ActionCardPlainText value={field.description} /></p> : null}
      {/* The question's description and its hint or issue describe the whole list (ChoiceList takes no aria-describedby). */}
      {confirm ?? (
        <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} onClickCapture={clickRow} onKeyDownCapture={keyDownCapture}
          onKeyUpCapture={endArrowing} onPointerDownCapture={endArrowing} onKeyDown={keyMark}>
          {field.multiple
            ? <ChoiceList {...common} multiple value={chosen} onValueChange={changeMultiple} />
            : <ChoiceList {...common} value={chosen[0] ?? null} onValueChange={changeSingle} />}
        </div>
      )}
      {otherChosen && other ? (
        <Input
          ref={otherInputRef}
          id={otherId}
          value={value.other ?? ""}
          onChange={changeOther}
          onKeyDown={keyOther}
          readOnly={disabled}
          maxLength={other.maxLength}
          autoComplete="off"
          aria-label={textOf(other.label)}
          aria-describedby={line ? lineId : undefined}
          data-invalid={issue ? true : undefined}
          placeholder={other.placeholder ? textOf(other.placeholder) : formatMessage({ id: "actionCard.question.otherPlaceholder" })}
          data-action-card-form-other=""
        />
      ) : null}
      {line}
    </div>
  );
}

export function OptionalMark() {
  const { formatMessage } = useIntl();
  return <LabelOptional className="ml-1">{formatMessage({ id: "ui.formField.optional" })}</LabelOptional>;
}
