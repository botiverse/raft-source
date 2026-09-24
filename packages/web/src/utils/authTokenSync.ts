import type { RefreshTokens } from "./refreshCoordinator";

type TokenListener = (tokens: RefreshTokens) => void;
type StorageListener = (listener: (event: StorageEvent) => void) => void;

const CHANNEL_NAME = "slock-auth-tokens";
const SOURCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function createAuthTokenSync(params: {
  channel?: BroadcastChannel;
  addStorageListener?: StorageListener;
  removeStorageListener?: StorageListener;
  readAccessToken: () => string | null;
  readRefreshToken: () => string | null;
}) {
  const listeners = new Set<TokenListener>();
  const channel = params.channel
    ?? (typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null);
  (channel as unknown as { unref?: () => void } | null)?.unref?.();

  function emit(tokens: RefreshTokens) {
    for (const listener of listeners) listener(tokens);
  }

  function parseMessage(data: unknown): RefreshTokens | null {
    if (!data || typeof data !== "object") return null;
    const event = data as { type?: unknown; sourceId?: unknown; accessToken?: unknown; refreshToken?: unknown };
    if (event.type !== "tokens-updated" || event.sourceId === SOURCE_ID) return null;
    if (typeof event.accessToken !== "string" || typeof event.refreshToken !== "string") return null;
    return { accessToken: event.accessToken, refreshToken: event.refreshToken };
  }

  const handleChannelMessage = (event: MessageEvent) => {
    const tokens = parseMessage(event.data);
    if (tokens) emit(tokens);
  };
  channel?.addEventListener("message", handleChannelMessage);

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== "slock_refresh_token") return;
    const accessToken = params.readAccessToken();
    const refreshToken = params.readRefreshToken();
    if (accessToken && refreshToken) emit({ accessToken, refreshToken });
  };

  const addStorageListener: StorageListener | null = params.addStorageListener
    ?? (typeof window !== "undefined"
      ? (listener) => window.addEventListener("storage", listener as EventListener)
      : null);
  const removeStorageListener: StorageListener | null = params.removeStorageListener
    ?? (typeof window !== "undefined"
      ? (listener) => window.removeEventListener("storage", listener as EventListener)
      : null);
  addStorageListener?.(handleStorage);

  return {
    subscribe(listener: TokenListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    publish(tokens: RefreshTokens) {
      emit(tokens);
      channel?.postMessage({
        type: "tokens-updated",
        sourceId: SOURCE_ID,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    },

    close() {
      channel?.removeEventListener("message", handleChannelMessage);
      removeStorageListener?.(handleStorage);
      channel?.close();
      listeners.clear();
    },
  };
}

export const authTokenSync = createAuthTokenSync({
  readAccessToken: () => localStorage.getItem("slock_access_token"),
  readRefreshToken: () => localStorage.getItem("slock_refresh_token"),
});
