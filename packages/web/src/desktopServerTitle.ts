import {
  validateIpcRequest,
  validateIpcResponse,
} from "@raft/desktop-contract/ipc";
import type {
  WindowSetServerTitleOk,
  WindowSetServerTitleRequest,
} from "@raft/desktop-contract/ipc";
import {
  DESKTOP_SET_SERVER_TITLE_CAPABILITY_VERSION,
  readDesktopSetServerTitleCapabilityVersion,
  waitForDesktopDocumentIdentity,
} from "./desktopHandshake";
import type {
  DesktopHandshakeBootstrapResult,
  DesktopInvoke,
} from "./desktopHandshake";

type DesktopHost = typeof globalThis & {
  __TAURI_INTERNALS__?: { invoke?: DesktopInvoke };
  __RAFT_DESKTOP_NATIVE_EXTENSIONS__?: unknown;
};

type SetServerTitle = (title: string, host: DesktopHost) => Promise<WindowSetServerTitleOk>;

type MinimalMutationObserver = {
  observe: (target: Node, options: MutationObserverInit) => void;
  disconnect: () => void;
};
type MutationObserverCtor = new (
  callback: (records: unknown[], observer: MinimalMutationObserver) => void,
) => MinimalMutationObserver;
type MinimalDocument = {
  title: string;
  head: Node;
  querySelector: (selectors: string) => Element | null;
};

/**
 * Dependencies for the title binding. `document`/`MutationObserver` are
 * injected (preferred from the host) so tests never overwrite globals; in
 * production they default to the ambient globals.
 */
export type TitleBindingDeps = {
  document?: MinimalDocument;
  MutationObserver?: MutationObserverCtor;
  setTitle?: SetServerTitle;
};

/**
 * Invoke the optional native `window.setServerTitle` extension with the exact
 * Web-computed title and the native-issued document identity. Mirrors the
 * out-of-band `window.openServer` extension: it is only negotiated when the
 * shell advertises `window.setServerTitle` v1, and never on browser/PWA. The
 * title is sent verbatim; the shared validator rejects an invalid title before
 * any invoke. Errors are fixed codes (no raw underlying strings).
 */
export async function setDesktopServerTitle(
  title: string,
  host: DesktopHost = globalThis as DesktopHost,
): Promise<WindowSetServerTitleOk> {
  const invoke = host.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") throw new Error("desktop-bridge-unavailable");
  const documentIdentity = await waitForDesktopDocumentIdentity(host);
  const request: WindowSetServerTitleRequest = {
    method: "window.setServerTitle",
    version: 1,
    params: {
      documentGeneration: documentIdentity.generation,
      documentNonce: documentIdentity.nonce,
      title,
    },
  };
  if (!validateIpcRequest(request)) throw new Error("invalid-canonical-server-title");
  const response = await invoke.call(host.__TAURI_INTERNALS__, "window_set_server_title", {
    params: request.params,
  });
  if (!validateIpcResponse(response) || response.method !== request.method) {
    throw new Error("invalid-set-server-title-response");
  }
  if (response.status === "error") throw new Error(response.error.code);
  return response as WindowSetServerTitleOk;
}

/**
 * Observe the document title (the single source of title bytes). Permanently
 * reconciles `head` so a whole-title-element replacement rebinds to the current
 * `<title>` instead of keeping a detached node observed.
 */
function observeDocumentTitle(
  doc: MinimalDocument,
  MutationObserver: MutationObserverCtor,
  onChange: () => void,
): () => void {
  let titleObserver: MinimalMutationObserver | null = null;
  let observedTitle: Element | null = null;

  const bindTitle = () => {
    const titleElement = doc.querySelector("title");
    if (titleElement === observedTitle) return;
    titleObserver?.disconnect();
    observedTitle = titleElement;
    if (titleElement) {
      titleObserver = new MutationObserver(onChange);
      titleObserver.observe(titleElement, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      onChange();
    }
  };

  const headObserver = new MutationObserver(bindTitle);
  headObserver.observe(doc.head, { childList: true });
  bindTitle();

  return () => {
    headObserver.disconnect();
    titleObserver?.disconnect();
  };
}

/**
 * Install the desktop server-title binding for this window. The title bytes
 * come solely from `document.title` (computed by browserDocumentTitle.ts) and
 * are sent verbatim (never normalized); the shared validator rejects an invalid
 * title before any invoke. The binding mirrors the title to the native window
 * title only after the desktop handshake succeeds and the shell advertises
 * `window.setServerTitle` v1. Fast server switches coalesce to the newest title
 * (desired/version drain); same-name renames update naturally; multi-window
 * isolation is inherent because each window mirrors its own document.title to
 * its own native title. Browser/PWA never invoke (handshake mode !== desktop,
 * or no marker). A handshake rejection stops quietly (fixed error, no raw
 * object); disposal during a pending handshake is honored after the await.
 */
export function installDesktopServerTitleBinding(
  handshake: Promise<DesktopHandshakeBootstrapResult>,
  host: DesktopHost = globalThis as DesktopHost,
  deps: TitleBindingDeps = {},
): () => void {
  const ambient = globalThis as {
    document?: MinimalDocument;
    MutationObserver?: MutationObserverCtor;
  };
  const doc = deps.document ?? (host as { document?: MinimalDocument }).document ?? ambient.document;
  const MutationObserver =
    deps.MutationObserver ??
    (host as { MutationObserver?: MutationObserverCtor }).MutationObserver ??
    ambient.MutationObserver;
  const setTitle = deps.setTitle ?? setDesktopServerTitle;

  let desiredTitle: string | null = null;
  let committedTitle: string | null = null;
  let desiredVersion = 0;
  let draining = false;
  let disposed = false;
  let unobserve: (() => void) | null = null;

  const setDesired = (title: string | null | undefined) => {
    // Preserve exact bytes; never normalize. An invalid (e.g. untrimmed) title
    // is rejected by the shared validator before any invoke (zero invoke).
    const next = title ?? null;
    if (next !== desiredTitle || next !== committedTitle) {
      desiredTitle = next;
      desiredVersion += 1;
    }
    void drain();
  };

  const drain = async () => {
    if (draining || disposed) return;
    draining = true;
    try {
      let result: DesktopHandshakeBootstrapResult;
      try {
        result = await handshake;
      } catch {
        // Handshake rejected: stop quietly (fixed error, no raw object).
        return;
      }
      // Honor disposal that happened while the handshake was pending.
      if (disposed) return;
      if (result.mode !== "desktop") return;
      if (
        readDesktopSetServerTitleCapabilityVersion(host) !==
        DESKTOP_SET_SERVER_TITLE_CAPABILITY_VERSION
      ) {
        return;
      }
      if (!doc || !MutationObserver) return;
      if (!unobserve) {
        unobserve = observeDocumentTitle(doc, MutationObserver, () => setDesired(doc.title));
        setDesired(doc.title);
      }
      while (!disposed && desiredTitle && desiredTitle !== committedTitle) {
        const target = desiredTitle;
        const attemptVersion = desiredVersion;
        try {
          await setTitle(target, host);
          committedTitle = target;
        } catch {
          // Fixed error; converge to the newest value if the title changed while
          // this attempt was in flight, otherwise stop (no raw object logged).
          if (attemptVersion === desiredVersion) break;
        }
      }
    } finally {
      draining = false;
    }
  };

  void drain();
  return () => {
    disposed = true;
    unobserve?.();
  };
}
