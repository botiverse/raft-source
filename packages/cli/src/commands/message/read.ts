// `raft message read --target <t> [--before <id|seq>] [--after <id|seq>] [--around <id|seq>] [--limit N]`
// → GET /internal/agent-api/history
//
// The history anchors accept either a message id (full or short) or a
// numeric seq. `--before` / `--after` exclude the anchor; `--around` includes it.

import type { Command } from "commander";

import type { ApiProxyDiagnostics } from "../../client.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { apiFailureError } from "../_apiFailure.js";
import { requireTargetAlias, type TargetAliasOpts } from "../_target.js";
import { formatHistory } from "./_format.js";
import { recordConsumedRead } from "./_consumedSeqState.js";

interface ReadOpts extends TargetAliasOpts {
  before?: string;
  after?: string;
  around?: string;
  limit?: string;
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
  if (res.errorCode === "INVALID_ARG") {
    return new CliError({
      code: "INVALID_ARG",
      message: res.error ?? `HTTP ${res.status}`,
    });
  }
  return apiFailureError(res, "READ_FAILED");
}

function validateReadOpts(opts: Partial<ReadOpts>): {
  channel: string;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
} {
  const channel = requireTargetAlias(opts);
  const limit = parsePositiveInt("limit", opts.limit);
  const before = opts.before?.trim();
  const after = opts.after?.trim();
  return {
    channel,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(opts.around !== undefined ? { around: opts.around } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export const messageReadCommand = defineCommand(
  {
    name: "read",
    description: "Read message history for a channel, DM, or thread",
    options: [
      { flags: "--target <target>", description: "Target: '#channel', 'dm:@peer', '#channel:threadId', 'dm:@peer:threadId'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--before <idOrSeq>", description: "Return messages strictly before this anchor (pure-decimal values are seqs)" },
      { flags: "--after <idOrSeq>", description: "Return messages strictly after this anchor (pure-decimal values are seqs)" },
      { flags: "--around <idOrSeq>", description: "Center the window on this anchor (8-character values are short ids)" },
      { flags: "--limit <n>", description: "Max messages to return (server default applies if omitted)" },
    ],
  },
  async (ctx, opts: Partial<ReadOpts>) => {
    const readOpts = validateReadOpts(opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.history.read({
      channel: readOpts.channel,
      ...(readOpts.before !== undefined ? { before: readOpts.before } : {}),
      ...(readOpts.after !== undefined ? { after: readOpts.after } : {}),
      ...(readOpts.around !== undefined ? { around: readOpts.around } : {}),
      ...(readOpts.limit !== undefined ? { limit: String(readOpts.limit) } : {}),
    });
    if (!res.ok) {
      throw mapReadFailure(res);
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API historyRead returned an empty response body",
      });
    }
    writeText(
      ctx.io, adoptCliReplyText(
      `${formatHistory(readOpts.channel, res.data, {
        around: readOpts.around,
        after: readOpts.after,
        before: readOpts.before,
      })}\n`,
    ));
    // FH-001 full-body advance contract (A), contiguous history-read slice:
    // 1. A command that returns full message bodies to the current agent can
    //    advance client_seen. This history-read path returns a bounded ordered
    //    window, so it advances the per-target consumed cursor to max(returned
    //    seq). Target-scoped: DM/channel/thread each own a cursor; thread read
    //    advances the thread, not its parent.
    // 2. Empty read ("No messages") does not advance or fabricate a boundary.
    // 3. Monotonic forward only: browsing older seq < cursor never lowers it.
    // 4. Passive receipt/wake hint/inbox preflight/thread-follow notices never
    //    advance (FH-EXT-001). Only active body-returning reads advance.
    // 5. Preview/snippet search is non-consuming. Full-body resolve is a
    //    follow-up: a single high seq cannot safely become a max boundary
    //    without contiguity or seen-set semantics.
    //
    // `--around` is an anchored context lookup, not a read-through boundary.
    // It can expose a high seq while leaving surrounding unread context outside
    // the returned window, so it must not update the local freshness cursor.
    if (readOpts.around === undefined) {
      const rows = res.data.messages ?? [];
      let maxSeq = 0;
      for (const row of rows) {
        if (typeof row.seq === "number" && Number.isFinite(row.seq) && row.seq > maxSeq) maxSeq = row.seq;
      }
      recordConsumedRead(agentContext.agentId, readOpts.channel, maxSeq > 0 ? maxSeq : undefined);
    }
  },
);

export function registerReadCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageReadCommand, runtimeOptions);
}
