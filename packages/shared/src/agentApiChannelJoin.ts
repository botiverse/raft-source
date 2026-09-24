export interface RaftChannelJoinRequest {
  /** Visible regular channel target, for example `#engineering`. */
  target: string;
}

export type RaftChannelJoinOperation =
  | "validate_target"
  | "server_info"
  | "resolve_target"
  | "channel_join";

export type RaftChannelJoinTransportError = {
  kind: "transport";
  reason: "transport_error";
  message: string;
  cause?: unknown;
} | {
  kind: "http";
  reason: "http_error";
  message: string;
  status: number;
  errorCode?: string | null;
  suggestedNextAction?: string | null;
  proxy?: unknown;
  response?: unknown;
} | {
  kind: "validation";
  reason: string;
  message: string;
  status?: number;
  cause?: unknown;
  response?: unknown;
};

export type RaftChannelJoinError = RaftChannelJoinTransportError | {
  kind: "validation";
  reason: "invalid_target" | "target_not_found";
  message: string;
};

export interface RaftChannelJoinSuccess {
  ok: true;
  status: number;
  data: {
    state: "joined" | "already_joined";
    target: string;
    channelId: string;
  };
}

export interface RaftChannelJoinFailure {
  ok: false;
  status?: number;
  operation: RaftChannelJoinOperation;
  error: RaftChannelJoinError;
}

export type RaftChannelJoinResult = RaftChannelJoinSuccess | RaftChannelJoinFailure;

export type RaftChannelJoinClientResult<T> = {
  ok: true;
  status: number;
  data: T;
} | {
  ok: false;
  status?: number;
  error: RaftChannelJoinTransportError;
};

export interface RaftChannelJoinClient<TChannelId extends string = string> {
  server: {
    info(): Promise<RaftChannelJoinClientResult<{
      channels: Array<{
        id: TChannelId;
        name: string;
        joined: boolean;
      }>;
    }>>;
  };
  channels: {
    join(params: { channelId: TChannelId }): Promise<RaftChannelJoinClientResult<{ ok: true }>>;
  };
}

export function parseRaftRegularChannelTarget(target: string): string | null {
  if (!target.startsWith("#") || target.includes(":")) return null;
  const name = target.slice(1).trim();
  return name.length > 0 ? name : null;
}

/**
 * Resolve a visible channel target and join it through the typed Agent API.
 *
 * This source-safe operation is shared by the SDK and the Raft CLI. It
 * intentionally does not make message send implicitly join channels.
 */
export async function joinRaftChannelByTarget<TChannelId extends string>(
  client: RaftChannelJoinClient<TChannelId>,
  request: RaftChannelJoinRequest,
): Promise<RaftChannelJoinResult> {
  const channelName = parseRaftRegularChannelTarget(request.target);
  if (!channelName) {
    return {
      ok: false,
      operation: "validate_target",
      error: {
        kind: "validation",
        reason: "invalid_target",
        message: "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.",
      },
    };
  }

  const infoResult = await client.server.info();
  if (!infoResult.ok) {
    return {
      ok: false,
      status: infoResult.status,
      operation: "server_info",
      error: infoResult.error,
    };
  }

  const channel = infoResult.data.channels.find((candidate) => candidate.name === channelName);
  if (!channel) {
    return {
      ok: false,
      status: 404,
      operation: "resolve_target",
      error: {
        kind: "validation",
        reason: "target_not_found",
        message: `Channel not found: ${request.target}`,
      },
    };
  }

  if (channel.joined) {
    return {
      ok: true,
      status: infoResult.status,
      data: {
        state: "already_joined",
        target: request.target,
        channelId: channel.id,
      },
    };
  }

  const joinResult = await client.channels.join({ channelId: channel.id });
  if (!joinResult.ok) {
    return {
      ok: false,
      status: joinResult.status,
      operation: "channel_join",
      error: joinResult.error,
    };
  }

  return {
    ok: true,
    status: joinResult.status,
    data: {
      state: "joined",
      target: request.target,
      channelId: channel.id,
    },
  };
}
