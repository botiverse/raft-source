// `raft message update-card --message-id <id> --card <file> [--expected-revision <n>]
//    [--idempotency-key <key>] [--json] [< new text on stdin]`
// → PUT /internal/agent-api/messages/:messageId/card (RFC 082 §4.2)
//
// The sender replaces its card message's card and its text (the fallback
// agents, search and push read), within 14 days of sending it. Notifies no
// one: the answer says so, naming each @mention of the new text.
//
// Retry-safe: each run sends an idempotency key (`--idempotency-key`, or one
// generated for the run), so a request that may not have reached the Server
// is sent once more under it, and an unknown outcome names the key to run
// again with. A run without the key (a rerun after a lost answer) that gets
// 409 card_revision_conflict for its `--expected-revision` reads the current
// card: when it is the card and text this run sent, an earlier run's update
// landed, and the command reports success (RFC 082 §4.2, Sage a80681df 4).

import { randomUUID } from "node:crypto";

import type { Command } from "commander";
import type { AgentApiMessageCardUpdateBody, AgentApiMessageCardUpdateResponse, MessageCard } from "@botiverse/raft-shared";
import {
  AGENT_API_RATE_LIMITED_CODE,
  asMessageId,
  extractRaftMentionHandles,
  formatMessageCardUpdateNotice,
  isMessageCardMetadata,
  MESSAGE_CARD_ERROR_CODES,
  MESSAGE_CARD_LIMITS,
  messageCardsEqual,
  messageCardStoredContent,
} from "@botiverse/raft-shared/src/agentCliSurface";

import type { ApiResponse } from "../../client";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import { writeDiagnostic, writeJson, writeText, NL } from "../../core/renderer";
import { assertCardFallback, loadCardFile, messageCardRefusal, shellQuoteArg, type LoadedCard } from "./_card";
import { formatCardStdinDeadlineDiagnostic, formatMessageCardUpdated, formatTarget, type MessageLike } from "./_format";
import { isPreResponseTransportAmbiguity, resolveOptionalSendContent } from "./send";

interface UpdateCardOpts {
  messageId?: string;
  card?: string;
  expectedRevision?: string;
  idempotencyKey?: string;
  json?: boolean;
}

type AgentApi = ReturnType<typeof createAgentApiSurfaceClient>;

const HEREDOC_DELIMITER = "RAFTMSG";

/** The 404 when the Server sent no sentence of its own (RFC 082 §4.2: one answer for every case). */
const NOT_FOUND_TEXT =
  `No card message with this id that you can update. Updating works only on a card message you sent in the last ${MESSAGE_CARD_LIMITS.updateWindowDays} days, `
  + "that is not deleted or retracted, in a conversation you can still post in; an unknown id gets this same answer.";

export function parseExpectedRevision(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const revision = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw cliError("INVALID_ARG", "--expected-revision is the card's revision number: for card=r3 in the message's header, 3.");
  }
  return revision;
}

/** The command to run again, as this run was given (`--expected-revision` replaced when `expectedRevision` is set). */
export function formatUpdateCardCommand(input: {
  messageId: string;
  file: string;
  expectedRevision?: number;
  idempotencyKey?: string;
  withText: boolean;
}): string {
  const parts = [
    "raft message update-card",
    `--message-id ${input.messageId}`,
    `--card ${shellQuoteArg(input.file)}`,
    ...(input.expectedRevision !== undefined ? [`--expected-revision ${input.expectedRevision}`] : []),
    ...(input.idempotencyKey ? [`--idempotency-key ${shellQuoteArg(input.idempotencyKey)}`] : []),
  ];
  return `${parts.join(" ")}${input.withText ? " (with the same text on stdin)" : ""}`;
}

function bodyNumber(res: ApiResponse<unknown>, key: string): number | undefined {
  const body = res.errorBody;
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** An outcome the CLI cannot know (the request may have landed): the next step is the same key again. */
function outcomeUnknown(err: CliError, keyedRerun: string): CliError {
  return new CliError({
    code: err.code,
    message: err.message,
    exitCode: err.exitCode,
    cause: err,
    retryable: true,
    faultDomain: err.fault_domain,
    layer: err.layer,
    correlationId: err.correlationId,
    proxyFailureClass: err.proxyFailureClass,
    proxyCauseCode: err.proxyCauseCode,
    proxyRouteFamily: err.proxyRouteFamily,
    proxyUpstreamLayer: err.proxyUpstreamLayer,
    proxyUpstreamStatus: err.proxyUpstreamStatus,
    proxyResponseStarted: err.proxyResponseStarted,
    proxyResponseComplete: err.proxyResponseComplete,
    suggestedNextAction:
      `It is not known whether the card was updated. Run the same command again with this key: ${keyedRerun}. `
      + "If the update landed, the same key answers it again; if not, the card is updated once.",
  });
}

/**
 * The update, sent once more under the same key when the first request may
 * not have reached the Server (a transport failure before any answer, or a
 * 5xx): the key makes the repeat answer the first result instead of a second
 * revision.
 */
async function requestUpdate(
  agentApi: AgentApi,
  messageId: string,
  body: AgentApiMessageCardUpdateBody,
  keyedRerun: string,
): Promise<ApiResponse<AgentApiMessageCardUpdateResponse>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await agentApi.messages.updateCard({ messageId: asMessageId(messageId) }, body);
      if (res.ok || res.status < 500 || attempt >= 2) return res;
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      if (attempt < 2 && isPreResponseTransportAmbiguity(err)) continue;
      // No answer, or a 5xx from the Server or the daemon's proxy: the update may have landed.
      throw err.fault_domain === "agent_api_transport" || /5XX$/.test(err.code) ? outcomeUnknown(err, keyedRerun) : err;
    }
  }
}

interface CurrentCard {
  messageId: string;
  revision: number;
  updatedAt: string;
  card: MessageCard;
  content: string;
}

/**
 * The card message as it is now, through the read paths an agent already has
 * (resolve for its conversation, then that one message without consuming it:
 * the history read carries the card). Null when it cannot be read.
 */
async function readCurrentCard(agentApi: AgentApi, messageId: string): Promise<CurrentCard | null> {
  try {
    const resolved = await agentApi.messages.resolve({ msgId: asMessageId(messageId) });
    const message = resolved.ok ? resolved.data?.message as MessageLike | undefined : undefined;
    const fullId = typeof message?.message_id === "string" ? message.message_id : null;
    if (!message || !fullId || typeof message.channel_name !== "string") return null;
    const page = await agentApi.history.read({ channel: formatTarget(message), around: fullId, limit: "1", consume: "false" });
    if (!page.ok) return null;
    const row = (page.data?.messages ?? []).find((m) => m.id === fullId || m.message_id === fullId) as
      | { content?: string; actionMetadata?: unknown }
      | undefined;
    if (!row || !isMessageCardMetadata(row.actionMetadata)) return null;
    return {
      messageId: fullId,
      revision: row.actionMetadata.revision,
      updatedAt: row.actionMetadata.updatedAt,
      card: row.actionMetadata.card,
      content: typeof row.content === "string" ? row.content : "",
    };
  } catch {
    return null;
  }
}

/**
 * Whether the current card is the card and text this run sent: an earlier
 * run's update landed. Compared on what this run sent (RFC 082 §4.2): the
 * card, and the text only when it wrote one. A text Raft derived from the
 * card follows from it, and a Server may derive it differently from this CLI.
 */
function alreadyApplied(current: CurrentCard, loaded: LoadedCard, content: string | undefined): boolean {
  if (!messageCardsEqual(current.card, loaded.card)) return false;
  return typeof content !== "string" || content.length === 0 || current.content.trim() === messageCardStoredContent(loaded.card, content).trim();
}

function writeUpdated(
  ctx: CommandContext,
  json: boolean,
  answer: AgentApiMessageCardUpdateResponse & { alreadyApplied?: boolean },
): void {
  if (json) {
    writeJson(ctx.io, answer);
    return;
  }
  writeText(ctx.io, formatMessageCardUpdated({
    messageId: answer.messageId,
    revision: answer.revision,
    notice: answer.notice,
    ...(answer.alreadyApplied ? { alreadyApplied: true } : {}),
  }), NL);
}

export const messageUpdateCardCommand = defineCommand(
  {
    name: "update-card",
    description: "Replace the card of a card message you sent (notifies no one)",
    usage: "--message-id <id> --card <file> [options] [< new text on stdin]",
    options: [
      { flags: "--message-id <id>", description: "The card message to update: its msg= id (full or short). Only a card message you sent." },
      { flags: "--card <file>", description: "JSON file with the new card; it replaces the whole card (see raft message send --help, Card messages)" },
      {
        flags: "--expected-revision <n>",
        description: "The revision you last read (card=rN in the message's header). If the card changed since, nothing changes and the error prints the command to run again.",
      },
      {
        flags: "--idempotency-key <key>",
        description: "Retry key: the same key with the same card and text answers the first result again instead of updating twice. One is made for each run when left out.",
      },
      { flags: "--json", description: "Emit the Agent API answer as JSON" },
    ],
    helpAfter:
      "\nReplaces the whole card of a card message you sent with raft message send --card, and its text. The text on stdin is optional: without it, Raft makes it from the new card.\n" +
      "Updating notifies no one: an @mention in the new text is not notified, and no inbox item, push or agent wake-up is made. To tell someone, send a new message.\n" +
      `Only your own card messages, for ${MESSAGE_CARD_LIMITS.updateWindowDays} days after you sent them, at most ${MESSAGE_CARD_LIMITS.updatesPerMessagePerMinute} times a minute each. Any other message gets one answer: not found; send a new message instead.\n` +
      "If card messages are off on this Server (flag message_cards), the update is refused: send a new message as text.\n" +
      "Example:\n" +
      `  raft message update-card --message-id 1a2b3c4d --card build.json --expected-revision 1 <<'${HEREDOC_DELIMITER}'\n` +
      "  Raft App 1.19.0 (11900001): ready for testing\n" +
      `  ${HEREDOC_DELIMITER}\n`,
  },
  async (ctx, opts: UpdateCardOpts) => {
    try {
      await updateCard(ctx, opts);
    } catch (err) {
      // With --json the error is JSON too.
      if (opts.json && err instanceof CliError && err.outputMode === undefined) err.outputMode = "json";
      throw err;
    }
  },
);

async function updateCard(ctx: CommandContext, opts: UpdateCardOpts): Promise<void> {
  const messageId = opts.messageId?.trim();
  if (!messageId) throw cliError("INVALID_ARG", "--message-id is required: the msg= id of the card message you sent.");
  if (opts.card === undefined) throw cliError("INVALID_ARG", "--card <file> is required: the JSON file with the new card.");
  const expectedRevision = parseExpectedRevision(opts.expectedRevision);
  const givenKey = opts.idempotencyKey?.trim();
  if (opts.idempotencyKey !== undefined && !givenKey) throw cliError("INVALID_ARG", "--idempotency-key is empty; leave it out to have one made for this run.");

  // Checked before stdin is read, so a bad card costs no text.
  const loaded = loadCardFile(opts.card);
  let stdinDeadlineExpired = false;
  const text = await resolveOptionalSendContent(ctx.io.stdin ?? process.stdin, {
    onNoBytesWithinWindow: () => {
      stdinDeadlineExpired = true;
    },
  });
  const content = text !== undefined && text.trim().length > 0 ? text : undefined;
  assertCardFallback(loaded, content);
  if (stdinDeadlineExpired && content === undefined) writeDiagnostic(ctx.io, formatCardStdinDeadlineDiagnostic("updated"), NL);

  const idempotencyKey = givenKey ?? randomUUID();
  const body: AgentApiMessageCardUpdateBody = {
    card: loaded.input,
    ...(content !== undefined ? { content } : {}),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    idempotencyKey,
  };
  const command = (overrides: { expectedRevision?: number; idempotencyKey?: string } = {}) => formatUpdateCardCommand({
    messageId,
    file: loaded.file,
    expectedRevision: overrides.expectedRevision ?? expectedRevision,
    idempotencyKey: overrides.idempotencyKey ?? givenKey,
    withText: content !== undefined,
  });

  const agentContext = ctx.loadAgentContext();
  const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
  const res = await requestUpdate(agentApi, messageId, body, command({ idempotencyKey }));
  if (res.ok && res.data) {
    writeUpdated(ctx, opts.json === true, res.data);
    return;
  }
  if (res.ok) throw cliError("INVALID_JSON_RESPONSE", "The card update returned an empty answer.");

  const refusal = messageCardRefusal(res, "update", loaded.file);
  if (refusal) throw refusal;
  const message = res.error ?? `HTTP ${res.status}`;
  if (res.errorCode === MESSAGE_CARD_ERROR_CODES.revisionConflict) {
    const current = bodyNumber(res, "currentRevision");
    // The retry rule: a rerun after a lost answer, whose first run landed.
    if (expectedRevision !== undefined) {
      const now = await readCurrentCard(agentApi, messageId);
      if (now && alreadyApplied(now, loaded, content)) {
        const unnotifiedMentionHandles = extractRaftMentionHandles(now.content).map((handle) => `@${handle}`);
        writeUpdated(ctx, opts.json === true, {
          ok: true,
          messageId: now.messageId,
          revision: now.revision,
          updatedAt: now.updatedAt,
          unnotifiedMentionHandles,
          notice: formatMessageCardUpdateNotice(unnotifiedMentionHandles),
          alreadyApplied: true,
        });
        return;
      }
    }
    throw cliError("CARD_REVISION_CONFLICT", message, {
      retryable: false,
      ...(current !== undefined ? { details: { currentRevision: current } } : {}),
      suggestedNextAction: current !== undefined
        ? `Read the message if you need to, then run: ${command({ expectedRevision: current })}`
        : "Read the message's header (card=rN), then run the same command again with --expected-revision N.",
    });
  }
  if (res.errorCode === MESSAGE_CARD_ERROR_CODES.notFound || res.status === 404) {
    throw cliError("MESSAGE_CARD_NOT_FOUND", res.errorCode === MESSAGE_CARD_ERROR_CODES.notFound ? message : NOT_FOUND_TEXT, {
      retryable: false,
      suggestedNextAction: `To show the new state, send a new message: raft message send --target <target> --card ${shellQuoteArg(loaded.file)}`,
    });
  }
  if (res.errorCode === "idempotency_key_reused") {
    throw cliError("IDEMPOTENCY_KEY_REUSED", message, {
      retryable: false,
      suggestedNextAction: "Use a new --idempotency-key (or leave it out) for a different card or text.",
    });
  }
  if (res.status === 429 || res.errorCode === AGENT_API_RATE_LIMITED_CODE) {
    const wait = bodyNumber(res, "retry_after");
    throw cliError("RATE_LIMITED", message, {
      retryable: true,
      ...(wait !== undefined ? { details: { retryAfterSeconds: wait } } : {}),
      suggestedNextAction: wait !== undefined
        ? `Wait ${wait} second${wait === 1 ? "" : "s"}, then run the same command again.`
        : "Wait a minute, then run the same command again.",
    });
  }
  if (res.status >= 500) throw outcomeUnknown(cliError("SERVER_5XX", message), command({ idempotencyKey }));
  throw cliError(res.errorCode === "channel_archived" ? "CHANNEL_ARCHIVED" : "UPDATE_CARD_FAILED", message, {
    retryable: false,
    ...(res.suggestedNextAction ? { suggestedNextAction: res.suggestedNextAction } : {}),
  });
}

export function registerUpdateCardCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, messageUpdateCardCommand, runtimeOptions);
}
