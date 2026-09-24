import { useLayoutEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { PanelHeading, PanelSection } from "raft-ui";

import type { Task } from "../../store/taskStore";
import ShowMoreToggle from "../ui/ShowMoreToggle";

import TaskProperties from "./TaskProperties";

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

export default function TaskModalHead({ task }: { task: Task }) {
  const { formatMessage } = useIntl();
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const [descriptionExpansion, setDescriptionExpansion] = useState({ key: "", expanded: false });
  const [descriptionOverflow, setDescriptionOverflow] = useState({ key: "", collapsible: false });
  const description = task.description?.trim();
  const descriptionKey = `${task.id}:${description ?? ""}`;
  const descriptionExpanded = descriptionExpansion.key === descriptionKey && descriptionExpansion.expanded;
  const descriptionCollapsible =
    description ? descriptionOverflow.key === descriptionKey && descriptionOverflow.collapsible : false;
  const descriptionCollapsed = descriptionCollapsible && !descriptionExpanded;

  useLayoutEffect(() => {
    if (!description) {
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
  }, [description, descriptionKey]);


  return (
    <PanelSection className="border-b-2 border-black bg-white">
      {/* Number sits inline with the title, GitHub/Linear style: it is part of
          how the task is named, not separate metadata. Kept non-bold and muted
          so it reads as an identifier rather than competing with the title. */}
      {/* The number lives in the persistent bar, not here. Rendering it in both
          places put the same identifier twice within ~30px; the bar's copy is
          the one that survives scrolling, so this one goes. */}
      <PanelHeading className="mb-2 line-clamp-3 break-words text-lg font-bold leading-snug" data-testid="task-modal-title" title={task.title}>{task.title}</PanelHeading>

      {/* No placeholder when there is no description: nothing to say is not
          worth a line of chrome, and today essentially every task has none. */}
      {description && (
        <div className="mb-3">
          <p
            ref={descriptionRef}
            id={`task-modal-description-${task.id}`}
            className={`whitespace-pre-wrap break-words text-sm text-black/70 ${
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
              onClick={() =>
                setDescriptionExpansion((cur) => ({
                  key: descriptionKey,
                  expanded: cur.key === descriptionKey ? !cur.expanded : true,
                }))}
              className="mt-1"
              data-testid="task-modal-description-toggle"
            />
          )}
        </div>
      )}

      <TaskProperties task={task} />
    </PanelSection>
  );
}
