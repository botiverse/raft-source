import { useCallback, useMemo, useState, useEffect, useLayoutEffect, useRef } from "react";
import { authorizeTaskAction } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MessageId } from "../../i18n/messages";

import AvatarSlot from "../ui/AvatarSlot";
import SectionEyebrow from "../ui/SectionEyebrow";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { useAuthStore } from "../../store/authStore";
import { useTaskStore } from "../../store/taskStore";
import type { Task, TaskHistoryEvent, TaskStatus } from "../../store/taskStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm } from "@botiverse/raft-ui";

import InlineBadgeEditor from "../InlineBadgeEditor";
import { HistoryTimeline } from "./HistoryTimeline";
import { TaskAssigneeAvatar, TaskAssigneeLabel } from "./TaskAssignee";
import { TaskBacklogReasonPopover } from "./TaskBacklogReasonPopover";
import { TaskHandoffReasonPanel } from "./TaskHandoffReasonPanel";

import { STATUS_STYLES, canEditTaskStatus, getTaskStatusOptions, toRuiTaskStatus } from "./taskStatusUi";
import { StatusBadge } from "./StatusBadge";
import { dedupeTaskAssigneeMembers } from "./taskAssigneeCandidates";

const EMPTY_HISTORY: TaskHistoryEvent[] = [];

/**
 * The Notion-style Properties region for a task.
 *
 * Two of these properties are writes and the rest are facts:
 *  - **Status** — member-level since #5829; the option list comes from
 *    `getTaskStatusOptions`, which offers legal transitions only (admins get
 *    the full set). We do not re-implement the transition table here.
 *  - **Assignee** — `PATCH /tasks/:id/assignee`, live since #5829 and until now
 *    with no caller in the browser at all. This property is the reason a human
 *    could change a task's status but could not hand it to anyone.
 *
 * The candidate list is `useChannelMembers` — the same source the @-mention
 * autocomplete uses, so it needs no new endpoint and is already scoped to this
 * channel. Scoping to channel members is also why this picker does not have to
 * reproduce the agent CLI's deliberately-opaque "not assignable here" answer:
 * a non-member is never offered, so there is no identity to probe.
 */

/** Sentinel for "no assignee". Clearing is the same write with a null assignee,
 *  so it is an option in the one picker rather than a second control. */
const UNASSIGN_ID = "unassign";

/** Ids are type-prefixed because a human and an agent can hold the same raw id. */
function assigneeOptionId(type: "user" | "agent", id: string): string {
  return `${type}:${id}`;
}

function mentionLabel(name: string): string {
  return `@${name}`;
}

export default function TaskProperties({ task, sourceRow, trailingRows, assigneeAsPerson = false, onOpenProfile }: {
  task: Task;
  /** Task v2 dialog: the assignee's avatar opens their profile, as a sender's
   *  avatar does in a conversation. It is a button of its own beside the
   *  picker's trigger (a button cannot hold another). */
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  /** Task v2: the assignee reads as on every task row — avatar and display
   *  name, "You" for the reader. */
  assigneeAsPerson?: boolean;
  /** Task v2: the Source fact, placed after Assignee (absent: no row). */
  sourceRow?: React.ReactNode;
  /** Task v2: facts after Created by (Created at, Earlier discussion). */
  trailingRows?: React.ReactNode;
}) {
  const { formatMessage } = useIntl();
  const currentUser = useAuthStore((s) => s.user);
  const { capabilities } = useServerPermissions();
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const updateTaskAssignee = useTaskStore((s) => s.updateTaskAssignee);
  const history = useTaskStore((s) => s.taskHistoryByTaskId[task.id] ?? EMPTY_HISTORY);
  const historyError = useTaskStore((s) => s.taskHistoryErrorByTaskId[task.id] ?? false);
  const registerTaskHistoryConsumer = useTaskStore((s) => s.registerTaskHistoryConsumer);
  const historyGeneration = useTaskStore((s) => s.taskHistoryGeneration);

  const { channelAgents, channelHumans } = useChannelMembers(task.channelId);
  const [openEditor, setOpenEditor] = useState<"status" | "backlogReason" | "assignee" | null>(null);
  const statusChipRef = useRef<HTMLButtonElement>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  // Someone other than you, chosen in the assignee picker: the reason step
  // (TaskHandoffReasonPanel) shows in the picker before the write.
  const [handoffTarget, setHandoffTarget] = useState<{ type: "user" | "agent"; id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Task history is a store-owned read model. The socket task:updated bridge
  // requests a refresh for observed tasks, so manual and Agent mutations share
  // the same update path while this mounted dialog simply subscribes.
  useEffect(() => registerTaskHistoryConsumer(task.id), [registerTaskHistoryConsumer, task.id, historyGeneration]);
  // Resource receipts are an advanced CLI-only task capability. They are not
  // useful in the person-facing task timeline, so keep those internal events
  // out of the UI while the API remains available to CLI clients.
  const visibleHistory = useMemo(
    () => history.filter((event) => event.eventType !== "resource_receipt_recorded"),
    [history],
  );

  const canManageServer = capabilities.deleteAnyTask;
  const canEditStatus = canEditTaskStatus(task, currentUser?.id, canManageServer);
  // Completed tasks are immutable by contract: the server freezes their
  // assignee so the completion record remains historically accurate. Keep the
  // control read-only here too, instead of showing a picker that can only fail
  // with `task is done` after the user makes a selection.
  const canEditAssignee = task.status !== "done" && authorizeTaskAction({ action: "assign", canReadChannel: true, canWriteChannel: true, readOnlyReason: task.readOnlyReason });
  const assigneeReadOnlyTitle = task.readOnlyReason
    ? formatMessage({ id: "task.permissions.historicalJoint" })
    : task.status === "done"
      ? formatMessage({ id: "task.permissions.done" })
      : undefined;
  const currentUserId = currentUser?.id;
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const statusOptions = useMemo(
    () => getTaskStatusOptions(task, currentUserId, canManageServer, taskV2)
      .map((option) => ({ id: option.id, label: formatMessage({ id: option.labelId }) })),
    [task, currentUserId, canManageServer, taskV2, formatMessage],
  );

  const unassignedLabel = formatMessage({ id: "task.properties.unassigned" });

  // Filtered here rather than inside the popover: SelectionPopover renders the
  // list it is given, exactly as the search page's filters do. Matching is on
  // the visible label — matching an id the user cannot read would make the list
  // appear to filter at random. Humans first, then agents; "unassign" always
  // survives so clearing never requires emptying the box first.
  const assigneeOptions = useMemo(() => {
    const needle = assigneeSearch.trim().toLowerCase();
    const people = [
      ...dedupeTaskAssigneeMembers(channelHumans).map((h) => ({
        id: assigneeOptionId("user", h.id),
        label: h.displayName || h.name,
        avatar: (
          <AvatarSlot
            context="compact-list"
            type="human"
            humanAvatarUrl={h.avatarUrl}
          />
        ),
      })),
      ...dedupeTaskAssigneeMembers(channelAgents).map((a) => ({
        id: assigneeOptionId("agent", a.id),
        label: a.displayName || a.name,
        avatar: <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={a.avatarUrl ?? null} />,
      })),
    ].filter((o) => !needle || o.label.toLowerCase().includes(needle));
    return [{ id: UNASSIGN_ID, label: unassignedLabel }, ...people];
  }, [assigneeSearch, channelAgents, channelHumans, unassignedLabel]);

  const selectedAssigneeId = task.claimedById && task.claimedByType
    ? assigneeOptionId(task.claimedByType, task.claimedById)
    : UNASSIGN_ID;
  // The server sends the *handle* here (`handleMap` is built from `users.name`),
  // so a real server would list "Richard Chien" in the picker and then show
  // "@stdrc" in the badge for the same pick. Resolve the display name from the
  // members we already have and fall back to the server's handle only when the
  // person is no longer a channel member. @stdrc msg=207ca92b: names should read
  // as display names, like everywhere else.
  const displayNameFor = useCallback((type: "agent" | "user", id: string): string | null => {
    const found = type === "agent"
      ? channelAgents.find((a) => a.id === id)
      : channelHumans.find((h) => h.id === id);
    return found ? found.displayName || found.name : null;
  }, [channelAgents, channelHumans]);

  const assigneeDisplay = task.claimedById && task.claimedByType
    ? displayNameFor(task.claimedByType, task.claimedById)
      ?? mentionLabel(task.claimedByName || formatMessage({ id: "task.properties.unknown" }))
    : unassignedLabel;
  const assigneeIdentity = task.claimedByType === "agent"
    ? channelAgents.find((a) => a.id === task.claimedById)
    : channelHumans.find((h) => h.id === task.claimedById);
  const claimedById = task.claimedById;
  const claimedByKind = task.claimedByType === "agent" ? "agent" : "human";
  const assigneeProfileButton = assigneeAsPerson && onOpenProfile && claimedById && task.claimedByType ? (
    <button
      type="button"
      onClick={() => onOpenProfile(claimedByKind, claimedById)}
      aria-label={formatMessage({ id: "task.properties.openAssigneeProfile" }, { name: assigneeDisplay })}
      className="shrink-0 self-center rounded-sticker outline-none hover:brightness-90 focus-visible:shadow-focus"
      data-testid="task-properties-assignee-avatar"
    >
      <TaskAssigneeAvatar task={task} identity={assigneeIdentity} />
    </button>
  ) : null;
  const createdByDisplay = displayNameFor(task.createdByType, task.createdById)
    ?? mentionLabel(task.createdByName || formatMessage({ id: "task.properties.unknown" }));

  const handleStatusSelect = useCallback(async (id: string) => {
    if (!canEditStatus) return;
    const next = id as TaskStatus;
    if (next === task.status) {
      setOpenEditor(null);
      return;
    }
    if (next === "backlog") {
      // A move into Backlog asks for a reason first; the popover makes the write.
      setOpenEditor("backlogReason");
      return;
    }
    // A pick closes the list at once, as a menu's does, and the write follows: Esc right after it then
    // reaches the dialog the properties sit in instead of a list still open on the write.
    setOpenEditor(null);
    setBusy(true);
    try {
      await updateTaskStatus(task.channelId, task.id, next);
    } catch (err) {
      console.error("Failed to update task status:", err);
    } finally {
      setBusy(false);
    }
  }, [canEditStatus, task.status, task.channelId, task.id, updateTaskStatus]);

  const handleAssigneeSelect = useCallback(async (id: string) => {
    if (!canEditAssignee) return;
    if (id === selectedAssigneeId) {
      setOpenEditor(null);
      return;
    }
    // No OCC token yet: the web `Task` type does not carry `revision`, so there
    // is nothing honest to send. `updateTaskAssignee` already accepts one — wire
    // it through the moment the type exposes the field, rather than inventing a
    // value here that the server would treat as authoritative.
    const [type, rawId] = id === UNASSIGN_ID ? [null, null] : id.split(":");
    // Handing it to someone else asks what it waits on them for first (the
    // reason is optional); taking it yourself or clearing it applies at once.
    if (type && rawId && !(type === "user" && rawId === currentUserId)) {
      const name = assigneeOptions.find((option) => option.id === id)?.label ?? displayNameFor(type as "user" | "agent", rawId) ?? "";
      setHandoffTarget({ type: type as "user" | "agent", id: rawId, name });
      return;
    }
    setOpenEditor(null);
    setBusy(true);
    try {
      await updateTaskAssignee(
        task.channelId,
        task.id,
        type && rawId ? { type: type as "user" | "agent", id: rawId } : null,
      );
    } catch (err) {
      console.error("Failed to update task assignee:", err);
    } finally {
      setBusy(false);
    }
  }, [assigneeOptions, canEditAssignee, currentUserId, displayNameFor, selectedAssigneeId, task.channelId, task.id, updateTaskAssignee]);

  const handleHandoffSubmit = useCallback(async (reason: string) => {
    if (!handoffTarget) return;
    // The chip is disabled while the hand-off is on its way, as for any other pick.
    setBusy(true);
    try {
      await updateTaskAssignee(task.channelId, task.id, { type: handoffTarget.type, id: handoffTarget.id }, undefined, reason);
    } finally {
      setBusy(false);
    }
    setHandoffTarget(null);
    setOpenEditor(null);
  }, [handoffTarget, task.channelId, task.id, updateTaskAssignee]);
  const handleHandoffCancel = useCallback(() => setHandoffTarget(null), []);

  const toggleStatusEditor = useCallback(() => {
    setOpenEditor((cur) => (cur === "status" ? null : "status"));
  }, []);
  const toggleAssigneeEditor = useCallback(() => {
    setAssigneeSearch("");
    setHandoffTarget(null);
    setOpenEditor((cur) => (cur === "assignee" ? null : "assignee"));
  }, []);
  const closeEditor = useCallback(() => {
    setHandoffTarget(null);
    setOpenEditor(null);
  }, []);
  const toggleHistory = useCallback(() => setHistoryOpen((v) => !v), []);

  // Same editor as Status, so the property reads the same — but
  // `searchable`, so the panel is the search page's SelectionPopover
  // rather than a plain list. A server's member list is long and humans
  // are assignable too, so this one has to be typed into; Status never
  // will be (@stdrc msg=c8c890d2, msg=4c357cb1).
  const assigneeEditor = (
    <InlineBadgeEditor
      displayValue={assigneeDisplay}
      selectedId={selectedAssigneeId}
      options={assigneeOptions}
      onSelect={handleAssigneeSelect}
      open={canEditAssignee && openEditor === "assignee"}
      onToggle={toggleAssigneeEditor}
      onRequestClose={closeEditor}
      badgeClassName="bg-transparent text-foreground"
      disabled={busy || !canEditAssignee}
      buttonTitle={assigneeReadOnlyTitle}
      buttonChildren={assigneeAsPerson && task.claimedById ? (
        <>
          <TaskAssigneeLabel
            task={task}
            identity={assigneeIdentity}
            viewerId={currentUserId}
            testId="task-properties-assignee-person"
            property
            avatar={!assigneeProfileButton}
          />
          <ChevronDown size={12} aria-hidden="true" className="shrink-0 self-center" />
        </>
      ) : undefined}
      // The name sits on the facts' baseline and gives the trigger its
      // baseline; the avatar and the chevron are centered in it (marks
      // do not take part in baseline alignment). No top nudge.
      // overflow-visible: the agent avatar's presence badge hangs past
      // the avatar's corner and the trigger's box; the Badge's own
      // overflow-hidden cut its bottom. The name truncates itself.
      buttonClassName={assigneeAsPerson && task.claimedById ? "mt-0 inline-flex h-auto items-baseline gap-1 overflow-visible bg-transparent text-foreground disabled:cursor-not-allowed" : undefined}
      buttonTestId="task-properties-assignee"
      dropdownTestId="task-assignee-dropdown"
      searchable
      search={assigneeSearch}
      onSearchChange={setAssigneeSearch}
      searchPlaceholder={formatMessage({ id: "task.assignee.searchPlaceholder" })}
      popoverTitle={formatMessage({ id: "task.properties.assignee" })}
      panel={handoffTarget ? (
        <TaskHandoffReasonPanel
          key={`${handoffTarget.type}:${handoffTarget.id}`}
          name={handoffTarget.name}
          onSubmit={handleHandoffSubmit}
          onCancel={handleHandoffCancel}
        />
      ) : null}
    />
  );

  // @artin asked for one horizontal facts row in #proj-task:142b9b9a. Keep
  // each label/value pair together, but let the row wrap on narrow panels.
  // raft-ui's `direction="inline"` is exactly that row: every label and value
  // on one first baseline, values 12px after their label, and a value drawn in
  // a shape (the status chip, the assignee trigger's badge fill) hangs its left
  // padding outward so its ink starts where plain text (Created by) does
  // (raft-design foundations/alignment.md). The hang keys on the first child's
  // data-slot (badge / task-chip / task-status-badge), which both triggers carry.
  // Raft DS › TaskCard: History folds under the properties, as a collapsible
  // section title (13/18 700 ink-3); its timeline uses task-status pixels.
  return (<>
    <DescriptionList direction="inline" data-testid="task-properties">
      <PropertyRow label={formatMessage({ id: "task.properties.status" })}>
        {canEditStatus || task.readOnlyReason ? <InlineBadgeEditor
          displayValue={formatMessage({ id: STATUS_STYLES[task.status].labelId })}
          selectedId={task.status}
          options={statusOptions}
          onSelect={handleStatusSelect}
          open={canEditStatus && openEditor === "status"}
          onToggle={toggleStatusEditor}
          onRequestClose={closeEditor}
          badgeStatus={toRuiTaskStatus(task.status)}
          badgeClassName=""
          // The list aligns facts on their first baseline: no top nudge.
          buttonClassName="mt-0"
          disabled={busy || !canEditStatus}
          buttonTitle={task.readOnlyReason ? formatMessage({ id: "task.permissions.historicalJoint" }) : undefined}
          buttonTestId="task-properties-status"
          optionTestIdPrefix="task-properties-status-option"
          triggerRef={statusChipRef}
        /> : <StatusBadge status={task.status} data-testid="task-properties-status-readonly">
          {formatMessage({ id: STATUS_STYLES[task.status].labelId })}
        </StatusBadge>}
        <TaskBacklogReasonPopover
          open={canEditStatus && openEditor === "backlogReason"}
          task={task}
          anchor={statusChipRef}
          finalFocus={statusChipRef}
          onClose={closeEditor}
        />
      </PropertyRow>

      <PropertyRow label={formatMessage({ id: "task.properties.assignee" })}>
        {assigneeProfileButton ? (
          <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
            {assigneeProfileButton}
            {assigneeEditor}
          </span>
        ) : assigneeEditor}
      </PropertyRow>

      {sourceRow}

      <PropertyRow label={formatMessage({ id: "task.properties.createdBy" })}>
        <span>{createdByDisplay}</span>
      </PropertyRow>
      {trailingRows}
    </DescriptionList>
    {task.readOnlyReason && <p className="mt-2 text-caption text-foreground-hint" data-testid="task-readonly-reason">
      {formatMessage({ id: "task.permissions.historicalJoint" })}
    </p>}
    <div className="pt-4"><SectionEyebrow as="button" className="flex w-full items-center gap-1 rounded-sticker text-left outline-none hover:text-foreground focus-visible:shadow-focus" aria-expanded={historyOpen} onClick={toggleHistory}><span>{formatMessage({ id: "task.properties.history" })}</span>{historyOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</SectionEyebrow>
      {historyOpen && <div className="mt-3 w-full">{historyError ? <p className="text-caption text-warning-strong">{formatMessage({ id: "task.history.error" })}</p> : visibleHistory.length === 0 ? <p className="text-caption text-foreground-hint">{formatMessage({ id: "task.history.empty" })}</p> : <HistoryTimeline history={visibleHistory} resolveName={displayNameFor} />}</div>}
    </div>
  </>);
}

export function TimelineText({ text, bold = false, className = "" }: { text: string; bold?: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null); const [open, setOpen] = useState(false); const [long, setLong] = useState(false);
  useLayoutEffect(() => { const el = ref.current; if (!el) return; const measure = () => setLong(el.scrollHeight > (Number.parseFloat(window.getComputedStyle(el).lineHeight) || 16) + 1); measure(); window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }, [text]);
  return <span className={`block ${className}`}><button type="button" className={`text-left ${bold ? "font-bold" : ""}`} onClick={() => long && setOpen((v) => !v)}><span ref={ref} className={`whitespace-pre-wrap break-words ${long && !open ? "line-clamp-1" : ""}`}>{text}</span>{long && (open ? <ChevronDown className="ml-1 inline" size={12} aria-hidden="true" /> : <ChevronRight className="ml-1 inline" size={12} aria-hidden="true" />)}</button></span>;
}

export function TimelineDetail({ event, resolveName, formatMessage }: { event: TaskHistoryEvent; resolveName: (type: "agent" | "user", id: string) => string | null; formatMessage: ReturnType<typeof useIntl>["formatMessage"] }) {
  const p = event.payload;
  if (["status_changed", "closed", "reopened"].includes(event.eventType) && p.from && p.to) {
    const from = String(p.from) as TaskStatus;
    const to = String(p.to) as TaskStatus;
    const transition = <div className="mt-0.5 flex items-center gap-1 text-foreground-hint"><StatusBadge status={from}>{formatMessage({ id: STATUS_STYLES[from]?.labelId ?? "task.status.todo" })}</StatusBadge> → <StatusBadge status={to}>{formatMessage({ id: STATUS_STYLES[to]?.labelId ?? "task.status.todo" })}</StatusBadge></div>;
    // What would bring it back. Only here: the server words `reason` itself on other moves.
    if (to !== "backlog" || typeof p.reason !== "string" || !p.reason) return transition;
    return <>{transition}<TimelineText text={p.reason} className="mt-0.5 text-foreground-hint" /></>;
  }
  // A hand-off: what the task waits on the new assignee for, under who got it.
  if (event.eventType === "assignee_changed" && p.assigneeId && typeof p.reason === "string" && p.reason) {
    return <><TimelineText text={historyDetail(event, resolveName, formatMessage)} className="mt-0.5 text-foreground-hint" /><TimelineText text={p.reason} className="mt-0.5 text-foreground-hint" /></>;
  }
  return <TimelineText text={historyDetail(event, resolveName, formatMessage)} className="mt-0.5 text-foreground-hint" />;
}


function historyDetail(event: TaskHistoryEvent, resolveName?: (type: "agent" | "user", id: string) => string | null, formatMessage?: ReturnType<typeof useIntl>["formatMessage"]): string {
  const p = event.payload;
  if (event.eventType === "created") { const status = String(p.status ?? "todo") as TaskStatus; return formatMessage?.({ id: "task.history.createdDetail" }, { taskNumber: String(p.taskNumber ?? "—"), status: formatMessage?.({ id: STATUS_STYLES[status]?.labelId ?? "task.status.todo" }) }) as string ?? ""; }
  if (["status_changed", "closed", "reopened"].includes(event.eventType) && p.from && p.to) {
    const localizeStatus = (value: unknown) => {
      const id = String(value) as TaskStatus;
      return STATUS_STYLES[id]?.labelId && formatMessage ? formatMessage({ id: STATUS_STYLES[id].labelId }) : String(value);
    };
    return formatMessage?.({ id: "task.history.transition" }, { from: localizeStatus(p.from), to: localizeStatus(p.to) }) as string ?? `${localizeStatus(p.from)} → ${localizeStatus(p.to)}`;
  }
  if (event.eventType === "amended" && p.changes && typeof p.changes === "object") {
    return Object.entries(p.changes as Record<string, unknown>).map(([key, value]) => {
      const fieldId = key === "title" ? "task.history.field.title" : key === "description" ? "task.history.field.description" : undefined;
      const label = fieldId ? formatMessage?.({ id: fieldId as MessageId }) : key;
      if (value && typeof value === "object" && "from" in value && "to" in value) {
        const change = value as { from?: unknown; to?: unknown };
        return formatMessage?.({ id: "task.history.detail.fieldChange" }, { field: label, from: String(change.from ?? "—"), to: String(change.to ?? "—") }) as string;
      }
      return formatMessage?.({ id: "task.history.detail.fieldChange" }, { field: label, from: "—", to: typeof value === "string" ? value : JSON.stringify(value) }) as string;
    }).join(" · ");
  }
  if (event.eventType === "assignee_changed") {
    if (!p.assigneeId) return formatMessage?.({ id: "task.history.detail.unassigned" }) ?? "Unassigned";
    const type = p.assigneeType === "agent" ? "agent" : "user";
    return formatMessage?.({ id: "task.history.assignedTo" }, { name: resolveName?.(type, String(p.assigneeId)) ?? (type === "agent" ? "agent" : "user") }) as string ?? `Assigned to ${resolveName?.(type, String(p.assigneeId)) ?? (type === "agent" ? "agent" : "user")}`;
  }
  return Object.entries(p).filter(([, value]) => value !== false && value !== null && value !== undefined).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ");
}

/**
 * One property, as the library models it: a `<dt>`/`<dd>` pair kept together
 * inside the shared, wrapping facts row. The row layout (one first baseline,
 * 12px term gap, 24px between facts, shape hang) is owned by
 * `DescriptionList direction="inline"`; this wrapper adds nothing to it.
 */
export function PropertyRow({ label, children, testId, className }: { label: string; children: React.ReactNode; testId?: string; className?: string }) {
  return (
    <DescriptionItem className={className} data-testid={testId}>
      <DescriptionTerm>{label}</DescriptionTerm>
      <DescriptionDetails>{children}</DescriptionDetails>
    </DescriptionItem>
  );
}
