import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { sessionFamilies, users } from "../db/schema";
import { dbTest } from "../test/integration/dbTest";
import { leaveRetiredSecondFactorFlagRowOff } from "../test/integration/secondFactor";
import * as gates from "./sessionIssueGate";

// Every place that issues or refreshes a user session, by file. A new caller
// (or one gone) fails here: a new way to sign in has to go through a gate in
// sessionIssueGate.ts, where a second factor will be required.
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** File → createSession calls and the gate calls that make their proofs. */
const SESSION_ISSUERS: Record<string, { createSession: number; gates: Record<string, number> }> = {
  "routes/appLogin.ts": { createSession: 1, gates: { proofForAppLogin: 1 } },
  // Register, and finishSocialSignIn (web + mobile social, first and second step).
  "routes/auth.ts": {
    createSession: 2,
    gates: { proofForMobileSocialLogin: 1, proofForSignup: 1, proofForSocialLogin: 1 },
  },
  // The device-code poll (consumeDeviceAuthorization): the device session, issued in the consume's
  // transaction while the approving web sign-in is live.
  "services/deviceAuthService.ts": { createSession: 1, gates: { proofForDeviceLogin: 1 } },
  // Passkey sign-in: its proof, from the consumed passkey_login challenge (the session: userService).
  "services/secondFactor/passkeySignIn.ts": { createSession: 0, gates: { proofForPasskeyLogin: 1 } },
  // The second step of a password or social sign-in: its proof, from the consumed challenge
  // (answered with a factor, or by finishing a two-step verification recovery request).
  "services/secondFactor/signIn.ts": { createSession: 0, gates: { proofForSecondFactorRecovered: 1, proofForSecondFactorVerified: 1 } },
  // signInLocked (password first and second step, passkey sign-in).
  "services/userService.ts": { createSession: 1, gates: { proofForPasswordLogin: 1 } },
  // SSO sign-in (rfcs/083-server-sso.md §5.4): the IdP's answer, after identity resolution.
  // and finishSsoSecondStep (its second step; the proof comes from services/secondFactor/signIn.ts).
  "services/sso/ssoSignIn.ts": { createSession: 2, gates: { proofForSsoLogin: 1 } },
};

/**
 * Every gate sessionIssueGate.ts exports, by what it may answer. A new gate
 * fails "every gate is classified" until it is listed here; a first-factor
 * gate is then exercised against an enforced person below.
 */
const FIRST_FACTOR_GATES = {
  proofForPasswordLogin: gates.proofForPasswordLogin,
  proofForSocialLogin: gates.proofForSocialLogin,
  proofForMobileSocialLogin: gates.proofForMobileSocialLogin,
  proofForSsoLogin: (userId: string) => gates.proofForSsoLogin(userId, "00000000-0000-4000-8000-000000000001"),
} as const;
/**
 * Never ask for a second factor: nothing enrolled yet (signup), or vouched for
 * by the approver (checked at approval). An app login also carries a verified
 * approver's second factor over (exercised below); a device login never does.
 */
const ALWAYS_ADMIT_GATES = ["proofForSignup", "proofForAppLogin", "proofForDeviceLogin"];
/**
 * Minted only from a consumed second-factor challenge: answered with a
 * factor, or by finishing a recovery request in the same transaction that
 * removed every factor (services/secondFactor/recovery.ts).
 */
const SECOND_STEP_GATES = ["proofForSecondFactorVerified", "proofForSecondFactorRecovered"];
/**
 * Both factors at once (design §2: a passkey with user verification), minted
 * only from a consumed passkey_login challenge, and only for a person passkey
 * sign-in is open to; exercised below.
 */
const BOTH_FACTOR_GATES = ["proofForPasskeyLogin"];

/**
 * Route files that answer with tokens of a session another listed issuer
 * created (they call no createSession and no gate themselves). Each names
 * that issuer.
 */
const TOKEN_RESPONDERS_OF_OTHER_ISSUERS: Record<string, string> = {
  // SSO sign-in (rfcs/083-server-sso.md §5): sessions come from services/sso/ssoSignIn.ts.
  "routes/sso.ts": "services/sso/ssoSignIn.ts",
  // The device-code poll: the session comes from consumeDeviceAuthorization (#12851).
  "routes/deviceAuth.ts": "services/deviceAuthService.ts",
};

/** File → calls of the refresh entries (rotation keeps a login, never starts one). */
const SESSION_REFRESHERS: Record<string, Record<string, number>> = {
  "routes/auth.ts": { refreshSessionWithTrace: 1 },
  "services/sessionService.ts": { rotateSession: 1, refreshSessionWithDurableReplay: 1, refreshSessionWithTrace: 1 },
};

const REFRESH_ENTRIES = ["rotateSession", "refreshSessionWithDurableReplay", "refreshSessionWithTrace", "refreshSession"];

function productionSources(): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    const file = entry.split("\\").join("/");
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
    if (file.startsWith("test/") || file.includes("/fixtures/") || file.includes("/testdata/")) continue;
    files.set(file, readFileSync(resolve(srcDir, file), "utf8"));
  }
  return files;
}

/** Calls of `name(`, not its definition (`function name(`). */
function countCalls(source: string, name: string): number {
  return [...source.matchAll(new RegExp(`(?<![\\w$])${name}\\(`, "g"))]
    .filter((match) => !/function\s*$/.test(source.slice(Math.max(0, match.index - 20), match.index)))
    .length;
}

/** The argument text of each `.json(...)`, parentheses balanced. */
function jsonBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/\.json\(/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < source.length && depth > 0) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")") depth--;
      end++;
    }
    bodies.push(source.slice(match.index + match[0].length, end - 1));
  }
  return bodies;
}

const sources = productionSources();

test("every createSession caller is listed with the gate that makes its proof", () => {
  const found: typeof SESSION_ISSUERS = {};
  for (const [file, source] of sources) {
    if (file === "services/sessionService.ts" || file === "services/sessionIssueGate.ts") continue;
    const createSession = countCalls(source, "createSession");
    const gates = Object.fromEntries(
      [...new Set([...source.matchAll(/(?<![\w$])(proofFor\w+)\(/g)].map((match) => match[1]!))]
        .sort()
        .map((gate) => [gate, countCalls(source, gate)]),
    );
    if (createSession > 0 || Object.keys(gates).length > 0) found[file] = { createSession, gates };
  }
  assert.deepEqual(found, SESSION_ISSUERS);
});

test("sessionService issues a session only from createSession, never in rotation", () => {
  const source = sources.get("services/sessionService.ts")!;
  // One family insert: createSession's. Rotation refuses a row with no family.
  assert.equal(source.match(/\.insert\(\s*sessionFamilies\s*\)/g)?.length, 1);
  assert.doesNotMatch(source, /familyId\s*\?\?\s*randomUUID\(\)/);
  assert.match(source, /export async function createSession\(\s*proof: SessionIssueProof,/);
});

test("every refresh entry caller is listed", () => {
  const found: typeof SESSION_REFRESHERS = {};
  for (const [file, source] of sources) {
    const calls = Object.fromEntries(
      REFRESH_ENTRIES.map((name) => [name, countCalls(source, name)] as const).filter(([, count]) => count > 0),
    );
    if (Object.keys(calls).length > 0) found[file] = calls;
  }
  assert.deepEqual(found, SESSION_REFRESHERS);
});

test("every route responding with an access and a refresh token is listed", () => {
  const responders = [...sources]
    .filter(([file]) => file.startsWith("routes/"))
    .filter(([, source]) => jsonBodies(source).some((body) => /\baccessToken\b/.test(body) && /\brefreshToken\b/.test(body)))
    .map(([file]) => file)
    .sort();
  // A floor, so a change in response syntax cannot silently empty the scan.
  assert.ok(responders.includes("routes/auth.ts"), `scan found ${responders.join(", ") || "nothing"}`);
  for (const issuer of Object.values(TOKEN_RESPONDERS_OF_OTHER_ISSUERS)) assert.ok(SESSION_ISSUERS[issuer], `${issuer} is a listed issuer`);
  const listed = new Set([...Object.keys(SESSION_ISSUERS), ...Object.keys(SESSION_REFRESHERS), ...Object.keys(TOKEN_RESPONDERS_OF_OTHER_ISSUERS)]);
  assert.deepEqual(responders.filter((file) => !listed.has(file)), []);
});

test("every gate is classified: first factor, always admits, second step, or both factors", () => {
  const exported = Object.keys(gates).filter((name) => name.startsWith("proofFor")).sort();
  assert.deepEqual(exported, [...Object.keys(FIRST_FACTOR_GATES), ...ALWAYS_ADMIT_GATES, ...SECOND_STEP_GATES, ...BOTH_FACTOR_GATES].sort());
});

// Design §7.3: with two-step verification on, a first factor alone issues no
// session. Every first-factor gate refuses a proof to a person who turned it on,
// whatever a leftover `auth_second_factor_v1` row says (the flag is retired,
// #raft-architecture:#32: even a row switched off changes nothing), and only to
// such a person.
for (const [name, gate] of Object.entries(FIRST_FACTOR_GATES)) {
  dbTest(`${name}: an enrolled person with only the first factor gets no proof, even with a leftover flag row off; anyone else does`, async ({ seed }) => {
    await leaveRetiredSecondFactorFlagRowOff();
    const enforced = await seed.human();
    await getDb().update(users).set({ secondFactorRequiredAt: new Date() }).where(eq(users.id, enforced.id));
    const refused = await gate(enforced.id);
    assert.equal(refused.secondFactorRequired, true);
    assert.equal("proof" in refused, false);

    const notEnrolled = await seed.human();
    const admitted = await gate(notEnrolled.id);
    assert.equal(admitted.secondFactorRequired, false);
    assert.equal(admitted.secondFactorRequired === false && admitted.proof.secondFactor, "not_required");
  });
}

test("the second-step gate takes only a second-factor sign-in challenge", () => {
  const row = { id: "c", userId: "u", kind: "second_factor_login" as const, flow: "password_login", payload: null, attempts: 1, expiresAt: new Date() };
  assert.deepEqual(
    { ...gates.proofForSecondFactorVerified(row, "totp") },
    { flow: "password_login", userId: "u", secondFactor: "verified", method: "totp", challengeId: "c" },
  );
  assert.throws(() => gates.proofForSecondFactorVerified({ ...row, kind: "webauthn_assertion" }, "totp"));
  assert.throws(() => gates.proofForSecondFactorVerified({ ...row, flow: "signup" }, "totp"));
  assert.throws(() => gates.proofForSecondFactorVerified({ ...row, userId: null }, "totp"));
});

const passkeyLoginRow = { id: "c", userId: null, kind: "webauthn_assertion" as const, flow: "passkey_login", payload: null, attempts: 5, expiresAt: new Date() };

test("the passkey gate takes only a passkey sign-in challenge", async () => {
  const passkey = { userId: "00000000-0000-4000-8000-000000000000", passkeyId: "p" };
  await assert.rejects(gates.proofForPasskeyLogin({ ...passkeyLoginRow, kind: "second_factor_login" }, passkey));
  await assert.rejects(gates.proofForPasskeyLogin({ ...passkeyLoginRow, flow: null }, passkey));
  // A step-up or second-step assertion challenge is bound to a person: never a sign-in.
  await assert.rejects(gates.proofForPasskeyLogin({ ...passkeyLoginRow, userId: passkey.userId }, passkey));
});

dbTest("proofForPasskeyLogin: both factors for every active person, enforced or not, even with a leftover flag row off; nothing for retired people", async ({ seed }) => {
  await leaveRetiredSecondFactorFlagRowOff();
  const enforced = await seed.human();
  await getDb().update(users).set({ secondFactorRequiredAt: new Date() }).where(eq(users.id, enforced.id));
  const notEnrolled = await seed.human();
  for (const person of [enforced, notEnrolled]) {
    const proof = await gates.proofForPasskeyLogin(passkeyLoginRow, { userId: person.id, passkeyId: "p" });
    assert.deepEqual(
      { ...proof },
      { flow: "passkey_login", userId: person.id, secondFactor: "verified", method: "passkey", challengeId: "c", passkeyId: "p" },
    );
  }

  const retired = await seed.human();
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, retired.id));
  assert.equal(await gates.proofForPasskeyLogin(passkeyLoginRow, { userId: retired.id, passkeyId: "p" }), null);
});

dbTest("proofForAppLogin inherits the approver's verification only from their own live, verified full family; proofForDeviceLogin never", async ({ seed }) => {
  const person = await seed.human();
  const other = await seed.human();
  const verifiedAt = new Date(Date.now() - 9 * 60_000);
  const family = async (values: Partial<typeof sessionFamilies.$inferInsert> = {}) => {
    const [row] = await getDb().insert(sessionFamilies)
      .values({ userId: person.id, scope: "full", secondFactorVerifiedAt: verifiedAt, secondFactorMethod: "totp", ...values })
      .returning({ id: sessionFamilies.id });
    return row!.id;
  };
  const verified = await family();
  assert.deepEqual(
    { ...(await gates.proofForAppLogin(person.id, verified)) },
    { flow: "app_login", userId: person.id, approverFamilyId: verified, secondFactor: "verified", method: "totp", verifiedAt },
  );

  const notInherited = {
    none: null,
    unverified: await family({ secondFactorVerifiedAt: null, secondFactorMethod: null }),
    otherPerson: await family({ userId: other.id }),
    device: await family({ scope: "device" }),
    revoked: await family({ revokedAt: new Date(), revokedReason: "logout" }),
    retired: await family({ retiredAt: new Date(), retiredReason: "migration" }),
  };
  for (const [name, approverFamilyId] of Object.entries(notInherited)) {
    assert.deepEqual(
      { ...(await gates.proofForAppLogin(person.id, approverFamilyId)) },
      { flow: "app_login", userId: person.id, approverFamilyId, secondFactor: "not_required" },
      name,
    );
  }

  // A device login's long-lived session never inherits, even from a verified approver.
  assert.deepEqual(
    { ...(await gates.proofForDeviceLogin(person.id, verified)) },
    { flow: "device_login", userId: person.id, approverFamilyId: verified, secondFactor: "not_required" },
  );
});
