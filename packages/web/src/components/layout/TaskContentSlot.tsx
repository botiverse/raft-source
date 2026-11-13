import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { PanelAction } from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";

import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useActivityUnreadSnapshot } from "../../store/activityUnreadSnapshot";
import { useInboxStore } from "../../store/inboxStore";
import type { InboxItem } from "../../store/inboxStore";
import { formatSearchOpenParam, useSearchContentStore } from "../../store/searchContentStore";
import type { SearchContentSlot } from "../../store/searchContentStore";
import { useTaskStore } from "../../store/taskStore";
import { useThreadStore } from "../../store/threadStore";
import { directTaskConversationChannelId, formatTaskConversationParam, isTaskConversationItem } from "../../utils/taskConversation";
import { slotItemKey } from "../../features/thread/threadsInboxHelpers";
import { TaskConversationPage } from "../task/taskConversationDialogChunk";
import { findKnownTaskById } from "../task/useTaskConversationTask";
import { ACTIVITY_MASTER_DETAIL_QUERY } from "../thread/activityLayout";
import { focusActivityRowAfterClose } from "../thread/activityRowFocus";
import AppEmptyState from "../ui/EmptyState";
import PanelHeader from "../ui/PanelHeader";
import { isContentSlotEntry, replaceEntryParams } from "./contentSlotEntry";
import { PanelLoading } from "./PanelLoading";

const SHRINK_PANEL_HEADER_CONTAINER_PROPS = { className: "shrink-0" };
const NO_ROWS: readonly InboxItem[] = [];

/** An Esc the page leaves alone: a field's (a composer's), an input method's, or one in a menu or popover over it. */
function isOthersEscape(event: KeyboardEvent<HTMLElement>): boolean {
  const target = event.target;
  if (event.defaultPrevented || event.nativeEvent.isComposing) return true;
  // A portalled menu or popover: its keys bubble here through React, not the DOM.
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) return true;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return document.querySelector("[role='menu'], [role='listbox']") !== null;
}

/** The task the slot names, as far as the client knows it: its channel and conversation. */
interface SlotTask {
  taskId: string;
  parentChannelId: string;
  conversationChannelId: string | null;
}

/** The slot's task from its Activity row (the unread snapshot's kept rows too) or the task lists, else null. */
function useKnownSlotTask(taskId: string, keptRows: readonly InboxItem[]): SlotTask | null {
  const row = useInboxStore((s) => s.items.find((item) => item.kind === "thread" && isTaskConversationItem(item) && item.taskId === taskId))
    ?? keptRows.find((item) => item.kind === "thread" && isTaskConversationItem(item) && item.taskId === taskId);
  const task = useTaskStore((s) => findKnownTaskById(s, taskId));
  return useMemo(() => {
    if (row?.kind === "thread") return { taskId, parentChannelId: row.parentChannelId, conversationChannelId: row.threadChannelId };
    if (task) return { taskId, parentChannelId: task.channelId, conversationChannelId: directTaskConversationChannelId(task) };
    return null;
  }, [row, task, taskId]);
}

/**
 * A task conversation opened from its Activity row, a Search hit or a row of
 * the Tasks page (stdrc):
 * the task dialog's frameless page, as in a task window, filling the main
 * area beside the list; on a phone a page pushed in place of the list, its
 * Back returning to it (useSearchContentUrlSync pops the entry). The task is
 * threadStore's taskModal slot, which RightPanel does not draw as the dialog
 * while this slot is open; the slot leaving closes it
 * (useSearchContentUrlSync). Inside it a person opens the app's profile panel
 * and an Artifact the shell's card, as in a thread shown here; another task
 * opened from it (a task ref) is the slot from then on. A message-keyed task
 * opened from it (pre-v2, a linked task's badge) is the dialog over it, and
 * closing that brings the slot's task back.
 */
export function TaskContentSlot({ slot, closeSlot, focusRowAfterClose }: {
  slot: SearchContentSlot;
  closeSlot: () => void;
  /** Where focus goes back to beside the list once it closes (the Tasks
   *  page: the task's row); by default the Activity row it was opened from. */
  focusRowAfterClose?: (taskId: string) => void;
}) {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const masterDetail = useMediaQuery(ACTIVITY_MASTER_DETAIL_QUERY);
  const modal = useThreadStore((s) => s.taskModal);
  const taskId = modal && !modal.parentMessageId ? modal.taskId ?? null : null;
  const keptRows = useActivityUnreadSnapshot()?.rows ?? NO_ROWS;
  const known = useKnownSlotTask(slot.id, keptRows);
  // The task this page last showed, and whether a message-keyed dialog has been over it since.
  const shownRef = useRef<SlotTask | null>(null);
  const coveredRef = useRef(false);
  const openedRef = useRef(false);
  if (taskId && modal?.parentChannelId) {
    shownRef.current = { taskId, parentChannelId: modal.parentChannelId, conversationChannelId: modal.threadChannelId };
  }

  // Another task opened from inside it: the slot (`?open=`, the open row) follows.
  useEffect(() => {
    if (!taskId || taskId === slot.id) return;
    useSearchContentStore.setState((state) => (
      state.slot?.kind === "task" && state.slot.id !== taskId ? { slot: { kind: "task", id: taskId } } : state
    ));
  }, [slot.id, taskId]);

  // The slot's task opened in place: `?task=` written first, in this entry, so
  // its sync pushes nothing. A message-keyed dialog over it closing brings it
  // back; an address naming only the slot (`?open=task:<id>`, no `?task=`)
  // opens it once its channel is known. Not after it closed from inside
  // (deleted; View in Channel on its way out): that is the unavailable state.
  useEffect(() => {
    if (modal) {
      openedRef.current = true;
      if (modal.parentMessageId) coveredRef.current = true;
      return;
    }
    const covered = coveredRef.current;
    coveredRef.current = false;
    const target = covered && shownRef.current?.taskId === slot.id ? shownRef.current : openedRef.current ? null : known;
    if (!target) return;
    // Only while the address is still this slot's: a dialog over it that closed on its way out (View in thread
    // writes the channel's address before its route commits) must not bring the task back over the channel.
    if (new URLSearchParams(window.location.search).get("open") !== formatSearchOpenParam({ kind: "task", id: slot.id })) return;
    openedRef.current = true;
    replaceEntryParams(navigate, (params) => params.set("task", formatTaskConversationParam(target.parentChannelId, target.taskId)));
    useThreadStore.getState().openTaskConversation({
      taskId: target.taskId,
      parentChannelId: target.parentChannelId,
      conversationChannelId: target.conversationChannelId,
    });
  }, [known, modal, navigate, slot.id]);

  // The page's own entry (a phone's) is popped: that drops ?open= and ?task=
  // together and the URL closes both, with no dialog between. Otherwise the
  // slot closes and takes its task along (useSearchContentUrlSync); beside
  // the list, focus goes back to the task's row (none on Search).
  const close = useCallback(() => {
    if (isContentSlotEntry() && new URLSearchParams(window.location.search).has("open")) {
      navigate(-1);
      return;
    }
    if (focusRowAfterClose) {
      closeSlot();
      if (masterDetail) focusRowAfterClose(slot.id);
      return;
    }
    const rowKey = slotItemKey(slot, [...useInboxStore.getState().items, ...keptRows]);
    closeSlot();
    if (masterDetail && !rowKey.startsWith("task:")) focusActivityRowAfterClose(rowKey);
  }, [closeSlot, focusRowAfterClose, keptRows, masterDetail, navigate, slot]);
  // Esc beside the list closes it, as an Artifact row's viewer; not a
  // field's Esc, nor one a menu or popover takes.
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !masterDetail || isOthersEscape(event)) return;
    event.preventDefault();
    close();
  }, [close, masterDetail]);

  let body;
  if (taskId) {
    body = (
      <Suspense fallback={<PanelLoading label={formatMessage({ id: "layout.main.loading" })} />}>
        {/* A phone's bar has Back where the desktop's has ×: both close the slot. */}
        <TaskConversationPage presentation={masterDetail ? "modal" : "mobile-modal"} page appProfiles onClose={close} />
      </Suspense>
    );
  } else if (modal?.parentMessageId) {
    // A message-keyed task's dialog is over it (RightPanel): the page waits under it.
    body = <div className="flex h-full min-h-0 w-full flex-col bg-layer-canvas" data-testid="task-content-slot-covered" />;
  } else {
    // Closed from inside (deleted; View in Channel, on its way out), or not known.
    body = (
      <div className="flex h-full min-h-0 w-full flex-col bg-layer-canvas">
        <PanelHeader
          title={formatMessage({ id: "layout.main.task" })}
          containerProps={SHRINK_PANEL_HEADER_CONTAINER_PROPS}
          onMobileBack={masterDetail ? undefined : close}
          backButtonVisibility="always"
          actions={masterDetail ? (
            <PanelAction onClick={close} aria-label={formatMessage({ id: "task.modal.close" })} data-testid="activity-task-gone-close">
              <X />
            </PanelAction>
          ) : undefined}
        />
        <AppEmptyState
          className="flex-1"
          icon={<ThreadIcon />}
          title={formatMessage({ id: "layout.main.taskUnavailable" })}
          data-testid="activity-task-gone"
        />
      </div>
    );
  }
  return (
    // Display contents: the page fills the main area as if this were not here.
    <div className="contents" onKeyDown={onKeyDown} data-testid="task-content-slot">{body}</div>
  );
}
