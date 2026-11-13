// What the form sheet (ActionCardFormSheet) holds while it is open: the
// values, the page of a form with steps, and the local draft that follows
// them (question-card spec §5.3, D10).
//
// A form with steps (form.steps, schemaVersion 8) shows a step a page; the
// steps only name fields of `fields`, and a step naming none this build draws
// is skipped. Fewer than two pages: one page, every field, as a form without
// steps. Given a `draftKey` (store/actionCardFormDrafts.ts), every edit and page turn
// is kept in sessionStorage while the card can be answered, and the next
// opening starts from it: each value still of its field's shape (else the
// field starts as it would), on the same page.
//
// A page turn moves focus to the new page's first field (else its "Question n
// of total" line), so neither keyboard focus falls to the page nor the
// pressed Back is left on the button that has become Cancel. A press within
// PAGE_TURN_SETTLE_MS of a turn is part of the press that turned it (the
// second click of a double click, a double tap, a held Enter) and does
// nothing: Next and the last page's submit are one button in one place.
// Watching where the press began can't tell: the second press of a double
// click begins after the page has turned.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionCardChoiceValue, ActionCardFormValue, ActionCardSpecField, ActionCardSpecForm, ActionCardSpecMsg } from "@botiverse/raft-shared";
import { readActionCardFormDraft, removeActionCardFormDraft, writeActionCardFormDraft } from "../../store/actionCardFormDrafts";
import { holdReload } from "../../utils/reloadHolds";

export type FormValues = Record<string, ActionCardFormValue>;

/** One page of the sheet: a step's title and its fields (the whole form when it has no steps). */
export interface FormPage {
  title?: ActionCardSpecMsg;
  fields: ActionCardSpecField[];
}

/** How long after a page turn a press still belongs to the one that turned it (about a double click's interval). */
export const PAGE_TURN_SETTLE_MS = 500;

export function useActionCardFormState({ steps, fields, draftKey, canSubmit }: {
  steps: ActionCardSpecForm["steps"];
  fields: ActionCardSpecField[];
  draftKey: string | null;
  /** False once the card can't be answered: the draft is no longer kept. */
  canSubmit: boolean;
}) {
  const pages = useMemo(() => formPages(steps, fields), [steps, fields]);
  const initialValues = useMemo(() => Object.fromEntries(fields.map((field) => [field.name, initialFieldValue(field)])), [fields]);
  const [restored] = useState(() => {
    const draft = draftKey ? readActionCardFormDraft(draftKey) : null;
    if (!draft) return null;
    const draftValues = Object.fromEntries(fields.map((field) => [field.name, draftFieldValue(field, draft.values[field.name]) ?? initialValues[field.name]!]));
    return { values: draftValues, page: Math.min(draft.page, pages.length - 1) };
  });
  const [values, setValues] = useState<FormValues>(restored?.values ?? initialValues);
  const [page, setPage] = useState(restored?.page ?? 0);
  const dirty = fields.some((field) => !sameValue(values[field.name], initialValues[field.name]));

  // Nothing filled in and on the first page: no draft. Returns whether a draft is kept.
  const hasDraftState = dirty || page > 0;
  const saveDraft = useCallback((): boolean => {
    if (!draftKey || !canSubmit) return false;
    if (!hasDraftState) {
      removeActionCardFormDraft(draftKey);
      return false;
    }
    return writeActionCardFormDraft(draftKey, { page, values });
  }, [canSubmit, draftKey, hasDraftState, page, values]);
  // A form filled in that no draft keeps (no draftKey, or storage refused it)
  // holds this tab from reloading itself onto a new Web release (utils/reloadSafety).
  useEffect(() => {
    const kept = saveDraft();
    return canSubmit && dirty && !kept ? holdReload() : undefined;
  }, [canSubmit, dirty, saveDraft]);

  const turnedAtRef = useRef<number | null>(null);
  const focusPendingRef = useRef(false);
  // Next, Back, or a problem on another page.
  const turnPage = useCallback((next: number) => {
    turnedAtRef.current = Date.now();
    focusPendingRef.current = true;
    setPage(next);
  }, []);
  const justTurned = useCallback(() => turnedAtRef.current !== null && Date.now() - turnedAtRef.current < PAGE_TURN_SETTLE_MS, []);
  // The ref of the page's fields (keyed by the page, so a new page's is set anew): focuses it after a turn.
  const pageRef = useCallback((element: HTMLElement | null) => {
    if (!element || !focusPendingRef.current) return;
    focusPendingRef.current = false;
    focusPageStart(element);
  }, []);

  return { pages, page, turnPage, justTurned, pageRef, values, setValues, dirty, saveDraft };
}

/**
 * What a page's start takes focus on, in its first field: a Choice's chosen
 * option, else its first; else the field's control. A list's options may not
 * have their roving tabindex yet when the page has just drawn.
 */
const PAGE_START_TARGETS = [
  "[role='radio'][aria-checked='true']",
  "[role='radio'], [role='checkbox']",
  "input:not([type='hidden']):not([aria-hidden='true']), textarea, button",
];

function focusPageStart(page: HTMLElement) {
  const field = page.querySelector<HTMLElement>("[data-action-card-form-field]");
  if (!field || !focusFieldStart(field)) page.closest("form")?.querySelector<HTMLElement>("[data-action-card-form-page]")?.focus();
}

/** Focuses a field's start (PAGE_START_TARGETS): a page's first field, or the next question after a single tap. False: nothing to focus. */
export function focusFieldStart(field: HTMLElement): boolean {
  const control = PAGE_START_TARGETS.map((selector) => field.querySelector<HTMLElement>(selector)).find(Boolean);
  control?.focus();
  return Boolean(control);
}

/** The sheet's pages: each step's fields in its order, else every field on one page. */
function formPages(steps: ActionCardSpecForm["steps"], fields: ActionCardSpecField[]): FormPage[] {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const pages = (steps ?? [])
    .map((step) => ({ ...(step.title ? { title: step.title } : {}), fields: step.fields.flatMap((name) => byName.get(name) ?? []) }))
    .filter((step) => step.fields.length > 0);
  return pages.length > 1 ? pages : [{ fields }];
}

/** A field's value when the sheet opens: the server's default (an agent's prefill), else empty. */
export function initialFieldValue(field: ActionCardSpecField): ActionCardFormValue {
  switch (field.type) {
    case "TextInput":
    case "TextArea":
    case "Select":
      return field.default ?? "";
    case "Toggle":
      return field.default ?? false;
    case "Choice":
      return field.default ? { ...field.default, selected: [...field.default.selected] } : { selected: [] };
    default:
      return (field.default ?? []).map((ref) => ref.id);
  }
}

/** A draft's value for a field, when it still has the field's shape; else null (the field starts as it would). */
function draftFieldValue(field: ActionCardSpecField, value: unknown): ActionCardFormValue | null {
  switch (field.type) {
    case "TextInput":
    case "TextArea":
    case "Select":
      return typeof value === "string" ? value : null;
    case "Toggle":
      return typeof value === "boolean" ? value : null;
    case "Choice": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const { selected, other } = value as { selected?: unknown; other?: unknown };
      if (!Array.isArray(selected) || !selected.every((item) => typeof item === "string")) return null;
      if (other !== undefined && typeof other !== "string") return null;
      return other === undefined ? { selected: [...selected] } : { selected: [...selected], other };
    }
    default:
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null;
  }
}

function sameValue(a: ActionCardFormValue | undefined, b: ActionCardFormValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((id) => b.includes(id));
  if (isChoiceValue(a) && isChoiceValue(b)) return sameValue(a.selected, b.selected) && a.other === b.other;
  return a === b;
}

export function isChoiceValue(value: ActionCardFormValue | undefined): value is ActionCardChoiceValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
