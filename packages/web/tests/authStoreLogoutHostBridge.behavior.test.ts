import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers/domSetup";
import { useAuthStore } from "../src/store/authStore";
import { useServerStore } from "../src/store/serverStore";

/**
 * `authStore.logout()` may fire `session:logout` on the host bridge only when the
 * trigger is `explicit_user_logout` (@MingQi review r4 #1). The other triggers —
 * `terminal_verdict`, `restore_timeout`, `dev_clear_local_state`, `unknown` — are
 * recoverable states, not "user asked to log out"; forcing the host to destroy its
 * session on those paths would bypass the design contract that refresh-failure is
 * wake/intent and host must bootstrap its own auth
 * (`mobile/docs/host-web-event-bridge-2026-07-15.md`).
 *
 * The explicit emit must happen AFTER the local clear sequence completes, so the
 * signal reflects post-state, not intent.
 */

interface Capture {
  calls: Array<{ kind: string; observedUser: unknown; observedTokens: [unknown, unknown] }>;
}

function installHost(capture: Capture): void {
  Object.defineProperty(window, "RaftHost", {
    value: Object.freeze({
      version: "raft-host-v1",
      emit(kind: string) {
        // Record what the auth store looks like AT the emit moment. If the emit fired
        // before the local clear, `user` and tokens would still be populated. That's
        // the "reflects post-state" invariant.
        const st = useAuthStore.getState();
        capture.calls.push({
          kind,
          observedUser: st.user,
          observedTokens: [st.accessToken, st.refreshToken],
        });
      },
    }),
    writable: true,
    configurable: true,
  });
}

function seedLoggedIn(): void {
  useServerStore.setState({
    servers: [{ id: "s1", slug: "x", name: "X" }] as never,
    current: { id: "s1", slug: "x", name: "X" } as never,
    loading: false,
  } as never);
  useAuthStore.setState({
    user: { id: "u1", email: "a@b.com" } as never,
    accessToken: "at",
    refreshToken: null,
  } as never);
}

let cap: Capture;

beforeEach(() => {
  cap = { calls: [] };
  installHost(cap);
  seedLoggedIn();
});

afterEach(() => {
  delete (window as unknown as { RaftHost?: unknown }).RaftHost;
});

test("explicit_user_logout: emits `session:logout` exactly once, AFTER local state is cleared", () => {
  useAuthStore.getState().logout("explicit_user_logout");
  assert.equal(cap.calls.length, 1);
  assert.equal(cap.calls[0].kind, "session:logout");
  // Post-state at emit time: user and tokens ARE gone. If the emit fired before the
  // clear, these would still be populated — which is exactly what "reflects post-state"
  // guards against.
  assert.equal(cap.calls[0].observedUser, null);
  assert.deepEqual(cap.calls[0].observedTokens, [null, null]);
});

test("default trigger (no arg) is explicit_user_logout — emits once", () => {
  useAuthStore.getState().logout();
  assert.equal(cap.calls.length, 1);
});

test("terminal_verdict: zero `session:logout` — recoverable state, host bootstraps its own auth", () => {
  useAuthStore.getState().logout("terminal_verdict");
  assert.equal(cap.calls.length, 0);
});

test("restore_timeout: zero `session:logout` — the host must not be told to destroy the session", () => {
  useAuthStore.getState().logout("restore_timeout");
  assert.equal(cap.calls.length, 0);
});

test("dev_clear_local_state: zero `session:logout` — dev-tool, not a product logout", () => {
  useAuthStore.getState().logout("dev_clear_local_state");
  assert.equal(cap.calls.length, 0);
});

test("unknown trigger: zero `session:logout` — ambiguous origin, fail-closed against noisy emit", () => {
  useAuthStore.getState().logout("unknown");
  assert.equal(cap.calls.length, 0);
});
