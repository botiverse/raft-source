// `raft task reply <ref> [--attachment-id <id>...] [--mention <actor>...]`
// (task v2) — reply in a task's own conversation; the body is read from
// stdin, as with `raft message send`. The first reply to a task from before
// task v2 creates its conversation.
// → POST /internal/agent-api/tasks/reply

import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { AgentApiStructuredMention } from "@botiverse/raft-shared";
import {
  formatAgentTaskReplySent,
  formatAgentDeliveredToAgentsLine,
  normalizeAgentDeliveredToAgents,
  structuredRaftMentionStillAppears,
} from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import { adoptCliReplyText, writeJson, writeText, NL } from "../../core/renderer";
import { apiFailureError } from "../_apiFailure";
import {
  formatPendingMentionActions,
  normalizePendingMentionActions,
  normalizeUnresolvedMentionHandles,
} from "../mention/_format";
import {
  classifyMessageSendOutcome,
  isPreResponseTransportAmbiguity,
  normalizeAttachmentIdFlags,
  parseMentionSelectors,
  resolveSendContent,
  SendContentError,
} from "../message/send";
import { resolveTaskAddress, TASK_ADDRESS_OPTIONS, TASK_REF_ARGUMENT, type TaskAddressOpts, type TaskAddress } from "./_taskAddress";

interface ReplyOpts extends TaskAddressOpts {
  attachmentId?: string[];
  mention?: string[];
  json?: boolean;
}

const HEREDOC = "RAFTMSG";

function missingReplyContent(ref: string): string {
  return [
    "No reply content received on stdin.",
    "Use a heredoc or pipe content into raft task reply:",
    `  raft task reply ${JSON.stringify(ref)} <<'${HEREDOC}'`,
    "  reply body",
    `  ${HEREDOC}`,
  ].join("\n");
}

async function readReply(stdin: NodeJS.ReadableStream, address: TaskAddress): Promise<string> {
  try {
    return await resolveSendContent(stdin);
  } catch (err) {
    if (err instanceof SendContentError && err.code === "MISSING_CONTENT") {
      throw cliError("MISSING_CONTENT", missingReplyContent(address.ref), { cause: err });
    }
    if (err instanceof SendContentError) throw cliError(err.code, err.message, { cause: err });
    throw err;
  }
}

export const taskReplyCommand = defineCommand(
  {
    name: "reply",
    description: "Reply in a task's discussion (its own conversation); the body is read from stdin",
    arguments: [TASK_REF_ARGUMENT],
    usage: '"#channel:#7" [options] < reply body on stdin',
    helpAfter:
      "\nThe reply body is read from stdin, never from arguments. Use a quoted heredoc so the shell leaves quotes, $vars and backticks alone:\n"
      + `  raft task reply "#channel:#7" <<'${HEREDOC}'\n`
      + "  reply body\n"
      + `  ${HEREDOC}\n`
      + '\nA task is named by its ref: "#channel:#7", or "dm:@peer:#7" for a task in a DM. Quote it: an unquoted # starts a shell comment.\n'
      + "Replying follows the task: later replies wake you (raft task unfollow <ref> stops that).\n"
      + "If the reply is sent but an @mention could not be delivered, the command still exits 0 and lists each undelivered mention with its recovery command. Do not resend the reply.\n",
    options: [
      ...TASK_ADDRESS_OPTIONS,
      {
        flags: "--attachment-id <id>",
        description: "Attachment ID to link (repeatable). Get one from `raft attachment upload`. Several IDs in one value, separated by spaces or commas, are split.",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      {
        flags: "--mention <actor>",
        description: "Bind an @handle to one actor (repeatable): human:<uuid>:<handle> or agent:<uuid>:<handle>.",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      { flags: "--json", description: "Emit the Agent API reply response as JSON" },
    ],
  },
  async (ctx, refArg: string | undefined, opts: ReplyOpts = {}) => {
    const address = resolveTaskAddress(refArg, opts);
    let mentions: AgentApiStructuredMention[];
    let attachmentIds: string[];
    try {
      mentions = parseMentionSelectors(opts.mention);
      // Checked before stdin is consumed, so a bad id costs no reply body.
      attachmentIds = normalizeAttachmentIdFlags(opts.attachmentId ?? [], address.channel);
    } catch (err) {
      if (err instanceof SendContentError) throw cliError(err.code, err.message, { cause: err });
      throw err;
    }
    const content = await readReply(ctx.io.stdin ?? process.stdin, address);
    for (const mention of mentions) {
      if (!structuredRaftMentionStillAppears(content, mention.name)) {
        throw cliError("MENTION_NOT_IN_CONTENT", `Structured mention @${mention.name} is not present in the reply body.`);
      }
    }

    const agentContext = ctx.loadAgentContext();
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const idempotencyKey = randomUUID();
    const body = {
      channel: address.channel,
      task_number: address.taskNumber,
      content,
      idempotencyKey,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    };

    // One retry, safe under the idempotency key: after a transport failure
    // before any response, or a 5xx, ask whether the reply committed and
    // resend only if the server says it did not.
    let res;
    let transportFailure: unknown;
    try {
      res = await agentApi.tasks.reply(body);
    } catch (err) {
      if (!isPreResponseTransportAmbiguity(err)) throw err;
      transportFailure = err;
    }
    if (transportFailure !== undefined || (res && !res.ok && res.status >= 500)) {
      const reconciliation = await agentApi.tasks.reply({
        channel: address.channel,
        task_number: address.taskNumber,
        idempotencyKey,
        reconcileOnly: true,
      }).catch(() => null);
      const state = reconciliation?.ok ? (reconciliation.data as { state?: unknown } | null)?.state : undefined;
      if (state === "committed") {
        res = reconciliation!;
      } else if (state === "not_found") {
        res = await agentApi.tasks.reply(body);
      } else if (transportFailure !== undefined) {
        throw transportFailure;
      }
    }
    if (!res) throw cliError("INVALID_JSON_RESPONSE", "Agent API taskReply did not return a response");
    if (!res.ok) throw apiFailureError(res, res.status === 404 ? "NOT_FOUND" : "REPLY_FAILED");
    if (!res.data) throw cliError("INVALID_JSON_RESPONSE", "Agent API taskReply returned an empty response body");

    const outcome = classifyMessageSendOutcome(res.data);
    if (outcome.kind === "held") {
      // The reply route has no freshness hold; a held answer is a server bug.
      throw new CliError({ code: "REPLY_FAILED", message: "The server held the reply instead of sending it; nothing was sent." });
    }
    if (opts.json) {
      writeJson(ctx.io, outcome.data);
      return;
    }
    if (outcome.kind === "committed") {
      writeText(ctx.io, adoptCliReplyText(
        `${formatAgentTaskReplySent(address.ref, outcome.data.messageId)}\n`
        + "The original response was lost, so delivery details are unavailable; the reply was not sent twice.",
      ), NL);
      return;
    }
    const data = outcome.data;
    const pendingMentionActions = normalizePendingMentionActions(data);
    const unresolvedMentionHandles = normalizeUnresolvedMentionHandles(data);
    const undelivered = pendingMentionActions.length + unresolvedMentionHandles.length;
    const mentionSection = undelivered > 0
      ? `${formatPendingMentionActions(pendingMentionActions, { source: "send", unresolvedMentionHandles }).trimEnd()}\n\n`
      : "";
    const deliveredLine = formatAgentDeliveredToAgentsLine(normalizeAgentDeliveredToAgents(data));
    writeText(ctx.io, adoptCliReplyText(
      `${mentionSection}${formatAgentTaskReplySent(address.ref, data.messageId, undelivered > 0)}${deliveredLine ? `\n${deliveredLine}` : ""}`,
    ), NL);
  },
);

export function registerTaskReplyCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskReplyCommand, runtimeOptions);
}
