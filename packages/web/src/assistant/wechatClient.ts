// Client data layer for the personal assistant's WeChat bridge (design
// "微信接入 Ottie"; server: packages/server/src/routes/assistantWeChat.ts and
// services/wechatBridgeService.ts), under /api/servers/:serverId/assistant/wechat.
// Each person sees and changes only their own connection.
//
//   GET    /status              → { available, binding: null | { bindingId, state: "active" | "reconnect_required", connectedAt } }
//                                  (a binding shows even while unavailable, so it can still be disconnected)
//   POST   /attempts            → 201 { attemptId, qrContent, expiresAt }
//                                  429 wechat_rate_limited, 404 wechat_unavailable / assistant_not_found,
//                                  409 wechat_already_connected / wechat_attempt_in_progress,
//                                  502 wechat_upstream_unavailable
//   POST   /attempts/:id/poll   { verifyCode? } → { status: wait | scanned | need_verify_code | confirmed
//                                  | expired | blocked | already_bound }
//                                  403 wechat_attempt_unbound, 410 wechat_attempt_used / wechat_attempt_expired,
//                                  429 wechat_poll_in_flight, 400 invalid_verify_code,
//                                  409 wechat_account_in_use / assistant_not_found,
//                                  502 wechat_upstream_unavailable / wechat_upstream_refused
//   DELETE /binding?bindingId=  → { binding: null }   404 wechat_not_connected, 409 wechat_binding_changed
//                                  (only the binding named: a newer one is never removed)
//   Errors are { error, code }.
//
// The start sets an HttpOnly cookie that binds the attempt to this browser
// (services/oauthBrowserBinding.ts, scoped to .../attempts); only a poll that
// carries it is answered. Start and poll are sent withCredentials, so a build
// whose API is on another origin of the same site (app.raft.build →
// api.raft.build) stores and sends it. The cookie is SameSite=Lax, so a page
// on another site (the desktop app's app://raft) can neither store nor send
// it: see wechatConnectHere.ts.

import { useEffect } from "react";
import axios from "axios";
import { create } from "zustand";
import api from "../api/client";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";

export type WeChatBindingState = "active" | "reconnect_required";

/** The person's connection as the server shows it: no WeChat account id or name is ever sent. */
export type WeChatBinding = {
  /** The binding's id: the one its connected notice names (`wechat-connected:<id>`). */
  bindingId: string;
  state: WeChatBindingState;
  connectedAt: string;
};

export type WeChatStatus = {
  /** Whether this person may connect WeChat here now (flags, assistant, server key). */
  available: boolean;
  binding: WeChatBinding | null;
};

export type WeChatStatusState =
  | { status: "loading" }
  /** The status could not be read (offline, 5xx): nothing is offered, a disconnect still works. */
  | { status: "error" }
  | { status: "ready"; value: WeChatStatus };

export type WeChatAttempt = { attemptId: string; qrContent: string; expiresAt: string };

export type WeChatAttemptStatus =
  | "wait"
  | "scanned"
  | "need_verify_code"
  | "confirmed"
  | "expired"
  | "blocked"
  | "already_bound";

const ATTEMPT_STATUSES: ReadonlySet<string> = new Set<WeChatAttemptStatus>([
  "wait", "scanned", "need_verify_code", "confirmed", "expired", "blocked", "already_bound",
]);

/** What WeChat's verification code may be: the server refuses anything else (400 invalid_verify_code). */
export const WECHAT_VERIFY_CODE_RE = /^[0-9A-Za-z]{1,16}$/u;

/** A refused or failed request: the HTTP status (null: no answer) and the server's `code`. */
export class WeChatRequestError extends Error {
  constructor(readonly status: number | null, readonly code: string | null) {
    super(code ?? `wechat_request_failed${status === null ? "" : `_${status}`}`);
  }
}

function toRequestError(error: unknown): WeChatRequestError {
  if (error instanceof WeChatRequestError) return error;
  if (!axios.isAxiosError(error)) return new WeChatRequestError(null, null);
  const body = (error.response?.data ?? null) as { code?: unknown } | null;
  return new WeChatRequestError(error.response?.status ?? null, typeof body?.code === "string" ? body.code : null);
}

function isAbort(error: unknown): boolean {
  return axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError");
}

// ---- Scope --------------------------------------------------------------------

type Key = `${string}:${string}`;

function keyOf(serverId: string, userId: string): Key {
  return `${serverId}:${userId}`;
}

function currentScope(): { serverId: string; key: Key } {
  const serverId = useServerStore.getState().current?.id;
  const userId = useAuthStore.getState().user?.id;
  if (!serverId || !userId) throw new WeChatRequestError(null, "no_current_server");
  return { serverId, key: keyOf(serverId, userId) };
}

function path(serverId: string): string {
  return `/servers/${encodeURIComponent(serverId)}/assistant/wechat`;
}

// ---- Status cache -------------------------------------------------------------

const NOT_HERE: WeChatStatus = Object.freeze({ available: false, binding: null });

const useWeChatCache = create<{ byKey: Record<Key, WeChatStatusState | undefined> }>(() => ({ byKey: {} }));
const inFlight = new Map<Key, Promise<void>>();

function store(key: Key, state: WeChatStatusState) {
  useWeChatCache.setState((current) => ({ byKey: { ...current.byKey, [key]: state } }));
}

function normalizeBinding(raw: unknown): WeChatBinding | null {
  const binding = raw as { bindingId?: unknown; state?: unknown; connectedAt?: unknown } | null | undefined;
  if (!binding || (binding.state !== "active" && binding.state !== "reconnect_required")) return null;
  return {
    bindingId: typeof binding.bindingId === "string" ? binding.bindingId : "",
    state: binding.state,
    connectedAt: typeof binding.connectedAt === "string" ? binding.connectedAt : "",
  };
}

function normalizeStatus(data: unknown): WeChatStatus {
  const body = (data ?? {}) as { available?: unknown; binding?: unknown };
  return { available: body.available === true, binding: normalizeBinding(body.binding) };
}

async function fetchInto(serverId: string, key: Key, keepOnError: boolean): Promise<void> {
  try {
    const { data } = await api.get(`${path(serverId)}/status`);
    store(key, { status: "ready", value: normalizeStatus(data) });
  } catch (error) {
    const { status } = toRequestError(error);
    // A server without the bridge's routes: WeChat is not offered here.
    if (status === 404) {
      store(key, { status: "ready", value: NOT_HERE });
      return;
    }
    if (keepOnError && useWeChatCache.getState().byKey[key]?.status === "ready") return;
    store(key, { status: "error" });
  }
}

function load(serverId: string, key: Key, keepOnError = false): Promise<void> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchInto(serverId, key, keepOnError).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/**
 * This person's WeChat connection in the current server, asked once and
 * shared (the assistant's settings and the connected notice in its DM).
 * `ask: false` reads what is known and asks nothing.
 */
export function useWeChatStatus({ ask = true }: { ask?: boolean } = {}): WeChatStatusState {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const key = serverId && userId ? keyOf(serverId, userId) : null;
  const cached = useWeChatCache((s) => (key ? s.byKey[key] : undefined));
  const loaded = cached !== undefined;
  useEffect(() => {
    if (!ask || loaded || !key || !serverId) return;
    void load(serverId, key);
  }, [ask, loaded, key, serverId]);
  return cached ?? { status: "loading" };
}

/**
 * Ask again (the settings menu opening, after connecting, or when a request
 * says the state moved); a failure keeps what was known. Never rejects.
 */
export function refreshWeChatStatus(): Promise<void> {
  let scope: { serverId: string; key: Key };
  try {
    scope = currentScope();
  } catch {
    return Promise.resolve();
  }
  return load(scope.serverId, scope.key, true);
}

function setBinding(key: Key, binding: WeChatBinding | null) {
  const current = useWeChatCache.getState().byKey[key];
  const value = current?.status === "ready" ? current.value : NOT_HERE;
  store(key, { status: "ready", value: { ...value, binding } });
}

// ---- Connecting ---------------------------------------------------------------

/** POST /attempts: a QR code bound to this browser. Throws WeChatRequestError (429 wechat_rate_limited, …). */
export async function startWeChatAttempt(): Promise<WeChatAttempt> {
  const { serverId } = currentScope();
  try {
    // withCredentials: the answer sets the cookie that binds the attempt to this browser.
    const { data } = await api.post(`${path(serverId)}/attempts`, {}, { withCredentials: true });
    const body = (data ?? {}) as Partial<Record<keyof WeChatAttempt, unknown>>;
    if (typeof body.attemptId !== "string" || typeof body.qrContent !== "string" || typeof body.expiresAt !== "string") {
      throw new WeChatRequestError(null, "invalid_response");
    }
    return { attemptId: body.attemptId, qrContent: body.qrContent, expiresAt: body.expiresAt };
  } catch (error) {
    throw toRequestError(error);
  }
}

/**
 * POST /attempts/:id/poll, with WeChat's verification code when the last
 * answer asked for it. Resolves with the status word; throws
 * WeChatRequestError, or rethrows an abort as is.
 */
export async function pollWeChatAttempt(
  attemptId: string,
  { verifyCode = null, signal }: { verifyCode?: string | null; signal?: AbortSignal } = {},
): Promise<WeChatAttemptStatus> {
  const { serverId } = currentScope();
  try {
    // withCredentials: the cookie from the start goes back with every poll.
    const { data } = await api.post(
      `${path(serverId)}/attempts/${encodeURIComponent(attemptId)}/poll`,
      verifyCode ? { verifyCode } : {},
      { withCredentials: true, signal },
    );
    const status = (data as { status?: unknown } | undefined)?.status;
    if (typeof status !== "string" || !ATTEMPT_STATUSES.has(status)) throw new WeChatRequestError(null, "invalid_response");
    return status as WeChatAttemptStatus;
  } catch (error) {
    if (isAbort(error)) throw error;
    throw toRequestError(error);
  }
}

// ---- Disconnecting ------------------------------------------------------------

/**
 * DELETE /binding?bindingId=: Raft forgets exactly that connection and its
 * token (always allowed, flag or not). "already_ended": it was gone already
 * (404), or a newer connection replaced it (409, which stays; the status is
 * read again). Throws WeChatRequestError on anything else.
 */
export async function disconnectWeChat(bindingId: string): Promise<"disconnected" | "already_ended"> {
  const { serverId, key } = currentScope();
  try {
    await api.delete(`${path(serverId)}/binding`, { params: { bindingId } });
  } catch (error) {
    const failure = toRequestError(error);
    // A newer connection was made since: it stays, and the status shows it.
    if (failure.code === "wechat_binding_changed") {
      await load(serverId, key);
      return "already_ended";
    }
    if (failure.code !== "wechat_not_connected") throw failure;
    setBinding(key, null);
    return "already_ended";
  }
  setBinding(key, null);
  return "disconnected";
}

/** Clears the cache. Tests and session changes. */
export function resetWeChatClientForTests(): void {
  inFlight.clear();
  useWeChatCache.setState({ byKey: {} });
}
