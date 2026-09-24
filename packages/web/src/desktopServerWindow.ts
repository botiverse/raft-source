import {
  validateIpcRequest,
  validateIpcResponse,
} from "@raft/desktop-contract/ipc";
import type {
  WindowBindServerOk,
  WindowBindServerRequest,
  WindowOpenServerOk,
  WindowOpenServerRequest,
} from "@raft/desktop-contract/ipc";
import {
  DESKTOP_OPEN_SERVER_CAPABILITY_VERSION,
  readDesktopOpenServerCapabilityVersion,
  waitForDesktopDocumentIdentity,
} from "./desktopHandshake";
import type {
  DesktopHandshakeBootstrapResult,
  DesktopInvoke,
} from "./desktopHandshake";
import { useServerStore } from "./store/serverStore";

type DesktopHost = typeof globalThis & {
  __TAURI_INTERNALS__?: { invoke?: DesktopInvoke };
  __RAFT_DESKTOP_NATIVE_EXTENSIONS__?: unknown;
};

const negotiatedOpenHosts = new WeakSet<object>();

function advertisesDesktopServerWindowOpen(host: DesktopHost): boolean {
  return readDesktopOpenServerCapabilityVersion(host) ===
    DESKTOP_OPEN_SERVER_CAPABILITY_VERSION;
}

type ServerBindingSource = Readonly<{
  currentServerId(): string | null | undefined;
  subscribe(listener: (serverId: string | null | undefined) => void): () => void;
}>;

type BindServer = (serverId: string, host: DesktopHost) => Promise<WindowBindServerOk>;

const defaultServerBindingSource: ServerBindingSource = {
  currentServerId: () => useServerStore.getState().current?.id,
  subscribe: (listener) => useServerStore.subscribe((state) => listener(state.current?.id)),
};

export async function bindDesktopServerWindow(
  serverId: string,
  host: DesktopHost = globalThis as DesktopHost,
): Promise<WindowBindServerOk> {
  const invoke = host.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") throw new Error("Desktop bridge unavailable");
  const documentIdentity = await waitForDesktopDocumentIdentity(host);
  const request: WindowBindServerRequest = {
    method: "window.bindServer",
    version: 1,
    params: {
      serverId,
      documentGeneration: documentIdentity.generation,
      documentNonce: documentIdentity.nonce,
    },
  };
  if (!validateIpcRequest(request)) throw new Error("invalid canonical server identity");
  const response = await invoke.call(host.__TAURI_INTERNALS__, "window_bind_server", {
    params: request.params,
  });
  if (!validateIpcResponse(response) || response.method !== request.method) {
    throw new Error("window.bindServer returned an invalid response");
  }
  if (response.status === "error") throw new Error(response.error.code);
  return response as WindowBindServerOk;
}

export function isDesktopServerWindowHost(
  host: DesktopHost = globalThis as DesktopHost,
): boolean {
  return typeof host.__TAURI_INTERNALS__?.invoke === "function";
}

export function supportsDesktopServerWindowOpen(
  host: DesktopHost = globalThis as DesktopHost,
): boolean {
  return isDesktopServerWindowHost(host) &&
    advertisesDesktopServerWindowOpen(host) &&
    negotiatedOpenHosts.has(host);
}

export async function openDesktopServerWindow(
  serverId: string,
  host: DesktopHost = globalThis as DesktopHost,
): Promise<WindowOpenServerOk> {
  const invoke = host.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function" || !supportsDesktopServerWindowOpen(host)) {
    throw new Error("Desktop Server-window extension unavailable");
  }
  const documentIdentity = await waitForDesktopDocumentIdentity(host);
  const request: WindowOpenServerRequest = {
    method: "window.openServer",
    version: 1,
    params: {
      serverId,
      documentGeneration: documentIdentity.generation,
      documentNonce: documentIdentity.nonce,
    },
  };
  if (!validateIpcRequest(request)) throw new Error("invalid canonical server identity");
  const response = await invoke.call(host.__TAURI_INTERNALS__, "window_open_server", { params: request.params });
  if (!validateIpcResponse(response) || response.method !== request.method || response.status === "error") {
    throw new Error("window.openServer failed");
  }
  return response as WindowOpenServerOk;
}

export function installDesktopServerWindowBinding(
  handshake: Promise<DesktopHandshakeBootstrapResult>,
  host: DesktopHost = globalThis as DesktopHost,
  source: ServerBindingSource = defaultServerBindingSource,
  bindServer: BindServer = bindDesktopServerWindow,
): () => void {
  let desiredServerId: string | null = null;
  let committedServerId: string | null = null;
  let desiredVersion = 0;
  let draining = false;
  let disposed = false;

  const drain = async () => {
    if (draining || disposed) return;
    draining = true;
    try {
      const result = await handshake;
      if (result.mode !== "desktop") return;
      if (advertisesDesktopServerWindowOpen(host)) negotiatedOpenHosts.add(host);
      while (!disposed && desiredServerId && desiredServerId !== committedServerId) {
        const target = desiredServerId;
        const attemptVersion = desiredVersion;
        try {
          await bindServer(target, host);
          committedServerId = target;
        } catch (error) {
          console.error("[Raft Desktop] server-window bind failed", error);
          // If the desired identity changed while this attempt was in flight,
          // immediately converge to the newest value. Otherwise retain the
          // uncommitted desired value for a later store event retry.
          if (attemptVersion === desiredVersion) break;
        }
      }
    } finally {
      draining = false;
    }
  };

  const setDesired = (serverId: string | null | undefined) => {
    const next = serverId || null;
    if (next !== desiredServerId || next !== committedServerId) {
      desiredServerId = next;
      desiredVersion += 1;
    }
    void drain();
  };

  setDesired(source.currentServerId());
  const unsubscribe = source.subscribe(setDesired);
  return () => {
    disposed = true;
    unsubscribe();
  };
}
