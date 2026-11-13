import type { ManagedMcpOAuthClientInput } from "@botiverse/raft-shared";
import { MANAGED_MCP_OAUTH_RESULT_CHANNEL } from "@botiverse/raft-shared";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import api from "../../../api/client";
import { McpOAuthUnsafeUrlError } from "./mcpAppApi";
import type { McpOAuthAttemptStatus, McpOAuthStartResponse } from "./mcpAppApi";

/** How often the attempt is polled when the result page's BroadcastChannel message does not arrive. */
export const MCP_OAUTH_POLL_INTERVAL_MS = 2_000;
/** An attempt expires on the server after 10 minutes; stop waiting then. */
export const MCP_OAUTH_WAIT_LIMIT_MS = 10 * 60_000;

export type McpOAuthStartBody =
  | {
    name: string;
    makeDefault: boolean;
    oauthClient?: ManagedMcpOAuthClientInput | null;
    /** Where the sign-in was started for (an Agent's Connect card). Context only: it never grants. */
    intent?: { agentId: string; actionCardMessageId?: string };
  }
  | {
    connectionId: string;
    oauthClient?: ManagedMcpOAuthClientInput | null;
  };


export type McpOAuthOutcome =
  | { kind: "connected"; connectionId: string | null }
  /** The attempt failed, expired, or can no longer be read (gone, forbidden). */
  | { kind: "failed" | "expired" }
  /** The sign-in window was closed while the attempt was still pending. */
  | { kind: "closed" };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Only a web page may be loaded into the popup. It starts as a same-origin about:blank, so a
 * `javascript:` (or any other scheme) URL would run as Raft. The server only issues https URLs; this
 * is the client's own check. Plain http is allowed only for a loopback provider in local development.
 */
export function isSafeAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

/** A 4xx other than timeout/rate limit: asking again will not change the answer. */
function isTerminalStatusError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function openBlankPopup(): Window | null {
  const popup = window.open("about:blank", "_blank");
  if (popup) popup.opener = null;
  return popup;
}

/**
 * Signs a Connection in with OAuth in a popup.
 *
 * The popup is opened synchronously in the click (popup blockers allow only that), then pointed at
 * the authorization URL from `/connections/oauth/start`. If the browser blocked it, `blockedUrl` is
 * set and `openSignInPage` opens it from a fresh click. The result page posts on the managed-MCP
 * BroadcastChannel with its attemptId; if that message never arrives (another browser profile,
 * BroadcastChannel unavailable) the attempt is polled every 2 s for up to 10 minutes. Either way the
 * attempt's status from the server decides the outcome, not the message.
 *
 * Only the current attempt reports an outcome: a response for an attempt that was cancelled, timed
 * out or already decided is dropped. A 4xx on the attempt (deleted elsewhere, no longer allowed)
 * ends it as failed. Closing the popup ends the wait once the server says the attempt is still
 * pending. A result that arrives after the wait ended still reports `onLateResult`, so the caller
 * can re-read the Connections.
 */
export function useMcpOAuthSignIn({
  appId,
  onOutcome,
  onStartError,
  onLateResult,
}: {
  appId: string;
  onOutcome: (outcome: McpOAuthOutcome) => void;
  onStartError: (error: unknown) => void;
  onLateResult?: () => void;
}) {
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  // The attempt responses are checked against, set synchronously (state lags a render behind).
  const attemptRef = useRef<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollInFlightRef = useRef(false);
  // Bumped by cancel, so a start request that returns afterwards is dropped.
  const startGenerationRef = useRef(0);

  const finish = useCallback((id: string) => {
    if (attemptRef.current !== id) return false;
    attemptRef.current = null;
    popupRef.current = null;
    setAttemptId(null);
    setBlockedUrl(null);
    return true;
  }, []);

  const start = useCallback(async (body: McpOAuthStartBody) => {
    const popup = openBlankPopup();
    const generation = ++startGenerationRef.current;
    setStarting(true);
    try {
      // withCredentials: the response sets the HttpOnly cookie that binds this sign-in to this
      // browser; the provider's redirect back to the API callback must carry it.
      const { data } = await api.post<McpOAuthStartResponse>(`/mcp/apps/${appId}/connections/oauth/start`, body, { withCredentials: true });
      if (generation !== startGenerationRef.current) {
        popup?.close();
        return;
      }
      if (!isSafeAuthorizationUrl(data.authorizationUrl)) throw new McpOAuthUnsafeUrlError();
      attemptRef.current = data.attemptId;
      popupRef.current = popup;
      if (popup) popup.location.href = data.authorizationUrl;
      // Blocked: a second window.open here is no longer in the click and would be blocked too.
      setBlockedUrl(popup ? null : data.authorizationUrl);
      setAttemptId(data.attemptId);
    } catch (error) {
      popup?.close();
      if (generation === startGenerationRef.current) onStartError(error);
    } finally {
      if (generation === startGenerationRef.current) setStarting(false);
    }
  }, [appId, onStartError]);

  /** Opens the sign-in page the browser blocked, from the person's own click. */
  const openSignInPage = useCallback(() => {
    if (!blockedUrl) return;
    const popup = openBlankPopup();
    if (!popup) return;
    popup.location.href = blockedUrl;
    popupRef.current = popup;
    setBlockedUrl(null);
  }, [blockedUrl]);

  const cancel = useCallback(() => {
    startGenerationRef.current += 1;
    setStarting(false);
    const popup = popupRef.current;
    attemptRef.current = null;
    popupRef.current = null;
    setAttemptId(null);
    setBlockedUrl(null);
    try {
      popup?.close();
    } catch {
      // Already gone.
    }
  }, []);

  const checkAttempt = useEffectEvent(async (id: string, source: "poll" | "message" | "closed") => {
    if (source === "poll" && pollInFlightRef.current) return;
    if (source === "poll") pollInFlightRef.current = true;
    try {
      const { data } = await api.get<{ attemptId: string; status: McpOAuthAttemptStatus; connectionId: string | null }>(`/mcp/oauth/attempts/${id}`);
      // `finish` reports only for the current attempt: a cancelled, timed-out or decided one is dropped.
      if (data.status === "pending") {
        if (source === "closed" && finish(id)) onOutcome({ kind: "closed" });
        return;
      }
      if (!finish(id)) return;
      onOutcome(data.status === "connected" ? { kind: "connected", connectionId: data.connectionId } : { kind: data.status });
    } catch (error) {
      if (isTerminalStatusError(error)) {
        if (finish(id)) onOutcome({ kind: "failed" });
      } else if (source === "closed") {
        if (finish(id)) onOutcome({ kind: "closed" });
      }
      // Otherwise a transient failure: the next poll asks again.
    } finally {
      if (source === "poll") pollInFlightRef.current = false;
    }
  });

  const tick = useEffectEvent((id: string) => {
    const popup = popupRef.current;
    let closed = false;
    try {
      closed = popup?.closed === true;
    } catch {
      closed = false;
    }
    if (closed) {
      popupRef.current = null;
      void checkAttempt(id, "closed");
      return;
    }
    void checkAttempt(id, "poll");
  });

  const giveUp = useEffectEvent((id: string) => {
    if (finish(id)) onOutcome({ kind: "expired" });
  });

  const handleChannelMessage = useEffectEvent((messageAttemptId: unknown) => {
    const current = attemptRef.current;
    if (current === null) {
      onLateResult?.();
      return;
    }
    // A result page from an older server carries no attemptId; ask about ours either way.
    if (messageAttemptId !== undefined && messageAttemptId !== current) return;
    void checkAttempt(current, "message");
  });

  // Listen while mounted, not only while waiting: a sign-in finished after Cancel (or after a
  // sign-in window looked closed) still refreshes the Connections.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return undefined;
    const channel = new BroadcastChannel(MANAGED_MCP_OAUTH_RESULT_CHANNEL);
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; attemptId?: unknown } | null;
      if (data?.type !== MANAGED_MCP_OAUTH_RESULT_CHANNEL) return;
      handleChannelMessage(data.attemptId);
    };
    channel.addEventListener("message", handleMessage);
    return () => {
      channel.removeEventListener("message", handleMessage);
      channel.close();
    };
  }, []);

  useEffect(() => {
    if (attemptId === null) return undefined;
    const poll = window.setInterval(() => tick(attemptId), MCP_OAUTH_POLL_INTERVAL_MS);
    const limit = window.setTimeout(() => giveUp(attemptId), MCP_OAUTH_WAIT_LIMIT_MS);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(limit);
    };
  }, [attemptId]);

  return { start, cancel, openSignInPage, blockedUrl, waiting: attemptId !== null, starting };
}
