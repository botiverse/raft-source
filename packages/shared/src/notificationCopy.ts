// Localization keys of every fixed phrase a notification banner carries
// (docs/contracts/notifications.md §1.5), each with its English template. The
// server renders the English text it always sends from the same template it
// sends the key with, so the fallback and the key cannot drift; clients
// translate the key from their own catalogs (web: the same ids in
// packages/web/src/i18n/messages; iOS / Android: their string tables, `{0}`,
// `{1}` = `%1$@`, `%2$@`).
//
// Args are positional strings: names (sender, channel, agent, server) and
// counts, never translated. A banner made only of names and punctuation
// (`#general`, `Alice: text`, `#12 Fix login`, `#general · Server`) has no key.

/** The newest preview key set (contract §3.1): 1 and 2 are the redacted-preview keys, 3 adds every other phrase. */
export const NOTIFICATION_KEY_SET_LATEST = 3;

/** key -> English template and the key set (contract §3.1) that introduced it. */
export const NOTIFICATION_COPY = {
  // Redacted previews (key sets 1 and 2).
  "push.preview.hidden.title": { en: "Raft", keySet: 1 },
  "push.preview.hidden.message": { en: "You have a new message", keySet: 1 },
  "push.preview.hidden.mention": { en: "You were mentioned", keySet: 1 },
  "push.preview.sender_only.message": { en: "{0} sent a message", keySet: 1 },
  "push.preview.sender_only.mention": { en: "{0} mentioned you", keySet: 1 },
  "push.preview.sender_only.task": { en: "{0}: task update", keySet: 2 },
  "push.preview.sender_only.agent": { en: "{0} needs your attention", keySet: 2 },
  "push.preview.sender_only.reminder": { en: "{0}: reminder", keySet: 2 },
  "push.preview.sender_only.notice": { en: "{0}: new notice", keySet: 2 },
  "push.preview.hidden.task": { en: "You have a task update", keySet: 2 },
  "push.preview.hidden.agent": { en: "An agent needs your attention", keySet: 2 },
  "push.preview.hidden.reminder": { en: "A reminder is due", keySet: 2 },
  "push.preview.hidden.notice": { en: "You have a new notice", keySet: 2 },
  // Titles (where a tap lands).
  "push.title.dm": { en: "DM", keySet: 3 },
  "push.title.thread": { en: "Thread", keySet: 3 },
  "push.title.thread_in_dm": { en: "Thread in DM", keySet: 3 },
  "push.title.thread_in_channel": { en: "Thread in #{0}", keySet: 3 },
  "push.title.task": { en: "Task", keySet: 3 },
  "push.title.task_in_dm": { en: "Task in DM", keySet: 3 },
  "push.title.task_in_channel": { en: "Task in #{0}", keySet: 3 },
  "push.title.task_assigned": { en: "Assigned to you", keySet: 3 },
  "push.title.agent_action_required": { en: "{0} needs your attention", keySet: 3 },
  "push.title.reminder": { en: "Reminder", keySet: 3 },
  "push.title.agent_migration_review": { en: "Confirm moving {0} to the cloud", keySet: 3 },
  "push.title.test": { en: "Raft test notification", keySet: 3 },
  // Subtitles (context): only a DM context is words; a channel or server label is a name.
  "push.subtitle.dm": { en: "DM", keySet: 3 },
  "push.subtitle.dm_server": { en: "DM · {0}", keySet: 3 },
  // Bodies.
  "push.body.attachment": { en: "Sent an attachment", keySet: 3 },
  "push.body.attachments": { en: "Sent {0} attachments", keySet: 3 },
  "push.body.no_text": { en: "(no text)", keySet: 3 },
  "push.body.sender_attachment": { en: "{0}: Sent an attachment", keySet: 3 },
  "push.body.sender_attachments": { en: "{0}: Sent {1} attachments", keySet: 3 },
  "push.body.sender_no_text": { en: "{0}: (no text)", keySet: 3 },
  "push.body.agent_migration_review": {
    en: "{0} is paused until you confirm. Review which files come over before the window closes.",
    keySet: 3,
  },
  "push.body.test": { en: "If you can read this, notifications reach this device.", keySet: 3 },
} as const satisfies Record<string, { en: string; keySet: number }>;

export type NotificationCopyKey = keyof typeof NOTIFICATION_COPY;

/** A fixed phrase: its key and positional args. */
export interface NotificationCopy {
  key: NotificationCopyKey;
  args: string[];
}

export function isNotificationCopyKey(value: unknown): value is NotificationCopyKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(NOTIFICATION_COPY, value);
}

/** The English text of a key: `{n}` replaced by `args[n]` in one pass (an arg is never read as a placeholder). */
export function formatNotificationCopy(key: NotificationCopyKey, args: readonly string[] = []): string {
  return NOTIFICATION_COPY[key].en.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? "");
}

/** Whether an app of preview key set `keySet` ships `key` (contract §3.1); an unknown key never. */
export function notificationCopyKeyInSet(key: string, keySet: number): boolean {
  return isNotificationCopyKey(key) && NOTIFICATION_COPY[key].keySet <= keySet;
}

/**
 * Keys of the fixed phrases in one notification's title / subtitle / body,
 * next to the English text (envelope and mobile socket `localization`, FCM
 * data `titleKey` ..., APNs `title-loc-key` ...). Absent parts are plain text.
 * `bodyArgs` is always set with `bodyKey` (as before key set 3); title and
 * subtitle args are omitted when empty.
 */
export interface NotificationLocalization {
  titleKey?: string;
  titleArgs?: string[];
  subtitleKey?: string;
  subtitleArgs?: string[];
  bodyKey?: string;
  bodyArgs?: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Reads a `localization` object off a payload (malformed parts dropped); null when nothing is left. */
export function parseNotificationLocalization(value: unknown): NotificationLocalization | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const out: NotificationLocalization = {};
  for (const part of ["title", "subtitle", "body"] as const) {
    const key = input[`${part}Key`];
    if (typeof key !== "string" || !key) continue;
    const args = input[`${part}Args`];
    out[`${part}Key`] = key;
    out[`${part}Args`] = isStringArray(args) ? args : [];
  }
  return out.titleKey || out.subtitleKey || out.bodyKey ? out : null;
}
