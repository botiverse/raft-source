import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JSDOM } from "jsdom";
import {
  installDesktopServerTitleBinding,
  setDesktopServerTitle,
} from "../src/desktopServerTitle";
import type {
  TitleBindingDeps,
} from "../src/desktopServerTitle";

function withTitleMarker<T extends object>(host: T): T {
  Object.defineProperty(host, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
    value: Object.freeze({ "window.openServer": 1, "window.setServerTitle": 1 }),
    writable: false,
    configurable: false,
  });
  return host;
}

// Build injected document/MutationObserver deps from jsdom (no global writes).
function titleDeps(documentTitle: string): {
  deps: TitleBindingDeps;
  document: Document;
} {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${documentTitle}</title></head><body></body></html>`,
  );
  const document = dom.window.document;
  const MutationObserver = dom.window.MutationObserver as unknown as new (
    cb: (records: unknown[], observer: { observe: () => void; disconnect: () => void }) => void,
  ) => { observe: (t: Node, o: MutationObserverInit) => void; disconnect: () => void };
  return { deps: { document: document as never, MutationObserver: MutationObserver as never }, document };
}

const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Desktop server title binding", () => {
  test("sends the exact Web title with the exact native document identity", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const host = {
      __RAFT_DESKTOP_DOCUMENT__: { generation: 9, nonce: "document-nine" },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Readonly<Record<string, unknown>>) => {
          calls.push({ command, args });
          return { method: "window.setServerTitle", status: "ok", result: {} };
        },
      },
    };
    await setDesktopServerTitle("My Server | Raft", host);
    assert.deepEqual(calls, [{
      command: "window_set_server_title",
      args: { params: {
        documentGeneration: 9,
        documentNonce: "document-nine",
        title: "My Server | Raft",
      } },
    }]);
  });

  test("rejects an invalid title before any native invoke", async () => {
    let invokes = 0;
    const host = {
      __RAFT_DESKTOP_DOCUMENT__: { generation: 9, nonce: "document-nine" },
      __TAURI_INTERNALS__: { invoke: async () => { invokes += 1; } },
    };
    await assert.rejects(() => setDesktopServerTitle("My\u202eServer | Raft", host), /invalid-canonical-server-title/);
    await assert.rejects(() => setDesktopServerTitle("not suffixed", host), /invalid-canonical-server-title/);
    // An untrimmed title is rejected verbatim (never normalized to trimmed).
    await assert.rejects(() => setDesktopServerTitle("Raft ", host), /invalid-canonical-server-title/);
    assert.equal(invokes, 0);
  });

  test("browser mode never invokes (zero invoke)", async () => {
    let invokes = 0;
    const host = { __TAURI_INTERNALS__: { invoke: async () => { invokes += 1; } } };
    const { deps } = titleDeps("My Server | Raft");
    installDesktopServerTitleBinding(Promise.resolve({ mode: "browser" } as const), host, deps);
    await tick();
    assert.equal(invokes, 0);
  });

  test("desktop without the setServerTitle marker never invokes", async () => {
    let invokes = 0;
    const host = { __TAURI_INTERNALS__: { invoke: async () => { invokes += 1; } } };
    Object.defineProperty(host, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
      value: Object.freeze({ "window.openServer": 1 }),
      writable: false,
      configurable: false,
    });
    const { deps } = titleDeps("My Server | Raft");
    installDesktopServerTitleBinding(Promise.resolve({ mode: "desktop" } as const), host, deps);
    await tick();
    assert.equal(invokes, 0);
  });

  test("desktop with the marker mirrors document.title to the native title", async () => {
    const titles: string[] = [];
    const host = withTitleMarker({
      __RAFT_DESKTOP_DOCUMENT__: { generation: 3, nonce: "document-three" },
      __TAURI_INTERNALS__: {
        invoke: async (_c: string, args: Readonly<Record<string, unknown>>) => {
          titles.push((args as { params: { title: string } }).params.title);
          return { method: "window.setServerTitle", status: "ok", result: {} };
        },
      },
    });
    const { deps } = titleDeps("My Server | Raft");
    installDesktopServerTitleBinding(Promise.resolve({ mode: "desktop" } as const), host, deps);
    await tick(10);
    assert.deepEqual(titles, ["My Server | Raft"]);
  });

  test("coalesces fast server switches to the newest title", async () => {
    const titles: string[] = [];
    const host = withTitleMarker({
      __RAFT_DESKTOP_DOCUMENT__: { generation: 3, nonce: "document-three" },
      __TAURI_INTERNALS__: {
        invoke: async (_c: string, args: Readonly<Record<string, unknown>>) => {
          titles.push((args as { params: { title: string } }).params.title);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { method: "window.setServerTitle", status: "ok", result: {} };
        },
      },
    });
    const { deps, document } = titleDeps("First | Raft");
    installDesktopServerTitleBinding(Promise.resolve({ mode: "desktop" } as const), host, deps);
    await tick(2);
    document.title = "Second | Raft";
    document.title = "Third | Raft";
    await tick(30);
    assert.equal(titles[titles.length - 1], "Third | Raft");
  });

  test("rebinds when the whole <title> element is replaced", async () => {
    const titles: string[] = [];
    const host = withTitleMarker({
      __RAFT_DESKTOP_DOCUMENT__: { generation: 3, nonce: "document-three" },
      __TAURI_INTERNALS__: {
        invoke: async (_c: string, args: Readonly<Record<string, unknown>>) => {
          titles.push((args as { params: { title: string } }).params.title);
          return { method: "window.setServerTitle", status: "ok", result: {} };
        },
      },
    });
    const { deps, document } = titleDeps("First | Raft");
    installDesktopServerTitleBinding(Promise.resolve({ mode: "desktop" } as const), host, deps);
    await tick(10);
    // Replace the entire <title> element; the permanent head reconcile must
    // rebind to the new node rather than keep observing the detached one.
    const oldTitle = document.querySelector("title");
    const newTitle = document.createElement("title");
    newTitle.textContent = "Replaced | Raft";
    oldTitle?.replaceWith(newTitle);
    await tick(20);
    assert.equal(titles[titles.length - 1], "Replaced | Raft");
  });

  test("dispose during a pending handshake installs no observer", async () => {
    let invokes = 0;
    const host = withTitleMarker({
      __RAFT_DESKTOP_DOCUMENT__: { generation: 3, nonce: "document-three" },
      __TAURI_INTERNALS__: { invoke: async () => { invokes += 1; } },
    });
    const { deps, document } = titleDeps("My Server | Raft");
    // Wrap the injected MutationObserver to count instantiations, so a leaked
    // observer installed after disposal is detected (not just invokes).
    let observerInstances = 0;
    const RealMO = deps.MutationObserver as unknown as new (cb: unknown) => {
      observe: (t: Node, o: MutationObserverInit) => void;
      disconnect: () => void;
    };
    const CountingMO = function (cb: unknown) {
      observerInstances += 1;
      return new RealMO(cb);
    } as unknown as typeof RealMO;
    const countingDeps: TitleBindingDeps = { ...deps, MutationObserver: CountingMO as never };
    let resolveHandshake!: (value: { mode: "desktop" }) => void;
    const handshake = new Promise<{ mode: "desktop" }>((resolve) => { resolveHandshake = resolve; });
    const dispose = installDesktopServerTitleBinding(handshake, host, countingDeps);
    // Dispose while the handshake is still pending (no observer created yet).
    dispose();
    const instancesAtDispose = observerInstances;
    resolveHandshake({ mode: "desktop" });
    await tick(10);
    // No observer installed after disposal -> no invoke and no leaked observer.
    assert.equal(invokes, 0);
    assert.equal(observerInstances, instancesAtDispose);
    document.title = "Changed | Raft";
    await tick(10);
    assert.equal(invokes, 0);
    assert.equal(observerInstances, instancesAtDispose);
  });

  test("a rejected handshake stops quietly without invoking", async () => {
    let invokes = 0;
    const host = withTitleMarker({
      __RAFT_DESKTOP_DOCUMENT__: { generation: 3, nonce: "document-three" },
      __TAURI_INTERNALS__: { invoke: async () => { invokes += 1; } },
    });
    const { deps } = titleDeps("My Server | Raft");
    const handshake = Promise.reject(new Error("handshake failed")) as Promise<{ mode: "desktop" }>;
    installDesktopServerTitleBinding(handshake, host, deps);
    await tick(10);
    assert.equal(invokes, 0);
  });
});
