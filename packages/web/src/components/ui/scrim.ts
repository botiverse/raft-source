/**
 * The Raft Design System scrim: the dim behind every modal surface. It is
 * raft-ui's Dialog overlay (`bg-layer-backdrop`: oklch(0 0 0 / 0.651) light,
 * 0.6 dark; no blur). Its colour and opacity are the same everywhere; whether
 * it moves follows its layer (Jasper, 2026-10-21): under a centred dialog it
 * appears at once, like the dialog; under a sheet or drawer it fades in with
 * the slide (index.css). raft-ui draws its own for Dialog, AlertDialog, Drawer
 * and Lightbox from the same token; a page slock draws itself (a preview page
 * of a dialog) uses this class.
 */
export const SCRIM_CLASS = "bg-layer-backdrop";

/**
 * A raft-ui overlay opened over the task dialog (TaskDialogShell) from outside
 * its React tree: its portal follows the task dialog's in the document.
 * index.css gives it the nested scrim's colour (the same selector, kept in
 * step); raft-ui's own nesting already covers one rendered inside the task
 * dialog (data-nested).
 */
export const NESTED_OVER_TASK_DIALOG_SELECTOR =
  '[data-slot="dialog-portal"]:has(> [data-task-dialog]) ~ * '
  + ':is([data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [data-slot="drawer-overlay"]):not([data-nested])';
