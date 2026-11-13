import { useCallback, useEffect, useRef, useState } from "react";

import type { ProfilePanelTarget } from "../profile/ProfilePanel";
import { useFocusRestore } from "../../hooks/useFocusRestore";
import { interceptTaskConversationDismiss } from "./taskConversationDialogChunk";

const EMPTY_STACK: ProfilePanelTarget[] = [];

/**
 * The profiles open in the task dialog, as an embedded page stack (the channel
 * members page's pattern): an avatar in the conversation, the head or the bar
 * starts it, one opened from a profile (an agent's creator) goes on top. It
 * belongs to the task: another task opened in place starts with none.
 *
 * Escape and the backdrop close the profile before the dialog, wherever focus
 * is in it (MainLayout's Modal asks through dismissTaskConversationDialog), and
 * closing it returns focus to what opened it if the close lost it
 * (useFocusRestore).
 */
export function useTaskProfileStack(taskId: string | null) {
  const [state, setState] = useState<{ taskId: string | null; stack: ProfilePanelTarget[] }>({ taskId, stack: EMPTY_STACK });
  const stack = state.taskId === taskId ? state.stack : EMPTY_STACK;
  const openerRef = useRef<HTMLElement | null>(null);

  const open = useCallback((type: "agent" | "human", id: string) => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setState({ taskId, stack: [{ type, id }] });
  }, [taskId]);
  const openNested = useCallback((type: "agent" | "human", id: string) => {
    setState((prev) => ({ taskId, stack: [...(prev.taskId === taskId ? prev.stack : EMPTY_STACK), { type, id }] }));
  }, [taskId]);
  const back = useCallback(() => {
    setState((prev) => ({ taskId, stack: prev.taskId === taskId ? prev.stack.slice(0, -1) : EMPTY_STACK }));
  }, [taskId]);
  const restoreFocus = useFocusRestore(openerRef);
  const close = useCallback(() => {
    setState({ taskId, stack: EMPTY_STACK });
    restoreFocus();
  }, [restoreFocus, taskId]);

  const isOpen = stack.length > 0;
  useEffect(() => {
    if (!isOpen) return undefined;
    return interceptTaskConversationDismiss(() => {
      close();
      return true;
    });
  }, [close, isOpen]);

  return { stack, profile: stack.at(-1) ?? null, open, openNested, back, close };
}
