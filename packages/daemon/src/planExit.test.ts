// Reconciler step 10a: the pure exit rule (planExit.ts). The table lives in
// testing/planExitCases.ts so the OAR host (step 10b) can run the same rows.
//
// RED proof (reverse-verified): drop `handToServer` (the cap) and the
// "capped" rows start again; stop counting a D5 crash and "capped: the fifth
// crash" keeps restarting; keepSnapshot false for a crash and the D5 rows fail;
// count a D3 close toward the cap again and the "never capped" rows hand off.

import { CRASH_STREAK_CAP, crashStreakBackoffMs, crashStreakExhausted, planExit, type RecoverableExitError } from "./planExit";
import { PLAN_EXIT_CASES } from "./testing/planExitCases";
import type { SessionChoice } from "./chooseSession";

function sessionKind(choice: SessionChoice): string {
  if (choice.kind !== "new") return choice.kind;
  return choice.reason === "resume_failed" ? `new:resume_failed:${choice.cause}` : `new:${choice.reason}`;
}

describe("planExit: rows D1-D5, D13 and the expected terminations", () => {
  test.each(PLAN_EXIT_CASES.map((c) => [`${c.row}: ${c.name}`, c] as const))("%s", (_label, c) => {
    const plan = planExit(c.facts);
    const { sessionKind: expectedSession, ...expected } = c.expect;
    // A key expected as undefined must be absent.
    for (const [key, value] of Object.entries(expected)) if (value === undefined) expect(plan, key).not.toHaveProperty(key);
    expect(plan).toMatchObject(Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== undefined)));
    if (expectedSession) expect(sessionKind(plan.session)).toBe(expectedSession);
  });

  test("every row and expected termination has a case", () => {
    const rows = new Set(PLAN_EXIT_CASES.map((c) => c.row));
    for (const row of ["D1", "D2", "D3", "D4", "D5", "D6", "D13", "turn_end", "stalled_recovery", "cold_idle_recycle", "turn_interrupt", "startup_timeout", "startup_request_error", "explicit_stop"]) {
      expect(rows.has(row), row).toBe(true);
    }
  });

  test("the snapshot stays unless the server owns the next start", () => {
    for (const c of PLAN_EXIT_CASES) {
      const plan = planExit(c.facts);
      expect(plan.keepSnapshot, c.name).toBe(!(plan.handToServer || plan.kind === "startup_request_error" || plan.kind === "stopped"));
    }
  });

  test("the sessionFacts are what chooseSession decided from", () => {
    for (const c of PLAN_EXIT_CASES) {
      const plan = planExit(c.facts);
      expect(plan.sessionFacts.sessionId, c.name).toBe(c.facts.session.sessionId);
    }
  });
});

describe("the crash streak (D3, D5, D12 share the backoff; the cap skips D3)", () => {
  test(`exhausted from the ${CRASH_STREAK_CAP}th failure in a row`, () => {
    expect([1, 2, 3, 4, 5, 6].map(crashStreakExhausted)).toEqual([false, false, false, false, true, true]);
  });

  test("backoff: base, doubling, capped", () => {
    const policy = { baseMs: 1_000, maxMs: 30_000, jitterRatio: 0, jitterUnit: 0 };
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => crashStreakBackoffMs(n, policy))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  test("consecutive crashes of any kind grow the backoff; only those not D3 count toward the cap", () => {
    let streak = 0;
    let cap = 0;
    const kinds: string[] = [];
    const crash = (recoverableError: RecoverableExitError | null) => planExit({ ...PLAN_EXIT_CASES[0]!.facts, code: 1, turnBoundarySatisfied: false, runtimeError: true, recoverableError, crashStreak: streak, capStreak: cap });
    for (const c of ["provider_connection_error", null, "rate_limited", null, "provider_server_error", null, null] as const) {
      const plan = crash(c);
      streak = plan.crashStreak;
      cap = plan.capStreak;
      kinds.push(plan.kind);
      expect(plan.handToServer).toBe(false);
    }
    expect(kinds).toEqual(["recoverable", "crash", "recoverable", "crash", "recoverable", "crash", "crash"]);
    expect([streak, cap]).toEqual([7, 4]);
    // However long the provider stays down, its closes never hand off.
    for (let i = 0; i < 20; i += 1) {
      const plan = crash("provider_connection_error");
      expect(plan).toMatchObject({ kind: "recoverable", handToServer: false, capStreak: 4 });
      streak = plan.crashStreak;
    }
    expect(crash(null)).toMatchObject({ handToServer: true, start: "none", capStreak: CRASH_STREAK_CAP });
  });
});
