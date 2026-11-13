import { useCallback, useId, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { ReactNode } from "react";
import { Dialog } from "@botiverse/raft-ui";
import type { DialogProps } from "@botiverse/raft-ui";
import { FramedDialogContent } from "../ui/NarrowDialog";
import { isFromForeignLayer } from "../ui/useOverlayLayer";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";
import { TaskDialogTitleContext } from "./taskDialogTitle";

type OpenChangeDetails = Parameters<NonNullable<DialogProps["onOpenChange"]>>[1];

/** The popup is as wide as the card inside it (the task's 960, a legacy task's 760); the card draws the frame. */
const TASK_DIALOG_POPUP_CLASS = "w-fit max-w-none";

function focusedElement(): HTMLElement | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * The task dialog on a desktop or tablet (MainLayout's RightPanel, md+): a raft-ui Dialog around the card the task
 * surface draws itself (the conversation's or the legacy task's DialogSurface), unframed (FramedDialogContent). Base UI
 * traps the focus, hides the page from assistive tech and locks its scroll; the scrim is raft-ui's.
 *
 * - Esc is the shortcut registry's, as under the old slock Modal: a non-modal "dialog" layer that closes it, after
 *   whatever inside took the key (a mention list, an editor, the profile beside the conversation; they mark it
 *   handled). Not a modal layer: the dialog is a workspace, and the conversation's own commands (the thread's, the
 *   composer's) and global ones (⌘K) keep working in it, as before. A layer opened over it (a lightbox, a
 *   confirmation) is modal and takes the Esc first. Base UI's own Esc close is cancelled and let through to the
 *   document, where the registry listens.
 * - A press on its own scrim closes it (Base UI only counts its own backdrop). A press in a layer opened over it from
 *   outside its React tree (the App-level image lightbox, the attachment previews, a dialog host's confirmation) is
 *   that layer's (isFromForeignLayer).
 * - Focus: on the dialog itself when it opens, unless something inside already took it (the composer's autofocus);
 *   a composer mounting later takes it then (mayTakeFocus allows a field inside the open dialog). On close it goes
 *   back to what opened it, unless the close moved it somewhere else on purpose (a jump to the message in chat).
 *
 * A raft-ui overlay opened over it from outside its tree draws the lighter nested scrim (index.css,
 * `[data-task-dialog]`); one rendered inside it nests by itself.
 *
 * Its name is the task's title (the card's title element takes the id from TaskDialogTitleContext); while there is
 * none on screen (loading, the title being edited) it is "Task" (aria-labelledby with no element falls back to
 * aria-label).
 */
export function TaskDialogShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const { formatMessage } = useIntl();
  const titleId = useId();
  useShortcutLayer("dialog", true, { onEscape: () => { onClose(); } });
  const handleOpenChange = useCallback((open: boolean, details: OpenChangeDetails) => {
    if (open) return;
    if (details.reason === "escape-key") details.allowPropagation();
    if (details.reason !== "outside-press" || isFromForeignLayer(details.event, popupRef.current)) {
      details.cancel();
      return;
    }
    onClose();
  }, [onClose]);
  // Read during the first render, before Base UI moves the focus in.
  const [finalFocus] = useState(() => {
    const opener = focusedElement();
    return () => {
      const active = focusedElement();
      // Focus already moved on, outside the dialog (the close jumped to a message in chat and focused it there).
      if (active && active.isConnected && !popupRef.current?.contains(active)) return false;
      return opener?.isConnected ? opener : true;
    };
  });

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <FramedDialogContent
        ref={popupRef}
        narrow="centered"
        modalLayer={false}
        initialFocus={popupRef}
        finalFocus={finalFocus}
        className={TASK_DIALOG_POPUP_CLASS}
        data-task-dialog=""
        aria-labelledby={titleId}
        aria-label={formatMessage({ id: "layout.main.task" })}
      >
        <TaskDialogTitleContext value={titleId}>{children}</TaskDialogTitleContext>
      </FramedDialogContent>
    </Dialog>
  );
}
