// `raft message read --target <t> [--unread | --before <id|seq> | --after <id|seq> | --around <id|seq>] [--limit N]`
// → GET /internal/agent-api/history
//
// The history anchors accept either a message id (full or short) or a
// numeric seq. `--before` / `--after` exclude the anchor; `--around` includes it.
// `--unread` starts right after the agent's read position instead of an anchor.

import type { Command } from "commander";

import type { ApiProxyDiagnostics } from "../../client";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context";
import {
  formatHint,
  formatTaskTargetUseTaskCommand,
  parseAgentTaskRef,
  RAFT_HINTS,
  TASK_TARGET_USE_TASK_COMMAND_ERROR_CODE,
} from "@botiverse/raft-shared/src/agentCliSurface";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { apiFailureError } from "../_apiFailure";
import { PEER_KIND_OPTION, requireTargetAlias, type TargetAliasOpts } from "../_target";
import { channelCardForRead } from "../../ax/channelCard";
import { readCoverageForRead } from "../../ax/readCoverage";
import { peerCardForRead } from "../../ax/peerCard";
import { countRendered } from "../../ax/renderCounts";
import { formatChannelCard, formatHistory, formatPeerCard, topLevelCoverageSentence } from "./_format";
import { elideSeenSenders } from "./_senderElision";
import { getConsumedExactSeqs, getConsumedSeq, recordHistoryReadWindow } from "./_consumedSeqState";

interface ReadOpts extends TargetAliasOpts {
  before?: string;
  after?: string;
  around?: string;
  limit?: string;
  unread?: boolean;
}

function parsePositiveInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `--${name} must be a positive integer; got ${raw}`,
    });
  }
  return n;
}

function mapReadFailure(res: {
  status: number;
  error: string | null;
  errorCode?: string | null;
  suggestedNextAction?: string | null;
  proxy?: ApiProxyDiagnostics | null;
}): CliError {
  if (res.errorCode === "NOT_FOUND") {
    return new CliError({
      code: "NOT_FOUND",
      message: res.error ?? `HTTP ${res.status}`,
      suggestedNextAction: res.suggestedNextAction ?? undefined,
    });
  }
  if (res.errorCode === "AMBIGUOUS_ID") {
    return new CliError({
      code: "AMBIGUOUS_ID",
      message: res.error ?? `HTTP ${res.status}`,
      suggestedNextAction: res.suggestedNextAction ?? "Use the full message UUID instead of the 8-character short id.",
    });
  }
  // `--around` a message older than the server plan's history window; the
  // server may offer an upgrade card as the next step.
  if (res.errorCode === "HISTORY_LIMITED") {
    return new CliError({
      code: "HISTORY_LIMITED",
      message: res.error ?? `HTTP ${res.status}`,
      suggestedNextAction: res.suggestedNextAction ?? undefined,
    });
  }
  if (res.errorCode === "INVALID_ARG") {
    return new CliError({
      code: "INVALID_ARG",
      message: res.error ?? `HTTP ${res.status}`,
    });
  }
  return apiFailureError(res, "READ_FAILED");
}

export interface ValidatedReadOpts {
  channel: string;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  unread?: true;
}

export function validateReadOpts(opts: Partial<ReadOpts>, resolvedTarget?: string): ValidatedReadOpts {
  const channel = resolvedTarget ?? requireTargetAlias(opts);
  const limit = parsePositiveInt("limit", opts.limit);
  const before = opts.before?.trim();
  const after = opts.after?.trim();
  if (opts.unread && (before || after || opts.around !== undefined)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--unread cannot be combined with --before, --after, or --around: it always starts right after your read position.",
      suggestedNextAction: formatHint(RAFT_HINTS.messageRead({ target: channel, unread: true })),
    });
  }
  return {
    channel,
    ...(opts.unread ? { unread: true as const } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(opts.around !== undefined ? { around: opts.around } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function alreadyShownIn(agentId: string, target: string, messages: ReadonlyArray<{ seq?: unknown }>): Set<number> {
  const upTo = getConsumedSeq(agentId, target) ?? 0;
  const exact = new Set(getConsumedExactSeqs(agentId, target));
  const shown = new Set<number>();
  for (const message of messages) {
    if (typeof message.seq === "number" && (message.seq <= upTo || exact.has(message.seq))) shown.add(message.seq);
  }
  return shown;
}

export const messageReadCommand = defineCommand(
  {
    name: "read",
    description: "Read message history for a channel, DM, or thread",
    options: [
      { flags: "--target <target>", description: "Target: '#channel', 'dm:@peer', '#channel:shortid', 'dm:@peer:shortid' (a thread: shortid is its root message's msg=, as in replyTarget), 'agent-event:eventId'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      { flags: "--before <idOrSeq>", description: "Return messages strictly before this anchor (pure-decimal values are seqs)" },
      { flags: "--after <idOrSeq>", description: "Return messages strictly after this anchor (pure-decimal values are seqs)" },
      { flags: "--around <idOrSeq>", description: "Center the window on this anchor: a message id, its 8-character short id, or a seq (an 8-digit value that is no short id here is a seq)" },
      { flags: "--unread", description: "Read this target's unread messages from others: start right after your read position and move it forward" },
      { flags: "--limit <n>", description: "Max messages to return (server default applies if omitted)" },
    ],
    helpAfter:
      "\nWhich read to use:\n" +
      "  --unread                   new messages from others; marks them read\n" +
      "  --after 0 --limit 100      a long thread from its start; continue with the command after \"Newer:\"\n" +
      "  --around <id|seq>          the messages around one; never moves your read position\n" +
      "  raft message resolve <id>  one message by id, in any conversation\n" +
      "\nWhat this prints counts as seen by you, so a later send is not held for it.\n" +
      "Never discard or filter the output (>/dev/null, | head, | grep): what you cut out still counts as seen.\n",
  },
  async (ctx, opts: Partial<ReadOpts>) => {
    const readOpts = validateReadOpts(opts);
    // Task v2: a task ref is read with `raft task read` in this CLI (servers
    // still accept it from older CLIs, which copy it from the delivery).
    const taskRef = parseAgentTaskRef(readOpts.channel);
    if (taskRef) {
      throw new CliError({
        code: TASK_TARGET_USE_TASK_COMMAND_ERROR_CODE,
        message: formatTaskTargetUseTaskCommand({ ref: taskRef.ref, action: "read" }),
      });
    }
    await executeHistoryRead(ctx, readOpts, (agentApi) => agentApi.history.read({
      channel: readOpts.channel,
      ...historyWindowQuery(readOpts),
    }));
  },
);

/** The window flags of a read, in the history query's shape. */
export function historyWindowQuery(readOpts: ValidatedReadOpts): {
  before?: string;
  after?: string;
  around?: string;
  limit?: string;
  unread?: "true";
} {
  return {
    ...(readOpts.before !== undefined ? { before: readOpts.before } : {}),
    ...(readOpts.after !== undefined ? { after: readOpts.after } : {}),
    ...(readOpts.around !== undefined ? { around: readOpts.around } : {}),
    ...(readOpts.limit !== undefined ? { limit: String(readOpts.limit) } : {}),
    ...(readOpts.unread ? { unread: "true" as const } : {}),
  };
}

type AgentApiSurface = ReturnType<typeof createAgentApiSurfaceClient>;
type HistoryReadResult = Awaited<ReturnType<AgentApiSurface["history"]["read"]>>;

/**
 * One read window, fetched by `fetchPage` (`raft message read`: the history
 * route; `raft task read`: a task's conversation) and printed the same way:
 * cards, sender elision, the window, and the consumed-seq ledger keyed by
 * `readOpts.channel`.
 */
export async function executeHistoryRead(
  ctx: CommandContext,
  readOpts: ValidatedReadOpts,
  fetchPage: (agentApi: AgentApiSurface) => Promise<HistoryReadResult>,
): Promise<void> {
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await fetchPage(agentApi);
    if (!res.ok) {
      throw mapReadFailure(res);
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API historyRead returned an empty response body",
      });
    }
    // A Server that does not know `unread` ignores it and returns the latest
    // page; printing that as "unread" would be wrong without anyone noticing.
    if (readOpts.unread && typeof res.data.unread_after_seq !== "number") {
      throw new CliError({
        code: "UNSUPPORTED_BY_SERVER",
        message: "This Server does not support --unread yet, so the page it returned was discarded instead of being shown as unread.",
        suggestedNextAction: "Read the latest page instead: the same command without --unread.",
      });
    }
    // `--unread` folds messages this agent was already shown (recorded locally,
    // per model context) so a message that came back unsettled is not read as new.
    const alreadyShownSeqs = readOpts.unread
      ? alreadyShownIn(agentContext.agentId, typeof res.data.target === "string" && res.data.target ? res.data.target : readOpts.channel, res.data.messages ?? [])
      : undefined;
    // Sender descriptions already shown in this context print as `@name`
    // only. Folded messages are not printed, so they claim nothing.
    const allMessages = res.data.messages ?? [];
    const printed = allMessages.filter((m) => !(typeof m.seq === "number" && alreadyShownSeqs?.has(m.seq)));
    const senders = elideSeenSenders(printed, agentContext.agentId);
    const elidedByMessage = new Map(printed.map((m, index) => [m, senders.messages[index]]));
    const displayData = { ...res.data, messages: allMessages.map((m) => elidedByMessage.get(m) ?? m) };
    // The channel's card goes first the first time this context reads the
    // channel (or a thread in it), and again after it changed.
    const channelCard = channelCardForRead(res.data.channel_card, agentContext.agentId);
    if (channelCard.card) {
      const text = formatChannelCard(channelCard.card.card, channelCard.card.changed);
      writeText(ctx.io, text);
      countRendered(agentContext.agentId, "channel_card", text);
    }
    // A DM's peer card, when this context has seen nothing of them (sender
    // elision above already claimed a message that shows them).
    const peerCard = peerCardForRead(res.data.peer_card, printed, agentContext.agentId);
    if (peerCard.card) {
      const text = formatPeerCard(peerCard.card.card);
      writeText(ctx.io, text);
      countRendered(agentContext.agentId, "peer_card", text);
    }
    // What a top-level read leaves out (thread replies), once per context.
    const resolvedTarget = typeof res.data.target === "string" && res.data.target ? res.data.target : readOpts.channel;
    const coverage = readCoverageForRead(topLevelCoverageSentence(readOpts.channel), resolvedTarget, agentContext.agentId);
    writeText(
      ctx.io, adoptCliReplyText(
      `${formatHistory(readOpts.channel, displayData, {
        around: readOpts.around,
        after: readOpts.after,
        before: readOpts.before,
        unread: readOpts.unread === true,
        ...(alreadyShownSeqs ? { alreadyShownSeqs } : {}),
        ...(readOpts.limit !== undefined ? { limit: readOpts.limit } : {}),
        omitTopLevelCoverage: !coverage.show,
      })}\n`,
    ));
    await senders.settle(ctx.io);
    await channelCard.settle(ctx.io);
    await peerCard.settle(ctx.io);
    await coverage.settle(ctx.io);
    // What the window consumed (the FH-001 full-body advance contract: target
    // identity from the resolver, `--around` and gapped windows record exact
    // seqs only, old-server boundary inference) is the shared seen policy
    // (shared/src/agentOps/seenPolicy/historyRead.ts).
    recordHistoryReadWindow(agentContext.agentId, {
      requestedTarget: readOpts.channel,
      ...(readOpts.around !== undefined ? { around: readOpts.around } : {}),
      ...(readOpts.after !== undefined ? { after: readOpts.after } : {}),
      ...(readOpts.unread && typeof res.data.unread_after_seq === "number" ? { after: String(res.data.unread_after_seq) } : {}),
      data: res.data,
    });
}

export function registerReadCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageReadCommand, runtimeOptions);
}
