import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronRight } from "lucide-react";
import { authorizeTaskAction } from "@botiverse/raft-shared";
import { Button, DescriptionList, PanelSection, Separator } from "@botiverse/raft-ui";

import type { Task } from "../../store/taskStore";
import SectionEyebrow from "../ui/SectionEyebrow";
import ShowMoreToggle from "../ui/ShowMoreToggle";
import { SkeletonTextBar } from "../ui/Skeleton";

import { TaskHeadEditButton, TaskHeadFieldEditor } from "./TaskHeadEditor";
import type { TaskHeadEditField } from "./TaskHeadEditor";
import TaskProperties, { PropertyRow } from "./TaskProperties";
import TaskSourceRow from "./TaskSourceRow";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useTaskDialogTitleId } from "./taskDialogTitle";

/**
 * The fixed head of a task modal: what it is, then what state it is in.
 * The discussion scrolls beneath it.
 *
 * The ordering is not styling — it is the order the questions arise when
 * someone opens a task. *What is this?* (title, description) → *what state is
 * it in and who owns it?* (properties) → *what has been said about it?*
 * (discussion). Putting state first, as this surface did before, answers a
 * question the reader has not asked yet.
 *
 * Two things follow from "the modal's subject is the task, not the thread":
 *  - the embedded ThreadPanel runs with `hideHeader`, because a thread that
 *    announces itself as `Thread — #channel` is a second surface declaring its
 *    own subject, and two subjects is what made this read as neither one thing
 *    nor the other;
 *  - it also runs with `hideParentMessage`, because the anchor message's body
 *    is where the title came from. Rendering both repeats one sentence today
 *    and shows a stale copy the moment `tasks.title` is edited away from it.
 *
 * Identity stays fixed while the conversation scrolls: losing sight of which
 * task you are in is the failure this layout exists to prevent.
 */
/** Built here rather than inline so the `#` sigil is not a bare literal in JSX
 *  — the i18n literal-disposition guard counts those, and a sigil is markup,
 *  not copy anyone should translate. */

const DESCRIPTION_COLLAPSE_LINE_LIMIT = 3;
const DESCRIPTION_FALLBACK_LINE_HEIGHT_PX = 20;
const DESCRIPTION_COLLAPSE_HEIGHT_EPSILON_PX = 1;

function getDescriptionLineHeightPx(element: HTMLElement): number {
  const computedStyle = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(computedStyle.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;

  const fontSize = Number.parseFloat(computedStyle.fontSize);
  if (Number.isFinite(fontSize) && fontSize > 0) return fontSize * 1.4;

  return DESCRIPTION_FALLBACK_LINE_HEIGHT_PX;
}

function descriptionExceedsCollapsedHeight(element: HTMLElement): boolean {
  const collapsedHeight = getDescriptionLineHeightPx(element) * DESCRIPTION_COLLAPSE_LINE_LIMIT;
  return element.scrollHeight > collapsedHeight + DESCRIPTION_COLLAPSE_HEIGHT_EPSILON_PX;
}


/** The head's title: a heading, at most three lines. */
const TASK_HEAD_TITLE_CLASS = "line-clamp-3 min-w-0 flex-1 break-words text-headline font-semibold text-foreground";

/** The property rows a task conversation's head has, in order (TaskProperties with its source and trailing rows). */
const SKELETON_PROPERTY_LABELS = [
  "task.properties.status",
  "task.properties.assignee",
  "task.source.label",
  "task.properties.createdBy",
  "task.properties.createdAt",
] as const;

/**
 * The head while the task loads: the loaded head's section, a two-line title
 * in the title's own type, a row where the description or its Add button goes,
 * the property rows with their labels and a bar for each value, and the History
 * toggle, so the conversation below starts where it will once the task is in.
 */
export function TaskModalHeadSkeleton({ divider = true }: { divider?: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <>
      <PanelSection className="border-t-0 bg-layer-canvas" aria-hidden="true" data-testid="task-conversation-loading">
        <div className="mb-2">
          <div className={TASK_HEAD_TITLE_CLASS}><SkeletonTextBar className="w-full" /></div>
          <div className={TASK_HEAD_TITLE_CLASS}><SkeletonTextBar className="w-1/2" /></div>
        </div>
        {/* The description, or (none, and the reader can edit: most tasks) the Add a description button's row. */}
        <div className="mb-3 flex h-8 items-center text-subhead"><SkeletonTextBar className="w-40" /></div>
        <DescriptionList direction="inline">
          {SKELETON_PROPERTY_LABELS.map((id) => (
            // One property a line, as the loaded rows are (each value is wider
            // than a short bar, so two never share a line in the head's column).
            <PropertyRow key={id} className="basis-full" label={formatMessage({ id })}>
              <SkeletonTextBar className="w-24" />
            </PropertyRow>
          ))}
        </DescriptionList>
        {/* TaskProperties' History toggle, always under the rows. */}
        <div className="pt-4"><SectionEyebrow as="div" className="flex w-full items-center gap-1"><span>{formatMessage({ id: "task.properties.history" })}</span><ChevronRight size={14} aria-hidden="true" /></SectionEyebrow></div>
      </PanelSection>
      {divider ? <Separator /> : null}
    </>
  );
}

export default function TaskModalHead({ task, propertyRows, divider = true, onOpenProfile }: {
  task: Task;
  /** Task v2 dialog: opens a person's or an agent's profile beside the
   *  conversation (the assignee's avatar). */
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  /** Task v2 dialog: Source and the facts after Created by go into the
   *  properties list itself (reply-design §6), replacing the quoted Source. */
  propertyRows?: { sourceRow?: ReactNode; trailingRows?: ReactNode };
  /** The hairline under the head. Off where nothing sits flat under it: on a
   *  phone, where the head is the conversation's first row and the first
   *  message follows as the rows follow one another, and in the panel pulled
   *  down from the bar, whose edge is its shadow. */
  divider?: boolean;
}) {
  const { formatMessage } = useIntl();
  // The task dialog is named by this title (TaskDialogShell).
  const dialogTitleId = useTaskDialogTitleId();
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const [descriptionExpansion, setDescriptionExpansion] = useState({ key: "", expanded: false });
  const [descriptionOverflow, setDescriptionOverflow] = useState({ key: "", collapsible: false });
  const description = task.description?.trim();
  const descriptionKey = `${task.id}:${description ?? ""}`;
  const descriptionExpanded = descriptionExpansion.key === descriptionKey && descriptionExpansion.expanded;
  const descriptionCollapsible =
    description ? descriptionOverflow.key === descriptionKey && descriptionOverflow.collapsible : false;
  const descriptionCollapsed = descriptionCollapsible && !descriptionExpanded;

  // Editing the title and description (#wg-task-v2:#22). Offered as the assignee
  // picker is (TaskProperties' canEditAssignee): the shared rule with channel
  // access assumed, since the head only shows to readers of the task, and the
  // server (PATCH /tasks/:id) is the authority, answering 403 with its reason.
  // Never on a legacy card, which the server cannot amend. The edit is keyed
  // by task, so a head reused for another task does not carry it over.
  const canEdit = !task.isLegacy && authorizeTaskAction({ action: "amend", canReadChannel: true, canWriteChannel: true, readOnlyReason: task.readOnlyReason });
  // A summary row has no description body (only `hasDescription`): editing it
  // from there would start from nothing and could wipe what is stored.
  const descriptionLoaded = task.description !== undefined || task.hasDescription === false;
  const [editing, setEditing] = useState<{ taskId: string; field: TaskHeadEditField } | null>(null);
  const editingField = canEdit && editing?.taskId === task.id ? editing.field : null;
  const descriptionShown = Boolean(description) && editingField !== "description";
  const titleEditButtonRef = useRef<HTMLButtonElement>(null);
  const descriptionEditButtonRef = useRef<HTMLButtonElement>(null);
  const addDescriptionRef = useRef<HTMLButtonElement>(null);
  const focusAfterEdit = useRef<TaskHeadEditField | null>(null);
  const openTitleEditor = useCallback(() => setEditing({ taskId: task.id, field: "title" }), [task.id]);
  const openDescriptionEditor = useCallback(() => setEditing({ taskId: task.id, field: "description" }), [task.id]);
  // A save from leaving the field (a click elsewhere) leaves focus where it
  // went; Enter and Esc, with focus still in the field, put it back.
  const closeEditor = useCallback((restoreFocus: boolean) => {
    focusAfterEdit.current = restoreFocus ? editing?.field ?? null : null;
    setEditing(null);
  }, [editing]);
  // Focus goes back to what opened the edit (the description's pencil, or Add
  // a description when the description was removed).
  useEffect(() => {
    if (editingField !== null) return;
    const field = focusAfterEdit.current;
    if (!field) return;
    focusAfterEdit.current = null;
    const target = field === "title"
      ? titleEditButtonRef.current
      : descriptionEditButtonRef.current ?? addDescriptionRef.current;
    target?.focus();
  }, [editingField]);

  useLayoutEffect(() => {
    if (!description || !descriptionShown) {
      setDescriptionOverflow({ key: "", collapsible: false });
      return;
    }

    const element = descriptionRef.current;
    if (!element) return;

    const measure = () => {
      const nextCollapsible = descriptionExceedsCollapsedHeight(element);
      setDescriptionOverflow((current) =>
        current.key === descriptionKey && current.collapsible === nextCollapsible
          ? current
          : { key: descriptionKey, collapsible: nextCollapsible },
      );
    };

    measure();

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            measure();
          });
    observer?.observe(element);
    window.addEventListener("resize", measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [description, descriptionKey, descriptionShown]);

  const toggleDescriptionExpanded = useCallback(() => {
    setDescriptionExpansion((cur) => ({
      key: descriptionKey,
      expanded: cur.key === descriptionKey ? !cur.expanded : true,
    }));
  }, [descriptionKey]);

  return (
    <>
      <PanelSection className="border-t-0 bg-layer-canvas">
        {/* Number sits inline with the title, GitHub/Linear style: it is part of
            how the task is named, not separate metadata. Kept non-bold and muted
            so it reads as an identifier rather than competing with the title. */}
        {/* The number lives in the persistent bar, not here. Rendering it in both
            places put the same identifier twice within ~30px; the bar's copy is
            the one that survives scrolling, so this one goes. */}
        {/* The task is what the dialog is about, so its title is set as a
            heading (text-headline at 600), not as body text: the strongest
            words in the dialog after its bar (raft-design foundations/
            comfort.md, Hierarchy contrast). A block, so line-clamp holds. */}
        {editingField === "title" ? (
          <div className="mb-2">
            <TaskHeadFieldEditor task={task} field="title" onClose={closeEditor} />
          </div>
        ) : (
          <div className="group/head-field mb-2 flex items-start gap-1">
            <h3 id={dialogTitleId} className={TASK_HEAD_TITLE_CLASS} data-testid="task-modal-title">{task.title}</h3>
            {canEdit && editingField === null ? (
              <TaskHeadEditButton
                label={formatMessage({ id: "task.amend.editTitle" })}
                onClick={openTitleEditor}
                buttonRef={titleEditButtonRef}
                testId="task-modal-title-edit"
              />
            ) : null}
          </div>
        )}

        {/* No placeholder when there is no description: nothing to say is not
            worth a line of chrome, and today essentially every task has none.
            Someone who can edit gets one quiet Add a description instead. */}
        {editingField === "description" ? (
          <div className="mb-3">
            <TaskHeadFieldEditor task={task} field="description" onClose={closeEditor} />
          </div>
        ) : description ? (
          <div className="group/head-field mb-3 flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <p
                ref={descriptionRef}
                id={`task-modal-description-${task.id}`}
                className={`whitespace-pre-wrap break-words text-subhead text-foreground-muted ${
                  descriptionCollapsed ? "line-clamp-3" : ""
                }`}
                data-testid="task-modal-description"
              >
                {description}
              </p>
              {descriptionCollapsible && (
                <ShowMoreToggle
                  expanded={descriptionExpanded}
                  collapsedLabel={formatMessage({ id: "message.content.showMore" })}
                  expandedLabel={formatMessage({ id: "message.content.collapse" })}
                  aria-controls={`task-modal-description-${task.id}`}
                  aria-expanded={descriptionExpanded}
                  onClick={toggleDescriptionExpanded}
                  className="mt-1"
                  data-testid="task-modal-description-toggle"
                />
              )}
            </div>
            {canEdit && descriptionLoaded && editingField === null ? (
              <TaskHeadEditButton
                label={formatMessage({ id: "task.amend.editDescription" })}
                onClick={openDescriptionEditor}
                buttonRef={descriptionEditButtonRef}
                testId="task-modal-description-edit"
              />
            ) : null}
          </div>
        ) : canEdit && descriptionLoaded && editingField === null ? (
          <div className="mb-3">
            {/* A ghost button, not a link: it needs a hit area on a phone,
                where the dialog is the whole screen. Pulled left by its
                padding so its words line up with the title's. */}
            <Button
              ref={addDescriptionRef}
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-3"
              onClick={openDescriptionEditor}
              data-testid="task-modal-add-description"
            >
              {formatMessage({ id: "task.amend.addDescription" })}
            </Button>
          </div>
        ) : null}

        {propertyRows ? (
          <TaskProperties task={task} sourceRow={propertyRows.sourceRow} trailingRows={propertyRows.trailingRows} assigneeAsPerson onOpenProfile={onOpenProfile} />
        ) : (
          <>
            <TaskProperties task={task} />
            {taskV2 ? <TaskSourceRow task={task} /> : null}
          </>
        )}
      </PanelSection>
      {divider ? <Separator /> : null}
    </>
  );
}
