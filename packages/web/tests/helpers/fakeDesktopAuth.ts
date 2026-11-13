// A fake Raft Desktop loopback (`raftDesktop.auth`) for tests of the web's
// desktop sign-in and account-link flows (src/utils/desktopOAuth.ts). The
// "browser" comes back with `code` as soon as the flow awaits the callback,
// unless the test holds it (`hold`) or makes it fail (`failCallback`).
// `appLogin: true` adds the app-login handoff half (passkey sign-in,
// src/utils/desktopPasskeySignIn.ts): its callback's state is the request id.
import type { DesktopAuthBridge } from "@botiverse/raft-shared";

export interface FakeDesktopAuth {
  auth: DesktopAuthBridge;
  /** Every bridge call, in order: "begin", "open", "await", "cancel" (+ "beginAppLogin", "openAppLogin"). */
  calls: string[];
  /** The states the web began attempts with. */
  states: string[];
  /** The authorization URLs the web asked the shell to open. */
  opened: string[];
  cancelled: string[];
  /** The app-login confirm pages the web asked the shell to open. */
  openedAppLogin: Array<{ requestId: string; loginUrl: string }>;
  redirectUri(): string;
  /** The app-login loopback's return URI. */
  appLoginReturnUri(): string;
  /** The next callback rejects with this message (as the preload rethrows it). */
  failCallback(message: string): void;
  /** The next callback comes back with this state instead of the attempt's. */
  answerWithState(state: string): void;
  /**
   * From now on the browser does not come back by itself: a callback waits
   * until `release()`, or rejects as main does — `oauth_cancelled` when its
   * attempt is cancelled, `oauth_superseded` when a newer attempt begins.
   */
  hold(): void;
  /** The browser of the latest held attempt comes back with the code. */
  release(): void;
  cleanup(): void;
}

export function installFakeDesktopAuth({ code = "one-time-code", port = 49152, appLogin = false }: { code?: string; port?: number; appLogin?: boolean } = {}): FakeDesktopAuth {
  const calls: string[] = [];
  const openedAppLogin: Array<{ requestId: string; loginUrl: string }> = [];
  // App-login attempts: attempt id → the request id it was opened for ("" until opened).
  const appLoginAttempts = new Map<string, string>();
  const states: string[] = [];
  const opened: string[] = [];
  const cancelled: string[] = [];
  let failure: string | null = null;
  let stateOverride: string | null = null;
  let attempts = 0;
  let holding = false;
  const held = new Map<string, { resolve: (value: { code: string; state: string }) => void; reject: (err: Error) => void; state: string }>();
  const rejectHeld = (attemptId: string, reason: string) => {
    held.get(attemptId)?.reject(new Error(reason));
    held.delete(attemptId);
  };
  const auth: DesktopAuthBridge = {
    beginLoopback: async ({ state }) => {
      calls.push("begin");
      states.push(state);
      for (const attemptId of [...held.keys()]) rejectHeld(attemptId, "oauth_superseded");
      attempts += 1;
      return { attemptId: `attempt-${attempts}`, redirectUri: `http://127.0.0.1:${port}/auth/done#state=${state}` };
    },
    openAuthorizationUrl: async (attemptId, url) => {
      calls.push("open");
      // As main: a cancelled attempt is no longer armed.
      if (cancelled.includes(attemptId)) throw new Error("oauth_not_armed");
      opened.push(url);
    },
    awaitCallback: async (attemptId) => {
      calls.push("await");
      if (holding) {
        const state = appLoginAttempts.get(attemptId) ?? states[states.length - 1];
        return new Promise((resolve, reject) => { held.set(attemptId, { resolve, reject, state }); });
      }
      if (failure) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      const state = stateOverride ?? appLoginAttempts.get(attemptId) ?? states[states.length - 1];
      stateOverride = null;
      return { code, state };
    },
    cancel: (attemptId) => {
      calls.push("cancel");
      cancelled.push(attemptId);
      rejectHeld(attemptId, "oauth_cancelled");
    },
    ...(appLogin ? {
      beginAppLoginLoopback: async () => {
        calls.push("beginAppLogin");
        for (const attemptId of [...held.keys()]) rejectHeld(attemptId, "oauth_superseded");
        attempts += 1;
        const attemptId = `attempt-${attempts}`;
        appLoginAttempts.set(attemptId, "");
        return { attemptId, returnUri: `http://127.0.0.1:${port}/callback` };
      },
      openAppLoginUrl: async (attemptId: string, request: { requestId: string; loginUrl: string }) => {
        calls.push("openAppLogin");
        if (cancelled.includes(attemptId)) throw new Error("oauth_not_armed");
        appLoginAttempts.set(attemptId, request.requestId);
        openedAppLogin.push(request);
      },
    } : {}),
  };
  const host = (typeof window !== "undefined" ? window : globalThis) as { raftDesktop?: unknown };
  const previous = host.raftDesktop;
  host.raftDesktop = { isDesktop: true, auth };
  return {
    auth,
    calls,
    states,
    opened,
    cancelled,
    openedAppLogin,
    appLoginReturnUri: () => `http://127.0.0.1:${port}/callback`,
    redirectUri: () => `http://127.0.0.1:${port}/auth/done#state=${states[states.length - 1]}`,
    failCallback: (message) => { failure = message; },
    answerWithState: (state) => { stateOverride = state; },
    hold: () => { holding = true; },
    release: () => {
      const last = [...held.entries()].at(-1);
      if (!last) throw new Error("no held callback to release");
      held.delete(last[0]);
      last[1].resolve({ code, state: last[1].state });
    },
    cleanup: () => {
      if (previous === undefined) delete host.raftDesktop;
      else host.raftDesktop = previous;
    },
  };
}
