import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import {
  emitHostEvent,
  hasRaftHostEventBridge,
  readRaftHostOnboardingContext,
  requestHostedOnboardingServerSwitch,
} from "../src/embed/hostBridge";

/**
 * Web side of the host↔web event bridge. The platform host installs `window.RaftHost`
 * at document-start; this file only tests the WEB HELPER — detection, no-op-when-absent,
 * frozen payload discipline. Full end-to-end path is gated per-platform in mobile CI.
 */

interface Capture {
  calls: Array<{ kind: string; payload: object }>;
  throwOnNext?: boolean;
}

function installHost(capture: Capture, version = "raft-host-v1"): void {
  Object.defineProperty(window, "RaftHost", {
    value: Object.freeze({
      version,
      emit(kind: string, payload: object) {
        capture.calls.push({ kind, payload });
        if (capture.throwOnNext) {
          capture.throwOnNext = false;
          throw new Error("host boom");
        }
      },
    }),
    writable: true, // test-only; production script defines writable=false
    configurable: true,
  });
}

function installOnboardingHost(capture: Capture, onboarding: unknown): void {
  Object.defineProperty(window, "RaftHost", {
    value: Object.freeze({
      version: "raft-host-v1",
      onboarding,
      emit(kind: string, payload: object) {
        capture.calls.push({ kind, payload });
      },
    }),
    writable: true,
    configurable: true,
  });
}

function removeHost(): void {
  delete (window as unknown as { RaftHost?: unknown }).RaftHost;
}

afterEach(removeHost);

test("no host installed: hasRaftHostEventBridge is false; emitHostEvent is a no-op", () => {
  removeHost();
  assert.equal(hasRaftHostEventBridge(), false);
  // Must not throw.
  emitHostEvent("session:logout");
});

test("compatible host installed: hasRaftHostEventBridge is true", () => {
  const cap: Capture = { calls: [] };
  installHost(cap);
  assert.equal(hasRaftHostEventBridge(), true);
});

test("wrong version: helper treats it as absent — soft versioning failure mode", () => {
  const cap: Capture = { calls: [] };
  installHost(cap, "raft-host-v0" as never);
  assert.equal(hasRaftHostEventBridge(), false);
  // And emitHostEvent short-circuits with no throw and no call recorded.
  emitHostEvent("session:logout");
  assert.equal(cap.calls.length, 0);
});

test("emitHostEvent with no payload sends {} — the host contract requires an object", () => {
  // The wire says `payload` MUST be an object, possibly empty. The helper enforces this
  // even when the caller omits the argument for a no-payload kind.
  const cap: Capture = { calls: [] };
  installHost(cap);
  emitHostEvent("session:logout");
  assert.deepEqual(cap.calls, [{ kind: "session:logout", payload: {} }]);
});

test("emitHostEvent with a payload sends it verbatim", () => {
  const cap: Capture = { calls: [] };
  installHost(cap);
  emitHostEvent("session:server-deleted", { serverSlug: "acme" });
  assert.deepEqual(cap.calls, [{ kind: "session:server-deleted", payload: { serverSlug: "acme" } }]);
});

test("onboarding completion is a typed wake carrying contract and current WebView identity", () => {
  const cap: Capture = { calls: [] };
  installHost(cap);
  emitHostEvent("onboarding:completed", {
    contractVersion: "raft-onboarding-v1",
    serverId: "server-1",
    serverSlug: "acme",
    generation: "webview:1",
  });
  assert.deepEqual(cap.calls, [{
    kind: "onboarding:completed",
    payload: {
      contractVersion: "raft-onboarding-v1",
      serverId: "server-1",
      serverSlug: "acme",
      generation: "webview:1",
    },
  }]);
});

test("all v1 kinds go through", () => {
  const cap: Capture = { calls: [] };
  installHost(cap);
  emitHostEvent("onboarding:completed", {
    contractVersion: "raft-onboarding-v1",
    serverId: "server-1",
    serverSlug: "acme",
    generation: "webview:1",
  });
  emitHostEvent("session:logout");
  emitHostEvent("session:server-deleted", { serverSlug: "a" });
  emitHostEvent("session:server-left", { serverSlug: "b" });
  emitHostEvent("session:server-switched", { serverSlug: "c" });
  emitHostEvent("session:token-refresh-failed");
  assert.equal(cap.calls.length, 6);
  assert.deepEqual(cap.calls.map((c) => c.kind), [
    "onboarding:completed",
    "session:logout",
    "session:server-deleted",
    "session:server-left",
    "session:server-switched",
    "session:token-refresh-failed",
  ]);
});

test("strict onboarding host context drives the pre-navigation switch request ABI", () => {
  const cap: Capture = { calls: [] };
  installOnboardingHost(cap, {
    contractVersion: "raft-onboarding-v1",
    generation: "webview:1",
    sourceServerId: "server-1",
  });
  assert.deepEqual(readRaftHostOnboardingContext(), {
    contractVersion: "raft-onboarding-v1",
    generation: "webview:1",
    sourceServerId: "server-1",
  });
  assert.equal(requestHostedOnboardingServerSwitch("server-2"), "sent");
  assert.deepEqual(cap.calls, [{
    kind: "onboarding:server-switch-request",
    payload: {
      contractVersion: "raft-onboarding-v1",
      generation: "webview:1",
      sourceServerId: "server-1",
      targetServerId: "server-2",
    },
  }]);
});

test("invalid onboarding context fails closed and never emits a switch request", () => {
  const cap: Capture = { calls: [] };
  for (const onboarding of [
    null,
    { contractVersion: "wrong", generation: "webview:1", sourceServerId: "server-1" },
    { contractVersion: "raft-onboarding-v1", generation: "", sourceServerId: "server-1" },
    { contractVersion: "raft-onboarding-v1", generation: "webview:1", sourceServerId: "with space" },
  ]) {
    installOnboardingHost(cap, onboarding);
    assert.equal(readRaftHostOnboardingContext(), null);
    assert.equal(requestHostedOnboardingServerSwitch("server-2"), "failed");
  }
  assert.deepEqual(cap.calls, []);
});

test("a compatible non-onboarding host keeps ordinary Web switching enabled", () => {
  const cap: Capture = { calls: [] };
  installHost(cap);
  assert.equal(readRaftHostOnboardingContext(), null);
  assert.equal(requestHostedOnboardingServerSwitch("server-2"), "not-hosted");
  assert.deepEqual(cap.calls, []);
});

test("a hosted bridge throw fails closed without committing a Web switch", () => {
  Object.defineProperty(window, "RaftHost", {
    configurable: true,
    value: Object.freeze({
      version: "raft-host-v1",
      onboarding: Object.freeze({
        contractVersion: "raft-onboarding-v1",
        generation: "webview:1",
        sourceServerId: "server-1",
      }),
      emit() { throw new Error("host rejected switch"); },
    }),
  });
  assert.equal(requestHostedOnboardingServerSwitch("server-2"), "failed");
});

test("host throwing does NOT propagate — the caller must not know about a host bug", () => {
  const cap: Capture = { calls: [], throwOnNext: true };
  installHost(cap);
  // Must not throw.
  emitHostEvent("session:logout");
  assert.equal(cap.calls.length, 1);
});


test("throwing getter on window.RaftHost: emit soft-fails, does NOT throw into caller", () => {
  // @MingQi review r4 #2: any read on window.RaftHost / .version / .emit can throw
  // (Proxy, adversarial getter, corrupted global). If any of these throws propagated
  // through emitHostEvent, `authStore.logout()` — which calls this synchronously —
  // would be derailed and the user's local state would not be cleared. The full
  // detect-and-invoke path is inside try; this proves the caller cannot be poisoned.
  Object.defineProperty(window, "RaftHost", {
    get() { throw new Error("hostile getter"); },
    configurable: true,
  });
  // Must not throw.
  emitHostEvent("session:logout");
  // hasRaftHostEventBridge also swallows the throw (returns false).
  assert.equal(hasRaftHostEventBridge(), false);
});

test("throwing .version getter: still soft-fails", () => {
  const shape = { version: undefined, emit: () => {} };
  Object.defineProperty(shape, "version", {
    get() { throw new Error("boom on version"); },
  });
  Object.defineProperty(window, "RaftHost", { value: shape, configurable: true, writable: true });
  emitHostEvent("session:logout");
  assert.equal(hasRaftHostEventBridge(), false);
});
