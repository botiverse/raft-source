import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import { useServerStore } from "../store/serverStore";
import { useAuthStore } from "../store/authStore";
import {
  resolveSocketRefreshOutcome,
} from "../utils/socketSessionPolicy";
import { getAuthRuntimeSnapshot } from "../utils/authSessionRuntime";
import {
  recoverSocketAuthWithLatestToken,
} from "../utils/socketAuthRecovery";
import {
  planReconnectAuthRefresh,
  parseAccessTokenExp,
} from "../utils/socketReconnectAuthRefresh";
import { prefetchServerFeatureFlags } from "../store/serverFeatureFlags";
import { assertValidDesktopRuntimeEnvironment, RUNTIME_SOCKET_ORIGIN } from "../desktopRuntimeEnvironment";

let socket: Socket | null = null;
let listenersAttached = false;
let refreshingForSocket = false;

function freshAuth() {
  return {
    token: localStorage.getItem("slock_access_token"),
    serverId: useServerStore.getState().current?.id ?? null,
    clientKind: "web",
  };
}

export function updateSocketAuthFromStorage() {
  if (!socket) return;
  socket.auth = freshAuth();
}

export function getSocket(): Socket {
  if (!socket) {
    assertValidDesktopRuntimeEnvironment();

    socket = io(RUNTIME_SOCKET_ORIGIN, {
      autoConnect: false,
      forceNew: true,
      // Polling sessions are instance-bound and our current deployment path
      // does not guarantee sticky affinity for Socket.IO sid routing.
      transports: ["websocket"],
      // Use object auth — function form has issues with socket.io-client 4.8.x ESM builds.
      // Auth is refreshed by setting socket.auth before each connect() call.
      auth: freshAuth(),
    });
  }
  return socket;
}

export function connectSocket() {
  const s = getSocket();

  if (!listenersAttached) {
    listenersAttached = true;
    s.on("connect_error", async (err) => {
      console.error("[Socket.io] Connection error:", err.message);

      // If HTTP refresh already rotated the token, retry with the latest
      // local token before spending another single-use refresh token.
      const recoveryResult = recoverSocketAuthWithLatestToken({
        socket: s,
        message: err.message,
        refreshInFlight: refreshingForSocket,
        latestAccessToken: localStorage.getItem("slock_access_token"),
        buildFreshAuth: freshAuth,
      });

      if (recoveryResult === "retried-with-latest-token") {
        return;
      }

      // If the error looks like an auth failure, try refreshing the token once.
      if (recoveryResult === "needs-refresh") {
        refreshingForSocket = true;
        try {
          let ok = false;
          try {
            ok = await useAuthStore.getState().refreshAccessToken();
          } catch (refreshErr) {
            // Transient refresh failures should not force logout.
            console.warn("[Socket.io] Refresh failed transiently:", refreshErr);
          }
          const outcome = resolveSocketRefreshOutcome({
            refreshSucceeded: ok,
            hasRefreshToken: !!localStorage.getItem("slock_refresh_token"),
            ...getAuthRuntimeSnapshot(),
          });
          if (outcome === "retry") {
            s.auth = freshAuth();
            s.connect();
          } else if (outcome === "keep-session") {
            // Keep session and let subsequent attempts retry naturally.
            console.warn("[Socket.io] Refresh not completed; keeping session for retry");
          } else {
            // Refresh token is dead/missing — force logout.
            useAuthStore.getState().logout("terminal_verdict");
          }
        } finally {
          refreshingForSocket = false;
        }
      }
    });
    s.on("connect", () => {
      console.log("[Socket.io] Connected, id:", s.id);
      // Stryker disable next-line all: lifecycle wiring is pinned by a source contract; batching behavior is covered in serverFeatureFlags.test.ts.
      void prefetchServerFeatureFlags(useServerStore.getState().current?.id);
    });
    s.on("disconnect", (reason) => {
      console.log("[Socket.io] Disconnected:", reason);
    });

    // socket.io-client's built-in reconnect (Manager-level) does not pass
    // through `connectSocket()` / `ensureSocketConnected()`, so the cached
    // `Socket.auth` object can hold a token that has since expired (axios
    // interceptor refreshed localStorage but the offline socket never saw
    // it). When that retry handshakes, the server rejects with "Invalid or
    // expired token" — but CF/transport mangling turns the surfaced error
    // into a generic "timeout" / "WebSocket is closed before connection
    // established", which doesn't match the auth-keyword check in
    // `connect_error`. Result: the socket is wedged until the user reloads.
    //
    // This `reconnect_attempt` listener fires before each engine.io retry.
    // We re-read localStorage and either (a) refresh `Socket.auth` in place
    // when the cached token is fresh, or (b) trigger an explicit token
    // refresh and then update auth, so the next handshake uses a valid
    // token. (#engineering:bc625a3b — task #348, 2026-05-03)
    s.io.on("reconnect_attempt", () => {
      void runReconnectAuthRefresh(s);
    });
  }

  if (!s.connected) {
    // Refresh auth before connecting to ensure fresh token
    s.auth = freshAuth();
    // Stryker disable next-line all: lifecycle wiring is pinned by a source contract; batching behavior is covered in serverFeatureFlags.test.ts.
    void prefetchServerFeatureFlags(useServerStore.getState().current?.id);
    s.connect();
  }
}

/**
 * Refresh `Socket.auth` ahead of the next reconnect attempt. See the
 * comment on the `reconnect_attempt` listener in `connectSocket()` for
 * the root cause this guards against. Exported only for testing seams;
 * call sites are inside this module.
 */
async function runReconnectAuthRefresh(s: Socket): Promise<void> {
  const action = planReconnectAuthRefresh({
    latestAccessToken: localStorage.getItem("slock_access_token"),
    freshAuth: freshAuth(),
    parseTokenExp: parseAccessTokenExp,
    now: Date.now(),
  });

  if (action.type === "skip") {
    return;
  }

  if (action.type === "update-auth-only") {
    s.auth = action.auth;
    return;
  }

  // trigger-refresh-and-update: the cached token is expired, near-expiry,
  // or unparseable. Force a refresh round-trip and then update auth with
  // the post-refresh token. If the refresh itself fails, fall back to
  // freshAuth() — engine.io will retry with whatever's there and the
  // existing connect_error handler will eventually catch up.
  if (refreshingForSocket) {
    s.auth = freshAuth();
    return;
  }
  refreshingForSocket = true;
  try {
    try {
      await useAuthStore.getState().refreshAccessToken();
    } catch (err) {
      console.warn("[Socket.io] Reconnect token refresh failed:", err);
    }
    s.auth = freshAuth();
  } finally {
    refreshingForSocket = false;
  }
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
  }
}

/**
 * Fully destroy and recreate the socket instance.
 * Call this after login or token refresh to ensure a clean connection.
 */
export function resetSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    listenersAttached = false;
  }
}

/**
 * Reconnect socket with updated auth (e.g. after server switch).
 * Destroys the old socket and creates a fresh one.
 */
export function reconnectSocket() {
  resetSocket();
  connectSocket();
}

/**
 * Ensure socket is connected — reconnect with fresh auth if disconnected.
 * Useful for visibility-change handlers (mobile tab foreground restore).
 */
export function ensureSocketConnected() {
  const s = socket;
  if (!s || !s.connected) {
    if (s) {
      // Socket exists but disconnected — update auth and reconnect
      s.auth = freshAuth();
      // Stryker disable next-line all: lifecycle wiring is pinned by a source contract; batching behavior is covered in serverFeatureFlags.test.ts.
      void prefetchServerFeatureFlags(useServerStore.getState().current?.id);
      s.connect();
    } else {
      connectSocket();
    }
  }
}

export function isSocketConnected() {
  return !!socket?.connected;
}
