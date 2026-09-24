// Terminal-logout trace-flush redirect race — RED repro + fix contract.
//
// Provenance: xxchan (key user) logged out ~2026-07-02 00:54:23+08 (DM 0a53786c).
// Rainsky ScopeDB (thread #proj-frontend:3279b995): her web-activity trace was
// ALIVE (1359 rows) but there were ZERO `slock.auth.*` terminal spans for her
// window, and ZERO `session_cleared` / `authVerdict=logout` GLOBALLY in the
// control window. So the terminal logout itself is un-traced — the backstop
// monitor is blind to the very event it exists to watch.
//
// ROOT CAUSE (mechanism, confirmed by ApplePI against current staging):
//   - `clearAuthAndRedirect()` (api/client.ts) calls the fire-and-forget
//     `emitAuthTraceAndFlush("session_cleared", terminal_verdict)` and then
//     SYNCHRONOUSLY does `window.location.href = "/"`.
//   - `emitAuthTraceAndFlush` (webAuthTrace.ts) only synchronously captures
//     token/server/record, then `void sendUrgentAuthTraceBatch(...)` — no await,
//     no handle for the caller to wait on.
//   - `sendUrgentAuthTraceBatch` is TWO-HOP: `await fetch(/scope-attestation)`
//     resolves FIRST, and only then is `fetch(/api/web-traces)` (the real trace)
//     issued.
//   `keepalive:true` keeps an ALREADY-ISSUED request alive across unload, but it
//   does NOT keep the JS continuation alive to receive the attestation response
//   and ISSUE the second fetch. So when the synchronous redirect tears down the
//   document before the attestation resolves, the real trace POST is never
//   issued → terminal trace lost. #2994 closed the concurrent-`flushing`-guard
//   loss, NOT this synchronous-nav-tears-continuation loss.
//
// This file:
//   - Test 1 / Test 2 (RED) run against CURRENT code and pin the loss: while the
//     attestation hop is still in flight (exactly when clearAuthAndRedirect
//     proceeds to navigate), the `/api/web-traces` POST has not been issued; if
//     the continuation never runs, it is never issued.
//   - GREEN CONTRACT (see block below Test 2) = the acceptance ApplePI's
//     terminal-only awaitable helper must satisfy. Left as a spec, not an import,
//     so this file compiles before the helper exists.
//
// Division (thread #proj-frontend:3279b995): ApplePI = fix (terminal-only
// awaitable `emitAuthTraceAndFlushBeforeUnload` + `Promise.race([helper, ~500ms]`
// in an async clearAuthAndRedirect); 铁根 = this repro/RED; Rainsky = staging/prod
// ScopeDB pre/post readback (session_cleared with pre-clear user/server/tab).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emitAuthTraceAndFlush,
  emitAuthTraceAndFlushBeforeUnload,
  setAuthTraceServerIdGetter,
  setAuthTraceFetchForTest,
  __resetAuthTraceForTest,
} from "../src/utils/webAuthTrace.ts";
import { clearAuthAndRedirect } from "../src/api/client.ts";

type StubStore = Record<string, string>;
function stubLocalStorage(initial: StubStore): { restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store: StubStore = { ...initial };
  const stub: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem: (k: string) => (k in store ? store[k]! : null),
    key: (i: number) => Object.keys(store)[i] ?? null,
    removeItem: (k: string) => {
      delete store[k];
    },
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: stub });
  return {
    restore: () => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

function stubWindowLocation(initialHref = "https://app.example.test/current"): { restore: () => void; href: () => string } {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const win = { location: { href: initialHref } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  return {
    href: () => win.location.href,
    restore: () => {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function urls(calls: Array<{ url: string }>): string[] {
  return calls.map((c) => c.url);
}
const hasAttestation = (calls: Array<{ url: string }>) =>
  urls(calls).some((u) => u.includes("/scope-attestation"));
const hasTracePost = (calls: Array<{ url: string }>) =>
  urls(calls).some((u) => u.includes("/api/web-traces"));

// RED 1: at the moment clearAuthAndRedirect would navigate (right after the
// fire-and-forget emit returns), the real /api/web-traces POST has NOT been
// issued — it is still blocked behind the pending attestation hop. Only once the
// attestation resolves (i.e. only if the JS continuation survives) does the trace
// go out. A synchronous redirect that tears down the context first loses it.
test("[repro] terminal session_cleared trace POST is deferred behind the attestation hop — unsent at redirect time", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({ slock_access_token: "tok-terminal" });

  const calls: Array<{ url: string }> = [];
  let resolveAttestation: (() => void) | null = null;
  try {
    setAuthTraceFetchForTest((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      if (url.includes("/scope-attestation")) {
        // Attestation stays in flight — models the window between emit and the
        // synchronous window.location.href="/" in clearAuthAndRedirect.
        return new Promise<Response>((resolve) => {
          resolveAttestation = () => resolve(jsonResponse({ attestation: "att-terminal" }));
        });
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    // Fire-and-forget, exactly as clearAuthAndRedirect does. Returns void — the
    // caller has no promise to await before it navigates.
    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "clearAuthAndRedirect",
      logoutTrigger: "terminal_verdict",
    });

    // The attestation hop is issued...
    await waitFor(() => hasAttestation(calls));
    // ...but the actual trace POST is NOT — this is the loss window. If a
    // synchronous redirect runs here, the trace never goes out.
    assert.equal(
      hasTracePost(calls),
      false,
      "REGRESSION GUARD: /api/web-traces must still be pending behind attestation at redirect time (this is the race the fix closes by awaiting)",
    );

    // Proof the ONLY missing ingredient is the caller waiting for the
    // continuation: let the attestation resolve, and the trace does go out.
    resolveAttestation?.();
    await waitFor(() => hasTracePost(calls));
    assert.ok(hasTracePost(calls), "once the continuation runs, the trace POST is issued");
  } finally {
    resolveAttestation?.();
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

// RED 2: if the continuation never runs (document torn down by navigation before
// the attestation response is processed), the terminal trace is permanently lost
// — no /api/web-traces is ever issued. This is what Rainsky observed as 0
// session_cleared globally.
test("[repro] if the attestation continuation never runs (nav tears it down), the terminal trace is never sent", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({ slock_access_token: "tok-terminal" });

  const calls: Array<{ url: string }> = [];
  try {
    setAuthTraceFetchForTest((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      if (url.includes("/scope-attestation")) {
        return new Promise<Response>(() => {}); // never resolves — continuation dies
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "clearAuthAndRedirect",
      logoutTrigger: "terminal_verdict",
    });

    await waitFor(() => hasAttestation(calls));
    // Give any (non-existent) continuation ample turns to fire the trace.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      hasTracePost(calls),
      false,
      "terminal trace is lost: /api/web-traces is never issued when the attestation continuation does not run",
    );
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("terminal-only awaitable flush issues /api/web-traces before the caller proceeds", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({ slock_access_token: "tok-terminal" });

  const calls: Array<{ url: string }> = [];
  let resolveAttestation: (() => void) | null = null;
  try {
    setAuthTraceFetchForTest((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      if (url.includes("/scope-attestation")) {
        return new Promise<Response>((resolve) => {
          resolveAttestation = () => resolve(jsonResponse({ attestation: "att-terminal" }));
        });
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const flushed = emitAuthTraceAndFlushBeforeUnload("slock.auth.session_cleared", {
      clearSessionCaller: "clearAuthAndRedirect",
      logoutTrigger: "terminal_verdict",
    });
    await waitFor(() => hasAttestation(calls));
    assert.equal(hasTracePost(calls), false, "trace POST should wait behind the pending attestation hop");

    resolveAttestation?.();
    await flushed;
    assert.ok(hasTracePost(calls), "awaiting the helper lets /api/web-traces be issued before redirect");
  } finally {
    resolveAttestation?.();
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("terminal-only awaitable flush is bounded when attestation stalls", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({ slock_access_token: "tok-terminal" });

  const calls: Array<{ url: string }> = [];
  try {
    setAuthTraceFetchForTest((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url });
      if (url.includes("/scope-attestation")) {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const start = performance.now();
    await emitAuthTraceAndFlushBeforeUnload(
      "slock.auth.session_cleared",
      {
        clearSessionCaller: "clearAuthAndRedirect",
        logoutTrigger: "terminal_verdict",
      },
      { timeoutMs: 25 },
    );
    const elapsed = performance.now() - start;

    assert.ok(hasAttestation(calls), "helper should still attempt the attestation hop");
    assert.equal(hasTracePost(calls), false, "stalled attestation cannot issue the trace POST");
    assert.ok(elapsed < 250, `bounded helper should not hang redirect; elapsed=${elapsed}`);
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("clearAuthAndRedirect waits for terminal session_cleared trace before clearing tokens and redirecting", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({
    slock_access_token: "tok-terminal",
    slock_refresh_token: "refresh-terminal",
  });
  const win = stubWindowLocation();

  const calls: Array<{ url: string; body?: unknown }> = [];
  let resolveAttestation: (() => void) | null = null;
  try {
    setAuthTraceFetchForTest((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, body });
      if (url.includes("/scope-attestation")) {
        return new Promise<Response>((resolve) => {
          resolveAttestation = () => resolve(jsonResponse({ attestation: "att-terminal" }));
        });
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const redirected = clearAuthAndRedirect();
    await waitFor(() => hasAttestation(calls));

    assert.equal(hasTracePost(calls), false, "redirect path should wait while terminal trace is still behind attestation");
    assert.equal(localStorage.getItem("slock_access_token"), "tok-terminal", "access token must remain until trace send gets its chance");
    assert.equal(localStorage.getItem("slock_refresh_token"), "refresh-terminal", "refresh token must remain until trace send gets its chance");
    assert.equal(win.href(), "https://app.example.test/current", "redirect must wait for the terminal trace send");

    resolveAttestation?.();
    await redirected;

    const traceCall = calls.find((call) => call.url.includes("/api/web-traces"));
    assert.ok(traceCall, "clearAuthAndRedirect should issue the terminal trace POST before redirecting");
    assert.equal((traceCall.body as any)?.records?.[0]?.name, "slock.auth.session_cleared");
    assert.equal((traceCall.body as any)?.records?.[0]?.attrs?.clearSessionCaller, "clearAuthAndRedirect");
    assert.equal((traceCall.body as any)?.records?.[0]?.attrs?.logoutTrigger, "terminal_verdict");
    assert.equal(localStorage.getItem("slock_access_token"), null, "access token should be cleared after terminal trace attempt");
    assert.equal(localStorage.getItem("slock_refresh_token"), null, "refresh token should be cleared after terminal trace attempt");
    assert.equal(win.href(), "/", "clearAuthAndRedirect should redirect after terminal trace attempt");
  } finally {
    resolveAttestation?.();
    win.restore();
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});
