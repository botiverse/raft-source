import { createContext, useCallback, useContext } from "react";
import { useNavigate } from "react-router-dom";
import type { NavigateFunction } from "react-router-dom";

import { useSearchContentStore } from "../../store/searchContentStore";
import { useThreadStore } from "../../store/threadStore";
import { isContentSlotEntry, replaceEntryParams } from "./contentSlotEntry";

export interface DetailSlotThreadTarget {
  parentChannelId: string;
  parentMessageId: string;
  threadChannelId?: string | null;
  focusedMessageId?: string | null;
}

/**
 * A thread opened from inside Activity's or Search's detail slot (a thread or
 * a task shown there: a thread link in a message, a task's Earlier
 * discussion) stays on the page: it takes the slot's place, as picking a
 * thread row does, instead of leaving for its channel (stdrc). Provided only
 * around those slots (MainLayout); null elsewhere, where the opener goes its
 * usual way. False: it could not (no thread channel known yet), the opener
 * goes its usual way too.
 */
export const DetailSlotThreadContext = createContext<((target: DetailSlotThreadTarget) => boolean) | null>(null);

export function useDetailSlotThreadOpener(): ((target: DetailSlotThreadTarget) => boolean) | null {
  return useContext(DetailSlotThreadContext);
}

/**
 * The slot's opener: the thread in the detail slot, `?open=thread:<id>&thread=<parent>`.
 * On a phone's page (its entry marked, useSearchContentUrlSync) the thread
 * replaces what it shows in that one entry, mark kept, so its Back still pops
 * to the list: `?thread=` goes in first, in place, and the thread's own sync
 * then pushes nothing. Beside the list the thread is a new entry, as ever.
 */
export function openThreadInDetailSlot(target: DetailSlotThreadTarget, navigate?: NavigateFunction): boolean {
  const { parentChannelId, parentMessageId, threadChannelId, focusedMessageId = null } = target;
  if (!threadChannelId) return false;
  if (navigate && isContentSlotEntry()) {
    replaceEntryParams(navigate, (params) => {
      // In the order the thread's sync writes them (thread, then task), so it finds nothing to change.
      const task = params.get("task");
      params.delete("task");
      params.set("thread", `${parentChannelId}:${parentMessageId}`);
      if (task) params.set("task", task);
    });
  }
  void useThreadStore.getState().openThread({ parentChannelId, parentMessageId, threadChannelId, focusedMessageId });
  useSearchContentStore.getState().open({ kind: "thread", id: threadChannelId, ...(focusedMessageId ? { messageId: focusedMessageId } : {}) });
  return true;
}

/** openThreadInDetailSlot with the router's navigate: the value MainLayout provides. */
export function useThreadInDetailSlotOpener(): (target: DetailSlotThreadTarget) => boolean {
  const navigate = useNavigate();
  return useCallback((target: DetailSlotThreadTarget) => openThreadInDetailSlot(target, navigate), [navigate]);
}
