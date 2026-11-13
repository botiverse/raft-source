import axios, { AxiosHeaders } from "axios";
import { DISPLAY_LOCALES, displayLocaleTag } from "@botiverse/raft-shared/src/displayLocales";
import type { AxiosInstance } from "axios";

const COMPILED_API_ORIGIN = typeof import.meta.env?.VITE_API_URL === "string" ? import.meta.env.VITE_API_URL.replace(/\/$/, "") : "";
export const FEEDBACK_HOST_VERSION = "raft-feedback-v1";
export const FEEDBACK_SESSION_UPDATED = "raft:feedback-session-updated";
export type FeedbackHostEvent = "ready" | "auth-required" | "integration-unavailable" | "close";
export interface FeedbackHostSession {
  accountId: string;
  sessionGeneration: number;
  webViewGeneration: number;
  accessToken: string;
  apiOrigin: string;
  /** Which native client is hosting the page. Passed through as given: the Server decides which kinds it accepts. */
  clientKind: string;
  clientVersion: string;
  locale: FeedbackHostLocale;
  /** The host's own theme family. The page always renders the Raft Design System; only `mode` is honoured. */
  theme: "brutal" | "elegant" | "raft";
  mode: "light" | "dark";
}
/**
 * Locales the page ships copy for: the BCP 47 tag of every display locale
 * (`en`, `zh-CN`, `ja`, …). Older hosts send only en / zh-CN.
 */
export const FEEDBACK_HOST_LOCALES: readonly string[] = DISPLAY_LOCALES.map(displayLocaleTag);
export type FeedbackHostLocale = string;
export type FeedbackBinding = Pick<FeedbackHostSession, "accountId" | "sessionGeneration" | "webViewGeneration">;
export interface FeedbackHost {
  version: typeof FEEDBACK_HOST_VERSION;
  capabilities?: string[];
  diagnostics?: {
    start: (request: { requestId: string }, binding: FeedbackBinding) => void | Promise<void>;
    cancel: (request: { requestId: string }, binding: FeedbackBinding) => void | Promise<void>;
  };
  /** Installed by the host before page scripts; refreshed by replacing session. */
  session: FeedbackHostSession;
  emit: (event: FeedbackHostEvent, binding: { accountId: string; sessionGeneration: number; webViewGeneration: number }) => void;
}
export function parseFeedbackHost(value: unknown, pageOrigin: string, compiledApiOrigin = COMPILED_API_ORIGIN): FeedbackHost | null {
  if (!value || typeof value !== "object") return null;
  const host = value as Partial<FeedbackHost>;
  const s = host.session;
  if (host.version !== FEEDBACK_HOST_VERSION || typeof host.emit !== "function" || !s) return null;
  if (typeof s.accountId !== "string" || !s.accountId || s.accountId.length > 128) return null;
  if (![s.sessionGeneration, s.webViewGeneration].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  if (typeof s.accessToken !== "string" || !s.accessToken || s.accessToken.length > 16384 || /\s/.test(s.accessToken)) return null;
  // The kind is not policed here (artin, 2026-10-10): any host may name itself and the
  // Server rejects kinds it does not know. Only its shape is checked, because it is sent
  // as a request header.
  if (typeof s.clientKind !== "string" || !s.clientKind || s.clientKind.length > 64 || /\s/.test(s.clientKind)) return null;
  if (typeof s.clientVersion !== "string" || !s.clientVersion.trim() || s.clientVersion.length > 64) return null;
  if (!FEEDBACK_HOST_LOCALES.includes(s.locale) || !["brutal", "elegant", "raft"].includes(s.theme) || !["light", "dark"].includes(s.mode)) return null;
  try {
    const origin = new URL(s.apiOrigin);
    // The additional API target is build-owned, never an arbitrary host choice.
    if (![pageOrigin, compiledApiOrigin].includes(origin.origin) || s.apiOrigin !== origin.origin) return null;
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) return null;
  } catch { return null; }
  return host as FeedbackHost;
}
export function sameFeedbackSession(a: FeedbackHostSession, b: FeedbackHostSession): boolean {
  return a.accountId === b.accountId && a.sessionGeneration === b.sessionGeneration
    && a.webViewGeneration === b.webViewGeneration && a.apiOrigin === b.apiOrigin
    && a.clientKind === b.clientKind;
}
export function readFeedbackHost(): FeedbackHost | null {
  try {
    const host = parseFeedbackHost((window as unknown as { RaftFeedback?: unknown }).RaftFeedback, window.location.origin);
    return host ? {
      version: host.version, session: { ...host.session }, emit: host.emit.bind(host),
      capabilities: Array.isArray(host.capabilities) ? [...host.capabilities] : undefined,
      diagnostics: host.diagnostics && typeof host.diagnostics.start === "function" && typeof host.diagnostics.cancel === "function"
        ? { start: host.diagnostics.start.bind(host.diagnostics), cancel: host.diagnostics.cancel.bind(host.diagnostics) } : undefined,
    } : null;
  } catch { return null; }
}
export function emitFeedbackEvent(host: FeedbackHost, event: FeedbackHostEvent): void {
  const { accountId, sessionGeneration, webViewGeneration } = host.session;
  try { host.emit(event, { accountId, sessionGeneration, webViewGeneration }); } catch { /* Host failures cannot expose credentials or initiate retries. */ }
}
export function createNativeFeedbackClient(initial: FeedbackHost, readHost = readFeedbackHost, onTerminal: (event: FeedbackHostEvent) => void = () => {}): AxiosInstance {
  const binding = { ...initial.session };
  const client = axios.create({ baseURL: `${binding.apiOrigin}/api` });
  const controller = new AbortController();
  const current = () => {
    const host = readHost();
    if (!host || !sameFeedbackSession(binding, host.session)) {
      controller.abort();
      emitFeedbackEvent(initial, "close");
      onTerminal("close");
      throw new Error("feedback_host_session_changed");
    }
    return host;
  };
  const cleanups = new WeakMap<object, () => void>();
  const release = (config: object | undefined) => { if (config) { cleanups.get(config)?.(); cleanups.delete(config); } };
  let authNotified = false;
  let fallbackNotified = false;
  client.interceptors.request.use(config => {
    const host = current();
    if (config.url !== "/product-feedback" && !config.url?.startsWith("/product-feedback/")) throw new Error("feedback_route_not_allowed");
    if (config.baseURL !== `${binding.apiOrigin}/api`) throw new Error("feedback_origin_not_allowed");
    config.headers = AxiosHeaders.from(config.headers);
    config.headers.set("Authorization", `Bearer ${host.session.accessToken}`);
    config.headers.set("X-Raft-Client-Kind", host.session.clientKind);
    config.headers.set("Accept-Language", host.session.locale);
    if (config.signal) {
      const input = config.signal as AbortSignal;
      const combined = new AbortController();
      const abort = () => combined.abort();
      input.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener("abort", abort, { once: true });
      if (input.aborted || controller.signal.aborted) abort();
      cleanups.set(config, () => { input.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", abort); });
      config.signal = combined.signal;
    } else config.signal = controller.signal;
    return config;
  });
  client.interceptors.response.use(response => { release(response.config); authNotified = false; current(); return response; }, error => {
    release(error.config);
    const host = current();
    if (error.response?.status === 401 && !authNotified) {
      authNotified = true;
      emitFeedbackEvent(host, "auth-required");
      onTerminal("auth-required");
    }
    if (error.response?.status === 503 && error.response?.data?.code === "feedback_integration_unavailable" && !fallbackNotified) {
      fallbackNotified = true;
      emitFeedbackEvent(host, "integration-unavailable");
    }
    return Promise.reject(error);
  });
  return client;
}
