// Canonical reminder formatting for agent-facing output.
// This is the canonical implementation of the agent-facing reminder text
// format (the MCP chat-bridge it originally mirrored has been removed) —
// an AX contract, not an implementation detail. Pinned by `_format.test.ts`.

import { T, sampleReminder } from "../_axExampleFixtures";
import { AGENT_BODY_CONTINUATION_PREFIX, foldAgentOneLineText, indentAgentBodyContinuationLines } from "@botiverse/raft-shared/src/agentCliSurface";
import { axSurface } from "../../core/renderer";
import type { ReminderEventSummary, ReminderSummary } from "@botiverse/raft-shared";
import type { TriggerLog, TriggerResult } from "./_triggerApp";
import type { AppReplyText } from "@botiverse/raft-shared/src/agentCliSurface";

const FIRED_HINT = "[fired] is the reminder's state, not something to act on: a fire still waiting for your ack is listed in `raft inbox check`.";
const MIGRATED_HINT = "Reminders marked [migrated] moved to the Reminder app and fire there now, under new ids.";

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
  // Moved to the Reminder app by the legacy import: it fires there now, so no
  // `next=` here (the stored time is the last one this system knew).
  if (r.status === "migrated") {
    return `#${r.reminderId.slice(0, 8)} [migrated] ${formatReminderType(r)} "${r.title}"${ref} -> now in the Reminder app`;
  }
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
  "Schedule receipt with next-fire time.",
  (r: ReminderSummary, warning?: string | null): string => {
  const lines = [
    `Reminder scheduled: #${r.reminderId.slice(0, 8)} ${formatReminderType(r)} "${r.title}"`,
    `Next: ${r.fireAt}`,
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
  (reminders: ReminderSummary[], now: Date, opts: { hiddenFired?: number } = {}): string => {
  const hiddenFired = opts.hiddenFired ?? 0;
  if (reminders.length === 0 && hiddenFired === 0) return ("No reminders.");
  const lines: string[] = reminders.length === 0
    ? ["No scheduled reminders."]
    : reminders.map((r) => formatReminder(r, now));
  if (reminders.some((r) => r.status === "fired")) lines.push(FIRED_HINT);
  if (reminders.some((r) => r.status === "migrated")) lines.push(MIGRATED_HINT);
  if (hiddenFired > 0) {
    lines.push(`Not shown: ${hiddenFired} fired one-time reminder${hiddenFired === 1 ? "" : "s"} (\`raft reminder list --status fired\`).`);
  }
  return (lines.join("\n"));
},
  {
    examples: [{ title: "fired not shown", args: [[sampleReminder], new Date("2026-08-31T08:00:00.000Z"), { hiddenFired: 47 }] }, { title: "fired listed", args: [[{ ...sampleReminder, status: "fired", firedAt: "2026-08-31T07:30:00.000Z" }], new Date("2026-08-31T08:00:00.000Z")] }, { title: "migrated", args: [[sampleReminder, { ...sampleReminder, reminderId: "bbbb0000-0000-0000-0000-000000000000", title: "weekly report", status: "migrated" }], new Date("2026-08-31T08:00:00.000Z")] }, { args: [[sampleReminder, { ...sampleReminder, reminderId: "aaaa0000-0000-0000-0000-000000000000", title: "overdue example", fireAt: "2026-08-31T07:00:00.000Z" }], new Date("2026-08-31T08:00:00.000Z")] }],
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

/**
 * Reminder seals live in a Raft daemon's inbox; an external agent has none, so
 * the pre-mutation seal check cannot run. Printed on stderr (stdout stays the
 * command's result) instead of skipping the check silently.
 */
export const formatReminderSealsUnchecked = axSurface(
  "Reminder mutation diagnostic (stderr) for external agents: the local seal check is unavailable.",
  (): string => "Reminder seals: not checked (not available for external agents).",
  {
    examples: [{ args: [] }],
  },
);

/** UTC `HH:MMZ`, with `YYYY-MM-DD ` first when it is not `now`'s UTC day. */
export function formatTriggerTime(iso: string, now: Date): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return foldAgentOneLineText(iso);
  const stamp = at.toISOString();
  const clock = `${stamp.slice(11, 16)}Z`;
  return stamp.slice(0, 10) === now.toISOString().slice(0, 10) ? clock : `${stamp.slice(0, 10)} ${clock}`;
}

const TRIGGER_LOG_TITLE_MAX = 120;

function oneLineTriggerTitle(title: string): string {
  const folded = foldAgentOneLineText(title);
  return folded.length <= TRIGGER_LOG_TITLE_MAX ? folded : `${folded.slice(0, TRIGGER_LOG_TITLE_MAX - 1)}…`;
}

/**
 * `raft reminder trigger` receipt. `key` is the one the caller passed (checked
 * against the key rule), not the app's echo; the title and body are not printed.
 */
export const formatTriggerResult = axSurface(
  "Trigger receipt: whether it woke you, was merged into the window, logged only, or throttled; then the log command.",
  (key: string, r: TriggerResult, now: Date): string => {
    const t = (iso: string | undefined) => (iso ? formatTriggerTime(iso, now) : "-");
    let line: string;
    switch (r.outcome) {
      case "woke":
        line = `Triggered ${key}: sent; it wakes you. More triggers of ${key} until ${t(r.nextWakeAllowedAt)} are recorded, not sent.`;
        break;
      case "merged":
        line = `Triggered ${key}: recorded, not sent (${r.triggerCount} recorded since the last notice, the first at ${t(r.firstTriggeredAt)}); the next one after ${t(r.nextWakeAllowedAt)} is sent.`;
        break;
      case "recorded":
        line = `Logged ${key}: recorded only; level log never wakes you.`;
        break;
      case "throttled":
        line = `Triggered ${key}: recorded only, over this hour's wake cap; wakes are allowed again at ${t(r.nextWakeAllowedAt)}.`;
        break;
      default:
        line = `Triggered ${key}: ${foldAgentOneLineText(r.outcome)}.`;
    }
    return [line, `Next: raft reminder log --key ${key} lists its history.`].join("\n");
  },
  {
    examples: [
      { title: "woke", args: ["slip_BTC", { key: "slip_BTC", outcome: "woke", triggerCount: 1, firstTriggeredAt: T, lastTriggeredAt: T, nextWakeAllowedAt: "2026-08-31T08:10:00.000Z" }, new Date(T)] },
      { title: "merged", args: ["slip_BTC", { key: "slip_BTC", outcome: "merged", triggerCount: 3, firstTriggeredAt: "2026-08-31T08:02:00.000Z", lastTriggeredAt: "2026-08-31T08:05:00.000Z", nextWakeAllowedAt: "2026-08-31T08:10:00.000Z" }, new Date(T)] },
      { title: "log level", args: ["feed_down", { key: "feed_down", outcome: "recorded", triggerCount: 2, firstTriggeredAt: T, lastTriggeredAt: T }, new Date(T)] },
      { title: "throttled", args: ["feed_down", { key: "feed_down", outcome: "throttled", triggerCount: 4, firstTriggeredAt: T, lastTriggeredAt: T, nextWakeAllowedAt: "2026-08-31T08:40:00.000Z" }, new Date(T)] },
    ],
  },
);

/**
 * `raft reminder log --key` output, newest first. Titles are folded to one
 * line and cut; bodies are data and are not printed.
 */
export const formatTriggerLog = axSurface(
  "Trigger key history: newest-first entries (time, level, outcome, title), triggers since the last notice, and how to raise it again.",
  (key: string, log: TriggerLog, now: Date): string => {
    // Keys under raft. are Raft's own (raft.throttled): they can be read, never raised.
    const next = key.startsWith("raft.")
      ? "Next: raft reminder log --key <key> shows one of the keys named above."
      : `Next: raft reminder trigger --key ${key} --title <text> raises it again.`;
    if (log.entries.length === 0) {
      return [`Trigger log for ${key}: no entries in the last 7 days.`, next].join("\n");
    }
    const count = log.entries.length;
    const lines = [`Trigger log for ${key}: ${count} ${count === 1 ? "entry" : "entries"}, newest first.`];
    for (const entry of log.entries) {
      lines.push(`${formatTriggerTime(entry.at, now)} · ${foldAgentOneLineText(entry.level)} · ${foldAgentOneLineText(entry.outcome)} · ${oneLineTriggerTitle(entry.title)}`);
    }
    const since = log.sinceLastEvent;
    if (since.triggerCount > 0) {
      const first = since.firstTriggeredAt ? formatTriggerTime(since.firstTriggeredAt, now) : "-";
      const last = since.lastTriggeredAt ? formatTriggerTime(since.lastTriggeredAt, now) : "-";
      lines.push(`Since the last notice: ${since.triggerCount} ${since.triggerCount === 1 ? "trigger" : "triggers"} (first ${first}, last ${last}).`);
    }
    lines.push(next);
    return lines.join("\n");
  },
  {
    examples: [
      {
        args: ["slip_BTC", {
          key: "slip_BTC",
          entries: [
            { at: "2026-08-31T07:55:00.000Z", level: "wake", outcome: "merged", title: "BTC slipped 2.1%" },
            { at: "2026-08-31T07:50:00.000Z", level: "wake", outcome: "woke", title: "BTC slipped 1.4%" },
          ],
          sinceLastEvent: { triggerCount: 1, firstTriggeredAt: "2026-08-31T07:55:00.000Z", lastTriggeredAt: "2026-08-31T07:55:00.000Z" },
        }, new Date(T)],
      },
      { title: "empty", args: ["feed_down", { key: "feed_down", entries: [], sinceLastEvent: { triggerCount: 0, firstTriggeredAt: null, lastTriggeredAt: null } }, new Date(T)] },
    ],
  },
);

/**
 * A Reminder App answer (`raft reminder schedule|list|show|update|snooze|cancel`
 * on a server whose reminders live in the app): the app's own reply text,
 * printed as the command's answer. It carries titles and notes an agent set,
 * so it is quoted like an app's text in `raft integration invoke`: every line,
 * the first too, starts with `  │ ` (free text never starts a line). The CLI
 * has already turned every line break into `\n`, replaced control characters
 * and cut it at 4000 characters (appReplyText).
 */
export const formatReminderAppReply = axSurface(
  "Reminder app reply text printed as the command's answer, quoted line by line, with the cut note when it was cut.",
  // `error`: the text of a refusal or failure, where the command did not (or may not) run, so the
  // cut note does not say it ran; the error's own lines say what changed.
  (reply: AppReplyText, kind: "answer" | "error" = "answer"): string => {
    const block = `${AGENT_BODY_CONTINUATION_PREFIX}${indentAgentBodyContinuationLines(reply.text)}`;
    if (reply.cutFrom === undefined) return block;
    const ran = kind === "answer" ? " It already ran: do not run it again to see the rest;" : "";
    return `${block}\nText cut at 4000 of ${reply.cutFrom} characters.${ran} raft reminder show --id <id> shows one reminder in full.`;
  },
  {
    examples: [
      { args: [{ text: "Scheduled 0191c135: check deploy status, 08-31 17:00 Asia/Shanghai (09:00Z), in #general:00000000. Details: raft reminder show --id 0191c135" }] },
      { title: "list", args: [{ text: "0191c135 active  08-31 09:00Z  once  check deploy status  #general:00000000\n7c41e2a0 active  09-01 02:00Z  daily@10:00  standup notes" }] },
      { title: "cut", args: [{ text: "0191c135 active  08-31 09:00Z  once  check deploy status  #general…", cutFrom: 5210 }] },
      { title: "cut error", args: [{ text: "Reminder 0191c135 is at revision 4, not 3; …", cutFrom: 5210 }, "error"] },
    ],
  },
);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function appReminderLine(value: unknown): string | null {
  const r = record(value);
  if (!r || typeof r.id !== "string") return null;
  const status = typeof r.status === "string" ? ` ${foldAgentOneLineText(r.status)}` : "";
  const next = typeof r.nextFireAt === "string" ? foldAgentOneLineText(r.nextFireAt) : "none";
  const title = typeof r.title === "string" ? ` "${foldAgentOneLineText(r.title)}"` : "";
  return `${foldAgentOneLineText(r.id.slice(0, 8))}${status}, next ${next}${title}`;
}

/**
 * A Reminder App answer without reply text (an older app): a short line per
 * reminder from its JSON fields (id, status, next fire, title), never the raw JSON.
 */
export const formatReminderAppAnswer = axSurface(
  "Reminder app answer without reply text: one CLI-made line per reminder (id, status, next fire, title).",
  (value: unknown): string => {
    const outer = record(value);
    const body = outer && outer.ok === true && "result" in outer ? record(outer.result) : outer;
    const listed = Array.isArray(body?.reminders) ? body.reminders.map(appReminderLine).filter((line): line is string => line !== null) : null;
    if (listed) return listed.length > 0 ? listed.join("\n") : "No reminders.";
    const one = appReminderLine(body?.reminder) ?? appReminderLine(body);
    return one ? `Reminder ${one}` : "Done; the Reminder app sent no details.";
  },
  {
    examples: [
      { args: [{ ok: true, status: 200, result: { reminder: { id: "0191c135-aaaa-bbbb-cccc-000000000000", status: "active", title: "check deploy status", nextFireAt: "2026-08-31T09:00:00.000Z" } } }] },
      { title: "list", args: [{ ok: true, status: 200, result: { reminders: [{ id: "0191c135-aaaa-bbbb-cccc-000000000000", status: "active", title: "check deploy status", nextFireAt: null }] } }] },
    ],
  },
);

/**
 * `raft reminder list` on a server whose reminders live in the Reminder app:
 * the scheduled reminders made before the move that the import did not take
 * (they still fire here), after the app's list. Empty when there are none.
 */
export const formatReminderLeftovers = axSurface(
  "Reminders made before the move to the Reminder app that still fire, listed after the app's own list.",
  (reminders: ReminderSummary[], now: Date, failure?: string | null): string => {
    if (failure) return `Reminders made before the move: not listed (${foldAgentOneLineText(failure)}).`;
    if (reminders.length === 0) return "";
    return [
      "Made before the move (still fire; cancel with raft reminder cancel --id <id>):",
      ...reminders.map((r) => formatReminder(r, now)),
    ].join("\n");
  },
  {
    examples: [
      { args: [[sampleReminder], new Date("2026-08-31T08:00:00.000Z")] },
      { title: "none", args: [[], new Date("2026-08-31T08:00:00.000Z")] },
      { title: "unreadable", args: [[], new Date("2026-08-31T08:00:00.000Z"), "HTTP 503"] },
    ],
  },
);


/**
 * `raft reminder list` when whether this server's reminders moved to the
 * Reminder app could not be read: after the legacy list, it says the app's
 * reminders were not checked rather than implying there are none.
 */
export const formatReminderAppUnchecked = axSurface(
  "List footer when the Reminder app's reminders could not be checked (the server's settings could not be read).",
  (): string => "Reminders in the Reminder app: not checked (this server's settings could not be read); run raft reminder list again to include them.",
  { examples: [{ args: [] }] },
);
