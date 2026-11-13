import { useMemo } from "react";
import type { HTMLAttributes } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Server } from "../../store/serverStore";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import { WorkspaceStripButton } from "./WorkspaceStripButton";
import { WorkspaceStripCurrentMark } from "./WorkspaceStripCurrentMark";

/** A strip avatar that can be dragged to reorder (a plain click still switches). */
export function WorkspaceStripSortableAvatar({ server, isCurrent, hasUnread, otherUnread = false, shortcut, sortable, hideTooltip, onPick }: {
  server: Server;
  isCurrent: boolean;
  hasUnread: boolean;
  otherUnread?: boolean;
  shortcut: ShortcutCombo | null;
  sortable: boolean;
  hideTooltip: boolean;
  onPick: (server: Server) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: server.id, disabled: !sortable });
  const dragProps = useMemo<HTMLAttributes<HTMLButtonElement> | undefined>(
    () => (sortable ? { ...attributes, ...listeners } : undefined),
    [sortable, attributes, listeners],
  );
  const style = useMemo(() => ({ transform: CSS.Translate.toString(transform), transition }), [transform, transition]);
  return (
    <div
      ref={setNodeRef}
      className="group/ws relative flex items-center"
      style={style}
      // raft-ui drag-and-drop: the place a drag came from stays at 40%.
      data-drag-origin={isDragging ? "" : undefined}
      data-workspace-id={server.id}
    >
      <WorkspaceStripButton server={server} isCurrent={isCurrent} hasUnread={hasUnread} otherUnread={otherUnread} shortcut={shortcut} hideTooltip={hideTooltip} onPick={onPick} dragProps={dragProps} />
      <WorkspaceStripCurrentMark on={isCurrent && !isDragging} />
    </div>
  );
}
