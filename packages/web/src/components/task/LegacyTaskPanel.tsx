import Banner from "../ui/Banner";
import { useEffect, useState } from "react";
import { ArrowLeft, FileText, MapPin, X } from "lucide-react";
import { useColumnWidth } from "../../store/columnWidthStore";
import { LEGACY_TASK_SIDE_PANEL_CLASS, legacyTaskSidePanelDesktopStyle } from "./legacyTaskPanelGeometry";
import ColumnResizeHandle from "../ui/ColumnResizeHandle";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useIntl } from "react-intl";

import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { TASK_STATUS_UI } from "./taskStatusUi";
import { StatusBadge } from "./StatusBadge";
import { Card, PanelAction, PanelActions, PanelHeader, ScrollArea } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import { isCoveredByShortcutHelp } from "../../features/keyboard-shortcuts/shortcutHelpStore";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";
import { useTaskDialogTitleId } from "./taskDialogTitle";

const NON_INTERACTIVE_TOOLTIP_PROPS = { className: "pointer-events-none" };

const LEGACY_PROPERTY_ROW_CLASS_NAME = "flex min-h-8 items-center gap-4 text-callout text-foreground";
const LEGACY_PROPERTY_LABEL_CLASS_NAME = "w-28 shrink-0 text-footnote font-medium text-foreground-hint";

// Status appearance comes from raft-ui's task-status chip (StatusBadge), so a
// legacy task reads exactly like every other task surface: Closed is stone,
// never red (red is reserved for irreversible consequences), no ALL CAPS.
export default function LegacyTaskPanel({
  presentation = "side",
  mobilePage = false,
  onClose,
  onViewInChannel,
}: {
  presentation?: "side" | "modal" | "mobile-modal";
  mobilePage?: boolean;
  onClose?: () => void;
  onViewInChannel?: () => void;
}) {
  const { formatMessage } = useIntl();
  // The task dialog is named by this title (TaskDialogShell).
  const dialogTitleId = useTaskDialogTitleId();
  const task = useLegacyTaskPanelStore((s) => s.task);
  const closeLegacyTask = useLegacyTaskPanelStore((s) => s.closeLegacyTask);
  const handleClose = onClose ?? closeLegacyTask;
  const { formatShortDateTime } = useTimeFormatter();
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1024px)").matches : true
  );
  // Shared with the profile panel: both are the right-hand detail column.
  const width = useColumnWidth("detail");

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Esc closes it as a docked panel layer: not an Escape something else handled (the keyboard shortcuts panel's
  // close), nor an input method's (the dispatcher's IME guard), nor while that panel covers this side panel.
  useShortcutLayer("panel", true, { onEscape: () => (presentation === "side" && isCoveredByShortcutHelp() ? false : void handleClose()) });

  if (!task) return null;

  const status = TASK_STATUS_UI[task.status];
  const createdAtText = formatShortDateTime(task.createdAt);
  const completedAtText = formatShortDateTime(task.completedAt);
  // Three presentations (mirror ThreadPanel):
  //   side          — current right-column on desktop, full-screen overlay on mobile.
  //   modal         — bounded centered card, used inside TaskDialogShell on desktop tasks-route.
  //   mobile-modal  — full-screen overlay on mobile tasks-route with X close visible,
  //                   per stdrc 2026-05-20 #proj-task:287f18ce.
  // Raft DS: the modal is the task-detail dialog (popover layer, 16 radius,
  // float shadow + seam edge, up to 760 wide; full screen on a phone); the
  // side column is paper behind a region seam.
  const panelClassName = presentation === "modal"
    ? mobilePage
      ? "flex h-full min-h-0 w-full flex-col overflow-hidden bg-layer-canvas sm:h-[min(78vh,720px)] sm:max-h-[calc(100dvh-2rem)] sm:w-[min(760px,calc(100vw-2rem))] sm:rounded-dialog sm:bg-layer-popover sm:shadow-float sm:ring-1 sm:ring-line-seam"
      : "flex h-full min-h-full max-h-none w-full flex-col overflow-hidden bg-layer-canvas sm:h-[min(78vh,720px)] sm:max-h-[calc(100dvh-2rem)] sm:w-[min(760px,calc(100vw-2rem))] sm:rounded-dialog sm:bg-layer-popover sm:shadow-float sm:ring-1 sm:ring-line-seam"
    : presentation === "mobile-modal"
    ? "absolute inset-0 z-cover flex flex-col bg-layer-canvas"
    : LEGACY_TASK_SIDE_PANEL_CLASS;
  const panelStyle = presentation === "side" && isDesktop ? legacyTaskSidePanelDesktopStyle(width) : undefined;
  const showResizeHandle = presentation === "side";
  // X close button visibility (mirrors ThreadPanel) per stdrc 2026-05-21
  // #proj-task:287f18ce msg=804c045d:
  //   modal        — X (centered card with backdrop, X is the dialog close)
  //   mobile-modal — NO X (full-screen overlay, back chevron handles close)
  //   side         — X on desktop (lg+) only; mobile uses back chevron
  const closeButtonClassName = presentation === "modal"
    ? "flex"
    : "hidden lg:flex";

  return (
    <div
      data-testid="legacy-task-panel"
      className={panelClassName}
      style={panelStyle}
    >
      {showResizeHandle && (
        <ColumnResizeHandle column="detail" edge="left" visibleFrom="lg" />
      )}

      {/* raft-ui PanelHeader owns the edges, as on every other panel head:
          the first and last icon boxes sit on the content margin and mirror
          (headEdges.ts). */}
      <PanelHeader data-testid="legacy-task-panel-header">
        <PanelAction
          onClick={handleClose}
          aria-label={formatMessage({ id: "task.modal.close" })}
          // In modal / mobile-modal the back chevron is the close affordance,
          // so it should hide at md+ (centered card with Rail). In side
          // presentation it stays through to lg-.
          className={presentation === "side" ? "lg:hidden" : "md:hidden"}
        >
          <ArrowLeft />
        </PanelAction>
        {/* A task is not a place or a person: a neutral tile, not a sticker. */}
        <div className="flex size-icon-header shrink-0 items-center justify-center rounded-sticker bg-fill-muted text-foreground-muted">
          <FileText size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-headline text-foreground">
            #{task.channelName || formatMessage({ id: "task.legacyPanel.unknownChannel" })}
          </h2>
          <p className="truncate font-mono text-mono-meta text-foreground-hint">
            {formatMessage({ id: "task.legacyPanel.taskNumberLegacy" }, { taskNumber: task.taskNumber })}
          </p>
        </div>
        {/*
          X close button (mirrors ThreadPanel).
          - modal: visible (centered dialog close affordance)
          - mobile-modal: NO X (back chevron is the close)
          - side: visible on desktop only
          Per stdrc 2026-05-21 #proj-task:287f18ce msg=804c045d.
        */}
        {presentation !== "mobile-modal" && (
          <PanelActions>
            {onViewInChannel && (
              <Tooltip
                content={formatMessage({ id: "message.threadPanel.viewInChannel" })}
                disableHoverablePopup
                contentProps={NON_INTERACTIVE_TOOLTIP_PROPS}
              >
                <PanelAction
                  onClick={onViewInChannel}
                  className={closeButtonClassName}
                  aria-label={formatMessage({ id: "message.threadPanel.viewInChannel" })}
                  data-testid="task-view-in-channel"
                >
                  <MapPin />
                </PanelAction>
              </Tooltip>
            )}
            <Tooltip
              content={formatMessage({ id: "task.modal.close" })}
              disableHoverablePopup
              contentProps={NON_INTERACTIVE_TOOLTIP_PROPS}
            >
              <PanelAction
                onClick={handleClose}
                className={closeButtonClassName}
                aria-label={formatMessage({ id: "task.modal.close" })}
                data-testid="task-close"
              >
                <X />
              </PanelAction>
            </Tooltip>
          </PanelActions>
        )}
      </PanelHeader>

      {/* The read-only task scrolls in a raft-ui ScrollArea, its spacing and
          padding on the content: a region named after the task, a tab stop
          once it overflows. */}
      <ScrollArea role="region" aria-label={task.title} className="flex-1" contentClassName="stack-y-4 px-(--surface-inset) py-4 safe-bottom">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={task.status}>
            {formatMessage({ id: status.labelId })}
          </StatusBadge>
        </div>

        <Card render={<section />} className="stack-y-3 p-4">
          <div>
            <p className="mb-1 text-footnote font-medium text-foreground-hint">{formatMessage({ id: "task.legacyPanel.title" })}</p>
            <h3 id={dialogTitleId} className="break-words text-headline text-foreground">{task.title}</h3>
          </div>
          <div>
            <p className="mb-1 text-footnote font-medium text-foreground-hint">{formatMessage({ id: "task.legacyPanel.description" })}</p>
            <p className="whitespace-pre-wrap break-words text-callout text-foreground">
              {task.description?.trim() || formatMessage({ id: "task.legacyPanel.noDescription" })}
            </p>
          </div>
        </Card>

        {/* The facts about the task, drawn as the Raft DS PropertyList: a label
            column in ink-3 (13/18 500), values in ink (14/20, at least 32 tall),
            times in Space Mono. Same rows as before (no list semantics added). */}
        <Card render={<section />} className="px-4 py-2">
          <div className={LEGACY_PROPERTY_ROW_CLASS_NAME}>
            <span className={LEGACY_PROPERTY_LABEL_CLASS_NAME}>{formatMessage({ id: "task.legacyPanel.createdBy" })}</span>
            <span className="min-w-0 break-words">@{task.createdByName || formatMessage({ id: "task.legacyPanel.unknown" })}</span>
          </div>
          <div className={LEGACY_PROPERTY_ROW_CLASS_NAME}>
            <span className={LEGACY_PROPERTY_LABEL_CLASS_NAME}>{formatMessage({ id: "task.legacyPanel.createdAt" })}</span>
            <span className={`min-w-0 ${createdAtText ? "font-mono" : ""}`}>{createdAtText || formatMessage({ id: "task.legacyPanel.unknown" })}</span>
          </div>
          <div className={LEGACY_PROPERTY_ROW_CLASS_NAME}>
            <span className={LEGACY_PROPERTY_LABEL_CLASS_NAME}>{formatMessage({ id: "task.legacyPanel.assignee" })}</span>
            <span className="min-w-0 break-words">{task.claimedByName ? `@${task.claimedByName}` : formatMessage({ id: "task.filter.unassigned" })}</span>
          </div>
          <div className={LEGACY_PROPERTY_ROW_CLASS_NAME}>
            <span className={LEGACY_PROPERTY_LABEL_CLASS_NAME}>{formatMessage({ id: "task.legacyPanel.completed" })}</span>
            <span className={`min-w-0 ${completedAtText ? "font-mono" : ""}`}>{completedAtText || formatMessage({ id: "task.legacyPanel.notDone" })}</span>
          </div>
        </Card>

        {/* Read before acting: the Raft DS info Banner, part of the page
            rather than news, so it does not announce itself. */}
        <Banner intent="info" live={false} title={formatMessage({ id: "task.legacyPanel.readOnly" })}>
          {formatMessage({ id: "task.legacyPanel.metadataOnlyHint" })}
        </Banner>
      </ScrollArea>
    </div>
  );
}
