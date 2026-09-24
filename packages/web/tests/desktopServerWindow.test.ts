import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  bindDesktopServerWindow,
  installDesktopServerWindowBinding,
  openDesktopServerWindow,
} from "../src/desktopServerWindow";

function withNativeOpenMarker<T extends object>(host: T): T {
  Object.defineProperty(host, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
    value: Object.freeze({ "window.openServer": 1 }),
    writable: false,
    configurable: false,
  });
  return host;
}

describe("Desktop Server window binding", () => {
  test("sends only the canonical server identity and exact native document identity", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const host = {
      __RAFT_DESKTOP_DOCUMENT__: { generation: 9, nonce: "document-nine" },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Readonly<Record<string, unknown>>) => {
          calls.push({ command, args });
          return {
            method: "window.bindServer",
            status: "ok",
            result: {
              serverId: "550e8400-e29b-41d4-a716-446655440000",
              disposition: "bound",
            },
          };
        },
      },
    };
    await bindDesktopServerWindow("550e8400-e29b-41d4-a716-446655440000", host);
    assert.deepEqual(calls, [{
      command: "window_bind_server",
      args: { params: {
        serverId: "550e8400-e29b-41d4-a716-446655440000",
        documentGeneration: 9,
        documentNonce: "document-nine",
      } },
    }]);
  });

  test("rejects a slug before native invoke", async () => {
    let invokes = 0;
    const host = {
      __RAFT_DESKTOP_DOCUMENT__: { generation: 9, nonce: "document-nine" },
      __TAURI_INTERNALS__: { invoke: async () => { invokes += 1; } },
    };
    await assert.rejects(() => bindDesktopServerWindow("botiverse", host), /canonical server identity/);
    assert.equal(invokes, 0);
  });

  test("opens through typed native IPC without accepting renderer routing fields", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const host = withNativeOpenMarker({
      __RAFT_DESKTOP_DOCUMENT__: { generation: 11, nonce: "document-eleven" },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Readonly<Record<string, unknown>>) => {
          calls.push({ command, args });
          return {
            method: "window.openServer",
            status: "ok",
            result: {
              serverId: "550e8400-e29b-41d4-a716-446655440001",
              disposition: "opened",
            },
          };
        },
      },
    });
    installDesktopServerWindowBinding(
      Promise.resolve({ mode: "desktop" } as const),
      host,
      { currentServerId: () => null, subscribe: () => () => {} },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const response = await openDesktopServerWindow(
      "550e8400-e29b-41d4-a716-446655440001",
      host,
    );
    assert.equal(response.result.disposition, "opened");
    assert.deepEqual(calls, [{
      command: "window_open_server",
      args: { params: {
        serverId: "550e8400-e29b-41d4-a716-446655440001",
        documentGeneration: 11,
        documentNonce: "document-eleven",
      } },
    }]);
  });

  test("rejects a slug before native open invoke", async () => {
    let invokes = 0;
    const host = withNativeOpenMarker({
      __RAFT_DESKTOP_DOCUMENT__: { generation: 9, nonce: "document-nine" },
      __TAURI_INTERNALS__: { invoke: async () => { invokes += 1; } },
    });
    installDesktopServerWindowBinding(
      Promise.resolve({ mode: "desktop" } as const),
      host,
      { currentServerId: () => null, subscribe: () => () => {} },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await assert.rejects(() => openDesktopServerWindow("botiverse", host), /canonical server identity/);
    assert.equal(invokes, 0);
  });

  test("preserves parent-native bind bytes and treats an absent open extension as unsupported", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const host = {
      __RAFT_DESKTOP_DOCUMENT__: { generation: 7, nonce: "parent-compatible" },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args });
          return {
            method: "window.bindServer",
            status: "ok",
            result: {
              serverId: "550e8400-e29b-41d4-a716-446655440000",
              disposition: "bound",
            },
          };
        },
      },
    };
    await bindDesktopServerWindow("550e8400-e29b-41d4-a716-446655440000", host);
    assert.deepEqual(calls[0], {
      command: "window_bind_server",
      args: { params: {
        serverId: "550e8400-e29b-41d4-a716-446655440000",
        documentGeneration: 7,
        documentNonce: "parent-compatible",
      } },
    });
    await assert.rejects(
      () => openDesktopServerWindow("550e8400-e29b-41d4-a716-446655440000", host),
      /extension unavailable/,
    );
    assert.equal(calls.length, 1, "old native must never receive the successor command");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const desktopHandshake = Promise.resolve({ mode: "desktop" } as const);
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const bound = (serverId: string) =>
  ({
    method: "window.bindServer",
    status: "ok",
    result: { serverId, disposition: "bound" },
  }) as const;

test("binding drain converges rapid A → B → A to the final desired native owner", async () => {
  let current = "A";
  let listener: ((id: string) => void) | undefined;
  const source = {
    currentServerId: () => current,
    subscribe: (next: (id: string) => void) => {
      listener = next;
      return () => {};
    },
  };
  const b = deferred<void>();
  const calls: string[] = [];
  let nativeOwner: string | null = null;
  const bind = async (id: string) => {
    calls.push(id);
    if (id === "B") await b.promise;
    nativeOwner = id;
    return bound(id);
  };
  installDesktopServerWindowBinding(desktopHandshake, globalThis, source, bind);
  await turn();
  current = "B";
  listener?.(current);
  await turn();
  current = "A";
  listener?.(current);
  b.resolve();
  await turn();
  assert.deepEqual(calls, ["A", "B", "A"]);
  assert.equal(nativeOwner, source.currentServerId());
});

test("failed binding retains desired identity and retries on later store convergence", async () => {
  let current = "A";
  let listener: ((id: string) => void) | undefined;
  const source = {
    currentServerId: () => current,
    subscribe: (next: (id: string) => void) => {
      listener = next;
      return () => {};
    },
  };
  const calls: string[] = [];
  let nativeOwner: string | null = null;
  let failB = true;
  const bind = async (id: string) => {
    calls.push(id);
    if (id === "B" && failB) throw new Error("injected B failure");
    nativeOwner = id;
    return bound(id);
  };
  installDesktopServerWindowBinding(desktopHandshake, globalThis, source, bind);
  await turn();
  current = "B";
  listener?.(current);
  await turn();
  failB = false;
  listener?.(current);
  await turn();
  assert.deepEqual(calls, ["A", "B", "B"]);
  assert.equal(nativeOwner, source.currentServerId());
});
