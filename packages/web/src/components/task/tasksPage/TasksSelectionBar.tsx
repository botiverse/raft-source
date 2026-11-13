import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { CircleDot, Trash2, User as UserIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuTrigger,
  DropdownMenuTrigger,
  Popover,
  PopoverTrigger,
  TaskStatusIcon,
} from "@botiverse/raft-ui";
import { FollowThreadIcon } from "@botiverse/ricons";
import {
  SelectionToolbar,
  SelectionToolbarAction,
  SelectionToolbarActions,
  SelectionToolbarClose,
  SelectionToolbarCount,
  SelectionToolbarCountValue,
  SelectionToolbarMore,
  SelectionToolbarMoreItems,
} from "@botiverse/raft-ui/wip";

import { useAuthStore } from "../../../store/authStore";
import type { Task, TaskStatus } from "../../../store/taskStore";
import AvatarSlot from "../../ui/AvatarSlot";
import SelectionPopover from "../../ui/SelectionPopover";
import { showToast } from "../../toastBridge";
import { TaskDeleteConfirmDialog } from "../TaskDeleteConfirmDialog";
import { TASK_STATUS_UI, toRuiTaskStatus } from "../taskStatusUi";
import { useTaskIdentityOptions } from "../useTaskIdentityOptions";
import { BOARD_STATUSES } from "./tasksPageApi";
import { canApplyBatchAction } from "./tasksBatch";
import type { BatchAction, BatchOutcome, TaskAssigneeRef } from "./tasksBatch";
import { useBatchViewer } from "./useBatchViewer";
import { focusLost } from "../../../utils/focusGuard";

/**
 * The bar over the Tasks page while tasks are selected (raft-ui
 * SelectionToolbar; the caller puts it in a SelectionToolbarDock): 已选 N,
 * then 状态 ▾ (set a status), 负责人 ▾ (assign to someone, or clear; with
 * the capability), 关注, 删除 (where a selected task is the viewer's to
 * delete), 更多, ×. What doesn't fit the width gives way (关注 / 删除 into
 * 更多, then the labels, then the menus into 更多 as submenus). Menus open
 * upward. Each action calls the per-task API for every selected task the
 * viewer may change that way (tasksBatch canApplyBatchAction, the rule of
 * the same change on one task), skips the rest, then says in a toast what
 * it did and how many it skipped; what the server refused stays selected.
 * Delete asks first (TaskDeleteConfirmDialog) and says there what the server
 * refused.
 */
export function TasksSelectionBar({ tasks, runBatch, onClear, onGone }: {
  /** The selected tasks still in the page's lists. */
  tasks: readonly Task[];
  /** Runs an action on them (TasksPage: one at a time; it ends the selection, but for what failed); null when one runs already. */
  runBatch: (action: BatchAction) => Promise<BatchOutcome | null>;
  onClear: () => void;
  /** The bar went (Esc, ×, an action done) while focus was in it, or lost: a focus restore (useFocusRestore). */
  onGone: () => void;
}) {
  const { formatMessage } = useIntl();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const viewer = useBatchViewer();
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const count = tasks.length;

  // Before the bar leaves the page: focus in it (or in its delete confirm, or lost to the page's body) goes back to
  // the list, not to nowhere.
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  useLayoutEffect(() => {
    const bar = document.querySelector('[data-testid="tasks-page-selection-bar"]');
    return () => {
      const active = document.activeElement;
      const inBar = !!active && (bar?.contains(active) || active.closest('[data-testid="tasks-batch-delete-confirm"]') !== null);
      if (inBar || focusLost()) onGoneRef.current();
    };
  }, []);

  const run = useCallback(async (action: BatchAction, describe: (outcome: BatchOutcome) => string) => {
    setBusy(true);
    try {
      const outcome = await runBatch(action);
      if (!outcome) return;
      showToast({ title: describe(outcome), type: outcome.done === 0 ? "error" : undefined });
    } finally {
      setBusy(false);
    }
  }, [runBatch]);

  const setStatus = useCallback((status: TaskStatus) => {
    const statusLabel = formatMessage({ id: TASK_STATUS_UI[status].labelId });
    void run({ kind: "status", status }, ({ done, skipped }) => formatMessage(
      { id: "task.page.batch.statusDone" },
      { count: done, status: statusLabel, skipped },
    ));
  }, [formatMessage, run]);

  const identityOptions = useTaskIdentityOptions();
  const [search, setSearch] = useState("");
  const onAssigneeOpenChange = useCallback((open: boolean) => {
    if (open) setSearch("");
    setAssigneeOpen(open);
  }, []);
  const assign = useCallback((assignee: TaskAssigneeRef | null, name: string) => {
    setAssigneeOpen(false);
    void run({ kind: "assignee", assignee }, ({ done, skipped }) => (assignee
      ? formatMessage({ id: "task.page.batch.assignDone" }, { count: done, name, skipped })
      : formatMessage({ id: "task.page.batch.unassignDone" }, { count: done, skipped })));
  }, [formatMessage, run]);
  const assigneeOptions = useMemo(() => {
    const me = userId ? `user:${userId}` : null;
    const needle = search.trim().toLowerCase();
    const people = identityOptions.filter((option) => option.key !== me
      && (!needle || option.label.toLowerCase().includes(needle) || option.handle.toLowerCase().includes(needle)));
    const youLabel = formatMessage({ id: "task.page.batch.assignToMe" });
    const noneLabel = formatMessage({ id: "task.filter.unassigned" });
    const sentinels = [
      ...(userId && (!needle || youLabel.toLowerCase().includes(needle))
        ? [{ key: "me", checked: false, label: youLabel, italic: true, reserveLeadingSlot: true, onClick: () => assign({ type: "user", id: userId }, formatMessage({ id: "task.page.batch.you" })) }]
        : []),
      ...(!needle || noneLabel.toLowerCase().includes(needle)
        ? [{ key: "none", checked: false, label: noneLabel, italic: true, reserveLeadingSlot: true, onClick: () => assign(null, noneLabel) }]
        : []),
    ];
    return [
      ...sentinels,
      ...people.map((option) => ({
        key: option.key,
        checked: false,
        label: option.label,
        reserveLeadingSlot: true,
        avatar: (
          <AvatarSlot
            context="compact-list"
            type={option.type === "agent" ? "agent" : "human"}
            agentAvatarUrl={option.type === "agent" ? option.avatarUrl ?? null : null}
            humanAvatarUrl={option.type === "user" ? option.avatarUrl ?? null : null}
          />
        ),
        onClick: () => assign({ type: option.type, id: option.id }, option.label),
      })),
    ];
  }, [assign, formatMessage, identityOptions, search, userId]);

  const follow = useCallback(() => {
    void run({ kind: "follow" }, ({ done, skipped }) => formatMessage({ id: "task.page.batch.followDone" }, { count: done, skipped }));
  }, [formatMessage, run]);
  // Delete waits in its confirmation (the red button loading) and closes it once every task it may delete is gone.
  // What the server refused stays selected and is said in the dialog, to try again.
  const remove = useCallback(async (): Promise<string | null> => {
    setBusy(true);
    try {
      const outcome = await runBatch({ kind: "delete" });
      if (!outcome) return null;
      if (outcome.failedIds.length > 0) return formatMessage({ id: "task.page.batch.deleteFailed" }, { count: outcome.failedIds.length });
      setConfirmingDelete(false);
      showToast({ title: formatMessage({ id: "task.page.batch.deleteDone" }, { count: outcome.done, skipped: outcome.skipped }) });
      return null;
    } finally {
      setBusy(false);
    }
  }, [formatMessage, runBatch]);
  const askDelete = useCallback(() => setConfirmingDelete(true), []);

  const statusLabel = formatMessage({ id: "task.properties.status" });
  const assigneeLabel = formatMessage({ id: "task.filter.assignee" });
  const followLabel = formatMessage({ id: "task.page.batch.follow" });
  const deleteLabel = formatMessage({ id: "task.page.batch.delete" });
  const moreLabel = formatMessage({ id: "task.page.batch.more" });
  const clearLabel = formatMessage({ id: "task.page.batch.clear" });
  // Delete shows where it would delete something: a selected task the viewer created, or deleteAnyTask.
  const canDelete = tasks.some((task) => canApplyBatchAction({ kind: "delete" }, task, viewer));

  const statusItems = BOARD_STATUSES.map((status) => <StatusMenuItem key={status} status={status} onPick={setStatus} />);
  // In More, 负责人 is a submenu: me, no one, then everyone the picker lists (no search there).
  const assigneeMoreItems = useMemo(() => {
    const me = userId ? `user:${userId}` : null;
    const noneLabel = formatMessage({ id: "task.filter.unassigned" });
    return [
      ...(userId
        ? [<AssigneeMenuItem key="me" label={formatMessage({ id: "task.page.batch.assignToMe" })} assigneeType="user" assigneeId={userId} name={formatMessage({ id: "task.page.batch.you" })} onPick={assign} />]
        : []),
      <AssigneeMenuItem key="none" label={noneLabel} name={noneLabel} onPick={assign} />,
      ...identityOptions.filter((option) => option.key !== me).map((option) => (
        <AssigneeMenuItem key={option.key} label={option.label} assigneeType={option.type} assigneeId={option.id} name={option.label} onPick={assign} />
      )),
    ];
  }, [assign, formatMessage, identityOptions, userId]);

  return (
    <>
      <SelectionToolbar aria-label={formatMessage({ id: "task.page.batch.aria" })} data-testid="tasks-page-selection-bar">
        <SelectionToolbarCount data-testid="selection-toolbar-count">
          {formatMessage(
            { id: "ui.selectionToolbar.count" },
            { count, number: <SelectionToolbarCountValue key="n">{count}</SelectionToolbarCountValue> },
          )}
        </SelectionToolbarCount>
        <SelectionToolbarActions>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              render={(
                <SelectionToolbarAction
                  menu
                  // Neutral, as the toolbar's 状态 filter: the selected tasks may have any status (the items keep theirs).
                  icon={<CircleDot aria-hidden />}
                  disabled={busy}
                  data-testid="tasks-batch-status"
                  moreItem={(
                    <DropdownMenuSubmenu>
                      <DropdownMenuSubmenuTrigger disabled={busy} data-testid="tasks-batch-more-status">
                        <CircleDot aria-hidden />
                        {statusLabel}
                      </DropdownMenuSubmenuTrigger>
                      <DropdownMenuContent aria-label={statusLabel}>{statusItems}</DropdownMenuContent>
                    </DropdownMenuSubmenu>
                  )}
                >
                  {statusLabel}
                </SelectionToolbarAction>
              )}
            />
            <DropdownMenuContent side="top" align="start" sideOffset={8} aria-label={statusLabel}>
              {statusItems}
            </DropdownMenuContent>
          </DropdownMenu>
          {viewer.canAssign ? (
            // The searchable picker is a Popover, not a menu: the action is its trigger.
            <Popover open={assigneeOpen} onOpenChange={onAssigneeOpenChange}>
              <PopoverTrigger
                disabled={busy}
                render={(
                  <SelectionToolbarAction
                    menu
                    icon={<UserIcon aria-hidden />}
                    disabled={busy}
                    data-testid="tasks-batch-assignee"
                    moreItem={(
                      <DropdownMenuSubmenu>
                        <DropdownMenuSubmenuTrigger disabled={busy} data-testid="tasks-batch-more-assignee">
                          <UserIcon size={14} aria-hidden />
                          {assigneeLabel}
                        </DropdownMenuSubmenuTrigger>
                        <DropdownMenuContent aria-label={formatMessage({ id: "task.page.batch.assignTo" })}>
                          {assigneeMoreItems}
                        </DropdownMenuContent>
                      </DropdownMenuSubmenu>
                    )}
                  >
                    {assigneeLabel}
                  </SelectionToolbarAction>
                )}
              />
              <SelectionPopover
                side="top"
                title={formatMessage({ id: "task.page.batch.assignTo" })}
                searchable
                search={search}
                onSearchChange={setSearch}
                options={assigneeOptions}
                className="w-64"
              />
            </Popover>
          ) : null}
          <SelectionToolbarAction secondary icon={<FollowThreadIcon aria-hidden />} disabled={busy} onClick={follow} data-testid="tasks-batch-follow">
            {followLabel}
          </SelectionToolbarAction>
          {canDelete ? (
            <SelectionToolbarAction secondary icon={<Trash2 aria-hidden />} disabled={busy} onClick={askDelete} data-testid="tasks-batch-delete">
              {deleteLabel}
            </SelectionToolbarAction>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              render={<SelectionToolbarMore aria-label={moreLabel} title={moreLabel} disabled={busy} data-testid="tasks-batch-more" />}
            />
            <DropdownMenuContent side="top" align="end" sideOffset={8} aria-label={moreLabel}>
              <SelectionToolbarMoreItems />
            </DropdownMenuContent>
          </DropdownMenu>
        </SelectionToolbarActions>
        <SelectionToolbarClose aria-label={clearLabel} title={clearLabel} onClick={onClear} data-testid="selection-toolbar-clear" />
      </SelectionToolbar>
      <TaskDeleteConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={formatMessage({ id: "task.page.batch.deleteConfirm" }, { count })}
        count={count}
        confirmLabel={formatMessage({ id: "task.page.batch.deleteAction" }, { count })}
        onConfirm={remove}
        testId="tasks-batch-delete-confirm"
      />
    </>
  );
}

function StatusMenuItem({ status, onPick }: { status: TaskStatus; onPick: (status: TaskStatus) => void }) {
  const { formatMessage } = useIntl();
  const pick = useCallback(() => onPick(status), [onPick, status]);
  return (
    <DropdownMenuItem onClick={pick} data-testid={`tasks-batch-status-${status}`}>
      <TaskStatusIcon status={toRuiTaskStatus(status)} aria-hidden />
      {formatMessage({ id: TASK_STATUS_UI[status].labelId })}
    </DropdownMenuItem>
  );
}

/** One choice of 负责人's submenu in More; without an assignee it clears it. */
function AssigneeMenuItem({ label, assigneeType, assigneeId, name, onPick }: {
  label: string;
  assigneeType?: TaskAssigneeRef["type"];
  assigneeId?: string;
  name: string;
  onPick: (assignee: TaskAssigneeRef | null, name: string) => void;
}) {
  const pick = useCallback(
    () => onPick(assigneeType && assigneeId ? { type: assigneeType, id: assigneeId } : null, name),
    [assigneeId, assigneeType, name, onPick],
  );
  return <DropdownMenuItem onClick={pick}>{label}</DropdownMenuItem>;
}
