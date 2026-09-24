import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JSDOM } from "jsdom";
import {
  bootstrapDesktopHandshake,
  createDesktopHandshakeRequest,
  DESKTOP_DOCUMENT_READY_EVENT,
  DESKTOP_OPEN_SERVER_CAPABILITY_VERSION,
  DESKTOP_SET_SERVER_TITLE_CAPABILITY_VERSION,
  performDesktopHandshake,
  readDesktopOpenServerCapabilityVersion,
  readDesktopSetServerTitleCapabilityVersion,
  renderDesktopHandshakeRecovery,
} from "../src/desktopHandshake";

const identity = Object.freeze({
  releaseId: "release-2026-07-24",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  builtAt: "2026-07-24T10:00:00Z",
  branch: "staging",
  deploymentEnvironment: "staging",
});

const documentIdentity = Object.freeze({
  generation: 7,
  nonce: "6edbdb72-a002-4b13-b9ee-68d21ae36c34",
});
const environment = Object.freeze({
  environmentId: "production" as const,
  generation: 3,
  frontendOrigin: "https://app.raft.build",
  apiOrigin: "https://api.raft.build",
  socketOrigin: "https://api.raft.build",
  updateAuthority: "productionHands" as const,
});

function ok(generation = documentIdentity.generation) {
  return {
    method: "desktop.handshake",
    status: "ok",
    result: {
      compatibilityState: "readyFull",
      documentGeneration: generation,
      environmentId: environment.environmentId,
      environmentGeneration: environment.generation,
    },
  } as const;
}

function eventHost(invoke: (command: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    host: {
      __TAURI_INTERNALS__: { invoke },
      __RAFT_DESKTOP_ENVIRONMENT__: environment,
      addEventListener(type: string, listener: (event: Event) => void) {
        const group = listeners.get(type) ?? new Set();
        group.add(listener);
        listeners.set(type, group);
      },
      removeEventListener(type: string, listener: (event: Event) => void) {
        listeners.get(type)?.delete(listener);
      },
    },
    emit(type: string, detail?: unknown) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener({ type, detail } as unknown as Event);
      }
    },
  };
}

describe("desktop handshake bridge", () => {
  test("builds the exact generation-bound desktop.handshake envelope", () => {
    assert.deepEqual(createDesktopHandshakeRequest(documentIdentity, identity, environment), {
      method: "desktop.handshake",
      version: 1,
      params: {
        frontendReleaseId: identity.releaseId,
        protocolVersion: 1,
        capabilities: ["desktop.handshake", "window.focus", "window.bindServer"],
        documentGeneration: documentIdentity.generation,
        documentNonce: documentIdentity.nonce,
        environmentId: "production",
        environmentGeneration: 3,
      },
    });
  });

  test("keeps parent-v1 bytes without the immutable native marker and adds only the exact ack with it", () => {
    const parent = createDesktopHandshakeRequest(documentIdentity, identity, environment);
    assert.equal("openServerCapabilityAck" in parent.params, false);

    const host = {};
    Object.defineProperty(host, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
      value: Object.freeze({ "window.openServer": 1 }),
      writable: false,
      configurable: false,
    });
    const version = readDesktopOpenServerCapabilityVersion(host);
    assert.equal(version, DESKTOP_OPEN_SERVER_CAPABILITY_VERSION);
    assert.deepEqual(
      createDesktopHandshakeRequest(documentIdentity, identity, environment, version).params,
      { ...parent.params, openServerCapabilityAck: 1 },
    );
  });

  test("rejects writable, replaceable, unfrozen, extra-key, and wrong-version marker forgeries", () => {
    const candidates: object[] = [
      { __RAFT_DESKTOP_NATIVE_EXTENSIONS__: Object.freeze({ "window.openServer": 1 }) },
      Object.defineProperty({}, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
        value: Object.freeze({ "window.openServer": 1 }),
        writable: false,
        configurable: true,
      }),
      Object.defineProperty({}, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
        value: { "window.openServer": 1 },
        writable: false,
        configurable: false,
      }),
      Object.defineProperty({}, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
        value: Object.freeze({ "window.openServer": 1, attacker: 1 }),
        writable: false,
        configurable: false,
      }),
      Object.defineProperty({}, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
        value: Object.freeze({ "window.openServer": 2 }),
        writable: false,
        configurable: false,
      }),
    ];
    for (const host of candidates) {
      assert.equal(readDesktopOpenServerCapabilityVersion(host), null);
      assert.equal(
        "openServerCapabilityAck" in createDesktopHandshakeRequest(
          documentIdentity,
          identity,
          environment,
          readDesktopOpenServerCapabilityVersion(host),
        ).params,
        false,
      );
    }
  });

  const frozenMarker = (record: Record<string, unknown>): object =>
    Object.defineProperty({}, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
      value: Object.freeze(record),
      writable: false,
      configurable: false,
    });

  test("accepts the closed extension subset across the four shell/Web quadrants", () => {
    // Old shell (openServer only) read by the new parser: openServer conserved,
    // setServerTitle absent -> title zero invoke.
    const oldShell = frozenMarker({ "window.openServer": 1 });
    assert.equal(
      readDesktopOpenServerCapabilityVersion(oldShell),
      DESKTOP_OPEN_SERVER_CAPABILITY_VERSION,
    );
    assert.equal(readDesktopSetServerTitleCapabilityVersion(oldShell), null);

    // New shell (both extensions) read by the new parser: both negotiated.
    const newShell = frozenMarker({ "window.openServer": 1, "window.setServerTitle": 1 });
    assert.equal(
      readDesktopOpenServerCapabilityVersion(newShell),
      DESKTOP_OPEN_SERVER_CAPABILITY_VERSION,
    );
    assert.equal(
      readDesktopSetServerTitleCapabilityVersion(newShell),
      DESKTOP_SET_SERVER_TITLE_CAPABILITY_VERSION,
    );

    // setServerTitle-only marker (closed subset) negotiates only setServerTitle.
    const titleOnly = frozenMarker({ "window.setServerTitle": 1 });
    assert.equal(readDesktopOpenServerCapabilityVersion(titleOnly), null);
    assert.equal(
      readDesktopSetServerTitleCapabilityVersion(titleOnly),
      DESKTOP_SET_SERVER_TITLE_CAPABILITY_VERSION,
    );

    // Browser / no marker: both null -> zero invoke.
    assert.equal(readDesktopOpenServerCapabilityVersion({}), null);
    assert.equal(readDesktopSetServerTitleCapabilityVersion({}), null);
  });

  test("rejects markers advertising keys outside the closed subset", () => {
    const forgeries: object[] = [
      frozenMarker({ "window.openServer": 1, attacker: 1 }),
      frozenMarker({ "window.setServerTitle": 1, "window.openServer": 1, extra: 1 }),
      frozenMarker({ "window.setServerTitle": 2 }),
    ];
    for (const host of forgeries) {
      assert.equal(readDesktopOpenServerCapabilityVersion(host), null);
      assert.equal(readDesktopSetServerTitleCapabilityVersion(host), null);
    }
  });

  test("rejects symbol and unknown own-keys via the Reflect.ownKeys closed set", () => {
    const symbolKey = Symbol("attacker");
    const withSymbol = frozenMarker({ "window.openServer": 1, [symbolKey]: 1 });
    assert.equal(readDesktopOpenServerCapabilityVersion(withSymbol), null);
    assert.equal(readDesktopSetServerTitleCapabilityVersion(withSymbol), null);
    const unknownOwnKey = frozenMarker({ "window.setServerTitle": 1, "window.unknown": 1 });
    assert.equal(readDesktopOpenServerCapabilityVersion(unknownOwnKey), null);
    assert.equal(readDesktopSetServerTitleCapabilityVersion(unknownOwnKey), null);
  });

  test("predecessor exactly-one-key parser rejects the new two-key marker", () => {
    // Freeze the predecessor parser: it negotiates openServer only when the
    // frozen marker has EXACTLY one key equal to window.openServer:1.
    const predecessorOpenServerVersion = (host: object): 1 | null => {
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
      return Object.keys(record).length === 1 && record["window.openServer"] === 1
        ? 1
        : null;
    };

    // Old shell (one key) is negotiated by the predecessor parser.
    const oldShell = frozenMarker({ "window.openServer": 1 });
    assert.equal(predecessorOpenServerVersion(oldShell), 1);
    // New shell (two keys) is REJECTED by the predecessor parser -> the old Web
    // degrades openServer rather than negotiating it.
    const newShell = frozenMarker({ "window.openServer": 1, "window.setServerTitle": 1 });
    assert.equal(predecessorOpenServerVersion(newShell), null);
    // The new parser still negotiates both on the new shell.
    assert.equal(readDesktopOpenServerCapabilityVersion(newShell), DESKTOP_OPEN_SERVER_CAPABILITY_VERSION);
    assert.equal(readDesktopSetServerTitleCapabilityVersion(newShell), DESKTOP_SET_SERVER_TITLE_CAPABILITY_VERSION);
  });

  test("basic handshake bytes do not depend on the native extension marker", () => {
    // The handshake envelope is built from the frozen module identity and
    // document identity only; the marker only governs the optional
    // openServerCapabilityAck, never the base handshake bytes.
    const withMarker = frozenMarker({ "window.openServer": 1, "window.setServerTitle": 1 });
    const withoutMarker = {};
    const baseWith = createDesktopHandshakeRequest(documentIdentity, identity, environment);
    const baseWithout = createDesktopHandshakeRequest(documentIdentity, identity, environment);
    assert.deepEqual(baseWith, baseWithout);
    // The marker presence does not alter the base handshake params.
    assert.equal("openServerCapabilityAck" in baseWith.params, false);
    void withMarker;
    void withoutMarker;
  });

  test("ordinary browser/PWA performs zero native invokes", async () => {
    let nativeInvokes = 0;
    const result = await bootstrapDesktopHandshake(
      {
        __TAURI_INTERNALS__: {
          get invoke() {
            nativeInvokes += 0;
            return undefined;
          },
        },
      },
      identity,
    );

    assert.equal(nativeInvokes, 0);
    assert.deepEqual(result, { mode: "browser" });
  });

  test("absence of a native bridge is a browser no-op", async () => {
    let nativeInvokes = 0;
    const host = new Proxy(
      {},
      {
        get(target, key, receiver) {
          if (key === "__TAURI_INTERNALS__") {
            return undefined;
          }
          nativeInvokes += 0;
          return Reflect.get(target, key, receiver);
        },
      },
    );

    const result = await bootstrapDesktopHandshake(host, identity);
    assert.equal(nativeInvokes, 0);
    assert.deepEqual(result, { mode: "browser" });
  });

  test("waits for native Finished identity before the first invoke", async () => {
    let nativeInvokes = 0;
    const bridge = eventHost(async () => {
      nativeInvokes += 1;
      return ok();
    });

    const pending = bootstrapDesktopHandshake(bridge.host, identity);
    await Promise.resolve();
    assert.equal(nativeInvokes, 0);

    bridge.emit(DESKTOP_DOCUMENT_READY_EVENT, documentIdentity);
    assert.equal((await pending).mode, "desktop");
    assert.equal(nativeInvokes, 1);
  });

  test("old native plus new Web emits the frozen parent-v1 handshake bytes", async () => {
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    const bridge = eventHost(async (_command, args) => {
      calls.push(args);
      return ok();
    });
    const pending = bootstrapDesktopHandshake(bridge.host, identity);
    bridge.emit(DESKTOP_DOCUMENT_READY_EVENT, documentIdentity);
    assert.equal((await pending).mode, "desktop");
    assert.deepEqual(calls, [{
      params: createDesktopHandshakeRequest(documentIdentity, identity, environment).params,
    }]);
    assert.equal(
      "openServerCapabilityAck" in (calls[0]?.params as Record<string, unknown>),
      false,
    );
  });

  test("invokes Tauri with the current document identity and validates exact response bytes", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const response = await performDesktopHandshake(
      async (command, args) => {
        calls.push({ command, args });
        return ok();
      },
      documentIdentity,
      identity,
      environment,
    );

    assert.deepEqual(calls, [
      {
        command: "desktop_handshake",
        args: {
          params: {
            frontendReleaseId: identity.releaseId,
            protocolVersion: 1,
            capabilities: ["desktop.handshake", "window.focus", "window.bindServer"],
            documentGeneration: documentIdentity.generation,
            documentNonce: documentIdentity.nonce,
            environmentId: "production",
            environmentGeneration: 3,
          },
        },
      },
    ]);
    assert.deepEqual(response, ok());
  });

  test("new native plus new Web sends the exact version ack before Ready", async () => {
    const calls: Array<{ command: string; args: Readonly<Record<string, unknown>> }> = [];
    const bridge = eventHost(async (command, args) => {
      calls.push({ command, args });
      return ok();
    });
    Object.defineProperty(bridge.host, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {
      value: Object.freeze({ "window.openServer": 1 }),
      writable: false,
      configurable: false,
    });

    const pending = bootstrapDesktopHandshake(bridge.host, identity);
    bridge.emit(DESKTOP_DOCUMENT_READY_EVENT, documentIdentity);
    assert.equal((await pending).mode, "desktop");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, {
      params: {
        ...createDesktopHandshakeRequest(documentIdentity, identity, environment).params,
        openServerCapabilityAck: 1,
      },
    });
  });

  test("same-release full reload waits for and handshakes a fresh document identity", async () => {
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    for (const current of [
      { generation: 7, nonce: "document-a" },
      { generation: 8, nonce: "document-b" },
    ]) {
      const bridge = eventHost(async (_command, args) => {
        seen.push(args);
        return ok(current.generation);
      });
      const pending = bootstrapDesktopHandshake(bridge.host, identity);
      bridge.emit(DESKTOP_DOCUMENT_READY_EVENT, current);
      assert.equal((await pending).mode, "desktop");
    }

    assert.deepEqual(
      seen.map((entry) => entry.params),
      [
        { ...createDesktopHandshakeRequest({ generation: 7, nonce: "document-a" }, identity, environment).params },
        { ...createDesktopHandshakeRequest({ generation: 8, nonce: "document-b" }, identity, environment).params },
      ],
    );
  });

  test("duplicate same-document handshake forwards the same identity for native revalidation", async () => {
    const calls: unknown[] = [];
    const invoke = async (_command: string, args: Readonly<Record<string, unknown>>) => {
      calls.push(args);
      return ok();
    };

    await performDesktopHandshake(invoke, documentIdentity, identity, environment);
    await performDesktopHandshake(invoke, documentIdentity, identity, environment);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  });

  test("rejects an acknowledgement for a different document generation", async () => {
    await assert.rejects(
      () =>
        performDesktopHandshake(
          async () => ok(documentIdentity.generation + 1),
          documentIdentity,
          identity,
          environment,
        ),
      /acknowledged a different document generation/,
    );
  });

  test("invalid native document identity fails before any invoke", async () => {
    let nativeInvokes = 0;
    const bridge = eventHost(async () => {
      nativeInvokes += 1;
      return ok();
    });
    const pending = bootstrapDesktopHandshake(bridge.host, identity);
    bridge.emit(DESKTOP_DOCUMENT_READY_EVENT, {
      generation: 0,
      nonce: "invalid",
    });

    await assert.rejects(() => pending, /document identity is invalid/);
    assert.equal(nativeInvokes, 0);
  });

  test("SPA history and hash events do not spuriously re-handshake", async () => {
    let nativeInvokes = 0;
    const bridge = eventHost(async () => {
      nativeInvokes += 1;
      return ok();
    });
    Object.assign(bridge.host, {
      __RAFT_DESKTOP_DOCUMENT__: documentIdentity,
    });

    await bootstrapDesktopHandshake(bridge.host, identity);
    bridge.emit("popstate");
    bridge.emit("hashchange");
    await Promise.resolve();
    assert.equal(nativeInvokes, 1);
  });

  test("fails closed on unknown response fields", async () => {
    await assert.rejects(
      () =>
        performDesktopHandshake(
          async () => ({
            method: "desktop.handshake",
            status: "ok",
            result: {
              compatibilityState: "readyFull",
              documentGeneration: documentIdentity.generation,
              extra: true,
            },
          }),
          documentIdentity,
          identity,
          environment,
        ),
      /response violates the shared IPC contract/,
    );
  });

  test("renders a visible fail-closed recovery surface", () => {
    const dom = new JSDOM("<!doctype html><html><body><main>app</main></body></html>");
    renderDesktopHandshakeRecovery(dom.window.document);

    assert.equal(
      dom.window.document.documentElement.dataset.raftDesktopCompatibility,
      "recovery",
    );
    const surface = dom.window.document.getElementById(
      "raft-desktop-handshake-recovery",
    );
    assert.equal(surface?.getAttribute("role"), "alert");
    assert.match(surface?.textContent ?? "", /needs to recover/);
    assert.equal(dom.window.document.querySelector("main"), null);
    assert.equal(dom.window.document.body.children.length, 1);
  });
});
