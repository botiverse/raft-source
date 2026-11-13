import { create } from "zustand";

interface ShortcutHelpState {
  open: boolean;
  /**
   * Opened over a thread folded into the conversation's column (#189 rule 3, `data-covers`): the panel then takes the
   * whole row over it, as the thread did, and the row's plan stays as it is. Otherwise the panel is a column of the
   * planned row in the thread's place (rowPlan `withShortcutHelpColumn`).
   */
  overCoveringThread: boolean;
  /** Opened from a menu: the panel takes focus once it is drawn, then clears this. */
  focusRequested: boolean;
  /** ⌘/ opens it and leaves focus where it is, so the person can try a key at once. */
  openInPlace: () => void;
  /** The Help menu: opens it (or keeps it open) and moves focus into it. */
  openWithFocus: () => void;
  close: () => void;
  focusTaken: () => void;
}

/**
 * The keyboard shortcuts panel, in the right-hand detail column
 * (ShortcutHelpColumn). Not in the URL: it is a reference opened for a moment,
 * and opening a thread or a profile closes it.
 */
/** A thread folded over the conversation, in MainLayout's row, now. */
function threadCoveringNow(): boolean {
  return typeof document !== "undefined" && document.querySelector(".thread-layout-container > .thread-side-column[data-covers]") !== null;
}

export const useShortcutHelpStore = create<ShortcutHelpState>((set, get) => ({
  open: false,
  overCoveringThread: false,
  focusRequested: false,
  openInPlace: () => set({ open: true, focusRequested: false, overCoveringThread: get().open ? get().overCoveringThread : threadCoveringNow() }),
  openWithFocus: () => set({ open: true, focusRequested: true, overCoveringThread: get().open ? get().overCoveringThread : threadCoveringNow() }),
  close: () => set({ open: false, focusRequested: false, overCoveringThread: false }),
  focusTaken: () => set({ focusRequested: false }),
}));

/** The panel's own element, so the Esc listener can tell a key pressed in it. */
export const SHORTCUT_HELP_PANEL_ID = "keyboard-shortcuts-panel";
/** The rail's Help button: the control the panel is opened from. */
export const HELP_MENU_TRIGGER_ID = "left-rail-help-trigger";

/**
 * The panel is open, so the docked profile or legacy task under it is
 * covered (inert, unseen). Their own Esc must not close them there: closing
 * the panel brings them back as they were.
 */
export function isCoveredByShortcutHelp(): boolean {
  return useShortcutHelpStore.getState().open;
}

/** ⌘/ / Ctrl+/: open the panel, leaving focus where it is, or close it. */
export function toggleShortcutHelpFromKeyboard(): void {
  const state = useShortcutHelpStore.getState();
  if (state.open) state.close();
  else state.openInPlace();
}

/**
 * Settings' "Customize" (the send key's card, the assistant's shortcut row): the panel, where shortcuts change,
 * opened with focus in it (#proj-frontend:#37: edits only in the panel; Settings links to it).
 */
export function openShortcutsToCustomize(): void {
  useShortcutHelpStore.getState().openWithFocus();
}
