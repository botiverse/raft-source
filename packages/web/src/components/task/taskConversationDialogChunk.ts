import { deferredDialog, deferredModule, deferredPanel } from "../../boot/deferredUi";
import { useThreadStore } from "../../store/threadStore";

/**
 * The Task v2 conversation (TaskConversationDialog), off the first download
 * (boot/deferredUi): one load shared by the dialog MainLayout opens and the
 * pop-out task window's page, fetched in the background after the first
 * screen. The window starts it as soon as it knows it shows a task, beside
 * the task's own load.
 */
// Not importHandledLocally here: deferredDialog / deferredPanel wrap the wait
// someone is looking at; this early start and the prefetch keep the app's recovery.
export const loadTaskConversationDialog = deferredModule(() => import("./TaskConversationDialog"));

/** In MainLayout's task slot (modal, mobile modal): nothing until its code is in. */
export const TaskConversationDialog = deferredDialog(loadTaskConversationDialog);

/** The pop-out window's page: under the window's Suspense, with Try again in place on a failed load. */
export const TaskConversationPage = deferredPanel(loadTaskConversationDialog);

// The open dialog's first answer to Escape and the backdrop (TaskDialogShell's onClose):
// a profile open beside the conversation closes before the dialog does. Here,
// not in the dialog's module, because MainLayout's TaskDialogShell calls it before that
// module may have loaded.
let closeOpenProfile: (() => boolean) | null = null;

/** The dialog registers what closes its profile (true: one was open). */
export function interceptTaskConversationDismiss(close: () => boolean): () => void {
  closeOpenProfile = close;
  return () => {
    if (closeOpenProfile === close) closeOpenProfile = null;
  };
}

/** TaskDialogShell's onClose for the task dialog: its profile first, then the dialog. */
export function dismissTaskConversationDialog(): void {
  if (closeOpenProfile?.()) return;
  useThreadStore.getState().closeTaskModal();
}
