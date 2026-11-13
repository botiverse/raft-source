// How the message box sends (#triage:#210): the account's choice (shared
// composerSendKey.ts), read by every MessageInput (channel, thread, DM, task
// conversation, the assistant's popover, attachment comments, forward) through
// `composerEnterAction`, the one place that decides what Enter does.
//
// - "enter" (default): Enter sends, Shift+Enter is a new line.
// - "mod_enter": ⌘Enter / Ctrl+Enter sends; Enter and Shift+Enter are new lines.
//
// In both, ⌘/Ctrl+Shift+Enter sends as a task where the box offers it, and a
// key pressed while an IME is composing never sends. The mention and channel
// menus take Enter/Tab before this is asked (MessageInput), in both modes.

import { normalizeComposerSendKey } from "@botiverse/raft-shared";
import type { ComposerSendKey } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";

export type { ComposerSendKey };

/** The send shortcut in "mod_enter" mode: ⌘Enter on Apple platforms, Ctrl+Enter elsewhere. */
export const MOD_ENTER_SEND_SHORTCUT: ShortcutCombo = { mod: true, key: "Enter" };

export interface ComposerKeyEvent {
  key: string;
  keyCode?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

/** An IME is composing (Chinese, Japanese, Korean input): Enter picks a candidate, never sends. */
export function isImeComposing(event: ComposerKeyEvent): boolean {
  return !!(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229);
}

export type ComposerEnterAction = "send" | "sendAsTask" | "newline";

/**
 * What a keydown in the message box does: send, send as a task, or a new line
 * (the browser's own, so the caller does nothing); null when it isn't Enter or
 * an IME is composing. `touchPortrait` (read from the viewport when not
 * given): a phone, or a tablet held upright, whose primary pointer is touch,
 * where in "enter" mode plain Enter is a new line and the Send button sends.
 */
export function composerEnterAction(
  event: ComposerKeyEvent,
  mode: ComposerSendKey,
  { sendAsTask = false, touchPortrait }: { sendAsTask?: boolean; touchPortrait?: boolean } = {},
): ComposerEnterAction | null {
  if (event.key !== "Enter" || isImeComposing(event)) return null;
  const mod = !!(event.metaKey || event.ctrlKey);
  if (mod && event.shiftKey && sendAsTask) return "sendAsTask";
  if (event.shiftKey) return "newline";
  if (mode === "mod_enter") return mod ? "send" : "newline";
  return (touchPortrait ?? isTouchPortrait()) ? "newline" : "send";
}

/** Phones in any orientation and tablets held upright, with touch as the primary pointer (cindyz #proj-uiux:3e2aa689). */
export function isTouchPortrait(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse) and (orientation: portrait)").matches;
}

/** The account's choice; the default ("enter") when unset, signed out, or from an older server. */
export function useComposerSendKey(): ComposerSendKey {
  return useAuthStore((state) => normalizeComposerSendKey(state.user?.composerSendKey));
}

/**
 * Shows the change at once and saves it to the account (PATCH /auth/me); a
 * failed save puts the previous value back (unless a later change replaced it)
 * and rethrows.
 */
export async function saveComposerSendKey(mode: ComposerSendKey): Promise<void> {
  const user = useAuthStore.getState().user;
  if (!user) return;
  const previous = user.composerSendKey ?? null;
  const next = mode === "mod_enter" ? "mod_enter" : null;
  useAuthStore.setState({ user: { ...user, composerSendKey: next } });
  const stillThis = () => {
    const current = useAuthStore.getState().user;
    return current && (current.composerSendKey ?? null) === next ? current : null;
  };
  try {
    const { data } = await api.patch("/auth/me", { composerSendKey: mode });
    const current = stillThis();
    if (current && data && "composerSendKey" in data) {
      useAuthStore.setState({ user: { ...current, composerSendKey: data.composerSendKey ?? null } });
    }
  } catch (err) {
    const current = stillThis();
    if (current) useAuthStore.setState({ user: { ...current, composerSendKey: previous } });
    throw err;
  }
}
