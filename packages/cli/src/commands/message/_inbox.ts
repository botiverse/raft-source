// Shared inbox-drain helper for `message check`. The CLI consumes the id-less
// /internal/agent-api/events surface directly; the server consumes/acks each
// returned batch as part of that request.

import type { AgentContext } from "../../auth/env.js";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { ApiClient } from "../../client.js";
import { CliError } from "../../core/errors.js";

interface InboxMessage {
  seq?: number;
  [key: string]: unknown;
}

export interface DrainResult {
  messages: InboxMessage[];
  drainedMore?: boolean;
  hasMore?: boolean;
  drainComplete?: boolean;
}

export interface DrainOpts {
  block: boolean;
  timeoutMs?: number;
}

// Safety ceiling for the drain-to-completion loop: 50 rounds x server batch
// size is far beyond any real backlog; the cap only guards against a server
// bug that reports has_more=true forever.
const MAX_DRAIN_ROUNDS = 50;

function sortedMessages(messages: InboxMessage[]): InboxMessage[] {
  return [...messages].sort((a, b) => {
    const aSeq = typeof a.seq === "number" && Number.isInteger(a.seq) && a.seq > 0 ? a.seq : Number.MAX_SAFE_INTEGER;
    const bSeq = typeof b.seq === "number" && Number.isInteger(b.seq) && b.seq > 0 ? b.seq : Number.MAX_SAFE_INTEGER;
    return aSeq - bSeq;
  });
}

function result(
  messages: InboxMessage[],
  opts: {
    drainedMore?: boolean;
    hasMore?: boolean;
    drainComplete?: boolean;
  } = {},
): DrainResult {
  return {
    messages: sortedMessages(messages),
    ...(opts.drainedMore ? { drainedMore: true } : {}),
    ...(opts.hasMore ? { hasMore: true } : {}),
    ...(opts.drainComplete ? { drainComplete: true } : {}),
  };
}

export async function drainInbox(
  ctx: AgentContext,
  opts: DrainOpts,
  client: ApiClient = new ApiClient(ctx),
): Promise<DrainResult> {
  const failCode = opts.block ? "WAIT_FAILED" : "CHECK_FAILED";
  const agentApi = createAgentApiSurfaceClient(client);
  const allMessages: InboxMessage[] = [];
  let sawHasMore = false;

  for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
    const res = await agentApi.events.get({ since: "latest" });
    if (!res.ok) {
      if (allMessages.length > 0) {
        return result(allMessages, { drainedMore: sawHasMore, hasMore: true });
      }
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : failCode,
        message: res.error ?? `HTTP ${res.status}`,
      });
    }

    const messages = res.data?.events ?? [];
    allMessages.push(...messages);
    const hasMore = res.data?.has_more === true;
    const drainComplete = !hasMore && allMessages.length > 0;
    sawHasMore = sawHasMore || hasMore;

    if (hasMore && messages.length > 0) continue;
    return result(allMessages, { drainedMore: sawHasMore, hasMore, drainComplete });
  }

  return result(allMessages, { drainedMore: sawHasMore, hasMore: true });
}
