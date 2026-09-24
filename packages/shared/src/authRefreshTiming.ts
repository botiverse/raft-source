// The server replay grace starts when the winning refresh rotation commits.
// A losing tab's fallback chain is: discover the 401, wait a bounded time for
// the winner's token write, then spend one retry RTT. Keep that chain within
// the server grace so a legitimate loser can still replay the winner rotation.
export const AUTH_REFRESH_ROTATED_REPLAY_GRACE_MS = 10_000;
export const AUTH_REFRESH_ROTATION_DISCOVERY_LAG_BUDGET_MS = 1_000;
export const AUTH_REFRESH_ROTATED_TOKEN_WAIT_MS = 4_000;
export const AUTH_REFRESH_ROTATION_RETRY_RTT_BUDGET_MS = 1_000;
export const AUTH_REFRESH_REQUEST_TIMEOUT_MS = 15_000;

export const AUTH_REFRESH_ROTATION_LOSER_WORST_CHAIN_MS =
  AUTH_REFRESH_ROTATION_DISCOVERY_LAG_BUDGET_MS
  + AUTH_REFRESH_ROTATED_TOKEN_WAIT_MS
  + AUTH_REFRESH_ROTATION_RETRY_RTT_BUDGET_MS;

export const AUTH_REFRESH_ROTATION_REPLAY_GRACE_MARGIN_MS =
  AUTH_REFRESH_ROTATED_REPLAY_GRACE_MS - AUTH_REFRESH_ROTATION_LOSER_WORST_CHAIN_MS;
