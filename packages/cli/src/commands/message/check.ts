// `raft message check` — non-blocking drain of /internal/agent-api/events.
//
// Non-blocking is a hard requirement (kuku redline): the CLI must return
// promptly with whatever is in the inbox, never hold the request open.
//
// Agent API /events consumes/acks returned messages server-side; the CLI does
// not perform a separate acknowledgement request.

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText, flushText, NL } from "../../core/renderer";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { createDaemonApiSurfaceClient } from "../../daemonApiPath";
import { drainInbox } from "./_inbox";
import { formatAppItemsUnavailable, formatInboxHint, formatMessages, formatTarget } from "./_format";
import { recordConsumedExactSeqs } from "./_consumedSeqState";
import { elideSeenSenders } from "./_senderElision";

/** How long the inbox probe may take before this command reads as before. */
export const MESSAGE_CHECK_INBOX_PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether the inbox replaces this command (RFC 081 D10). Only a positive answer
 * counts: the server lists inbox items (`rows`) and this agent's conversations
 * are in them (not `appRowsOnly`, a personal assistant). Anything else (an
 * older server, 4xx, 5xx, `INBOX_UNAVAILABLE`, an answer outside the contract,
 * no answer within the timeout) keeps the drain: the probe decides whether to
 * refuse, and must never be able to stop an agent reading (Tenny, #wg-ax:4ee99a1f).
 */
export async function inboxReplacesMessageCheck(
  client: Parameters<typeof createAgentApiSurfaceClient>[0],
  timeoutMs: number = MESSAGE_CHECK_INBOX_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A probe that loses the race is cancelled, so its socket doesn't hold the process open.
  const probe = new AbortController();
  // Not a delay: the deadline after which a slow probe stops mattering and the drain runs.
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    const listing = await Promise.race([
      createAgentApiSurfaceClient(client, { signal: probe.signal }).inbox.list({ items: "true" }),
      timedOut,
    ]);
    if (!listing || !listing.ok) return false;
    const data = listing.data as { rows?: unknown; appRowsOnly?: unknown } | null | undefined;
    // A personal assistant lists app rows only; its owner DM still comes through /events.
    return Array.isArray(data?.rows) && data?.appRowsOnly !== true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    probe.abort();
  }
}

export const messageCheckCommand = defineCommand(
  {
    name: "check",
    description: "Removed where the server lists inbox items: use raft inbox check, then raft inbox read --target <item>. On an older server it drains the agent inbox and acks what it printed.",
    helpAfter:
      "\nWhat this prints counts as seen by you, so a later send is not held for it.\n" +
      "Never discard or filter the output (>/dev/null, | head, | grep): what you cut out still counts as seen.\n",
  },
  async (ctx) => {
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    // RFC 081 D10 (tygg, #wg-ax:4ee99a1f): where the server lists inbox items,
    // the inbox is the one way to catch up and this drain is gone. A server
    // that lists them answers `rows`; one that doesn't (the flag is off) keeps
    // this command, the only reader of its app notices until the flag is on.
    if (await inboxReplacesMessageCheck(client)) {
      throw new CliError({
        code: "MESSAGE_CHECK_REMOVED",
        message: "raft message check was removed: list with raft inbox check, read one with raft inbox read --target <item>. Nothing was read.",
        suggestedNextAction: "raft inbox check lists everything unread, app notices included; then raft inbox read --target <item> reads one.",
      });
    }
    const result = await drainInbox(
      agentContext,
      { block: false },
      client,
    );
    let appInboxStatus = "";
    if (agentContext.clientMode === "managed-runner" && result.messages.length === 0) {
      const response = await createDaemonApiSurfaceClient(client).inbox.check();
      if (!response.ok) {
        throw new CliError({
          code: response.status >= 500 ? "SERVER_5XX" : "CHECK_FAILED",
          message: response.error ?? `HTTP ${response.status}`,
        });
      }
      const pendingAppItems = response.data?.pending_app_items ?? 0;
      if (pendingAppItems > 0) {
        appInboxStatus = `\nApp items pending: ${pendingAppItems}. Run \`raft inbox check\` to inspect them.\n`;
      }
    } else if (agentContext.clientMode !== "managed-runner" && result.messages.length === 0) {
      appInboxStatus = `\n${formatAppItemsUnavailable()}\n`;
    }
    const drainStatus = result.hasMore
      ? "\nMore messages are pending. Run `raft message check` again.\n"
      : result.drainComplete
        ? "\nNo more new inbox messages.\n"
        : "\n";
    const senders = elideSeenSenders(result.messages, agentContext.agentId);
    writeText(ctx.io, adoptCliReplyText(`${formatMessages(senders.messages)}${drainStatus}${appInboxStatus}`));
    if (result.inboxHint) writeText(ctx.io, formatInboxHint(result.inboxHint), NL);
    // Task #178: ack leased third-party events only after their bodies reached
    // stdout. If the write or flush fails (EPIPE, closed pipe) nothing is
    // acked; the daemon lease expires and the events are served again on the
    // next check. An old daemon without the route answers non-2xx: ignored.
    const leases = result.thirdPartyLeases ?? [];
    await senders.settle(ctx.io);
    if (leases.length > 0 && await flushText(ctx.io)) {
      const daemonApi = createDaemonApiSurfaceClient(client);
      for (const lease of leases) {
        try {
          await daemonApi.thirdPartyEvents.ack({ batchId: lease.batchId, eventIds: lease.eventIds });
        } catch {
          // Transport/proxy failure: same outcome as no ack, the lease expires.
        }
      }
    }
    // `/events` batches are sparse attention drains, not contiguous history
    // slices. Record exact target-scoped seqs rather than seeding
    // `seenUpToSeq`; the send gate can credit only these rendered bodies while
    // still holding for any older gap in the same target.
    const consumed: Record<string, number[]> = {};
    for (const message of result.messages as Array<{ seq?: number }>) {
      const seq = typeof message.seq === "number" && Number.isInteger(message.seq) && message.seq > 0
        ? message.seq
        : undefined;
      if (seq === undefined) continue;
      const target = formatTarget(message as never);
      (consumed[target] ??= []).push(seq);
    }
    recordConsumedExactSeqs(agentContext.agentId, consumed);
  },
);

export function registerCheckCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageCheckCommand, runtimeOptions);
}
