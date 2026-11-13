// `raft inbox read --target <item> [--limit <n>] [--cursor <cursor>]`
// -> POST /internal/agent-api/inbox/read (RFC 081 D4)
//
// Reads one page of one inbox item, oldest unread first. The server consumes
// exactly what the page returns, so the request is sent once and never
// retried: a retry after a lost response would consume a second page that
// was never printed.

import type { Command } from "commander";
import {
  AGENT_INBOX_READ_MAX_ENTRIES,
  formatHint,
  inboxReadEntriesWithTarget,
  inboxReadExpiredRefusal,
  RAFT_HINTS,
} from "@botiverse/raft-shared/src/agentCliSurface";

import type { ApiResponse } from "../../client";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { apiFailureError, rateLimitedResponseError } from "../_apiFailure";
import { formatTarget } from "../message/_format";
import { recordConsumedExactSeqs } from "../message/_consumedSeqState";
import { elideSeenSenders } from "../message/_senderElision";
import { formatInboxRead, type InboxReadEntry } from "./_format";

interface InboxReadOpts {
  target?: string;
  limit?: string;
  cursor?: string;
}

const LIST_ITEMS = `${formatHint(RAFT_HINTS.inboxList())} lists your items.`;

type ValidatedInboxReadOpts = { target: string; limit?: number; cursor?: string };

function validate(opts: InboxReadOpts): ValidatedInboxReadOpts {
  const target = opts.target?.trim();
  if (!target) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--target is required: an item from raft inbox check.",
      suggestedNextAction: LIST_ITEMS,
    });
  }
  let limit: number | undefined;
  if (opts.limit !== undefined) {
    const raw = opts.limit.trim();
    limit = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_INBOX_READ_MAX_ENTRIES) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `--limit must be a whole number from 1 to ${AGENT_INBOX_READ_MAX_ENTRIES}; got ${opts.limit}`,
      });
    }
  }
  const cursor = opts.cursor?.trim();
  if (opts.cursor !== undefined && !cursor) {
    throw new CliError({ code: "INVALID_ARG", message: "--cursor is empty; copy it from the Next: line." });
  }
  return { target, ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) };
}

/**
 * Where to read when the server cannot read items: a conversation's own read
 * (`message read --unread`, or `task read --unread` for a task ref), a single
 * event's read, or the list for an app or reminder item.
 */
function readWithoutInboxItems(target: string): string {
  if (target.startsWith("app:") || target.startsWith("reminder:")) return LIST_ITEMS;
  if (target.startsWith("agent-event:")) return `Read it with ${formatHint(RAFT_HINTS.messageRead({ target }))}.`;
  return `Read the conversation with ${formatHint(RAFT_HINTS.messageRead({ target, unread: true }))}.`;
}

function mapReadFailure(res: ApiResponse<unknown>, target: string): CliError {
  const rateLimited = rateLimitedResponseError(res, formatHint(RAFT_HINTS.inboxRead({ target })));
  if (rateLimited) return rateLimited;
  if (res.status === 404 && res.errorCode === "INBOX_ITEMS_DISABLED") {
    return new CliError({
      code: "INBOX_ITEMS_DISABLED",
      message: "Inbox items are not on for this server.",
      suggestedNextAction: readWithoutInboxItems(target),
    });
  }
  // The route exists but the server does not read items yet.
  if (res.status === 501) {
    return new CliError({
      code: "UNSUPPORTED_BY_SERVER",
      message: "This server can't read inbox items yet.",
      suggestedNextAction: readWithoutInboxItems(target),
    });
  }
  switch (res.errorCode) {
    case "NOT_FOUND":
      return new CliError({ code: "NOT_FOUND", message: `No inbox item ${target} that you can read.`, suggestedNextAction: LIST_ITEMS });
    case "EXPIRED": {
      // A reaction notices item whose reactions were all removed before it was read (shared with the SDK's inbox.read).
      const withdrawn = inboxReadExpiredRefusal(target);
      if (withdrawn) return new CliError({ code: "EXPIRED", message: withdrawn.message, suggestedNextAction: withdrawn.nextAction });
      return new CliError({ code: "EXPIRED", message: `What was unread on ${target} expired before it was read.`, suggestedNextAction: LIST_ITEMS });
    }
    case "AMBIGUOUS_ID":
    case "INVALID_TARGET":
    case "INVALID_CURSOR":
      return new CliError({
        code: res.errorCode,
        message: res.error ?? `HTTP ${res.status}`,
        suggestedNextAction: res.suggestedNextAction ?? LIST_ITEMS,
      });
    default:
      return apiFailureError(res, "INBOX_READ_FAILED");
  }
}

function positiveSeq(entry: { seq?: unknown }): number | undefined {
  return typeof entry.seq === "number" && Number.isInteger(entry.seq) && entry.seq > 0 ? entry.seq : undefined;
}

export const inboxReadCommand = defineCommand(
  {
    name: "read",
    description: "Read one page of one inbox item, oldest unread first; what it prints is marked read.",
    options: [
      { flags: "--target <item>", description: "An item from raft inbox check: a conversation target, app:<app>/<ref>, app:<app>, reminder:<id>, or agent-event:<id>" },
      { flags: "--limit <n>", description: `At most this many entries (1-${AGENT_INBOX_READ_MAX_ENTRIES})` },
      { flags: "--cursor <cursor>", description: "Reminders only: the cursor from the Next: line" },
    ],
    helpAfter:
      "\nEach run prints at most one page (20 entries, about 8,000 characters). When more is left, the first line says how many; run the same command again for the rest.\n" +
      "A reminder is shown but stays until you ack it (raft reminder ack).\n" +
      "To re-read something already read, use raft message read --target <target>.\n" +
      "\nWhat this prints counts as seen by you, so a later send is not held for it.\n" +
      "Never discard or filter the output (>/dev/null, | head, | grep): what you cut out still counts as seen.\n",
  },
  async (ctx, opts: InboxReadOpts = {}) => {
    const { target, limit, cursor } = validate(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    // One attempt only (destructive_read): see the header comment.
    const res = await createAgentApiSurfaceClient(client).inbox.read({
      target,
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!res.ok) throw mapReadFailure(res, target);
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API inboxRead returned an empty response body",
      });
    }
    // A conversation page's entries name their conversation only by
    // `channelId`: they take the page's target, for the header and the ledger.
    const entries = inboxReadEntriesWithTarget(res.data, res.data.entries as InboxReadEntry[]);
    // Sender descriptions already shown in this context print as `@name` only.
    const senders = elideSeenSenders(entries, agentContext.agentId);
    writeText(ctx.io, formatInboxRead({ response: res.data, entries: senders.messages }), NL);
    await senders.settle(ctx.io);
    // What the page printed counts as seen, so a later send is not held for
    // it. A page is not a contiguous history window (a reminder's revisions,
    // an app item's events), so only the exact seqs are recorded, as
    // `raft message check` does.
    const consumed: Record<string, number[]> = {};
    for (const entry of entries) {
      const seq = positiveSeq(entry);
      if (seq === undefined) continue;
      (consumed[formatTarget(entry)] ??= []).push(seq);
    }
    recordConsumedExactSeqs(agentContext.agentId, consumed);
  },
);

export function registerInboxReadCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, inboxReadCommand, runtimeOptions);
}
