import { test } from "node:test";
import assert from "node:assert/strict";

import { getAuthVerdict } from "../src/utils/authVerdict";
import type { AuthVerdict, AuthVerdictSignal } from "../src/utils/authVerdict";
import type { AuthRestoreState } from "../src/utils/authRestoreMachine";

// L1 — getAuthVerdict exhaustive truth table (Auth Session Contract, PR #2494).
//
// This pins the SINGLE clear-session oracle. Both the auth store (loadUser) and
// the api/client.ts interceptor funnel their "should this failure clear the
// session?" decision through getAuthVerdict. The contract invariant being locked:
//
//   A persisted session is cleared (verdict "logout") IF AND ONLY IF the refresh
//   credential is absent OR was definitively rejected by the server (HTTP 401/403
//   on /auth/refresh or the post-refresh /auth/me). Every other failure
//   (network / undefined status / 5xx / timeout / 429 / 408 / CORS) MUST yield
//   keep-session, defer-to-auth-restore, or retry — never logout.
//
// Expected verdicts below are written out EXPLICITLY per the contract, NOT
// re-derived from the implementation, so that any future change to getAuthVerdict
// that deviates from the contract trips this test.

const TERMINAL_STATUSES: ReadonlyArray<number> = [401, 403];
const TRANSIENT_STATUSES: ReadonlyArray<number | undefined> = [
  undefined, // network error / aborted / CORS — no HTTP status
  0,
  408, // request timeout
  429, // rate limited
  500,
  502,
  503,
];
const ALL_STATUSES: ReadonlyArray<number | undefined> = [...TERMINAL_STATUSES, ...TRANSIENT_STATUSES];
const RESTORE_STATES: ReadonlyArray<AuthRestoreState> = ["booting", "signed_out", "restoring_auth", "authenticated"];
const BOOLS: ReadonlyArray<boolean> = [true, false];

function isTerminalStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

// ── refresh_succeeded: always retry the original request, never clear ──
test("verdict[refresh_succeeded] is always retry regardless of restore context", () => {
  for (const initialized of BOOLS) {
    for (const restoreState of RESTORE_STATES) {
      const verdict = getAuthVerdict({
        signal: { type: "refresh_succeeded" },
        initialized,
        restoreState,
      });
      assert.equal(
        verdict,
        "retry",
        `refresh_succeeded must always be retry (initialized=${initialized}, restoreState=${restoreState})`,
      );
    }
  }
});

// ── refresh_failed: logout IFF (no refresh token) OR (server rejected 401/403) ──
test("verdict[refresh_failed] logs out only on missing refresh token or terminal 401/403", () => {
  for (const status of ALL_STATUSES) {
    for (const hasRefreshToken of BOOLS) {
      for (const initialized of BOOLS) {
        for (const restoreState of RESTORE_STATES) {
          const signal: AuthVerdictSignal = { type: "refresh_failed", status, hasRefreshToken };
          const verdict = getAuthVerdict({ signal, initialized, restoreState });

          const expected: AuthVerdict =
            !hasRefreshToken || isTerminalStatus(status) ? "logout" : "keep-session";

          assert.equal(
            verdict,
            expected,
            `refresh_failed{status=${status},hasRefreshToken=${hasRefreshToken}} ` +
              `(initialized=${initialized},restoreState=${restoreState}) expected ${expected}, got ${verdict}`,
          );
        }
      }
    }
  }
});

// ── refresh_failed transient invariant: a present refresh token + non-auth status never logs out ──
test("verdict[refresh_failed] keeps the session on every transient status when a refresh token exists", () => {
  for (const status of TRANSIENT_STATUSES) {
    const verdict = getAuthVerdict({
      signal: { type: "refresh_failed", status, hasRefreshToken: true },
      initialized: true,
      restoreState: "authenticated",
    });
    assert.equal(
      verdict,
      "keep-session",
      `transient refresh_failed{status=${status}} with a refresh token must keep-session, got ${verdict}`,
    );
  }
});

// ── post_refresh_me_failed: transient → keep-session; terminal → defer during restore, else logout ──
test("verdict[post_refresh_me_failed] keeps the session on every transient status", () => {
  for (const status of TRANSIENT_STATUSES) {
    for (const initialized of BOOLS) {
      for (const restoreState of RESTORE_STATES) {
        const verdict = getAuthVerdict({
          signal: { type: "post_refresh_me_failed", status },
          initialized,
          restoreState,
        });
        assert.equal(
          verdict,
          "keep-session",
          `post_refresh_me_failed{status=${status}} (transient) must keep-session ` +
            `(initialized=${initialized},restoreState=${restoreState}), got ${verdict}`,
        );
      }
    }
  }
});

test("verdict[post_refresh_me_failed] defers terminal 401/403 while restore is unsettled, else logs out", () => {
  for (const status of TERMINAL_STATUSES) {
    for (const initialized of BOOLS) {
      for (const restoreState of RESTORE_STATES) {
        const verdict = getAuthVerdict({
          signal: { type: "post_refresh_me_failed", status },
          initialized,
          restoreState,
        });
        const unsettled = !initialized || restoreState === "restoring_auth";
        const expected: AuthVerdict = unsettled ? "defer-to-auth-restore" : "logout";
        assert.equal(
          verdict,
          expected,
          `post_refresh_me_failed{status=${status}} (initialized=${initialized},` +
            `restoreState=${restoreState}) expected ${expected}, got ${verdict}`,
        );
      }
    }
  }
});

// ── Global invariant sweep: logout never appears for a transient signal ──
test("no transient-evidence signal ever yields logout (contract: only absent/rejected credential clears)", () => {
  const transientSignals: AuthVerdictSignal[] = [
    ...TRANSIENT_STATUSES.map((status): AuthVerdictSignal => ({ type: "refresh_failed", status, hasRefreshToken: true })),
    ...TRANSIENT_STATUSES.map((status): AuthVerdictSignal => ({ type: "post_refresh_me_failed", status })),
    { type: "refresh_succeeded" },
  ];
  for (const signal of transientSignals) {
    for (const initialized of BOOLS) {
      for (const restoreState of RESTORE_STATES) {
        const verdict = getAuthVerdict({ signal, initialized, restoreState });
        assert.notEqual(
          verdict,
          "logout",
          `transient signal ${JSON.stringify(signal)} must never logout ` +
            `(initialized=${initialized},restoreState=${restoreState}), got ${verdict}`,
        );
      }
    }
  }
});
