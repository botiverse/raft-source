// Canonical reminder formatting for agent-facing output.
// This is the canonical implementation of the agent-facing reminder text
// format (the MCP chat-bridge it originally mirrored has been removed) —
// an AX contract, not an implementation detail. Pinned by `_format.test.ts`.

import { T, sampleReminder } from "../_axExampleFixtures.js";
import { axSurface } from "../../core/renderer.js";
import type { ReminderEventSummary, ReminderSummary } from "@botiverse/raft-shared";

const MODIFY_HINT = "(to modify: snooze/update/cancel; raft reminder --help)";

/**
 * A scheduled row whose `next` has already passed renders identically to a
 * healthy one: `[scheduled] next=<timestamp>`. Whether that timestamp is overdue
 * has to be computed in the reader's head against the current time, so a starved
 * row and a waiting row are typographically the same. During the 2026-08-09
 * incident that was the surface everyone triaged from, and rows that had
 * silently stopped firing read as normal in it.
 *
 * The marker adds no judgement — `next < now` is already in the payload. It just
 * stops the list from presenting it as unremarkable.
 *
 * `now` is required rather than defaulted to the ambient clock. A default would
 * make every snapshot test silently time-dependent: they would pass while their
 * fixture timestamp is in the future and start failing once real time passes it.
 * Requiring it turns "forgot to say which clock this is judged against" into a
 * compile error, and keeps the one real clock read at the command boundary
 * (`list.ts`, via the shared clock seam) instead of buried in a formatter.
 */
export const formatReminder = axSurface(
  "One reminder row incl. OVERDUE marker judged against the passed clock.",
  (r: ReminderSummary, now: Date): string => {
  const ref = r.msgRef ? ` ref=${r.msgRef}` : "";
  const timeField = r.status === "fired"
    ? `fired_at=${r.firedAt ?? r.fireAt}`
    : `next=${r.fireAt}`;
  // Only `scheduled` carries a future-facing `next`; `fired` and `canceled` are
  // terminal, so a past timestamp on them is expected rather than a signal, and
  // marking them would train people to ignore the marker. An unparseable
  // `fireAt` yields no marker either — absence of a marker must never be read as
  // "verified on time".
  const fireAtMs = Date.parse(r.fireAt);
  const overdue = r.status === "scheduled" && Number.isFinite(fireAtMs) && fireAtMs < now.getTime();
  return (`#${r.reminderId.slice(0, 8)} [${r.status}] ${formatReminderType(r)} ${timeField}${overdue ? " OVERDUE" : ""} "${r.title}"${ref}`);
},
  {
    examples: [{ args: [sampleReminder, new Date("2026-08-31T08:00:00.000Z")] }, { title: "OVERDUE", args: [{ ...sampleReminder, fireAt: "2026-08-31T07:00:00.000Z" }, new Date("2026-08-31T08:00:00.000Z")] }],
  },
);


export const formatReminderScheduled = axSurface(
  "Schedule receipt with next-fire time and modify hint.",
  (r: ReminderSummary, warning?: string | null): string => {
  const lines = [
    `Reminder scheduled: #${r.reminderId.slice(0, 8)} ${formatReminderType(r)} "${r.title}"`,
    `Next: ${r.fireAt}`,
    MODIFY_HINT,
  ];
  if (warning) lines.push(`Warning: ${warning}`);
  return (lines.join("\n"));
},
  {
    examples: [{ args: [sampleReminder, null] }],
  },
);

export const formatReminderList = axSurface(
  "Reminder list.",
  (reminders: ReminderSummary[], now: Date): string => {
  if (reminders.length === 0) return ("No reminders.");
  return (reminders.map((r) => formatReminder(r, now)).join("\n"));
},
  {
    examples: [{ args: [[sampleReminder, { ...sampleReminder, reminderId: "aaaa0000-0000-0000-0000-000000000000", title: "overdue example", fireAt: "2026-08-31T07:00:00.000Z" }], new Date("2026-08-31T08:00:00.000Z")] }],
  },
);

export const formatReminderCanceled = axSurface(
  "Cancel receipt.",
  (r: ReminderSummary): string => {
  return (`Reminder canceled: #${r.reminderId.slice(0, 8)} [${r.status}] "${r.title}"`);
},
  {
    examples: [{ args: [{ ...sampleReminder, status: "canceled" }] }],
  },
);

export const formatReminderSnoozed = axSurface(
  "Snooze receipt.",
  (r: ReminderSummary): string => {
  return ([
    `Reminder snoozed: #${r.reminderId.slice(0, 8)} ${formatReminderType(r)} "${r.title}"`,
    `Next: ${r.fireAt}`,
    MODIFY_HINT,
  ].join("\n"));
},
  {
    examples: [{ args: [{ ...sampleReminder, fireAt: "2026-08-31T09:20:00.000Z" }] }],
  },
);

export const formatReminderUpdated = axSurface(
  "Update receipt.",
  (r: ReminderSummary, warning?: string | null): string => {
  const lines = [
    `Reminder updated: #${r.reminderId.slice(0, 8)} ${formatReminderType(r)} "${r.title}"`,
    `Next: ${r.fireAt}`,
    MODIFY_HINT,
  ];
  if (warning) lines.push(`Warning: ${warning}`);
  return (lines.join("\n"));
},
  {
    examples: [{ args: [sampleReminder, null] }],
  },
);

export const formatReminderLog = axSurface(
  "Reminder event log.",
  (events: ReminderEventSummary[]): string => {
  if (events.length === 0) return ("No reminder events.");
  return (events.map((event) => {
    const next = event.nextFireAt ? ` next=${event.nextFireAt}` : " next=none";
    return `${event.occurredAt} ${event.eventType.toUpperCase()} by ${event.actorType}${event.actorId ? `:${event.actorId}` : ""}${next}`;
  }).join("\n"));
},
  {
    examples: [{ args: [[{ eventId: "e-1", reminderId: sampleReminder.reminderId, eventType: "scheduled", actorType: "agent", actorId: "a-1", occurredAt: T, nextFireAt: sampleReminder.fireAt, metadata: null }, { eventId: "e-2", reminderId: sampleReminder.reminderId, eventType: "fired", actorType: "system", actorId: null, occurredAt: T, nextFireAt: null, metadata: null }]] }],
  },
);

function formatReminderType(r: ReminderSummary): string {
  if (!r.recurrence) return "(one-time)";
  return `(recurring · ${r.recurrence.description})`;
}
