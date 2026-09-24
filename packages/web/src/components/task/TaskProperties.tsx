import { useMemo, useState, useEffect, useLayoutEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { MessageId } from "../../i18n/messages";

import AvatarSlot from "../ui/AvatarSlot";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { useAuthStore } from "../../store/authStore";
import { useTaskStore } from "../../store/taskStore";
import type { Task, TaskHistoryEvent, TaskStatus } from "../../store/taskStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { Badge, DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm } from "raft-ui";

import InlineBadgeEditor from "../InlineBadgeEditor";
import Timeline from "../ui/Timeline";

import { STATUS_STYLES, canEditTaskStatus, getTaskStatusOptions } from "./taskStatusUi";
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

export default function TaskProperties({ task }: { task: Task }) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const currentUser = useAuthStore((s) => s.user);
  const { capabilities, role } = useServerPermissions();
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const updateTaskAssignee = useTaskStore((s) => s.updateTaskAssignee);
  const history = useTaskStore((s) => s.taskHistoryByTaskId[task.id] ?? EMPTY_HISTORY);
  const historyError = useTaskStore((s) => s.taskHistoryErrorByTaskId[task.id] ?? false);
  const registerTaskHistoryConsumer = useTaskStore((s) => s.registerTaskHistoryConsumer);
  const historyGeneration = useTaskStore((s) => s.taskHistoryGeneration);

  const { channelAgents, channelHumans } = useChannelMembers(task.channelId);
  const [openEditor, setOpenEditor] = useState<"status" | "assignee" | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Task history is a store-owned read model. The socket task:updated bridge
  // requests a refresh for observed tasks, so manual and Agent mutations share
  // the same update path while this mounted dialog simply subscribes.
  useEffect(() => registerTaskHistoryConsumer(task.id), [registerTaskHistoryConsumer, task.id, historyGeneration]);
  // Resource receipts are an advanced CLI-only task capability. They are not
  // useful in the person-facing task timeline, so keep those internal events
  // out of the UI while the API remains available to CLI clients.
  const visibleHistory = history.filter((event) => event.eventType !== "resource_receipt_recorded");
  const historyColor = (event: TaskHistoryEvent): string | undefined => {
    const candidate = [event.payload.to, event.payload.status, event.payload.from].find(
      (value): value is string => typeof value === "string" && ["todo", "in_progress", "in_review", "done", "closed"].includes(value),
    );
    const status = candidate ?? (event.eventType === "closed" ? "closed" : event.eventType === "reopened" ? "in_progress" : undefined);
    return status ? STATUS_STYLES[status as TaskStatus]?.bg : undefined;
  };
  let timelineStatus: TaskStatus | undefined;
  const timelineItems = visibleHistory.map((event) => {
    const pointColor = historyColor(event);
    if (pointColor) timelineStatus = (Object.keys(STATUS_STYLES) as TaskStatus[]).find((s) => STATUS_STYLES[s].bg === pointColor);
    return { event, pointColor, lineColor: timelineStatus ? STATUS_STYLES[timelineStatus].bg : undefined };
  });

  const canManageServer = capabilities.deleteAnyTask;
  const canEditStatus = canEditTaskStatus(task, currentUser?.id, canManageServer, role);
  const canEditAssignee = role !== "guest";
  const statusOptions = getTaskStatusOptions(task, currentUser?.id, canManageServer)
    .map((option) => ({ id: option.id, label: formatMessage({ id: option.labelId }) }));

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
            gravatarHash={h.gravatarHash}
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
  const displayNameFor = (type: "agent" | "user", id: string): string | null => {
    const found = type === "agent"
      ? channelAgents.find((a) => a.id === id)
      : channelHumans.find((h) => h.id === id);
    return found ? found.displayName || found.name : null;
  };

  const assigneeDisplay = task.claimedById && task.claimedByType
    ? displayNameFor(task.claimedByType, task.claimedById)
      ?? mentionLabel(task.claimedByName || formatMessage({ id: "task.properties.unknown" }))
    : unassignedLabel;
  const createdByDisplay = displayNameFor(task.createdByType, task.createdById)
    ?? mentionLabel(task.createdByName || formatMessage({ id: "task.properties.unknown" }));

  const handleStatusSelect = async (id: string) => {
    const next = id as TaskStatus;
    if (next === task.status) {
      setOpenEditor(null);
      return;
    }
    setBusy(true);
    try {
      await updateTaskStatus(task.channelId, task.id, next);
      setOpenEditor(null);
    } catch (err) {
      console.error("Failed to update task status:", err);
    } finally {
      setBusy(false);
    }
  };

  const handleAssigneeSelect = async (id: string) => {
    if (id === selectedAssigneeId) {
      setOpenEditor(null);
      return;
    }
    // No OCC token yet: the web `Task` type does not carry `revision`, so there
    // is nothing honest to send. `updateTaskAssignee` already accepts one — wire
    // it through the moment the type exposes the field, rather than inventing a
    // value here that the server would treat as authoritative.
    const [type, rawId] = id === UNASSIGN_ID ? [null, null] : id.split(":");
    setBusy(true);
    try {
      await updateTaskAssignee(
        task.channelId,
        task.id,
        type && rawId ? { type: type as "user" | "agent", id: rawId } : null,
      );
      setOpenEditor(null);
    } catch (err) {
      console.error("Failed to update task assignee:", err);
    } finally {
      setBusy(false);
    }
  };

  // @artin asked for one horizontal facts row in #proj-task:142b9b9a. Keep
  // each label/value pair together, but let the row wrap on narrow panels.
  return (<>
    <div className="mb-4 border-b border-black/10 pb-3"><button type="button" className="mb-1 flex w-full items-center gap-1 text-left text-xs font-bold" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}><span>{formatMessage({ id: "task.properties.history" })}</span>{historyOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</button>
      {historyOpen && <div className="mt-3 w-full">{historyError ? <p className="text-xs text-red-700">{formatMessage({ id: "task.history.error" })}</p> : visibleHistory.length === 0 ? <p className="text-xs text-black/50">{formatMessage({ id: "task.history.empty" })}</p> : <Timeline items={timelineItems.map(({ event, pointColor, lineColor }) => ({ id: event.id, title: <TimelineText text={historyTitle(event, formatMessage)} bold />, meta: `${event.actorName ?? event.actorType} · ${formatShortDateTime(event.createdAt)}`, colorClass: pointColor, lineColorClass: lineColor, children: <TimelineDetail event={event} resolveName={(type, id) => displayNameFor(type, id)} formatMessage={formatMessage} /> }))} />}</div>}
    </div>
    <DescriptionList
      className="flex flex-wrap items-center gap-x-6 gap-y-2"
      data-testid="task-properties"
    >
      <PropertyRow label={formatMessage({ id: "task.properties.status" })}>
        {canEditStatus ? <InlineBadgeEditor
          displayValue={formatMessage({ id: STATUS_STYLES[task.status].labelId })}
          selectedId={task.status}
          options={statusOptions}
          onSelect={handleStatusSelect}
          open={openEditor === "status"}
          onToggle={() => setOpenEditor((cur) => (cur === "status" ? null : "status"))}
          onRequestClose={() => setOpenEditor(null)}
          badgeClassName={STATUS_STYLES[task.status].bg}
          disabled={busy}
          buttonTestId="task-properties-status"
          optionTestIdPrefix="task-properties-status-option"
        /> : <StatusBadge status={task.status} data-testid="task-properties-status-readonly">
          {formatMessage({ id: STATUS_STYLES[task.status].labelId })}
        </StatusBadge>}
      </PropertyRow>

      {/* Same editor as Status, so the property reads the same — but
          `searchable`, so the panel is the search page's SelectionPopover
          rather than a plain list. A server's member list is long and humans
          are assignable too, so this one has to be typed into; Status never
          will be (@stdrc msg=c8c890d2, msg=4c357cb1). */}
      <PropertyRow label={formatMessage({ id: "task.properties.assignee" })}>
        {canEditAssignee ? <InlineBadgeEditor
          displayValue={assigneeDisplay}
          selectedId={selectedAssigneeId}
          options={assigneeOptions}
          onSelect={handleAssigneeSelect}
          open={openEditor === "assignee"}
          onToggle={() => {
            setAssigneeSearch("");
            setOpenEditor((cur) => (cur === "assignee" ? null : "assignee"));
          }}
          onRequestClose={() => setOpenEditor(null)}
          badgeClassName="bg-white"
          uppercase={false}
          disabled={busy}
          buttonTestId="task-properties-assignee"
          dropdownTestId="task-assignee-dropdown"
          searchable
          search={assigneeSearch}
          onSearchChange={setAssigneeSearch}
          searchPlaceholder={formatMessage({ id: "task.assignee.searchPlaceholder" })}
          popoverTitle={formatMessage({ id: "task.properties.assignee" })}
        /> : <Badge uppercase={false} data-testid="task-properties-assignee-readonly">
          {assigneeDisplay}
        </Badge>}
      </PropertyRow>

      <PropertyRow label={formatMessage({ id: "task.properties.createdBy" })}>
        <span>{createdByDisplay}</span>
      </PropertyRow>
    </DescriptionList>
  </>);
}

function TimelineText({ text, bold = false, className = "" }: { text: string; bold?: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null); const [open, setOpen] = useState(false); const [long, setLong] = useState(false);
  useLayoutEffect(() => { const el = ref.current; if (!el) return; const measure = () => setLong(el.scrollHeight > (Number.parseFloat(window.getComputedStyle(el).lineHeight) || 16) + 1); measure(); window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }, [text]);
  return <span className={`block ${className}`}><button type="button" className={`text-left ${bold ? "font-bold" : ""}`} onClick={() => long && setOpen((v) => !v)}><span ref={ref} className={`whitespace-pre-wrap break-words ${long && !open ? "line-clamp-1" : ""}`}>{text}</span>{long && (open ? <ChevronDown className="ml-1 inline" size={12} aria-hidden="true" /> : <ChevronRight className="ml-1 inline" size={12} aria-hidden="true" />)}</button></span>;
}

function TimelineDetail({ event, resolveName, formatMessage }: { event: TaskHistoryEvent; resolveName: (type: "agent" | "user", id: string) => string | null; formatMessage: ReturnType<typeof useIntl>["formatMessage"] }) {
  const p = event.payload;
  if (["status_changed", "closed", "reopened"].includes(event.eventType) && p.from && p.to) { const from = String(p.from) as TaskStatus; const to = String(p.to) as TaskStatus; return <div className="mt-1 flex items-center gap-1 text-black/60"><Badge variant="accent" uppercase={false} className={STATUS_STYLES[from]?.bg}>{formatMessage({ id: STATUS_STYLES[from]?.labelId ?? "task.status.todo" })}</Badge> → <Badge variant="accent" uppercase={false} className={STATUS_STYLES[to]?.bg}>{formatMessage({ id: STATUS_STYLES[to]?.labelId ?? "task.status.todo" })}</Badge></div>; }
  return <TimelineText text={historyDetail(event, resolveName, formatMessage)} className="mt-1 text-black/60" />;
}

function historyTitle(event: TaskHistoryEvent, formatMessage: ReturnType<typeof useIntl>["formatMessage"]): string {
  const key = ({ created: "task.history.created", amended: "task.history.amended", status_changed: "task.history.statusChanged", assignee_changed: "task.history.assigneeChanged", reopened: "task.history.reopened", closed: "task.history.closed", resource_receipt_recorded: "task.history.receipt" } as Record<string, MessageId>)[event.eventType];
  return key ? formatMessage({ id: key }) : event.eventType;
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
 * inside the shared, wrapping facts row.
 *
 * This used to be a hand-rolled `flex justify-between` with locally chosen type
 * and colour, which is exactly why the block did not line up with the rest of
 * the app — the numbers came from me rather than from the design system.
 * Scale and colour remain design-system owned; this wrapper only defines the
 * product-requested horizontal grouping.
 */
function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DescriptionItem className="flex min-w-0 items-center gap-2">
      <DescriptionTerm className="mb-0 shrink-0">{label}</DescriptionTerm>
      <DescriptionDetails className="min-w-0">{children}</DescriptionDetails>
    </DescriptionItem>
  );
}
