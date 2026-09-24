import {
  joinRaftChannelByTarget as joinSharedRaftChannelByTarget,
  parseRaftRegularChannelTarget as parseSharedRaftRegularChannelTarget,
} from "@botiverse/raft-shared/src/agentApiChannelJoin.js";
import type {
  RaftChannelJoinClient,
  RaftChannelJoinRequest,
  RaftChannelJoinResult,
} from "@botiverse/raft-shared/src/agentApiChannelJoin.js";

export type {
  RaftChannelJoinClient,
  RaftChannelJoinClientResult,
  RaftChannelJoinError,
  RaftChannelJoinFailure,
  RaftChannelJoinOperation,
  RaftChannelJoinRequest,
  RaftChannelJoinResult,
  RaftChannelJoinSuccess,
  RaftChannelJoinTransportError,
} from "@botiverse/raft-shared/src/agentApiChannelJoin.js";

export function parseRaftRegularChannelTarget(target: string): string | null {
  return parseSharedRaftRegularChannelTarget(target);
}

/**
 * Resolve a visible channel target and join it through the typed Agent API.
 *
 * This is the shared behavior used by both `createRaftClient()` and the Raft
 * CLI. It intentionally does not make message send implicitly join channels.
 */
export async function joinRaftChannelByTarget<TChannelId extends string>(
  client: RaftChannelJoinClient<TChannelId>,
  request: RaftChannelJoinRequest,
): Promise<RaftChannelJoinResult> {
  return joinSharedRaftChannelByTarget(client, request);
}
