import { useEffect, useState } from "react";
import { ArrowLeft, FileText, MapPin, X } from "lucide-react";
import { useResizablePanel } from "../../hooks/useResizablePanel";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useIntl } from "react-intl";

import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { TASK_STATUS_UI } from "./taskStatusUi";
import Button from "../ui/Button";
import Tooltip from "../ui/Tooltip";

// Mirrors `STATUS_STYLES` in `task/taskStatusUi.ts` — Title Case labels +
// `closed` uses `bg-brutal-stone` (terminal-state token), NOT `bg-brutal-red`.
// Red is reserved for destructive irreversible actions; closed is a
// reversible terminal state. Status indicators don't get the brutal
// uppercase transform here either — see `taskStatusUi.STATUS_STYLES`
// rationale (stdrc msg=ce25da45 + msg=65681d15).
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
  const task = useLegacyTaskPanelStore((s) => s.task);
  const closeLegacyTask = useLegacyTaskPanelStore((s) => s.closeLegacyTask);
  const handleClose = onClose ?? closeLegacyTask;
  const { formatShortDateTime } = useTimeFormatter();
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1024px)").matches : true
  );
  const { width, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizablePanel({
    storageKey: "slock:legacyTaskPanelWidth",
    min: 320,
    max: 560,
    defaultWidth: 380,
    direction: "left",
  });

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    // keydown-global-exempt: docked panel non-modal, Escape is convenience close, parent surface owns focus
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleClose]);

  if (!task) return null;

  const status = TASK_STATUS_UI[task.status];
  // Three presentations (mirror ThreadPanel):
  //   side          — current right-column on desktop, full-screen overlay on mobile.
  //   modal         — bounded centered card, used inside <Modal> on desktop tasks-route.
  //   mobile-modal  — full-screen overlay on mobile tasks-route with X close visible,
  //                   per stdrc 2026-05-20 #proj-task:287f18ce.
  const panelClassName = presentation === "modal"
    ? mobilePage
      ? "flex h-full min-h-0 w-full flex-col overflow-hidden border-0 bg-white shadow-none sm:h-[min(78vh,720px)] sm:max-h-[calc(100dvh-2rem)] sm:w-[min(760px,calc(100vw-2rem))] sm:border-2 sm:shadow-brutal"
      : "flex h-full min-h-full max-h-none w-full flex-col overflow-hidden border-0 bg-white shadow-none sm:h-[min(78vh,720px)] sm:max-h-[calc(100dvh-2rem)] sm:w-[min(760px,calc(100vw-2rem))] sm:border-2 sm:shadow-brutal"
    : presentation === "mobile-modal"
    ? "absolute inset-0 z-30 flex flex-col bg-white"
    : "absolute inset-0 z-30 flex flex-col bg-white lg:relative lg:inset-auto lg:z-auto lg:border-l-2 lg:border-black";
  const panelStyle = presentation === "side" && isDesktop ? { width } : undefined;
  const showResizeHandle = presentation === "side";
  // X close button visibility (mirrors ThreadPanel) per stdrc 2026-05-21
  // #proj-task:287f18ce msg=804c045d:
  //   modal        — X (centered card with backdrop, X is the dialog close)
  //   mobile-modal — NO X (full-screen overlay, back chevron handles close)
  //   side         — X on desktop (lg+) only; mobile uses back chevron
  const closeButtonClassName = presentation === "modal"
    ? "btn-brutal-sm flex size-7 items-center justify-center bg-white"
    : "btn-brutal-sm hidden size-7 items-center justify-center bg-white lg:flex";

  return (
    <div
      data-testid="legacy-task-panel"
      className={panelClassName}
      style={panelStyle}
    >
      {showResizeHandle && (
        <div
          className="hidden md:block absolute left-0 top-0 bottom-0 w-2 -ml-1 z-10 cursor-col-resize touch-none select-none"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        />
      )}

      <div data-testid="legacy-task-panel-header" className="flex h-panel-header items-center gap-3 border-b-2 border-black bg-white px-5">
        <Button
          type="button"
          onClick={handleClose}
          shape="icon"
          aria-label={formatMessage({ id: "task.modal.close" })}
          // In modal / mobile-modal the back chevron is the close affordance,
          // so it should hide at md+ (centered card with Rail). In side
          // presentation it stays through to lg-.
          className={presentation === "side" ? "lg:hidden" : "md:hidden"}
        >
          <ArrowLeft size={14} />
        </Button>
        <div className="flex size-icon-header shrink-0 items-center justify-center border-2 border-black bg-soft-signal text-black">
          <FileText size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-bold text-black text-base">
            #{task.channelName || formatMessage({ id: "task.legacyPanel.unknownChannel" })}
          </h2>
          <p className="text-xs text-black/50 font-mono">
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
          <div className="flex items-center gap-1">
            {onViewInChannel && (
              <Tooltip
                content={formatMessage({ id: "message.threadPanel.viewInChannel" })}
                disableHoverablePopup
                contentProps={{ className: "pointer-events-none bg-white" }}
              >
                <button
                  type="button"
                  onClick={onViewInChannel}
                  className={closeButtonClassName}
                  aria-label={formatMessage({ id: "message.threadPanel.viewInChannel" })}
                  data-testid="task-view-in-channel"
                >
                  <MapPin size={14} />
                </button>
              </Tooltip>
            )}
            <Tooltip
              content={formatMessage({ id: "task.modal.close" })}
              disableHoverablePopup
              contentProps={{ className: "pointer-events-none bg-white" }}
            >
              <button
                type="button"
                onClick={handleClose}
                className={closeButtonClassName}
                aria-label={formatMessage({ id: "task.modal.close" })}
                data-testid="task-close"
              >
                <X size={14} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto bg-white px-5 py-4 space-y-4 safe-bottom">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`shrink-0 border border-black px-1 py-0.5 text-[10px] font-bold leading-none ${status.bg}`}>
            {formatMessage({ id: status.labelId })}
          </span>
        </div>

        <section className="card-brutal bg-white p-4 space-y-3">
          <div>
            <p className="text-xs font-mono text-black/40 mb-1">{formatMessage({ id: "task.legacyPanel.title" })}</p>
            <h3 className="text-lg font-bold break-words">{task.title}</h3>
          </div>
          <div>
            <p className="text-xs font-mono text-black/40 mb-1">{formatMessage({ id: "task.legacyPanel.description" })}</p>
            <p className="text-sm whitespace-pre-wrap break-words text-black/80">
              {task.description?.trim() || formatMessage({ id: "task.legacyPanel.noDescription" })}
            </p>
          </div>
        </section>

        <section className="card-brutal bg-white p-4 space-y-2 text-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="text-black/50 font-mono">{formatMessage({ id: "task.legacyPanel.createdBy" })}</span>
            <span className="text-right">@{task.createdByName || formatMessage({ id: "task.legacyPanel.unknown" })}</span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="text-black/50 font-mono">{formatMessage({ id: "task.legacyPanel.createdAt" })}</span>
            <span className="text-right">{formatShortDateTime(task.createdAt) || formatMessage({ id: "task.legacyPanel.unknown" })}</span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="text-black/50 font-mono">{formatMessage({ id: "task.legacyPanel.assignee" })}</span>
            <span className="text-right">{task.claimedByName ? `@${task.claimedByName}` : formatMessage({ id: "task.filter.unassigned" })}</span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="text-black/50 font-mono">{formatMessage({ id: "task.legacyPanel.completed" })}</span>
            <span className="text-right">{formatShortDateTime(task.completedAt) || formatMessage({ id: "task.legacyPanel.notDone" })}</span>
          </div>
        </section>

        <section className="border-2 border-black bg-soft-signal/30 shadow-brutal-sm p-4">
          <p className="text-sm font-bold">{formatMessage({ id: "task.legacyPanel.readOnly" })}</p>
          <p className="mt-1 text-sm text-black/70">
            {formatMessage({ id: "task.legacyPanel.metadataOnlyHint" })}
          </p>
        </section>
      </div>
    </div>
  );
}
