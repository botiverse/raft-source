// packages/desktop-contract/src/ipc.ts
// Typed IPC schema — matches actual Tauri invoke surface for Phase 1A.
// Only methods currently registered in lib.rs generate_handler! are declared.
// Future methods (window.navigate, notification.subscribe, session.*) are
// explicitly reserved but not in the MVP contract.

// ── Request ──────────────────────────────────────

export type IpcRequest =
  | DesktopHandshakeRequest
  | WindowFocusRequest
  | WindowBindServerRequest
  | WindowOpenServerRequest
  | WindowSetServerTitleRequest
  | RecoveryRetryRequest
  | RecoveryQuitRequest;

export interface DesktopHandshakeRequest {
  method: "desktop.handshake";
  version: 1;
  params: {
    frontendReleaseId: string;
    protocolVersion: number;
    capabilities: string[];
    documentGeneration: number;
    documentNonce: string;
    environmentId: "production" | "staging";
    environmentGeneration: number;
    openServerCapabilityAck?: 1;
  };
}

export interface WindowFocusRequest {
  method: "window.focus";
  version: 1;
  params: Record<string, never>;
}

export interface WindowBindServerRequest {
  method: "window.bindServer";
  version: 1;
  params: {
    serverId: string;
    documentGeneration: number;
    documentNonce: string;
  };
}

/** Optional native extension, advertised out-of-band by the shell. */
export interface WindowOpenServerRequest {
  method: "window.openServer";
  version: 1;
  params: WindowBindServerRequest["params"];
}

/**
 * Optional native extension, advertised out-of-band by the shell via
 * `__RAFT_DESKTOP_NATIVE_EXTENSIONS__["window.setServerTitle"]`. Sets the
 * calling server-* window's native title to the exact Web-computed title.
 * NOT part of the required CAPABILITY_IDS manifest.
 */
export interface WindowSetServerTitleRequest {
  method: "window.setServerTitle";
  version: 1;
  params: {
    documentGeneration: number;
    documentNonce: string;
    title: string;
  };
}

export interface RecoveryRetryRequest {
  method: "recovery.retry";
  version: 1;
  params: Record<string, never>;
}

export interface RecoveryQuitRequest {
  method: "recovery.quit";
  version: 1;
  params: Record<string, never>;
}

// ── Response ─────────────────────────────────────

export type IpcResponse =
  | DesktopHandshakeOk
  | DesktopHandshakeError
  | WindowFocusOk
  | WindowFocusError
  | WindowBindServerOk
  | WindowBindServerError
  | WindowOpenServerOk
  | WindowOpenServerError
  | WindowSetServerTitleOk
  | WindowSetServerTitleError
  | RecoveryRetryOk
  | RecoveryRetryError
  | RecoveryQuitOk
  | RecoveryQuitError;

export type DesktopHandshakeOk = {
  method: "desktop.handshake";
  status: "ok";
  result: {
    compatibilityState: "readyMinimum" | "readyFull";
    documentGeneration: number;
    environmentId: "production" | "staging";
    environmentGeneration: number;
  };
};

export type DesktopHandshakeError = {
  method: "desktop.handshake";
  status: "error";
  error: IpcErrorBody;
};

export type WindowFocusOk = {
  method: "window.focus";
  status: "ok";
  result: { focused: boolean };
};

export type WindowFocusError = {
  method: "window.focus";
  status: "error";
  error: IpcErrorBody;
};

export type WindowBindServerOk = {
  method: "window.bindServer";
  status: "ok";
  result: { serverId: string; disposition: "bound" | "focusedExisting" };
};

export type WindowBindServerError = {
  method: "window.bindServer";
  status: "error";
  error: IpcErrorBody;
};

export type WindowOpenServerOk = {
  method: "window.openServer";
  status: "ok";
  result: { serverId: string; disposition: "opened" | "focusedExisting" };
};

export type WindowOpenServerError = {
  method: "window.openServer";
  status: "error";
  error: IpcErrorBody;
};

export type WindowSetServerTitleOk = {
  method: "window.setServerTitle";
  status: "ok";
  result: Record<string, never>;
};

export type WindowSetServerTitleError = {
  method: "window.setServerTitle";
  status: "error";
  error: IpcErrorBody;
};

export type RecoveryRetryOk = {
  method: "recovery.retry";
  status: "ok";
  result: Record<string, never>;
};

export type RecoveryRetryError = {
  method: "recovery.retry";
  status: "error";
  error: IpcErrorBody;
};

export type RecoveryQuitOk = {
  method: "recovery.quit";
  status: "ok";
  result: Record<string, never>;
};

export type RecoveryQuitError = {
  method: "recovery.quit";
  status: "error";
  error: IpcErrorBody;
};

export interface IpcErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}

// ── Server title validation (shared by Web producer + native consumer) ──────
//
// The native shell sets the exact Web-computed title and never silently
// normalizes it, so both sides enforce the identical closed rule: the title
// must already be trimmed and equal either the bare fallback `Raft` or a
// non-empty visible prefix followed by ` | Raft`, within a UTF-8 byte budget,
// with C0/C1 control code points and bidi override/isolate/mark code points
// rejected.

export const SERVER_TITLE_FALLBACK = "Raft";
export const SERVER_TITLE_SUFFIX = " | Raft";
export const SERVER_TITLE_MAX_UTF8_BYTES = 200;

function isControlOrBidiCodePoint(code: number): boolean {
  // C0 (U+0000–U+001F) and C1 (U+007F–U+009F) control code points.
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  // Bidi embedding/override/isolate: U+202A–U+202E, U+2066–U+2069.
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  // Left-to-right / right-to-left marks.
  if (code === 0x200e || code === 0x200f) return true;
  return false;
}

export function validateServerTitle(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  // Must already be trimmed; native never normalizes.
  if (value !== value.trim()) return false;
  if (new TextEncoder().encode(value).length > SERVER_TITLE_MAX_UTF8_BYTES) {
    return false;
  }
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && isControlOrBidiCodePoint(code)) return false;
  }
  if (value === SERVER_TITLE_FALLBACK) return true;
  if (value.endsWith(SERVER_TITLE_SUFFIX)) {
    const prefix = value.slice(0, value.length - SERVER_TITLE_SUFFIX.length);
    return prefix.trim().length > 0;
  }
  return false;
}

/** Closed runtime validator for untrusted invoke envelopes. */
export function validateIpcRequest(value: unknown): value is IpcRequest {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.params)) return false;
  if (!hasExactFields(value, ["method", "version", "params"])) return false;

  switch (value.method) {
    case "desktop.handshake": {
      const params = value.params;
      const baseFields = [
        "frontendReleaseId",
        "protocolVersion",
        "capabilities",
        "documentGeneration",
        "documentNonce",
        "environmentId",
        "environmentGeneration",
      ];
      if (
        (!hasExactFields(params, baseFields) &&
          !hasExactFields(params, [...baseFields, "openServerCapabilityAck"])) ||
        typeof params.frontendReleaseId !== "string" ||
        params.frontendReleaseId.length === 0 ||
        !Number.isInteger(params.protocolVersion) ||
        (params.protocolVersion as number) < 1 ||
        !Number.isSafeInteger(params.documentGeneration) ||
        (params.documentGeneration as number) < 1 ||
        typeof params.documentNonce !== "string" ||
        params.documentNonce.length === 0 ||
        (params.environmentId !== "production" && params.environmentId !== "staging") ||
        !Number.isSafeInteger(params.environmentGeneration) ||
        (params.environmentGeneration as number) < 1 ||
        (params.openServerCapabilityAck !== undefined &&
          params.openServerCapabilityAck !== 1) ||
        !Array.isArray(params.capabilities) ||
        params.capabilities.some(
          (cap) => typeof cap !== "string" || cap.length === 0,
        )
      ) {
        return false;
      }
      return new Set(params.capabilities).size === params.capabilities.length;
    }
    case "window.bindServer":
    case "window.openServer":
      return (
        hasExactFields(value.params, ["serverId", "documentGeneration", "documentNonce"]) &&
        typeof value.params.serverId === "string" &&
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value.params.serverId) &&
        Number.isSafeInteger(value.params.documentGeneration) &&
        (value.params.documentGeneration as number) >= 1 &&
        typeof value.params.documentNonce === "string" &&
        value.params.documentNonce.length > 0
      );
    case "window.setServerTitle":
      return (
        hasExactFields(value.params, [
          "documentGeneration",
          "documentNonce",
          "title",
        ]) &&
        Number.isSafeInteger(value.params.documentGeneration) &&
        (value.params.documentGeneration as number) >= 1 &&
        typeof value.params.documentNonce === "string" &&
        value.params.documentNonce.length > 0 &&
        validateServerTitle(value.params.title)
      );
    case "window.focus":
    case "recovery.retry":
    case "recovery.quit":
      return hasExactFields(value.params, []);
    default:
      return false;
  }
}

/** Closed runtime validator for response bytes returned by the native shell. */
export function validateIpcResponse(value: unknown): value is IpcResponse {
  if (
    !isRecord(value) ||
    typeof value.method !== "string" ||
    (value.status !== "ok" && value.status !== "error")
  ) {
    return false;
  }

  if (value.status === "error") {
    return (
      hasExactFields(value, ["method", "status", "error"]) &&
      isKnownMethod(value.method) &&
      isErrorBody(value.error)
    );
  }

  if (!hasExactFields(value, ["method", "status", "result"]) || !isRecord(value.result)) {
    return false;
  }
  switch (value.method) {
    case "desktop.handshake":
      return (
        hasExactFields(value.result, [
          "compatibilityState",
          "documentGeneration",
          "environmentId",
          "environmentGeneration",
        ]) &&
        (value.result.compatibilityState === "readyMinimum" ||
          value.result.compatibilityState === "readyFull") &&
        Number.isSafeInteger(value.result.documentGeneration) &&
        (value.result.documentGeneration as number) >= 1 &&
        (value.result.environmentId === "production" ||
          value.result.environmentId === "staging") &&
        Number.isSafeInteger(value.result.environmentGeneration) &&
        (value.result.environmentGeneration as number) >= 1
      );
    case "window.focus":
      return (
        hasExactFields(value.result, ["focused"]) &&
        typeof value.result.focused === "boolean"
      );
    case "window.bindServer":
    case "window.openServer":
      return (
        hasExactFields(value.result, ["serverId", "disposition"]) &&
        typeof value.result.serverId === "string" &&
        (value.method === "window.bindServer"
          ? value.result.disposition === "bound" ||
            value.result.disposition === "focusedExisting"
          : value.result.disposition === "opened" ||
            value.result.disposition === "focusedExisting")
      );
    case "window.setServerTitle":
      return hasExactFields(value.result, []);
    case "recovery.retry":
    case "recovery.quit":
      return hasExactFields(value.result, []);
    default:
      return false;
  }
}

function isKnownMethod(method: string): method is IpcRequest["method"] {
  return (
    method === "desktop.handshake" ||
    method === "window.focus" ||
    method === "window.bindServer" ||
    method === "window.openServer" ||
    method === "window.setServerTitle" ||
    method === "recovery.retry" ||
    method === "recovery.quit"
  );
}

function isErrorBody(value: unknown): value is IpcErrorBody {
  return (
    isRecord(value) &&
    hasExactFields(value, ["code", "message", "retryable"]) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    typeof value.retryable === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

// ── Event (MVP: deep-link only) ──────────────────

export type IpcEvent = DeepLinkEvent;

export interface DeepLinkEvent {
  type: "deep-link";
  version: 1;
  uri: string;
  action: "open" | "channel" | "dm";
  serverId: string;
  channelId?: string;
  dmChannelId?: string;
  messageId?: string;
  threadParentMessageId?: string;
}

// ── Reserved for future phases ────────────────────
// window.navigate, notification.subscribe, notification.click,
// window.lifecycle, cancel, session.getOpaqueHandle
