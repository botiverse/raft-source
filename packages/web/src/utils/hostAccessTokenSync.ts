export const HOST_ACCESS_TOKEN_UPDATED_EVENT = "raft:host-access-token-updated";
export const HOST_ACCESS_TOKEN_BINDING_STORAGE_KEY = "slock_host_auth_binding";

export type HostAccessTokenSurface =
  | "computers"
  | "billing"
  | "marketplace"
  | "administration";

export interface HostAccessTokenEventDetail {
  accountId: string;
  serverId: string;
  sessionGeneration: number;
  webViewGeneration: number;
  sequence: number;
}

export type HostAccessTokenBinding = Pick<
  HostAccessTokenEventDetail,
  "accountId" | "serverId" | "sessionGeneration" | "webViewGeneration"
>;

export interface HostAccessTokenContext {
  hostShell: boolean;
  surface: HostAccessTokenSurface | null;
  accountId: string | null;
  serverId: string | null;
}

type PendingUpdate = {
  detail: HostAccessTokenEventDetail;
  accessToken: string;
  contextKey: string;
};

const NON_NEGATIVE_INTEGER_FIELDS = [
  "sessionGeneration",
  "webViewGeneration",
  "sequence",
] as const;
const EVENT_DETAIL_FIELDS = new Set([
  "accountId",
  "serverId",
  ...NON_NEGATIVE_INTEGER_FIELDS,
]);
const BINDING_FIELDS = new Set([
  "accountId",
  "serverId",
  "sessionGeneration",
  "webViewGeneration",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseHostAccessTokenEventDetail(
  value: unknown,
): HostAccessTokenEventDetail | null {
  if (typeof value !== "object" || value === null) return null;
  const detail = value as Record<string, unknown>;
  if (Object.keys(detail).some((field) => !EVENT_DETAIL_FIELDS.has(field))) return null;
  if (!nonEmptyString(detail.accountId) || !nonEmptyString(detail.serverId)) return null;
  for (const field of NON_NEGATIVE_INTEGER_FIELDS) {
    if (!Number.isSafeInteger(detail[field]) || Number(detail[field]) < 0) return null;
  }
  return {
    accountId: detail.accountId,
    serverId: detail.serverId,
    sessionGeneration: Number(detail.sessionGeneration),
    webViewGeneration: Number(detail.webViewGeneration),
    sequence: Number(detail.sequence),
  };
}

export function parseHostAccessTokenBinding(value: unknown): HostAccessTokenBinding | null {
  if (typeof value !== "object" || value === null) return null;
  const binding = value as Record<string, unknown>;
  if (Object.keys(binding).some((field) => !BINDING_FIELDS.has(field))) return null;
  if (
    !nonEmptyString(binding.accountId)
    || !nonEmptyString(binding.serverId)
    || !Number.isSafeInteger(binding.sessionGeneration)
    || Number(binding.sessionGeneration) < 0
    || !Number.isSafeInteger(binding.webViewGeneration)
    || Number(binding.webViewGeneration) < 0
  ) {
    return null;
  }
  return {
    accountId: binding.accountId,
    serverId: binding.serverId,
    sessionGeneration: Number(binding.sessionGeneration),
    webViewGeneration: Number(binding.webViewGeneration),
  };
}

export function parseHostAccessTokenBindingStorage(raw: string | null): HostAccessTokenBinding | null {
  if (raw === null) return null;
  try {
    return parseHostAccessTokenBinding(JSON.parse(raw));
  } catch {
    return null;
  }
}

function contextKey(context: HostAccessTokenContext): string | null {
  if (
    !context.hostShell
    || context.surface === null
    || context.accountId === null
    || context.serverId === null
  ) {
    return null;
  }
  return `${context.surface}\u0000${context.accountId}\u0000${context.serverId}`;
}

export function hostAccessTokenSurfaceForPathname(
  pathname: string,
): HostAccessTokenSurface | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (/^(?:\/s\/[^/]+)?\/computers$/.test(normalized)) return "computers";
  const match = /^(?:\/s\/[^/]+)?\/settings\/(billing|applications|integrations|administration)$/.exec(normalized);
  if (!match) return null;
  if (match[1] === "billing") return "billing";
  if (match[1] === "applications" || match[1] === "integrations") return "marketplace";
  return "administration";
}

export function accessTokenSubject(accessToken: string | null): string | null {
  if (!accessToken) return null;
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(globalThis.atob(padded)) as { sub?: unknown; type?: unknown };
    return decoded.type === "access" && nonEmptyString(decoded.sub) ? decoded.sub : null;
  } catch {
    return null;
  }
}

/**
 * One document-level owner for native-host access-token rotations.
 *
 * The host injects the expected session/WebView binding at document start; this
 * listener latches it and never lets an event establish or retarget that trust.
 * The event carries only fence metadata. After exact binding validation, the
 * token itself is reread from current-origin storage. Rapid events coalesce into
 * one scheduled commit, and every commit revalidates the live account/server
 * context so logout, server switch, navigation, and page disposal fail closed.
 */
export function createHostAccessTokenSync(params: {
  eventTarget: EventTarget;
  expectedBinding: HostAccessTokenBinding | null;
  readContext: () => HostAccessTokenContext;
  readAccessToken: () => string | null;
  commitAccessOnlyToken: (accessToken: string) => void;
  schedule?: (task: () => void) => void;
}) {
  const schedule = params.schedule ?? queueMicrotask;
  const expectedBinding = params.expectedBinding === null ? null : { ...params.expectedBinding };
  let lastSequence = -1;
  let pending: PendingUpdate | null = null;
  let scheduled = false;
  let closed = false;

  const flush = () => {
    scheduled = false;
    const update = pending;
    pending = null;
    if (closed || update === null) return;

    const liveContext = params.readContext();
    if (contextKey(liveContext) !== update.contextKey) return;
    if (
      liveContext.accountId !== update.detail.accountId
      || liveContext.serverId !== update.detail.serverId
    ) {
      return;
    }
    params.commitAccessOnlyToken(update.accessToken);
  };

  const handleTokenUpdate = (event: Event) => {
    if (closed) return;
    const detail = parseHostAccessTokenEventDetail((event as CustomEvent<unknown>).detail);
    if (detail === null) return;
    if (
      expectedBinding === null
      || detail.accountId !== expectedBinding.accountId
      || detail.serverId !== expectedBinding.serverId
      || detail.sessionGeneration !== expectedBinding.sessionGeneration
      || detail.webViewGeneration !== expectedBinding.webViewGeneration
      || detail.sequence <= lastSequence
    ) {
      return;
    }

    const liveContext = params.readContext();
    const key = contextKey(liveContext);
    if (
      key === null
      || liveContext.accountId !== detail.accountId
      || liveContext.serverId !== detail.serverId
    ) {
      return;
    }
    const accessToken = params.readAccessToken();
    if (!nonEmptyString(accessToken)) return;

    lastSequence = detail.sequence;
    pending = { detail, accessToken, contextKey: key };
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    pending = null;
    params.eventTarget.removeEventListener(HOST_ACCESS_TOKEN_UPDATED_EVENT, handleTokenUpdate);
    params.eventTarget.removeEventListener("pagehide", close);
  };

  params.eventTarget.addEventListener(HOST_ACCESS_TOKEN_UPDATED_EVENT, handleTokenUpdate);
  params.eventTarget.addEventListener("pagehide", close, { once: true });

  return { close };
}
