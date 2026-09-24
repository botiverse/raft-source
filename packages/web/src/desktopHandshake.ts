import { CAPABILITY_IDS } from "@raft/desktop-contract/capabilities";
import {
  validateIpcRequest,
  validateIpcResponse,
} from "@raft/desktop-contract/ipc";
import type {
  DesktopHandshakeRequest,
  DesktopHandshakeOk,
} from "@raft/desktop-contract/ipc";
import {
  FRONTEND_RELEASE_IDENTITY,
} from "./buildIdentity";
import type {
  FrontendReleaseIdentity,
} from "./buildIdentity";
import {
  DESKTOP_RUNTIME_ENVIRONMENT,
  readDesktopRuntimeEnvironment,
} from "./desktopRuntimeEnvironment";
import type {
  DesktopRuntimeEnvironment,
} from "./desktopRuntimeEnvironment";
import { createIntl, createIntlCache } from "react-intl";
import { DEFAULT_LOCALE, resolveInitialLocale } from "./i18n/locale";
import { mergedMessages } from "./i18n/messages";

const desktopHandshakeIntlCache = createIntlCache();

function desktopHandshakeFormatMessage() {
  const locale = typeof window === "undefined"
    ? DEFAULT_LOCALE
    : resolveInitialLocale({
      storage: window.localStorage,
      languages: window.navigator?.languages,
      search: window.location?.search,
    });
  return createIntl(
    { locale, defaultLocale: DEFAULT_LOCALE, messages: mergedMessages(locale) },
    desktopHandshakeIntlCache,
  ).formatMessage;
}

const DESKTOP_HANDSHAKE_COMMAND = "desktop_handshake";
const DESKTOP_PROTOCOL_VERSION = 1;
export const DESKTOP_DOCUMENT_READY_EVENT = "raft:desktop-document-ready";
export const DESKTOP_OPEN_SERVER_CAPABILITY = "window.openServer";
export const DESKTOP_OPEN_SERVER_CAPABILITY_VERSION = 1 as const;
export const DESKTOP_SET_SERVER_TITLE_CAPABILITY = "window.setServerTitle";
export const DESKTOP_SET_SERVER_TITLE_CAPABILITY_VERSION = 1 as const;

/**
 * The closed set of native extension keys this Web build understands. The
 * marker is only accepted when every advertised key is in this set, so an
 * unknown future extension cannot negotiate anything here.
 */
const KNOWN_NATIVE_EXTENSIONS: readonly string[] = [
  DESKTOP_OPEN_SERVER_CAPABILITY,
  DESKTOP_SET_SERVER_TITLE_CAPABILITY,
];

export type DesktopDocumentIdentity = Readonly<{
  generation: number;
  nonce: string;
}>;

export type DesktopInvoke = (
  command: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

type DesktopBridgeHost = {
  __TAURI_INTERNALS__?: {
    invoke?: DesktopInvoke;
  };
  __RAFT_DESKTOP_DOCUMENT__?: unknown;
  __RAFT_DESKTOP_ENVIRONMENT__?: unknown;
  __RAFT_DESKTOP_NATIVE_EXTENSIONS__?: unknown;
  addEventListener?: (
    type: string,
    listener: (event: Event) => void,
    options?: AddEventListenerOptions | boolean,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: (event: Event) => void,
  ) => void;
};

export type DesktopHandshakeBootstrapResult =
  | { mode: "browser" }
  | { mode: "desktop"; response: DesktopHandshakeOk };

/**
 * Build the shared, closed handshake envelope from the frozen module identity.
 * Mutable window globals and DOM datasets are observability mirrors only and
 * are deliberately not accepted as identity inputs here.
 */
export function createDesktopHandshakeRequest(
  documentIdentity: DesktopDocumentIdentity,
  identity: FrontendReleaseIdentity = FRONTEND_RELEASE_IDENTITY,
  environment: DesktopRuntimeEnvironment | null = DESKTOP_RUNTIME_ENVIRONMENT,
  openServerCapabilityVersion: 1 | null = null,
): DesktopHandshakeRequest {
  if (!environment) {
    throw new Error("desktop bridge did not expose a valid native environment");
  }
  const request: DesktopHandshakeRequest = {
    method: "desktop.handshake",
    version: 1,
    params: {
      // Exact-404 Minimum Desktop is deliberately usable by a Web build that
      // predates Desktop release metadata. Native ignores this sentinel in
      // Minimum and never treats it as a Full manifest identity.
      frontendReleaseId: identity.releaseId ?? "unadapted",
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      capabilities: [...CAPABILITY_IDS],
      documentGeneration: documentIdentity.generation,
      documentNonce: documentIdentity.nonce,
      environmentId: environment.environmentId,
      environmentGeneration: environment.generation,
    },
  };
  if (openServerCapabilityVersion === DESKTOP_OPEN_SERVER_CAPABILITY_VERSION) {
    request.params.openServerCapabilityAck = openServerCapabilityVersion;
  }
  if (!validateIpcRequest(request)) {
    throw new Error("desktop handshake request violates the shared IPC contract");
  }
  return request;
}

export async function performDesktopHandshake(
  invoke: DesktopInvoke,
  documentIdentity: DesktopDocumentIdentity,
  identity: FrontendReleaseIdentity = FRONTEND_RELEASE_IDENTITY,
  environment: DesktopRuntimeEnvironment | null = DESKTOP_RUNTIME_ENVIRONMENT,
  openServerCapabilityVersion: 1 | null = null,
): Promise<DesktopHandshakeOk> {
  const request = createDesktopHandshakeRequest(
    documentIdentity,
    identity,
    environment,
    openServerCapabilityVersion,
  );
  const rawResponse = await invoke(DESKTOP_HANDSHAKE_COMMAND, {
    params: request.params,
  });

  if (
    !validateIpcResponse(rawResponse) ||
    rawResponse.method !== request.method
  ) {
    throw new Error("desktop handshake response violates the shared IPC contract");
  }
  if (rawResponse.status === "error") {
    throw new Error(
      `desktop handshake failed: ${rawResponse.error.code}: ${rawResponse.error.message}`,
    );
  }
  if (rawResponse.result.documentGeneration !== documentIdentity.generation) {
    throw new Error(
      "desktop handshake acknowledged a different document generation",
    );
  }
  if (
    !environment ||
    rawResponse.result.environmentId !== environment.environmentId ||
    rawResponse.result.environmentGeneration !== environment.generation
  ) {
    throw new Error(
      "desktop handshake acknowledged a different environment generation",
    );
  }
  return rawResponse as DesktopHandshakeOk;
}

/**
 * Accept only the native document-start marker: an exact frozen version map
 * held by a non-writable, non-configurable global property. Ordinary page
 * assignment and the predecessor shell's absent marker cannot negotiate any
 * extension. The new parser accepts the closed subset
 * `{ window.openServer?, window.setServerTitle? }`; the predecessor parser
 * required exactly one key, so reading a two-key marker degrades openServer
 * there rather than negotiating it.
 */
function readNativeExtensionsMarker(
  host: DesktopBridgeHost,
): Record<string, unknown> | null {
  const descriptor = Object.getOwnPropertyDescriptor(
    host,
    "__RAFT_DESKTOP_NATIVE_EXTENSIONS__",
  );
  if (
    !descriptor ||
    descriptor.writable !== false ||
    descriptor.configurable !== false ||
    !("value" in descriptor)
  ) {
    return null;
  }
  const marker = descriptor.value;
  if (
    typeof marker !== "object" ||
    marker === null ||
    Array.isArray(marker) ||
    !Object.isFrozen(marker)
  ) {
    return null;
  }
  const record = marker as Record<string, unknown>;
  // Closed subset over own keys (including symbols): reject any symbol own-key
  // outright and any string own-key outside the known extension set.
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !KNOWN_NATIVE_EXTENSIONS.includes(key)) return null;
  }
  return record;
}

export function readDesktopOpenServerCapabilityVersion(
  host: DesktopBridgeHost,
): 1 | null {
  const record = readNativeExtensionsMarker(host);
  if (!record) return null;
  return record[DESKTOP_OPEN_SERVER_CAPABILITY] ===
    DESKTOP_OPEN_SERVER_CAPABILITY_VERSION
    ? DESKTOP_OPEN_SERVER_CAPABILITY_VERSION
    : null;
}

export function readDesktopSetServerTitleCapabilityVersion(
  host: DesktopBridgeHost,
): 1 | null {
  const record = readNativeExtensionsMarker(host);
  if (!record) return null;
  return record[DESKTOP_SET_SERVER_TITLE_CAPABILITY] ===
    DESKTOP_SET_SERVER_TITLE_CAPABILITY_VERSION
    ? DESKTOP_SET_SERVER_TITLE_CAPABILITY_VERSION
    : null;
}

function parseDesktopDocumentIdentity(
  value: unknown,
): DesktopDocumentIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "generation,nonce" ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    typeof record.nonce !== "string" ||
    record.nonce.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    generation: record.generation as number,
    nonce: record.nonce,
  });
}

/**
 * Wait for native Finished to issue the identity for this exact top-level
 * document. A stale renderer retains only its old nonce, so a delayed invoke
 * cannot grant privilege to the replacement generation.
 */
export function waitForDesktopDocumentIdentity(
  host: DesktopBridgeHost,
): Promise<DesktopDocumentIdentity> {
  const existing = parseDesktopDocumentIdentity(
    host.__RAFT_DESKTOP_DOCUMENT__,
  );
  if (existing) return Promise.resolve(existing);

  if (typeof host.addEventListener !== "function") {
    return Promise.reject(
      new Error("desktop bridge did not expose a document lifecycle channel"),
    );
  }

  return new Promise((resolve, reject) => {
    const onDocumentReady = (event: Event) => {
      const parsed = parseDesktopDocumentIdentity(
        (event as CustomEvent<unknown>).detail,
      );
      host.removeEventListener?.(
        DESKTOP_DOCUMENT_READY_EVENT,
        onDocumentReady,
      );
      if (!parsed) {
        reject(new Error("desktop document identity is invalid"));
        return;
      }
      resolve(parsed);
    };
    host.addEventListener?.(
      DESKTOP_DOCUMENT_READY_EVENT,
      onDocumentReady,
      { once: true },
    );
  });
}

/**
 * Browser/PWA has no Tauri bridge and therefore performs zero invokes. The
 * bridge probe is isolated from identity construction so native identity can
 * never be sourced from mutable runtime state.
 */
export async function bootstrapDesktopHandshake(
  host: DesktopBridgeHost = globalThis as DesktopBridgeHost,
  identity: FrontendReleaseIdentity = FRONTEND_RELEASE_IDENTITY,
): Promise<DesktopHandshakeBootstrapResult> {
  const invoke = host.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") {
    return { mode: "browser" };
  }

  const documentIdentity = await waitForDesktopDocumentIdentity(host);
  const environment = readDesktopRuntimeEnvironment(host);
  const openServerCapabilityVersion = readDesktopOpenServerCapabilityVersion(host);

  return {
    mode: "desktop",
    response: await performDesktopHandshake(
      invoke.bind(host.__TAURI_INTERNALS__),
      documentIdentity,
      identity,
      environment,
      openServerCapabilityVersion,
    ),
  };
}

/**
 * Keep a failed Desktop document visibly fail-closed while native closes it and
 * routes to Recovery. Browser/PWA never calls this because it performs no
 * handshake. The user-facing copy intentionally excludes raw native errors.
 */
export function renderDesktopHandshakeRecovery(
  documentTarget: Document = document,
): void {
  const render = () => {
    if (!documentTarget.body) return;
    documentTarget.documentElement.dataset.raftDesktopCompatibility =
      "recovery";
    documentTarget.getElementById("raft-desktop-handshake-recovery")?.remove();

    const surface = documentTarget.createElement("section");
    surface.id = "raft-desktop-handshake-recovery";
    surface.setAttribute("role", "alert");
    surface.setAttribute("aria-live", "assertive");
    surface.style.cssText =
      "min-height:100vh;box-sizing:border-box;padding:32px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;font-family:system-ui,sans-serif;background:#fff8e1;color:#111";

    const formatMessage = desktopHandshakeFormatMessage();
    const title = documentTarget.createElement("h1");
    title.textContent = formatMessage({ id: "desktop.handshake.recoverTitle" });
    const message = documentTarget.createElement("p");
    message.textContent = formatMessage({ id: "desktop.handshake.recoverBody" });
    surface.append(title, message);
    // Do not leave the application interactive behind a warning. Native will
    // close this renderer, but the Web side independently replaces the active
    // document with a terminal recovery surface first.
    documentTarget.body.replaceChildren(surface);
  };

  if (documentTarget.body) {
    render();
  } else {
    documentTarget.addEventListener("DOMContentLoaded", render, { once: true });
  }
}
