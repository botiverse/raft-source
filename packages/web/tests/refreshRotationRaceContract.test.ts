import assert from "node:assert/strict";
import test from "node:test";
import { createRefreshCoordinator } from "../src/utils/refreshCoordinator";
import type { RefreshTokens } from "../src/utils/refreshCoordinator";

// Multi-tab refresh-token rotation race (#proj-frontend:afe11af8, 2026-06-11).
//
// Two tabs hit access-token expiry ~simultaneously and both refresh the same
// stored refresh token RT0. The server single-use-rotates RT0 -> RT1 for the
// winner and rejects (4xx) the loser's now-stale RT0. The loser must recover by
// picking up the winner's rotated token (written to the shared localStorage)
// rather than signing the user out.
//
// Legacy behaviour: the "rotation-not-yet-visible" branch waited a SINGLE fixed
// REFRESH_RETRY_DELAYS_MS[0] (250ms) grace, then threw -> authStore.logout(
// "terminal_verdict"). Under slow networks the winner's rotated token can
// propagate later than 250ms, so the loser throws => spurious logout. The fix
// replaces the fixed grace with an event-driven wait for the rotation signal
// (`waitForRotatedToken` / `rotatedTokenWaitMs`), bounded so a genuine
// revocation still surfaces the 4xx instead of hanging forever.
//
// RED→GREEN: the first test is RED against the legacy fixed-grace coordinator
// and GREEN once the wait-for-rotation fix lands. The second is a backstop that
// must stay GREEN on both (no infinite wait on real revocation).

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Params superset so this file type-checks against both the current coordinator
// (which ignores the extra fields) and the fixed one (which adds them).
type CoordParams = Parameters<typeof createRefreshCoordinator>[0] & {
  subscribeToTokenUpdates?: (listener: (tokens: RefreshTokens) => void) => () => void;
  waitForRotatedToken?: (currentToken: string, timeoutMs: number) => Promise<string | null>;
  rotatedTokenWaitMs?: number;
  rotatedTokenPollMs?: number;
};

/**
 * Two coordinators sharing one localStorage + a single-use-rotation mock server.
 * `winnerPropagateMs` models a slow downlink: the winner's rotated token only
 * becomes visible in the shared store that many ms after the server rotated.
 * `revokeAll` makes the server reject every refresh (true revocation, no rotation).
 */
function makeWorld(opts: {
  winnerPropagateMs: number;
  rotatedTokenWaitMs?: number;
  rotatedTokenPollMs?: number;
  emitTokenUpdates?: boolean;
  revokeAll?: boolean;
  /** Every refresh throws a network error (no HTTP response) — models a dropped
   *  / weak downlink rather than a server auth rejection. */
  networkErrorAll?: boolean;
  /** Server-side idempotency/grace for an old refresh token that was just
   * consumed by another in-flight rotation. */
  replayConsumedRotation?: boolean;
}) {
  const store = { accessToken: "AT0", refreshToken: "RT0" };
  const listeners = new Set<(tokens: RefreshTokens) => void>();
  const recentRotations = new Map<string, RefreshTokens>();
  let validRefresh = "RT0";
  let gen = 0;

  const requestRefreshFor = (tab: "A" | "B") => async (rt: string): Promise<RefreshTokens> => {
    await sleep(tab === "A" ? 50 : 120); // tab A reaches the server first
    if (opts.networkErrorAll) {
      await sleep(20); // dropped connection — no HTTP response, no status
      throw new Error("network request failed"); // note: NO `.response`/status
    }
    if (!opts.revokeAll && rt === validRefresh) {
      gen += 1;
      const tokens: RefreshTokens = { accessToken: `AT${gen}`, refreshToken: `RT${gen}` };
      recentRotations.set(rt, tokens);
      validRefresh = tokens.refreshToken; // old RT now single-use-invalidated
      await sleep(tab === "A" ? opts.winnerPropagateMs : 30); // slow success downlink
      return tokens;
    }
    if (opts.replayConsumedRotation && recentRotations.has(rt)) {
      await sleep(30);
      return recentRotations.get(rt)!;
    }
    await sleep(30); // small/fast 401 body
    const err: any = new Error("invalid_refresh_token");
    err.response = { status: 401 };
    throw err;
  };

  const writeTokens = (t: RefreshTokens) => {
    // The winner's rotated token landing here is the cross-tab signal the loser
    // polls for or receives through the authTokenSync subscription path.
    store.accessToken = t.accessToken;
    store.refreshToken = t.refreshToken;
    if (opts.emitTokenUpdates) {
      for (const listener of listeners) listener(t);
    }
  };

  const mk = (tab: "A" | "B") =>
    createRefreshCoordinator({
      readRefreshToken: () => store.refreshToken,
      readAccessToken: () => store.accessToken,
      writeTokens,
      requestRefresh: requestRefreshFor(tab),
      rotatedTokenWaitMs: opts.rotatedTokenWaitMs,
      rotatedTokenPollMs: opts.rotatedTokenPollMs ?? 25,
      subscribeToTokenUpdates: opts.emitTokenUpdates
        ? (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }
        : undefined,
    } as CoordParams);

  return { store, mkA: () => mk("A"), mkB: () => mk("B") };
}

function makeCascadeWorld(tabCount: number) {
  const store = { accessToken: "AT0", refreshToken: "RT0" };
  const listeners = new Set<(tokens: RefreshTokens) => void>();
  const events: string[] = [];
  let validRefresh = "RT0";
  let gen = 0;

  const writeTokens = (tab: string, tokens: RefreshTokens) => {
    store.accessToken = tokens.accessToken;
    store.refreshToken = tokens.refreshToken;
    events.push(`${tab}:write:${tokens.refreshToken}`);
    for (const listener of listeners) listener(tokens);
  };

  const makeTab = (index: number) => {
    const tab = `tab${index + 1}`;
    return createRefreshCoordinator({
      readAccessToken: () => store.accessToken,
      readRefreshToken: () => store.refreshToken,
      writeTokens: (tokens) => writeTokens(tab, tokens),
      requestRefresh: async (refreshToken) => {
        events.push(`${tab}:request:${refreshToken}`);
        await sleep(index * 10);
        if (refreshToken !== validRefresh) {
          events.push(`${tab}:reject:${refreshToken}:valid=${validRefresh}`);
          const error: any = new Error("invalid_refresh_token");
          error.response = { status: 401 };
          throw error;
        }

        gen += 1;
        const tokens: RefreshTokens = {
          accessToken: `AT${gen}`,
          refreshToken: `RT${gen}`,
        };
        events.push(`${tab}:rotate:${refreshToken}->${tokens.refreshToken}`);
        validRefresh = tokens.refreshToken;
        return tokens;
      },
      subscribeToTokenUpdates: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      rotatedTokenWaitMs: 500,
      rotatedTokenPollMs: 10,
    });
  };

  return {
    events,
    refreshAll: () => Promise.allSettled(
      Array.from({ length: tabCount }, (_, index) => makeTab(index).refresh()),
    ),
  };
}

test("multi-tab rotation race: the losing tab recovers via the rotation signal, not a fixed grace", async () => {
  // Winner's rotated token propagates at 600ms — past the legacy single 250ms
  // grace (=> legacy loser throws => RED) but well under rotatedTokenWaitMs
  // (=> fixed loser polls the rotated token and retries => GREEN).
  const { mkA, mkB } = makeWorld({ winnerPropagateMs: 600, rotatedTokenWaitMs: 2000 });

  const results = await Promise.allSettled([mkA().refresh(), mkB().refresh()]);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  assert.equal(
    rejected.length,
    0,
    "both tabs must recover from a single-use rotation race; the losing tab threw " +
      `${rejected[0]?.reason?.response?.status} — the legacy fixed 250ms grace is shorter than the ` +
      "winner's rotated-token propagation, producing a spurious terminal_verdict logout. " +
      "Fix: wait for the rotation signal (waitForRotatedToken / rotatedTokenWaitMs) before giving up.",
  );
});

test("multi-tab rotation race: token-update event wakes the loser without sleeping to the timeout", async () => {
  // Polling remains a compatibility fallback, but the browser path should wake
  // from authTokenSync's storage/BroadcastChannel signal when the winner writes
  // the rotated token. With a 5s poll interval, this test would otherwise sleep
  // to the 2s timeout before retrying.
  const { mkA, mkB } = makeWorld({
    winnerPropagateMs: 300,
    rotatedTokenWaitMs: 2000,
    rotatedTokenPollMs: 5000,
    emitTokenUpdates: true,
  });

  const started = Date.now();
  const results = await Promise.allSettled([mkA().refresh(), mkB().refresh()]);
  const elapsed = Date.now() - started;
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  assert.equal(rejected.length, 0, "both tabs must recover once the token-update event fires");
  assert.ok(
    elapsed < 1200,
    `losing tab should wake from token-update event, not wait for the 2s fallback timeout (elapsed ${elapsed}ms)`,
  );
});

test("multi-tab rotation cascade: five tabs adopt the winner token pair instead of re-rotating until the retry limit leaks a 401", async () => {
  const world = makeCascadeWorld(5);

  const results = await world.refreshAll();
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  assert.equal(
    rejected.length,
    0,
    "all five tabs must recover by adopting the observed access+refresh token pair; " +
      `retrying with each observed refresh token causes a cascade and leaks ${rejected[0]?.reason?.response?.status}`,
  );
  assert.equal(
    world.events.filter((event) => event.includes(":rotate:")).length,
    1,
    `only the first winner should rotate the refresh token; losers should adopt instead: ${world.events.join(", ")}`,
  );
});

test("multi-tab rotation race: browser default wait covers slow token propagation beyond 3s", async () => {
  // This is the remaining user-reported shape after #2781: the fixed 250ms
  // grace was removed, but the browser default was still too short for a slow
  // winner response. A 3.4s propagation fails under the old 3s default and
  // succeeds with the longer bounded wait.
  const { mkA, mkB } = makeWorld({ winnerPropagateMs: 3400 });

  const results = await Promise.allSettled([mkA().refresh(), mkB().refresh()]);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  assert.equal(
    rejected.length,
    0,
    "both tabs must recover when the winner's rotated token lands after the old 3s wait bound",
  );
});

test("backstop: genuine refresh-token revocation still rejects within the wait bound (no infinite hang)", async () => {
  // Server revokes everyone; no rotation ever lands in the store. The loser must
  // NOT wait forever — it must surface the 4xx after at most rotatedTokenWaitMs.
  const waitMs = 500;
  const { mkA, mkB } = makeWorld({ winnerPropagateMs: 0, rotatedTokenWaitMs: waitMs, revokeAll: true });

  const started = Date.now();
  const results = await Promise.allSettled([mkA().refresh(), mkB().refresh()]);
  const elapsed = Date.now() - started;

  assert.ok(
    results.every((r) => r.status === "rejected"),
    "true revocation (no rotation) must reject both tabs, not resolve",
  );
  assert.ok(
    elapsed < waitMs + 1500,
    `revocation must surface within ~rotatedTokenWaitMs, not hang (elapsed ${elapsed}ms)`,
  );
});

test("weak-network: a network error (no HTTP response) surfaces transiently — no rotation-wait hang, no auth status", async () => {
  // xxchan 6/17: logout is likely tied to weak/dropped network. A refresh that
  // fails with NO HTTP response (dropped connection / timeout) is NOT an auth
  // rejection: isAuthErrorStatus(undefined) is false, so the coordinator must
  // skip the rotation-wait branch entirely and surface the error via its bounded
  // retries. It must (a) reject (transient — the auth policy then keeps the
  // session, see authVerdict.test.ts weak-network matrix), (b) carry no 401/403
  // status, and (c) NOT sit in the long rotatedTokenWait. A large wait bound here
  // would make this test slow if the coordinator wrongly entered the wait.
  const waitMs = 5000;
  const { mkA, mkB } = makeWorld({ winnerPropagateMs: 0, rotatedTokenWaitMs: waitMs, networkErrorAll: true });

  const started = Date.now();
  const results = await Promise.allSettled([mkA().refresh(), mkB().refresh()]);
  const elapsed = Date.now() - started;

  assert.ok(
    results.every((r) => r.status === "rejected"),
    "a persistent network error must reject (transient), not resolve",
  );
  for (const r of results) {
    const status = (r as PromiseRejectedResult).reason?.response?.status;
    assert.equal(
      status,
      undefined,
      "a network error must carry no 401/403 — so the auth policy keeps the session instead of logging out",
    );
  }
  assert.ok(
    elapsed < waitMs,
    `network error must surface via bounded retries, NOT sit in the ${waitMs}ms rotation-wait (elapsed ${elapsed}ms)`,
  );
});

test("background-frozen winner residual: server replay grace lets the loser recover without logout", async () => {
  // The 6/24 residual (xxchan recurring logout). Models a winner tab that
  // rotates server-side (single-use-invalidating the loser's RT0) but then
  // FREEZES before publishing the new token: it only writeTokens/emits at
  // winnerPropagateMs=1500ms, far beyond the loser's bounded wait budget
  // (rotatedTokenWaitMs=100 × ≤3 retries). #2976's event-driven wait + #3042's
  // adopt-pair can't help — there is no token in the shared store and no
  // BroadcastChannel emit within the window. The server must replay the
  // just-created child session for the recently consumed old token, otherwise
  // the loser sees a terminal 401 even though the session was not revoked.
  const { mkA, mkB } = makeWorld({
    winnerPropagateMs: 1500,
    rotatedTokenWaitMs: 100,
    rotatedTokenPollMs: 20,
    emitTokenUpdates: true,
    replayConsumedRotation: true,
  });
  const results = await Promise.allSettled([mkA().refresh(), mkB().refresh()]);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  const fulfilled = results.filter((r): r is PromiseFulfilledResult<RefreshTokens> => r.status === "fulfilled");

  assert.equal(
    rejected.length,
    0,
    "server replay grace must prevent the loser from treating a frozen winner's consumed RT0 as true revocation",
  );
  assert.deepEqual(
    fulfilled.map((r) => r.value),
    [
      { accessToken: "AT1", refreshToken: "RT1" },
      { accessToken: "AT1", refreshToken: "RT1" },
    ],
    "both tabs should converge on the same replayed child session",
  );
});
