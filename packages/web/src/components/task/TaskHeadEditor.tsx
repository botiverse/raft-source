import { TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from "@botiverse/raft-shared";
import { Banner, BannerDescription, Button, Field, FieldError, Input, Textarea } from "@botiverse/raft-ui";
import { Pencil, TriangleAlert } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, FocusEvent, KeyboardEvent, Ref } from "react";
import { useIntl } from "react-intl";

import { useTaskStore } from "../../store/taskStore";
import type { Task, TaskAmendInput } from "../../store/taskStore";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import Tooltip from "../ui/Tooltip";

/**
 * Editing a task's title and description in the task head (#wg-task-v2:#22), over
 * PATCH /tasks/:id (useTaskStore.amendTask). The server is the authority on
 * who may edit; the head only offers the pencil to people the shared rule
 * allows (authorizeTaskAction "amend"), and shows the server's word otherwise.
 *
 * The draft never goes away on a failed save: a refused, stale or failed write
 * leaves what was typed on screen with the reason under it, so nothing typed is
 * lost to a race or a dropped connection.
 */

export type TaskHeadEditField = "title" | "description";

/** Revealed when the pointer is over the field or focus is in it; always
 *  shown where there is no hover (touch), as CopyIconButton's HUD idle tone. */
const EDIT_BUTTON_REVEAL_CLASS =
  "-my-1 shrink-0 text-foreground-hint opacity-0 transition-opacity hover:text-foreground group-hover/head-field:opacity-100 group-focus-within/head-field:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

/** The pencil beside the title or the description (an icon button with its name
 *  as tooltip and accessible label). */
export function TaskHeadEditButton({ label, onClick, buttonRef, testId }: {
  label: string;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  testId: string;
}) {
  return (
    <Tooltip content={label}>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon-md"
        aria-label={label}
        onClick={onClick}
        className={EDIT_BUTTON_REVEAL_CLASS}
        data-testid={testId}
      >
        <Pencil aria-hidden />
      </Button>
    </Tooltip>
  );
}

type EditProblem =
  | { kind: "titleRequired" }
  | { kind: "stale" }
  | { kind: "failed"; message: string | null };

/** A 409 for a lost revision race carries `currentRevision` (PATCH
 *  /tasks/:id); any other 409 (a legacy card) does not. */
function staleRevisionOf(err: unknown): { stale: false } | { stale: true; revision: number | undefined } {
  if (getApiErrorResponse(err)?.status !== 409) return { stale: false };
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (!data || typeof data !== "object" || !("currentRevision" in data)) return { stale: false };
  const revision = (data as { currentRevision?: unknown }).currentRevision;
  return { stale: true, revision: typeof revision === "number" ? revision : undefined };
}

/** The text of the field being edited, as the task has it now. */
function fieldValueOf(task: Task, field: TaskHeadEditField): string {
  return field === "title" ? task.title.trim() : (task.description ?? "").trim();
}

/** An IME composing a word keeps its Enter (Safari sends it with keyCode 229). */
function isComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * The title (one line) or the description (a text area) being edited, in
 * place (raft-design tasks.md, Editing a task). Enter saves either; in the
 * description Shift+Enter is a new line. Leaving the field saves too. Esc
 * cancels, putting the text back as it was, without closing the dialog around
 * it. There are no Save / Cancel buttons; refusals and the stale warning show
 * under the field, which stays in edit mode with the draft.
 *
 * Someone else's edit is caught by the field itself, not by the revision
 * (status and assignee changes move the revision too): the field's text when
 * editing opened is the base, and a save finding the task's text no longer the
 * base says so and sends nothing. Saving again after that replaces their text.
 * The revision still goes along, so a race the socket has not yet reported
 * comes back as a 409 and the same warning.
 *
 * `onClose(restoreFocus)` runs after a save (or a save with nothing to send)
 * and on Esc; `restoreFocus` is whether the field still had focus, so focus
 * goes back to the pencil only when it was not taken elsewhere.
 */
export function TaskHeadFieldEditor({ task, field, onClose }: {
  task: Task;
  field: TaskHeadEditField;
  onClose: (restoreFocus: boolean) => void;
}) {
  const { formatMessage } = useIntl();
  const amendTask = useTaskStore((s) => s.amendTask);
  const [draft, setDraft] = useState(() => (field === "title" ? task.title : task.description ?? ""));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<EditProblem | null>(null);
  // The field's text this edit started from (see above). null: the server
  // said someone else got there first (a 409) and the store may not have their
  // text yet, so the next save takes whatever the task has then as the base.
  const baseRef = useRef<string | null>(fieldValueOf(task, field));
  // After a lost race, the revision the server reported: saving again is
  // against what is there now (the store's copy may not have caught up yet).
  const retryRevisionRef = useRef<number | undefined>(undefined);
  // A write in flight, and the edit being over (saved or cancelled): a blur
  // from the field going away, or from Enter's save, must not save again.
  const busyRef = useRef(false);
  const closedRef = useRef(false);
  const controlRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  // Focus goes to the field with the caret at the end of the text, ready to type.
  useLayoutEffect(() => {
    const control = controlRef.current;
    if (!control) return;
    control.focus();
    const end = control.value.length;
    control.setSelectionRange(end, end);
  }, []);

  const close = useCallback(() => {
    closedRef.current = true;
    const control = controlRef.current;
    onClose(Boolean(control) && control === control?.ownerDocument.activeElement);
  }, [onClose]);

  const save = useCallback(async () => {
    if (busyRef.current || closedRef.current) return;
    const value = draft.trim();
    const current = fieldValueOf(task, field);
    if (field === "title" && !value) {
      setProblem({ kind: "titleRequired" });
      return;
    }
    const base = baseRef.current ?? current;
    // Nothing of ours to write: unchanged, or already what the task says.
    if (value === base || value === current) {
      close();
      return;
    }
    if (current !== base) {
      // Someone else changed this field since the edit opened: say so and
      // let the person decide. The next save is against their text.
      baseRef.current = current;
      setProblem({ kind: "stale" });
      return;
    }
    baseRef.current = current;
    const patch: TaskAmendInput = field === "title"
      ? { title: value }
      // A description left blank is removed.
      : value ? { description: value } : { clearDescription: true };
    const retryRevision = retryRevisionRef.current;
    const expectedRevision =
      retryRevision !== undefined && (task.revision === undefined || retryRevision > task.revision)
        ? retryRevision
        : task.revision;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await amendTask(task.id, patch, expectedRevision);
    } catch (err) {
      const stale = staleRevisionOf(err);
      if (stale.stale) {
        retryRevisionRef.current = stale.revision;
        baseRef.current = null;
        setProblem({ kind: "stale" });
      } else {
        console.error("Failed to edit the task:", err);
        setProblem({ kind: "failed", message: getApiErrorResponse(err)?.error ?? null });
      }
      busyRef.current = false;
      setBusy(false);
      return;
    }
    busyRef.current = false;
    close();
  }, [amendTask, close, draft, field, task]);

  const cancel = useCallback(() => {
    // The write is on its way: closing now would say nothing changed.
    if (busyRef.current) return;
    close();
  }, [close]);

  // Esc cancels the edit and stops there: it is marked handled, so the dialog
  // (or the pulled-down head) stays open. Enter saves (Shift+Enter is a new
  // line in the description; the title has no new lines).
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key !== "Enter" || isComposing(event)) return;
    if (field === "description" && event.shiftKey) return;
    event.preventDefault();
    void save();
  }, [cancel, field, save]);

  // Leaving the field saves. Not when the window itself loses focus (another
  // app or tab): the field is still where the person left it.
  const handleBlur = useCallback((event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (closedRef.current || busyRef.current) return;
    if (!event.currentTarget.ownerDocument.hasFocus()) return;
    void save();
  }, [save]);

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    setProblem((current) => (current?.kind === "titleRequired" ? null : current));
  }, []);

  const titleRequired = problem?.kind === "titleRequired";
  const notice = problem?.kind === "stale"
    ? formatMessage({ id: "task.amend.stale" })
    : problem?.kind === "failed"
      ? problem.message ?? formatMessage({ id: "task.amend.failed" })
      : null;

  return (
    <div className="stack-y-2" aria-busy={busy || undefined} data-testid={`task-head-editor-${field}`}>
      <Field invalid={titleRequired}>
        {field === "title" ? (
          <Input
            ref={controlRef}
            type="text"
            value={draft}
            readOnly={busy}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            maxLength={TASK_TITLE_MAX_LENGTH}
            aria-label={formatMessage({ id: "task.amend.titleLabel" })}
            className="w-full"
            data-testid="task-head-title-input"
          />
        ) : (
          <Textarea
            ref={controlRef}
            rows={5}
            value={draft}
            readOnly={busy}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            maxLength={TASK_DESCRIPTION_MAX_LENGTH}
            aria-label={formatMessage({ id: "task.amend.descriptionLabel" })}
            className="max-h-[40dvh]"
            data-testid="task-head-description-input"
          />
        )}
        {titleRequired ? (
          <FieldError match data-testid="task-head-title-required">
            {formatMessage({ id: "task.amend.titleRequired" })}
          </FieldError>
        ) : null}
      </Field>
      {notice ? (
        <Banner status="warning" size="sm" role="alert" data-testid="task-head-edit-notice">
          <TriangleAlert />
          <BannerDescription>{notice}</BannerDescription>
        </Banner>
      ) : null}
    </div>
  );
}
