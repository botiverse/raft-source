import {
  cancelReminder,
  createReminder,
  getReminderById,
  listReminderEvents,
  listReminderEventsForOwner,
  listReminders,
  resolveHistoricalReminderIdForOwner,
  replaceReminder,
  snoozeReminder,
  updateReminder,
  type CreateReminderInput,
  type ListRemindersFilter,
  type ReminderEventRow,
  type ReminderMutationOptions,
  type ReminderReplaceInput,
  type ReminderRow,
  type ReminderServiceOptions,
  type ReminderUpdatePatch,
} from "./service.js";

export type AppReminderMutationOptions = ReminderMutationOptions;

/**
 * Product-neutral Reminder CRUD facade.
 *
 * Scheduling authority belongs to the target Computer. Callers commit the
 * durable lifecycle row through this facade, then publish the returned exact
 * version to the Computer after their transaction commits.
 */
export function createAppReminder(
  input: CreateReminderInput,
  opts: ReminderServiceOptions = {},
): Promise<ReminderRow> {
  return createReminder(input, opts);
}

export function replaceAppReminder(
  reminderId: string,
  input: ReminderReplaceInput,
  opts: AppReminderMutationOptions,
): Promise<ReminderRow | null> {
  return replaceReminder(reminderId, input, opts);
}

export function cancelAppReminder(
  reminderId: string,
  opts: AppReminderMutationOptions,
): Promise<ReminderRow | null> {
  return cancelReminder(reminderId, opts);
}

export async function cancelMatchingAppReminders(
  filter: ListRemindersFilter,
  matches: (row: ReminderRow) => boolean,
  opts: Omit<AppReminderMutationOptions, "expectedVersion">,
): Promise<ReminderRow[] | null> {
  const rows = await listReminders(filter, opts);
  const canceled: ReminderRow[] = [];
  for (const row of rows) {
    if (!matches(row)) continue;
    const result = await cancelReminder(row.id, {
      ...opts,
      expectedVersion: row.version,
    });
    if (!result) return null;
    canceled.push(result);
  }
  return canceled;
}

export function snoozeAppReminder(
  reminderId: string,
  delaySeconds: number,
  opts: AppReminderMutationOptions,
): Promise<ReminderRow | null> {
  return snoozeReminder(reminderId, delaySeconds, opts);
}

export function updateAppReminder(
  reminderId: string,
  patch: ReminderUpdatePatch,
  opts: AppReminderMutationOptions,
): Promise<ReminderRow | null> {
  return updateReminder(reminderId, patch, opts);
}

export function listAppReminders(
  filter: ListRemindersFilter,
  opts: ReminderServiceOptions = {},
): Promise<ReminderRow[]> {
  return listReminders(filter, opts);
}

export function listAppReminderEvents(
  reminderId: string,
  opts: ReminderServiceOptions = {},
): Promise<ReminderEventRow[]> {
  return listReminderEvents(reminderId, opts);
}

export function listAppReminderEventsForOwner(
  reminderId: string,
  serverId: string,
  ownerAgentId: string,
  opts: ReminderServiceOptions = {},
): Promise<ReminderEventRow[]> {
  return listReminderEventsForOwner(reminderId, serverId, ownerAgentId, opts);
}

export function resolveAppHistoricalReminderIdForOwner(
  idOrPrefix: string,
  serverId: string,
  ownerAgentId: string,
  opts: ReminderServiceOptions = {},
) {
  return resolveHistoricalReminderIdForOwner(idOrPrefix, serverId, ownerAgentId, opts);
}

export function getAppReminderById(
  reminderId: string,
  opts: ReminderServiceOptions = {},
): Promise<ReminderRow | null> {
  return getReminderById(reminderId, opts);
}
