import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers/domSetup";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

/**
 * @MingQi review r5 #2: helper-unit tests prove `emitHostEvent` swallows a throwing
 * `RaftHost`; they DO NOT prove `authStore.logout()` composed with a hostile global
 * completes cleanly. A host-fault must never break logout — that's the whole reason
 * the emit is fire-and-forget in a try. This file runs the real `logout()` against a
 * genuinely hostile `window.RaftHost` and asserts the auth store and localStorage are
 * both cleared, i.e. the LOCAL CLEAR — the thing that actually protects the user —
 * runs to completion regardless of the emit's fate.
 */

function seedLoggedIn(): void {
  localStorage.setItem("slock_access_token", "at-fixture");
  localStorage.setItem("slock_refresh_token", "rt-fixture");
  useServerStore.setState({
    servers: [{ id: "s1", slug: "x", name: "X" }] as never,
    current: { id: "s1", slug: "x", name: "X" } as never,
    loading: false,
  } as never);
  useAuthStore.setState({
    user: { id: "u1", email: "a@b.com" } as never,
    accessToken: "at-fixture",
    refreshToken: "rt-fixture",
  } as never);
}

function installHostileEmit(): void {
  // A `.emit` that throws on every invocation.
  Object.defineProperty(window, "RaftHost", {
    value: Object.freeze({
      version: "raft-host-v1",
      emit: () => { throw new Error("hostile emit"); },
    }),
    writable: true,
    configurable: true,
  });
}

function installHostileVersionGetter(): void {
  // A `.version` getter that throws every time it is read.
  const shape = { emit: () => {} };
  Object.defineProperty(shape, "version", {
    get() { throw new Error("hostile version getter"); },
  });
  Object.defineProperty(window, "RaftHost", { value: shape, configurable: true, writable: true });
}

function installHostileProxy(): void {
  // A Proxy whose get() throws on any read — the pathological case.
  const proxy = new Proxy({}, { get() { throw new Error("hostile proxy get"); } });
  Object.defineProperty(window, "RaftHost", { value: proxy, configurable: true, writable: true });
}

beforeEach(seedLoggedIn);

afterEach(() => {
  delete (window as unknown as { RaftHost?: unknown }).RaftHost;
  localStorage.clear();
});

function assertFullyLoggedOut(): void {
  const st = useAuthStore.getState();
  assert.equal(st.user, null, "user must be cleared");
  assert.equal(st.accessToken, null, "accessToken must be cleared");
  assert.equal(st.refreshToken, null, "refreshToken must be cleared");
  assert.equal(localStorage.getItem("slock_access_token"), null, "localStorage access token must be cleared");
  assert.equal(localStorage.getItem("slock_refresh_token"), null, "localStorage refresh token must be cleared");
}

test("hostile `.emit` throws: logout still completes; auth + localStorage cleared", () => {
  installHostileEmit();
  // Must NOT throw — a host-fault in emit cannot derail the local clear.
  useAuthStore.getState().logout("explicit_user_logout");
  assertFullyLoggedOut();
});

test("hostile `.version` getter throws: helper treats as absent; logout completes", () => {
  installHostileVersionGetter();
  useAuthStore.getState().logout("explicit_user_logout");
  assertFullyLoggedOut();
});

test("hostile Proxy on window.RaftHost: read-any-property throws; logout still completes", () => {
  installHostileProxy();
  useAuthStore.getState().logout("explicit_user_logout");
  assertFullyLoggedOut();
});
