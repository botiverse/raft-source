// Refusals the agent API (internalAgentApi.ts) and the legacy agent routes
// (internal.ts, /internal/agent/:id/...) both answer for the same checks,
// defined once so the two routes can't drift apart
// (docs/contracts/agent-api-refusals.md).

import { OAUTH_CLIENT_CATEGORIES, RAFT_HINTS, TASK_ASSIGN_REASON_UNCHANGED, TASK_ASSIGN_REASON_UNCHANGED_MESSAGE } from "@botiverse/raft-shared";
import { sentenceQuoting, type RefusalInput } from "../lib/refusal";
import { PROFILE_AVATAR_MAX_SIZE_LABEL } from "../services/avatarService";
import { taskStatusRejectionCode } from "./agentApiErrorTrace";
import { isThreadTarget } from "./agentWritableTarget";

/** A channel that takes no new messages or task changes (409 `channel_archived`). */
export const CHANNEL_ARCHIVED_REFUSAL: RefusalInput = {
  code: "channel_archived",
  error: "This channel is archived, so it takes no new messages or task changes: post or work in another channel, or ask someone who manages it to unarchive it.",
};

/** A thread route given a channel or DM (400 `not_a_thread`). */
export const NOT_A_THREAD_REFUSAL: RefusalInput = {
  code: "not_a_thread",
  error: "That target is a channel or DM, not a thread: name a thread as #channel:<msg> or dm:@peer:<msg>, with the parent message's msg= short id.",
};

/**
 * A channel id or name this agent can't use: missing and not visible read the
 * same (#wg-rbac B14).
 */
export const AGENT_CHANNEL_NOT_FOUND_REFUSAL: RefusalInput = {
  code: "channel_not_found",
  error: "Not found, or you don't have access: no channel you can see matches that target, so check it or list the channels you can see.",
  next: RAFT_HINTS.serverInfo({ view: "channels" }),
};

/** A thread target this agent can't use: missing and not visible read the same. */
export const THREAD_NOT_FOUND_REFUSAL: RefusalInput = {
  code: "thread_not_found",
  error: "Not found, or you don't have access: no thread or message you can see matches that target, which is #channel:<msg> or dm:@peer:<msg> with the parent message's msg= short id.",
};

// History.

/** A history read without a conversation (400 `INVALID_ARG`). */
export const HISTORY_TARGET_REQUIRED_REFUSAL: RefusalInput = {
  code: "INVALID_ARG",
  error: "A history read needs a conversation to read: name a channel, DM or thread, such as #all or dm:@richard.",
};

/** A conversation the agent can see but not read (403 `history_not_accessible`). */
export const HISTORY_NOT_ACCESSIBLE_REFUSAL: RefusalInput = {
  code: "history_not_accessible",
  error: "You don't have access to this conversation's history: read a conversation you are a member of, or join this one first.",
};

// Channel join and leave.

export const THREAD_NOT_JOINABLE_REFUSAL: RefusalInput = { code: "thread_not_joinable", error: "That target is a thread, which you follow rather than join: follow the thread to get its replies." };
export const DM_NOT_JOINABLE_REFUSAL: RefusalInput = { code: "dm_not_joinable", error: "A DM can't be joined: its two participants are its only members." };
export const JOINT_CHANNEL_ADD_ONLY_REFUSAL: RefusalInput = { code: "joint_channel_add_only", error: "You can't join this channel yourself. Ask someone from your server who's in it to add you." };
export const JOIN_CHANNEL_ARCHIVED_REFUSAL: RefusalInput = { code: "channel_archived", error: "This channel is archived, so nobody can join it until it is unarchived." };
export const SERVER_ROLE_CANNOT_JOIN_REFUSAL: RefusalInput = { code: "server_role_cannot_join", error: "Your server role can't join public channels: ask a server owner or admin to add you, or to change your role." };
export const CHANNEL_TYPE_NOT_LEAVABLE_REFUSAL: RefusalInput = { code: "channel_type_not_leavable", error: "Agents can only leave regular or joint channels: a thread is unfollowed instead, and a DM can't be left." };
export const LEAVE_CHANNEL_ARCHIVED_REFUSAL: RefusalInput = { code: "channel_archived", error: "This channel is archived, so its members can't change until it is unarchived." };
export const PRIVATE_CHANNEL_INVITE_ONLY_REFUSAL: RefusalInput = { code: "private_channel_invite_only", error: "This is a private channel, so you can't join it yourself: ask one of its members to add you." };
export const ALL_CHANNEL_MEMBERSHIP_FIXED_REFUSAL: RefusalInput = {
  code: "all_channel_membership_fixed",
  error: "Everyone on the server is in #all, so nobody can leave it.",
  suggestedNextAction: "Do not retry.",
};

// Reactions.

export const EMOJI_INVALID_REFUSAL: RefusalInput = { code: "emoji_invalid", error: "That isn't an emoji a reaction can use: send one emoji, such as 👍." };
export const SYSTEM_MESSAGE_NOT_REACTABLE_REFUSAL: RefusalInput = { code: "system_message_not_reactable", error: "System messages can't receive reactions." };
export const REACTION_MEMBERSHIP_REQUIRED_REFUSAL: RefusalInput = { code: "channel_membership_required", error: "You must be a member of this channel to react to its messages: join it first." };
export const REACTION_CHANNEL_ARCHIVED_REFUSAL: RefusalInput = { code: "channel_archived", error: "This channel is archived, so its messages can't get new reactions." };
export const REACTION_CHANNEL_READ_ONLY_REFUSAL: RefusalInput = {
  code: "channel_read_only",
  error: "This channel is read-only on your current plan, so its messages can't get new reactions.",
  suggestedNextAction: "A server owner can upgrade the plan to make it writable again.",
};

// Tasks.

/** A task write in a channel the agent can't post in (403 `channel_membership_required`). */
export const TASK_MEMBERSHIP_REQUIRED_REFUSAL: RefusalInput = {
  code: "channel_membership_required",
  error: "You can change tasks only in a channel you are a member of: join this channel first.",
};

/** A task from before its channel was shared, written from a participant workspace (403 `joint_task_read_only`). */
export const JOINT_TASK_READ_ONLY_REFUSAL: RefusalInput = {
  code: "joint_task_read_only",
  error: "This task is from before the channel was shared, and such tasks are read-only from a participant workspace: change it from the workspace that hosts the channel.",
};

export const TOO_MANY_TASKS_REFUSAL: RefusalInput = { code: "too_many_tasks", error: "A task create takes at most 50 tasks at once: split them into several creates." };

/** A task create or claim aimed at a thread, which holds no tasks (409 `thread_target`). */
export const TASK_CREATE_IN_THREAD_REFUSAL: RefusalInput = { code: "thread_target", error: "A thread holds no tasks, so its messages can't become tasks: create the task in the thread's channel instead." };
export const TASK_CLAIM_IN_THREAD_REFUSAL: RefusalInput = { code: "thread_target", error: "A thread holds no tasks, so its messages can't be claimed as tasks: claim tasks in the thread's channel instead." };

/**
 * The one answer of a task route whose channel the agent can't use for tasks:
 * no such agent, no such channel or one it can't see, or one that holds no
 * tasks all read the same; the agent API keeps the reason on the request span.
 */
export const TASK_CHANNEL_NOT_FOUND_REFUSAL: RefusalInput = {
  code: "task_channel_not_found",
  error: "Not found, or you don't have access: no channel you can use for tasks has that name, so check the name or pick a channel you are a member of.",
  next: RAFT_HINTS.serverInfo({ view: "channels" }),
};

/** The task changed between the route's read and its write (`task_state_conflict`). */
export const TASK_STATE_CONFLICT_ERROR = "The task changed while this update was being made: look at the task again, and make the change if it still applies.";

/** A board has no task by that number (404 `task_not_found`). */
export function taskNotFoundRefusal(channel: string, taskNumber: number): RefusalInput {
  return {
    code: "task_not_found",
    error: sentenceQuoting([String(channel)], `${channel} has no task #${taskNumber}: check the number in its task list.`, "This channel has no task with that number: check the number in its task list."),
    next: RAFT_HINTS.taskListAll(channel),
  };
}

/**
 * A status change the task service refused (409); its free-text reason
 * classified as on the request span (taskStatusRejectionCode). A reason with
 * no sentence of its own here is answered as the service says it.
 */
export function taskStatusRefusal(reason: string, channel: string, taskNumber: number): RefusalInput {
  const code = taskStatusRejectionCode(reason);
  switch (code) {
    case "task_not_found":
      return taskNotFoundRefusal(channel, taskNumber);
    case "task_resource_receipt_required":
      return { code, error: "This task creates a resource, so it needs a resource receipt before it can move to done: record the receipt first, then mark it done." };
    case "task_status_unchanged":
      return { code, error: `Task #${taskNumber} is ${reason}, so there is nothing to change.` };
    case "task_not_claimed":
      return { code, error: "A task has to be claimed before it moves to in_progress: claim it first.", next: RAFT_HINTS.taskClaim({ target: channel, taskNumber }) };
    case "task_state_conflict":
      return { code, error: TASK_STATE_CONFLICT_ERROR };
    default:
      return { code, error: reason };
  }
}

/** An unclaim the task service refused (409); its reasons are fixed strings (taskService.unclaimTask). */
export function taskUnclaimRefusal(reason: string, channel: string, taskNumber: number): RefusalInput {
  switch (reason) {
    case "task not found":
      return taskNotFoundRefusal(channel, taskNumber);
    case "task is done":
      return { code: "task_done", error: `Task #${taskNumber} is done, so it can't be unclaimed: reopen it first if someone should pick it up again.` };
    case "task is not assigned":
      return { code: "task_not_assigned", error: `Task #${taskNumber} has no assignee, so there is nothing to unclaim.` };
    case "task state changed concurrently":
      return { code: "task_state_conflict", error: TASK_STATE_CONFLICT_ERROR };
    default:
      return { code: "task_unclaim_rejected", error: reason };
  }
}

// Reminders.

export const REMINDER_MAX_TITLE_LEN = 500;

export const REMINDER_STATUS_FILTER_INVALID_REFUSAL: RefusalInput = { code: "reminder_status_invalid", error: "A reminder status filter takes scheduled, fired, canceled or migrated, separated by commas." };
export const REMINDER_TITLE_REQUIRED_REFUSAL: RefusalInput = { code: "reminder_title_invalid", error: "A reminder needs a title: give it a short line saying what it is for." };
export const REMINDER_TITLE_TOO_LONG_REFUSAL: RefusalInput = { code: "reminder_title_invalid", error: `A reminder's title can be at most ${REMINDER_MAX_TITLE_LEN} characters: shorten it.` };
export const REMINDER_TIMEZONE_INVALID_REFUSAL: RefusalInput = { code: "reminder_timezone_invalid", error: "A reminder's time zone must be an IANA name, such as Asia/Shanghai." };
export const REMINDER_REPEAT_INVALID_REFUSAL: RefusalInput = { code: "reminder_repeat_invalid", error: "A repeat rule is text such as every:15m, daily@09:00 or weekly:mon,fri@09:00." };
export const REMINDER_TIMEZONE_REQUIRED_REFUSAL: RefusalInput = { code: "reminder_timezone_required", error: "A daily@ or weekly: rule needs a time zone: give an IANA name, such as America/Los_Angeles." };
export const REMINDER_SCHEDULE_REQUIRED_REFUSAL: RefusalInput = { code: "reminder_schedule_required", error: "A reminder needs to know when to fire: give it a delay in seconds, a time to fire at, or a repeat rule." };
export const REMINDER_MESSAGE_REQUIRED_REFUSAL: RefusalInput = { code: "reminder_message_required", error: "A reminder you schedule needs the message it is about: give that message's id." };
export const REMINDER_CHANNEL_INVALID_REFUSAL: RefusalInput = { code: "reminder_channel_invalid", error: "A reminder's channel has to be a channel name, such as #general: give one, or leave the channel out." };
/** A time zone name Intl doesn't know (400 `reminder_timezone_invalid`). */
export function reminderTimezoneUnknownRefusal(tz: string): RefusalInput {
  return {
    code: "reminder_timezone_invalid",
    error: sentenceQuoting([tz], `"${tz}" isn't a time zone this server knows: use an IANA name, such as Asia/Shanghai.`, "That isn't a time zone this server knows: use an IANA name, such as Asia/Shanghai."),
  };
}

/** A repeat rule that doesn't parse, with the parser's reason (400 `reminder_repeat_invalid`). */
export function reminderRepeatUnparsedRefusal(parseError: string): RefusalInput {
  return {
    code: "reminder_repeat_invalid",
    error: sentenceQuoting([parseError], `That repeat rule doesn't parse: ${parseError}`, "That repeat rule doesn't parse: use one such as every:15m, daily@09:00 or weekly:mon,fri@09:00."),
  };
}

/** A fire time or delay resolveScheduleInput refused, in its words (400 `reminder_schedule_invalid`). */
export function reminderScheduleInvalidRefusal(scheduleError: string): RefusalInput {
  return { code: "reminder_schedule_invalid", error: scheduleError };
}

/** No reminder of this agent's has that id; another agent's reads the same (404 `reminder_not_found`). */
export const REMINDER_NOT_FOUND_REFUSAL: RefusalInput = {
  code: "reminder_not_found",
  error: "None of your reminders has that id: check the id in your reminder list.",
};

/**
 * A reminder's delivery channel the agent can't use: no such channel and one
 * it can't see read the same (404 `channel_not_found`).
 */
export const REMINDER_CHANNEL_NOT_FOUND_REFUSAL: RefusalInput = {
  code: "channel_not_found",
  error: "Not found, or you don't have access: no channel you can see has that name, so check the name, or leave the channel out to be reminded where the message is.",
  next: RAFT_HINTS.serverInfo({ view: "channels" }),
};

/** A cancel, snooze or update of a reminder that is past it (409 `reminder_not_active`). */
export function reminderNotCancelableRefusal(status: string): RefusalInput {
  return { code: "reminder_not_active", error: `This reminder is already ${status}, so there is nothing to cancel.` };
}
export function reminderNotSnoozableRefusal(status: string): RefusalInput {
  return { code: "reminder_not_active", error: `This reminder is already ${status}, so it can't be snoozed: only scheduled or fired reminders can.` };
}
export const REMINDER_FIRED_NOT_UPDATABLE_REFUSAL: RefusalInput = {
  code: "reminder_not_active",
  error: "This reminder has already fired, so it can't be updated: snooze it back to scheduled first, or schedule a new one.",
};
export function reminderNotUpdatableRefusal(status: string): RefusalInput {
  return { code: "reminder_not_active", error: `This reminder is already ${status}, so it can't be updated.` };
}

export const REMINDER_UPDATE_INVALID_REFUSAL: RefusalInput = { code: "reminder_update_invalid", error: "An update changes exactly one thing: the time (fireAt or delaySeconds), the repeat, or the title." };

/** The reminder changed between the route's read and its write (409 `reminder_state_conflict`). */
export const REMINDER_STATE_CONFLICT_REFUSAL: RefusalInput = {
  code: "reminder_state_conflict",
  error: "The reminder changed while this request was being made: look at it again in your reminder list, and make the change if it still applies.",
};

// Writable targets: send, resolve-channel (uploads) and action prepare.

/** Why resolveWritableAgentTarget gave no conversation to write to (null: none the agent can see). */
export type UnwritableAgentTarget = "forbidden" | "peer-not-found" | "self-dm" | null;

/** A DM by peer name (`dm:@peer`) or by App Bot subject (`dm:sub:<sub>`). */
function isDmTarget(target: string): boolean {
  return /^dm:(@|sub:)/i.test(target);
}

/**
 * The refusal for a target the agent can't write to, the same on every route
 * that resolves one (send, resolve-channel, action prepare). A target that
 * resolves to nothing reads the same for every reason, a function of the
 * target string alone (internalAgentApi.appBotDmBySub.test.ts); a channel or
 * thread the agent can see but isn't in is 403.
 */
export function unwritableTargetRefusal(outcome: UnwritableAgentTarget, target: string): { status: 400 | 403 | 404; refusal: RefusalInput } {
  switch (outcome) {
    case "forbidden":
      if (isThreadTarget(target) && target.startsWith("#")) {
        return { status: 403, refusal: { code: "target_forbidden", error: "You can't post in this thread because you aren't a member of its channel (following a thread only lets you read it): join the channel to reply, or if you were mentioned there, DM whoever mentioned you to say you aren't in the channel.", next: RAFT_HINTS.channelJoinName() } };
      }
      if (isDmTarget(target)) {
        return { status: 403, refusal: { code: "target_forbidden", error: "You can't send to this DM, for one of these reasons: you are an assistant and it isn't with your owner, it would open a new DM with a guest, or you aren't part of it. Reply where the person reached you instead." } };
      }
      return { status: 403, refusal: { code: "target_forbidden", error: "You can't post in this channel because you aren't a member: join it to send, or if you were mentioned there, DM whoever mentioned you to say you aren't in the channel.", next: RAFT_HINTS.channelJoinName() } };
    case "peer-not-found": {
      const name = target.slice(4);
      return {
        status: 404,
        refusal: {
          code: "peer_not_found",
          error: sentenceQuoting([name], `No person or agent on this server is called @${name}: check the name, or look it up in the server's directory.`, "No person or agent on this server has that name: check the name, or look it up in the server's directory."),
          next: RAFT_HINTS.serverInfo({ query: name }),
        },
      };
    }
    case "self-dm":
      return { status: 400, refusal: { code: "self_dm", error: "You can't send a DM to yourself: pick another person or agent, or post in a channel." } };
    case null:
      return { status: 404, refusal: targetNotFoundRefusal(target) };
  }
}

/**
 * Nothing the agent can post in matches the target (404 `target_not_found`),
 * the same for every reason: also the answer when the target of a card a
 * route posts for the agent (an Agent Login approval or install request, an
 * app registration card) resolves to nothing.
 */
export function targetNotFoundRefusal(target: string): RefusalInput {
  if (isThreadTarget(target)) {
    return {
      code: "target_not_found",
      error: sentenceQuoting([target], `No thread you can reply in matches ${target}: a thread target is #channel:<id> or dm:@peer:<id>, where <id> is the parent message's short id (the msg= field, as in replyTarget), and that message must belong to the conversation named before it.`, "No thread you can reply in matches that target: a thread target is #channel:<id> or dm:@peer:<id>, where <id> is the parent message's short id (the msg= field, as in replyTarget), and that message must belong to the conversation named before it."),
    };
  }
  return {
    code: "target_not_found",
    error: sentenceQuoting([target], `Nothing you can post in matches ${target}: check the target, or find the conversation in the server's directory.`, "Nothing you can post in matches that target: check the target, or find the conversation in the server's directory."),
    next: RAFT_HINTS.serverInfo(),
  };
}

// Attachment uploads.

export const UPLOAD_FILE_REQUIRED_REFUSAL: RefusalInput = { code: "file_required", error: "The upload carries no file: send exactly one file with it." };
export const UPLOAD_FILE_EMPTY_REFUSAL: RefusalInput = { code: "file_empty", error: "That file is empty, and an empty file can't be uploaded: check the path, then upload a file with content." };
export const UPLOAD_CHANNEL_REQUIRED_REFUSAL: RefusalInput = { code: "INVALID_ARG", error: "An upload needs the channel it goes to: give that channel's id." };
export const UPLOAD_MEMBERSHIP_REQUIRED_REFUSAL: RefusalInput = {
  code: "channel_membership_required",
  error: "You can upload only to a conversation you can post in: join the channel first, or upload where you can post.",
};

// Agent profile: display name, description and avatar.

export const MAX_AGENT_PROFILE_DESCRIPTION_LENGTH = 3000;
export const MAX_AGENT_PROFILE_DISPLAY_NAME_LENGTH = 80;

export const PROFILE_UPDATE_NO_FIELDS_REFUSAL: RefusalInput = { code: "PROFILE_UPDATE_NO_FIELDS", error: "A profile update needs something to change: give a display name, a description or an avatar URL." };
/** No image came with an avatar upload (400 `avatar_file_required`, the code the agent API server avatar route already sent). */
export const AVATAR_FILE_REQUIRED_REFUSAL: RefusalInput = { code: "avatar_file_required", error: "The avatar upload carries no image: send one JPEG, PNG, GIF or WebP file." };
export const AVATAR_BAD_FORMAT_REFUSAL: RefusalInput = { code: "PROFILE_AVATAR_BAD_FORMAT", error: "Only an image can be an avatar: upload a JPEG, PNG, GIF or WebP file." };
const AVATAR_URL_INVALID_REFUSAL: RefusalInput = { code: "PROFILE_AVATAR_URL_BAD_FORMAT", error: "An avatar URL has to start with pixel: (such as pixel:random:<seed>): give one in that form, or upload an image file instead." };
const DISPLAY_NAME_EMPTY_REFUSAL: RefusalInput = { code: "profile_display_name_invalid", error: "A display name can't be empty: give the name to show, or leave it out to keep the current one." };
const DISPLAY_NAME_TOO_LONG_REFUSAL: RefusalInput = { code: "profile_display_name_invalid", error: `A display name can be at most ${MAX_AGENT_PROFILE_DISPLAY_NAME_LENGTH} characters: shorten it.` };
const DESCRIPTION_EMPTY_REFUSAL: RefusalInput = { code: "profile_description_invalid", error: "A description can't be empty: give one, or leave it out to keep the current one." };
const DESCRIPTION_TOO_LONG_REFUSAL: RefusalInput = { code: "profile_description_invalid", error: `A description can be at most ${MAX_AGENT_PROFILE_DESCRIPTION_LENGTH} characters: shorten it.` };

export type AgentProfileFields = { avatarUrl?: string; displayName?: string; description?: string };

/**
 * The fields of an agent's profile update, checked the same way on the agent
 * API and the legacy route: present fields only, trimmed (a description keeps
 * its whitespace), or the 400 refusal for the first field that is wrong.
 */
export function agentProfileUpdateFields(body: { avatarUrl?: unknown; displayName?: unknown; description?: unknown }): { ok: true; fields: AgentProfileFields } | { ok: false; refusal: RefusalInput } {
  const has = (key: "avatarUrl" | "displayName" | "description") => Object.prototype.hasOwnProperty.call(body, key);
  if (!has("avatarUrl") && !has("displayName") && !has("description")) return { ok: false, refusal: PROFILE_UPDATE_NO_FIELDS_REFUSAL };
  const fields: AgentProfileFields = {};
  if (has("avatarUrl")) {
    const value = typeof body.avatarUrl === "string" ? body.avatarUrl.trim() : "";
    if (!value.startsWith("pixel:")) return { ok: false, refusal: AVATAR_URL_INVALID_REFUSAL };
    fields.avatarUrl = value;
  }
  if (has("displayName")) {
    const value = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!value) return { ok: false, refusal: DISPLAY_NAME_EMPTY_REFUSAL };
    if (value.length > MAX_AGENT_PROFILE_DISPLAY_NAME_LENGTH) return { ok: false, refusal: DISPLAY_NAME_TOO_LONG_REFUSAL };
    fields.displayName = value;
  }
  if (has("description")) {
    const value = typeof body.description === "string" ? body.description : "";
    if (!value) return { ok: false, refusal: DESCRIPTION_EMPTY_REFUSAL };
    if (value.length > MAX_AGENT_PROFILE_DESCRIPTION_LENGTH) return { ok: false, refusal: DESCRIPTION_TOO_LONG_REFUSAL };
    fields.description = value;
  }
  return { ok: true, fields };
}

/** A managed App Bot's avatar is its App's logo (403 `app_bot_avatar_managed`). */
export const APP_BOT_AVATAR_MANAGED_REFUSAL: RefusalInput = {
  code: "app_bot_avatar_managed",
  error: "A managed bot's avatar is its app's logo, so it can't be changed here: the app's owner changes it by changing the logo.",
};
/** A cloud agent's or an assistant's description is its instructions (403 `hosted_agent_description_human_only`). */
export const DESCRIPTION_HUMAN_ONLY_REFUSAL: RefusalInput = {
  code: "hosted_agent_description_human_only",
  error: "Your description is your instructions, so only a human can change it: nothing was changed, and leaving the description out lets you change the other fields.",
  suggestedNextAction: "Your description is your instructions, so only a human can change it: ask one to edit it in your Profile tab in Raft. Nothing was changed; to update your display name or avatar, retry without the description.",
};
/** An avatar image over the size limit (400 `PROFILE_AVATAR_TOO_LARGE`). */
export const AVATAR_TOO_LARGE_REFUSAL: RefusalInput = {
  code: "PROFILE_AVATAR_TOO_LARGE",
  error: `That image is too big for an avatar: upload one of ${PROFILE_AVATAR_MAX_SIZE_LABEL} or smaller.`,
};
/** The acting agent was deleted mid-request (404 `agent_not_found`; the same sentence as the 401 for a credential's missing agent). */
export const AGENT_GONE_REFUSAL: RefusalInput = {
  code: "agent_not_found",
  error: "The agent this credential belongs to no longer exists on this server: use the credential of an agent that does.",
};
/** The server was deleted while its avatar was being set (404 `server_not_found`). */
export const SERVER_GONE_FOR_AVATAR_REFUSAL: RefusalInput = {
  code: "server_not_found",
  error: "This server no longer exists, so its avatar can't be changed.",
};
/** The agent's server was deleted mid-request (404 `server_not_found`). */
export const AGENT_SERVER_GONE_REFUSAL: RefusalInput = {
  code: "server_not_found",
  error: "This agent's server no longer exists: work from an agent on a server that does.",
};

/**
 * The fields an agent may never write on its own profile, checked the same on
 * the agent API and the legacy route, before the fields themselves: a managed
 * App Bot's avatar (it is its app's logo), and the description of a cloud
 * agent or a personal assistant (it is their instructions, so only a human may
 * change it; the next human edit pushes it to the provider). `isHostedAgent`
 * is asked only when a description is being written.
 */
export async function agentProfileFenceRefusal(
  agent: { managedByAppInstallId?: string | null; assistantOwnerUserId?: string | null },
  body: { avatarUrl?: unknown; description?: unknown },
  isHostedAgent: () => Promise<boolean>,
): Promise<RefusalInput | null> {
  const has = (key: "avatarUrl" | "description") => Object.prototype.hasOwnProperty.call(body, key);
  if (has("avatarUrl") && agent.managedByAppInstallId) return APP_BOT_AVATAR_MANAGED_REFUSAL;
  if (has("description") && (agent.assistantOwnerUserId || await isHostedAgent())) return DESCRIPTION_HUMAN_ONLY_REFUSAL;
  return null;
}

// Integrations: Agent Login, the Marketplace and app registration cards.

export const MARKETPLACE_LIMIT_INVALID_REFUSAL: RefusalInput = { code: "limit_invalid", error: "A Marketplace search's limit is a whole number from 1 to 50." };
/**
 * Any failed availability or authority check on an agent token (403
 * `AGENT_JWT_NOT_AUTHORIZED`): one sentence for every reason, so an
 * unavailable private App reads the same as an unknown one
 * (docs/raft-app/agent-audience-jwt.md).
 */
export const AGENT_JWT_NOT_AUTHORIZED_REFUSAL: RefusalInput = {
  code: "AGENT_JWT_NOT_AUTHORIZED",
  error: "You can't get a token for that app: it isn't available to you on this server, you haven't logged in to it, or its access is waiting on a person's approval. List your integrations to see which apps you can use and how.",
};
/**
 * An App installed here whose installation is suspended (403
 * `INTEGRATION_INSTALLATION_SUSPENDED`), not an install offer. Names the app by
 * its client key (a constrained identifier), not its publisher-set name.
 */
export function installationSuspendedRefusal(clientKey: string | null): RefusalInput {
  const app = clientKey ? `The app ${clientKey}` : "This app";
  return {
    code: "INTEGRATION_INSTALLATION_SUSPENDED",
    error: sentenceQuoting(
      clientKey ? [clientKey] : [],
      `${app} is installed on this server, but its installation is suspended: a server owner or admin must restore it before agents can log in.`,
      "This app is installed on this server, but its installation is suspended: a server owner or admin must restore it before agents can log in.",
    ),
  };
}
const LOGIN_SCOPE_NOT_OFFERED_REFUSAL: RefusalInput = {
  code: "INVALID_SCOPE",
  error: "This service doesn't offer one of the scopes you asked for: ask only for scopes it declares, or leave the scopes out to get its defaults.",
};
const LOGIN_SCOPES_MALFORMED_REFUSAL: RefusalInput = {
  code: "scopes_invalid",
  error: "Scopes are a list of at least one scope name, each a non-empty string: send them in that form, or leave them out to get the service's defaults.",
};
/** The 400 for a scope error the Agent Login service threw, by its message, or null when the message is about something else. */
function isMalformedScopesMessage(message: string): boolean {
  return message === "scopes must be an array"
    || message === "scopes must contain strings"
    || message === "scope values must be non-empty"
    || message === "at least one scope is required";
}
export function agentLoginScopeRefusal(message: string): RefusalInput | null {
  if (message === "invalid_scope") return LOGIN_SCOPE_NOT_OFFERED_REFUSAL;
  if (isMalformedScopesMessage(message)) return LOGIN_SCOPES_MALFORMED_REFUSAL;
  return null;
}
const APP_SCOPES_MALFORMED_REFUSAL: RefusalInput = {
  code: "scopes_invalid",
  error: "An app's scopes are a list of at least one Raft scope name, each a non-empty string, such as openid and profile: send them in that form.",
};
/**
 * The 400 for a scope error while preparing an app registration card. Unlike
 * an Agent Login, an app left without scopes gets none, so the step never says
 * to leave them out; any other scope message is answered as app metadata.
 */
export function appRegistrationScopeRefusal(message: string): RefusalInput {
  if (message === "invalid_scope") return APP_SCOPE_UNKNOWN_REFUSAL;
  if (isMalformedScopesMessage(message)) return APP_SCOPES_MALFORMED_REFUSAL;
  return appMetadataInvalidRefusal(message);
}
/** 410 `LEGACY_APP_UPDATE_DISABLED`: registration changes no longer go through a card. */
export const APP_UPDATE_CARD_DISABLED_REFUSAL: RefusalInput = {
  code: "LEGACY_APP_UPDATE_DISABLED",
  error: "An app's registration is no longer changed through a card: its owner updates the app directly.",
};
export const APP_CARD_TARGET_REQUIRED_REFUSAL: RefusalInput = { code: "target_required", error: "An app registration card needs a target: give the channel or DM to post it in." };
export const APP_CARD_MODE_INVALID_REFUSAL: RefusalInput = { code: "mode_invalid", error: "An app card's mode is register (update cards are no longer used)." };
export const APP_SCOPE_UNKNOWN_REFUSAL: RefusalInput = { code: "INVALID_SCOPE", error: "One of the scopes isn't a scope Raft defines: ask only for Raft scopes, such as openid and profile." };
export const APP_CATEGORY_INVALID_REFUSAL: RefusalInput = { code: "INVALID_CATEGORY", error: `That isn't an app category: use one of ${OAUTH_CLIENT_CATEGORIES.join(", ")}.` };
export const APP_NAME_REQUIRED_REFUSAL: RefusalInput = { code: "app_name_required", error: "Registering an app needs its name: give the name people will see." };
export const APP_RETURN_URL_REQUIRED_REFUSAL: RefusalInput = { code: "return_url_required", error: "Registering an app needs its return URL, where people land after logging in with Raft: give it." };

// App management: rotate secret, transfer, update, manage and logo.

export const APP_CLIENT_KEY_REQUIRED_REFUSAL: RefusalInput = { code: "client_key_required", error: "Say which app this is for: give its client id." };
/** An app this agent can't see reads the same as one that doesn't exist (404 `app_not_found`, non-enumerating). */
export const APP_NOT_FOUND_REFUSAL: RefusalInput = { code: "app_not_found", error: "No app you can see on this server has that client id: check the id, or list the apps you manage." };
/** The same 404 for a status lookup by the card that registered the app. */
export const APP_NOT_FOUND_BY_CARD_REFUSAL: RefusalInput = { code: "app_not_found", error: "No app you can see on this server was registered by that card: check the card, or list the apps you manage." };
/** The one fixed message the Marketplace review request throws (oauthService requestOAuthClientPublish). */
export const APP_REVIEW_DESCRIPTION_MESSAGE = "description is required before requesting marketplace review";
export const APP_REVIEW_DESCRIPTION_REQUIRED_REFUSAL: RefusalInput = { code: "app_description_required", error: "An app needs a description before it can be sent for Marketplace review: add one, then request the review again." };
/** 403 `APP_MANAGE_AUTHORITY_REQUIRED`: only the app's owner or a server admin (and, for a secret, a delegated rotate maintainer) may make the change. */
export function appManageAuthorityRefusal(change: "rotate its secret" | "transfer it" | "update it" | "manage it" | "update its logo"): RefusalInput {
  const who = change === "rotate its secret"
    ? "this app's owner, an agent given rotate rights on it, or a current server admin"
    : "this app's owner or a current server admin";
  return { code: "APP_MANAGE_AUTHORITY_REQUIRED", error: `Only ${who} can ${change}: ask one of them to do it.` };
}
export const APP_TRANSFER_FIELDS_REQUIRED_REFUSAL: RefusalInput = { code: "transfer_fields_required", error: "Transferring an app needs its client id and the agent to give it to." };
export function appTransferTargetNotFoundRefusal(name: string): RefusalInput {
  return {
    code: "target_agent_not_found",
    error: sentenceQuoting([name], `No agent on this server is called @${name}: check the name of the agent to give the app to.`, "No agent on this server has that name: check the name of the agent to give the app to."),
  };
}
export const APP_UPDATE_NO_FIELDS_REFUSAL: RefusalInput = { code: "app_update_no_fields", error: "An app update needs something to change: give at least one field, such as its name, description or return URL." };
export const APP_RETURN_URL_EMPTY_REFUSAL: RefusalInput = { code: "RETURN_URL_REQUIRED", error: "An app's return URL can't be empty, since an OAuth app keeps a registered callback address: give a new one, or leave it out to keep the current one." };
export function shareLinkTargetNotApplicableRefusal(action: string): RefusalInput {
  return {
    code: "SHARE_LINK_TARGET_NOT_APPLICABLE",
    error: sentenceQuoting([action], `A target server applies only to creating or revoking a share link, not to ${action}: leave it out.`, "A target server applies only to creating or revoking a share link: leave it out."),
  };
}
export const SHARE_LINK_TARGET_INVALID_REFUSAL: RefusalInput = { code: "SHARE_LINK_TARGET_INVALID", error: "A target server is named by its slug, which has only lowercase letters, digits and hyphens." };
export const SHARE_LINK_TARGET_REQUIRED_REFUSAL: RefusalInput = {
  code: "SHARE_LINK_TARGET_REQUIRED",
  error: "A private share link installs on one server: name that server by its slug.",
  suggestedNextAction: "Pass the server's slug with --target-server.",
};
export const SHARE_LINK_UNAVAILABLE_REFUSAL: RefusalInput = { code: "share_link_unavailable", error: "This app can't get a private share link in its current state (an app that is turned off can't be shared): check its status first." };
export const SHARE_LINK_NOT_FOUND_REFUSAL: RefusalInput = { code: "share_link_not_found", error: "This app has no active share link to revoke (for that server, if you named one)." };
export const PUBLISH_REQUEST_UNAVAILABLE_REFUSAL: RefusalInput = { code: "publish_request_unavailable", error: "This app can't be sent for Marketplace review in its current state: it is already published, or its removal is pending. Check its status first." };
export const APP_NOT_PUBLISHED_REFUSAL: RefusalInput = { code: "app_not_published", error: "This app isn't published in the Marketplace, or it is turned off, so its removal can't be requested: check its status." };
export const APP_PUBLISHED_NOT_DELETABLE_REFUSAL: RefusalInput = { code: "app_published", error: "A published app can't be deleted: request its removal from the Marketplace first, and delete it once it is removed." };
export const LOGO_FILE_REQUIRED_REFUSAL: RefusalInput = { code: "logo_file_required", error: "The logo upload carries no image: send one JPEG, PNG, GIF or WebP file." };
export const APP_LOGO_TOO_LARGE_REFUSAL: RefusalInput = { code: "APP_LOGO_TOO_LARGE", error: `That image is too big for a logo: upload one of ${PROFILE_AVATAR_MAX_SIZE_LABEL} or smaller.` };
export const APP_LOGO_BAD_FORMAT_REFUSAL: RefusalInput = { code: "APP_LOGO_BAD_FORMAT", error: "Only an image can be a logo: upload a JPEG, PNG, GIF or WebP file." };
export const APP_STATUS_LOOKUP_INVALID_REFUSAL: RefusalInput = { code: "app_lookup_invalid", error: "Look an app up by exactly one of its client id or the card that registered it, not both and not neither." };

// Slice 11: the last agent API and legacy route refusals.

/**
 * A refusal whose sentence is a service's own message, as the route answered
 * before: the message when it reads as a refusal sentence, `fallback`
 * otherwise (a message with a line break or a flag in it, or a long one).
 */
export function serviceMessageRefusal(code: string, message: string, fallback: string): RefusalInput {
  return { code, error: sentenceQuoting([message], message, fallback) };
}

/**
 * A message looked up by id that the agent can't read (404 `NOT_FOUND`): no
 * such message and one it can't see read the same, on the agent API and the
 * legacy resolve route alike.
 */
export const MESSAGE_NOT_FOUND_REFUSAL: RefusalInput = {
  code: "NOT_FOUND",
  error: "Not found, or you don't have access: no message you can see has that id, so check the id or search for the message.",
};
const MESSAGE_ID_INVALID_REFUSAL: RefusalInput = { code: "INVALID_ARG", error: "A message id is a full UUID or the 8-character short id a message line shows (msg=): check the id." };
const MESSAGE_SHORT_ID_AMBIGUOUS_REFUSAL: RefusalInput = {
  code: "AMBIGUOUS_ID",
  error: "That 8-character short id matches more than one message you can see: use the message's full id instead.",
  suggestedNextAction: "Use the full message UUID instead of the 8-character short id.",
};
/** A message id lookup that failed (messageService.resolveMessageIdVisibleToAgent), by its fixed messages. */
export function messageResolveRefusal(error: string): RefusalInput {
  if (/ambiguous/i.test(error)) return MESSAGE_SHORT_ID_AMBIGUOUS_REFUSAL;
  if (/must be/i.test(error)) return MESSAGE_ID_INVALID_REFUSAL;
  return MESSAGE_NOT_FOUND_REFUSAL;
}

/**
 * The single answer BOTH for "no message with that short id in this channel"
 * and for "that short id belongs to some other channel" (404 `NOT_FOUND`):
 * one function, so the two are identical by construction. Saying "it lives in
 * #elsewhere" would tell a caller who cannot see that channel both that it
 * exists and where the message is; saying "it has no replies yet" would
 * assert something not checked. `parentRef` is safe to echo: the caller
 * supplied it, and it resolved as visible to them. Task #145, @Tenny's ruling
 * in #proj-dx:4cd28c12.
 */
export function threadAnchorNotFoundRefusal(parentRef: string): RefusalInput {
  return {
    code: "NOT_FOUND",
    error: sentenceQuoting(
      [parentRef],
      `No message or thread in ${parentRef} has that id: check the message id, or read the conversation's recent messages.`,
      "No message or thread in that conversation has that id: check the message id, or read the conversation's recent messages.",
    ),
    next: RAFT_HINTS.messageRead({ target: parentRef }),
  };
}

/** A message seq cursor that is neither a whole number nor `latest` (400 `since_invalid`). */
export const SINCE_SEQ_INVALID_REFUSAL: RefusalInput = { code: "since_invalid", error: "since is a message seq (a whole number, 0 or more) or latest: pass the seq the last page ended at, or latest." };
/** A `since` time that isn't a date and time (400 `invalid_since`). */
export const SINCE_TIME_INVALID_REFUSAL: RefusalInput = { code: "invalid_since", error: "since is a date and time in ISO 8601 form, such as 2026-11-01T09:00:00Z: send it in that form, or leave it out." };

/** An integration action type the generic action prepare doesn't take (400 `ACTION_TYPE_NOT_PREPARABLE`). */
export const ACTION_TYPE_NOT_PREPARABLE_REFUSAL: RefusalInput = {
  code: "ACTION_TYPE_NOT_PREPARABLE",
  error: "Integration action cards can't be prepared directly: the integration commands create them, so use those instead.",
};
/** A legacy send, resolve-channel or action prepare without a target (400 `target_required`). */
export const TARGET_REQUIRED_REFUSAL: RefusalInput = { code: "target_required", error: "Say where this goes: give a target, such as #general, dm:@richard or a thread." };

/**
 * A not-found the Agent Login service threw (oauthService.requestAgentAccess):
 * the acting agent gone, the service no longer available to it, or (any
 * other message) the service's own words.
 */
export function agentLoginNotFoundRefusal(message: string): RefusalInput {
  if (message === "Agent not found") return AGENT_GONE_REFUSAL;
  if (message === "OAuth client not found for server") {
    return { code: "service_not_found", error: "That service isn't available to you on this server any more: list your integrations to see the ones you can log in to." };
  }
  return serviceMessageRefusal("not_found", message, "Something this login needs no longer exists: start the login again.");
}

/** App fields the app service refused, in its words (400 `INVALID_APP_METADATA`). */
export function appMetadataInvalidRefusal(message: string): RefusalInput {
  return serviceMessageRefusal("INVALID_APP_METADATA", message, "One of the app's fields isn't valid: check its manifest URL, setup fields, scopes and when-to-use text.");
}

/**
 * An assignment the task service refused (409); its reasons are fixed
 * strings (taskService.assignTask), and any other is answered in its words.
 */
export function taskAssignRefusal(reason: string, channel: string, taskNumber: number): RefusalInput {
  switch (reason) {
    case "task not found":
      return taskNotFoundRefusal(channel, taskNumber);
    case "task is done":
      return { code: "task_done", error: `Task #${taskNumber} is done, so it can't be assigned: reopen it first if someone should pick it up again.` };
    case "task state changed concurrently":
      return { code: "task_state_conflict", error: TASK_STATE_CONFLICT_ERROR };
    case "task channel is unavailable":
      return { code: "task_channel_unavailable", error: "This task's channel no longer exists, so the task can't be assigned." };
    case "assignee not found":
      return { code: "assignee_not_found", error: "No person or agent on this server matches that assignee: check the name." };
    case "assignee is not a member of this channel":
      return { code: "assignee_not_member", error: "That assignee isn't a member of this task's channel: add them to the channel first, or assign someone who is in it." };
    case TASK_ASSIGN_REASON_UNCHANGED_MESSAGE:
      return { code: TASK_ASSIGN_REASON_UNCHANGED, error: reason };
    default:
      return serviceMessageRefusal("task_assign_rejected", reason, "The task couldn't be assigned as asked: look at the task again, then try once more.");
  }
}

// Machine routes (internal.ts /machine/...).

/** A machine route without a machine's credential, or with one for a machine not on this server (401 `machine_auth_required`). */
export const MACHINE_AUTH_REQUIRED_REFUSAL: RefusalInput = { code: "machine_auth_required", error: "This request needs a machine's own credential for this server: send it with the machine's key." };
/** The authenticated machine is no longer on its server (404 `machine_not_found`). */
export const MACHINE_NOT_FOUND_REFUSAL: RefusalInput = { code: "machine_not_found", error: "This machine is no longer registered on this server: connect it to the server again." };
/** The machine's server was deleted mid-request (404 `server_not_found`). */
export const MACHINE_SERVER_GONE_REFUSAL: RefusalInput = { code: "server_not_found", error: "This machine's server no longer exists." };
