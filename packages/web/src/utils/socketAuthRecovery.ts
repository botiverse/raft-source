import type { Socket } from "socket.io-client";
import { getSocketAuthErrorRecoveryAction } from "./socketSessionPolicy";

export type SocketAuthLike = Pick<Socket, "auth" | "connect">;

export type SocketAuthRecoveryResult = "ignored" | "retried-with-latest-token" | "needs-refresh";

function readSocketAuthToken(socket: SocketAuthLike): string | null {
  const auth = socket.auth as { token?: unknown } | undefined;
  return typeof auth?.token === "string" ? auth.token : null;
}

export function recoverSocketAuthWithLatestToken(params: {
  socket: SocketAuthLike;
  message: string | undefined;
  refreshInFlight: boolean;
  latestAccessToken: string | null | undefined;
  buildFreshAuth: () => Record<string, unknown>;
}): SocketAuthRecoveryResult {
  const action = getSocketAuthErrorRecoveryAction({
    message: params.message,
    refreshInFlight: params.refreshInFlight,
    socketAuthToken: readSocketAuthToken(params.socket),
    latestAccessToken: params.latestAccessToken,
  });

  if (action === "retry-with-latest-token") {
    params.socket.auth = params.buildFreshAuth();
    params.socket.connect();
    return "retried-with-latest-token";
  }

  if (action === "refresh-token") return "needs-refresh";
  return "ignored";
}
