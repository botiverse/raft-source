/**
 * Desktop vs phone for the shell (Tailwind's md breakpoint): ShellFrame's `useIsDesktopShell`, and threadRowState's
 * read of it, which leaves the shell's own module (its top bar, its install prompt) out of the thread's head.
 */
export const DESKTOP_SHELL_QUERY = "(min-width: 768px)";
