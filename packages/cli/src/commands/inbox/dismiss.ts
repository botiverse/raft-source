// `raft inbox dismiss --target <item> | --before <time>`
// -> POST /internal/agent-api/inbox/dismiss (RFC 081 D12)
//
// The escape hatch for a list full of stale items: marks items dismissed
// without printing or reading them. Exactly one of --target or --before;
// there is no "all". Reminders are never dismissed (they need an ack).
//
// The target a Computer-local app item's row prints (its `dismiss:` line in
// `raft inbox check`'s daemon section) is answered by a managed runner's
// daemon, in the Server's response shape; that request never reaches the
// Server (packages/daemon/src/agentCredentialProxy.ts).

import type { Command } from "commander";
import { AGENT_INBOX_DISMISS_BEFORE_NEXT_ACTION, formatHint, RAFT_HINTS } from "@botiverse/raft-shared/src/agentCliSurface";

import type { ApiResponse } from "../../client";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { apiFailureError, rateLimitedResponseError } from "../_apiFailure";
import { formatInboxDismissed } from "./_format";

interface InboxDismissOpts {
  target?: string;
  before?: string;
}

type DismissRequest = { target: string } | { before: string };

const INBOX_CHECK = formatHint(RAFT_HINTS.inboxList());
const LIST_ITEMS = `${INBOX_CHECK} lists your items.`;
// The Server's BEFORE_TOO_RECENT refusal carries the same line.
const BEFORE_FORMAT = AGENT_INBOX_DISMISS_BEFORE_NEXT_ACTION;

function validate(opts: InboxDismissOpts): DismissRequest {
  const target = opts.target?.trim();
  const before = opts.before?.trim();
  if (Boolean(target) === Boolean(before)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "Give exactly one of --target or --before; there is no \"all\".",
    });
  }
  return target ? { target } : { before: before! };
}

function mapDismissFailure(res: ApiResponse<unknown>, request: DismissRequest): CliError {
  const again = formatHint(RAFT_HINTS.inboxDismiss(request));
  const rateLimited = rateLimitedResponseError(res, again);
  if (rateLimited) return rateLimited;
  if (res.status === 404 && res.errorCode === "INBOX_ITEMS_DISABLED") {
    return new CliError({
      code: "INBOX_ITEMS_DISABLED",
      message: "Inbox items are not on for this server, so there is nothing to dismiss.",
      suggestedNextAction: INBOX_CHECK,
    });
  }
  // The route exists but the server does not dismiss items yet.
  if (res.status === 501) {
    return new CliError({
      code: "UNSUPPORTED_BY_SERVER",
      message: "This server can't dismiss inbox items yet.",
      suggestedNextAction: INBOX_CHECK,
    });
  }
  const serverMessage = res.error ?? `HTTP ${res.status}`;
  switch (res.errorCode) {
    case "NEEDS_ACK":
      return new CliError({
        code: "NEEDS_ACK",
        message: serverMessage,
        suggestedNextAction: res.suggestedNextAction ?? "Ack it with raft reminder ack.",
      });
    case "INVALID_BEFORE":
    case "BEFORE_TOO_RECENT":
    case "INVALID_ARG":
      return new CliError({ code: res.errorCode, message: serverMessage, suggestedNextAction: BEFORE_FORMAT });
    case "NOT_FOUND":
      return new CliError({
        code: "NOT_FOUND",
        message: `No inbox item ${"target" in request ? request.target : request.before} that you can dismiss.`,
        suggestedNextAction: LIST_ITEMS,
      });
    default:
      return apiFailureError(res, "INBOX_DISMISS_FAILED");
  }
}

export const inboxDismissCommand = defineCommand(
  {
    name: "dismiss",
    // RFC 081 D12 fixes this first line of --help; the exception for Computer-local items is in helpAfter.
    description: "Dismisses without reading; dismissed items won't remind you again.",
    options: [
      { flags: "--target <item>", description: "One item from raft inbox check" },
      { flags: "--before <time>", description: "Every item with no activity since this time: YYYY-MM-DD (UTC) or an RFC 3339 time, at least 24 hours ago, or the launch date raft inbox check names" },
    ],
    helpAfter:
      "\nFor a list full of stale items you won't read. Nothing is printed or read.\n" +
      "The one exception to \"won't remind you again\": an item whose row has a dismiss: line lives on your Computer, and its app may list it again; you are then told again.\n" +
      "Reminders are never dismissed: ack them with raft reminder ack. To read an item instead: raft inbox read --target <item>.\n",
  },
  async (ctx, opts: InboxDismissOpts = {}) => {
    const request = validate(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).inbox.dismiss(request);
    if (!res.ok) throw mapDismissFailure(res, request);
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API inboxDismiss returned an empty response body",
      });
    }
    writeText(ctx.io, formatInboxDismissed(res.data), NL);
  },
);

export function registerInboxDismissCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, inboxDismissCommand, runtimeOptions);
}
