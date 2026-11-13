// The plan's history window, for every read of message content (cindyz,
// #proj-commercial task #8): a Free server shows the last 30 days to everyone
// who reads it, people and agents alike, with no exceptions. A message is
// behind the window when it was created at or before the cutoff, inside it
// when after (messageService's `created_at > cutoff`).
//
// Reads that already filter in SQL keep doing so with `cutoff`; reads of one
// message by id check it with `isBehindHistoryWindow` after their access
// check, so a message the reader may not see is never said to exist. Agents
// are told why older messages are missing (`agentHistoryLimitNote`,
// `agentHistoryLimitedRefusal`), not left to read it as "not found".

import { PLAN_CONFIG, getEffectiveLimits, type ServerPlan } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { messages } from "../db/schema";
import { lastSeqBehindHistory } from "./messageService";
import { getServerHistoryWindow } from "./planService";

export interface HistoryWindow {
  plan: ServerPlan;
  /** Undefined when the plan keeps all history. */
  cutoff: Date | undefined;
}

export async function getServerHistoryWindowForRead(serverId: string, now: Date = new Date()): Promise<HistoryWindow> {
  const { plan, cutoff } = await getServerHistoryWindow(serverId, now);
  return { plan, cutoff };
}

const requestWindows = new WeakMap<object, Promise<HistoryWindow>>();

/**
 * The window for one request (`request` is the key, e.g. the Express req):
 * read once, however many files or messages the request checks.
 */
export function getRequestHistoryWindow(request: object, serverId: string): Promise<HistoryWindow> {
  let window = requestWindows.get(request);
  if (!window) {
    window = getServerHistoryWindowForRead(serverId);
    requestWindows.set(request, window);
  }
  return window;
}

/** `lastSeqBehindHistory` for the reading server's window; 0 when it keeps all history. */
export async function lastSeqBehindWindow(channelId: string, window: HistoryWindow): Promise<number> {
  return window.cutoff ? lastSeqBehindHistory(channelId, window.cutoff) : 0;
}

export function isBehindHistoryWindow(createdAt: Date | string, window: HistoryWindow): boolean {
  return window.cutoff !== undefined && new Date(createdAt).getTime() <= window.cutoff.getTime();
}

function historyDays(plan: ServerPlan): number {
  return getEffectiveLimits(plan).messageHistoryDays;
}

/** The line an agent's read carries when it reaches the start of the window and older messages exist. */
export function agentHistoryLimitNote(window: HistoryWindow): string {
  return `Older messages are hidden: this server is on the ${PLAN_CONFIG[window.plan].displayName} plan, which keeps the last ${historyDays(window.plan)} days. Upgrading to Pro restores the full history.`;
}

/**
 * The line an agent's search carries when the window hides matches (task
 * #proj-commercial:#24, F): how many (MessageSearchPage.olderHidden), and not
 * to tell a person nothing older exists.
 */
export function agentSearchHistoryLimitNote(window: HistoryWindow, hidden: { count: number; capped: boolean }): string {
  const matches = hidden.capped
    ? `Over ${hidden.count} older matches are`
    : hidden.count === 1 ? "1 older match is" : `${hidden.count} older matches are`;
  return `${matches} hidden: this server is on the ${PLAN_CONFIG[window.plan].displayName} plan, which keeps the last ${historyDays(window.plan)} days, so don't say nothing older exists. Upgrading to Pro restores the full history.`;
}

/**
 * A file is behind the window with the message it was posted in; one not
 * posted yet is not. The window step after a file's own access check (files
 * keep their authority rule, services/attachmentAuthorityService.ts):
 * `messageCreatedAt` is that message's time when the check already read it (a
 * bound file's authority context), so it is not read again; a legacy file's
 * check reads none, and its message time is looked up here.
 */
export async function isAttachmentBehindWindow(
  attachment: { messageId: string | null | undefined; messageCreatedAt?: Date | null },
  window: HistoryWindow,
): Promise<boolean> {
  if (!window.cutoff || !attachment.messageId) return false;
  const createdAt = attachment.messageCreatedAt
    ?? (await getDb().select({ createdAt: messages.createdAt }).from(messages)
      .where(eq(messages.id, attachment.messageId)).limit(1))[0]?.createdAt;
  return createdAt !== undefined && isBehindHistoryWindow(createdAt, window);
}

/**
 * The refusal (404, through refuse()) when an agent asks for one message
 * behind the window, by id or as a read's anchor, or acts on it (`subject:
 * "file"` for a file posted in it). The CLI branches on `HISTORY_LIMITED`;
 * the plan and its days are in the sentence (no client read the former
 * top-level `historyLimit`).
 */
export function agentHistoryLimitedRefusal(window: HistoryWindow, subject: "message" | "file" = "message"): { code: "HISTORY_LIMITED"; error: string } {
  const days = historyDays(window.plan);
  const what = subject === "file" ? "This file is in a message" : "This message is";
  return {
    code: "HISTORY_LIMITED",
    error: `${what} older than the ${days}-day history on the ${PLAN_CONFIG[window.plan].displayName} plan. Upgrading to Pro restores the full history.`,
  };
}

/**
 * The answer when a person's request names one message behind the window (an
 * API call; the web never shows such a message). `code` as the context
 * route's `history_limited`.
 */
export function humanHistoryLimitedError(window: HistoryWindow) {
  const days = historyDays(window.plan);
  return {
    error: `This message is older than the ${days}-day history on the ${PLAN_CONFIG[window.plan].displayName} plan.`,
    code: "history_limited" as const,
  };
}
