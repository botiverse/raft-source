// Raft Design System type roles used across this panel. Space Grotesk is what
// people say; Space Mono is what machines write (versions, paths, sizes,
// hostnames, runtimes, commands).
/** A quiet line where a list or value is empty (13/18, ink-3). */
export const DETAIL_EMPTY_NOTE_CLASS_NAME = "text-footnote text-foreground-hint";
/** Explanatory copy above a control or a command (13/18, ink-2). */
export const DETAIL_HELP_CLASS_NAME = "text-footnote text-foreground-muted";
/** A sentence about something that went wrong but can be fixed (orange ink). */
export const DETAIL_PROBLEM_CLASS_NAME = "text-footnote text-warning-strong";
/** The label of one step / one command line (field label: 13/18 600). */
export const DETAIL_STEP_LABEL_CLASS_NAME = "text-footnote font-semibold text-foreground";
/** Layout only: raft-ui's CopyableCode draws the Raft DS command line. */
export const COMMAND_LINE_CLASS_NAME = "min-w-0 flex-1";
