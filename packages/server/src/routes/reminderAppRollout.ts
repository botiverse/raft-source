import type { Response } from "express";
import { setRequestTraceErrorCode } from "../middleware/requestObservability";
import { reminderAppActiveForServer } from "../services/reminderAppGate";
import { refuse, type RefusalInput } from "../lib/refusal";

export const REMINDERS_MOVED_TO_APP = "reminders_moved_to_app";

/**
 * Why: one sentence, no commands (the refusal envelope's rule). The commands
 * go in the next step, which every client prints after it.
 */
const REMINDERS_MOVED_TO_APP_REFUSAL: RefusalInput = {
  code: REMINDERS_MOVED_TO_APP,
  error: "Reminders on this server moved to the Reminder app, so scheduling, updating and snoozing them here no longer works, and nothing was changed.",
  suggestedNextAction: "Use the Reminder app from the \"Installed on this Server\" list in your instructions, or find its service id with `raft integration list`, then run `raft integration invoke --service <id> --list-actions`. If Reminder is not listed, the app is not installed on this server; ask a server admin. `raft reminder list`, `log` and `cancel` still work for your existing reminders.",
};

/**
 * Refuses a legacy reminder write (schedule, update, snooze) when the server's
 * `reminder_app` rollout flag is on, and reports whether it did. Covers both
 * the agent API and the machine-key `/internal/agent/:id/reminders` routes that
 * older Computers still call: their prompts still teach `raft reminder
 * schedule`, so this refusal is what points their agents at the app. List, log
 * and cancel are never guarded, and reminders already queued keep firing. The
 * code lands on the request span as `error_code`, which is how the rollout
 * counts remaining legacy callers per server and agent.
 */
export async function refuseIfRemindersMovedToApp(res: Response, serverId: string | null | undefined): Promise<boolean> {
  if (!(await reminderAppActiveForServer(serverId))) return false;
  setRequestTraceErrorCode(res, REMINDERS_MOVED_TO_APP);
  refuse(res, 409, REMINDERS_MOVED_TO_APP_REFUSAL);
  return true;
}

export const REMINDER_MIGRATED = "reminder_migrated";

/** A reminder the legacy import moved to the Reminder App: managed there, not here (409 `reminder_migrated`). */
export function reminderMigratedRefusal(reminderId: string): RefusalInput {
  return {
    code: REMINDER_MIGRATED,
    error: `Reminder ${reminderId} moved to the Reminder app and is managed there now, so nothing was changed here.`,
    suggestedNextAction: "Use the Reminder app from the \"Installed on this Server\" list in your instructions, or find its service id with `raft integration list`, then run `raft integration invoke --service <id> --list-actions`.",
  };
}
