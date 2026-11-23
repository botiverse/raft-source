import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { computerPairings, deviceAuthorizations, integrationAuditEvents, serverMembers, users } from "../db/schema";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { __resetLatestComputerVersionForTest } from "../services/computerVersionService";
import { claimComputerPairing, COMPUTER_PAIRING_MAX_LIFETIME_MS, COMPUTER_PAIRING_MIN_COMPUTER_VERSION, hashComputerPairingId, MAX_ACTIVE_COMPUTER_PAIRINGS } from "../services/computerPairingService";
import { approveDeviceAuthorization } from "../services/deviceAuthService";
import { revokeSession } from "../services/sessionService";
import { openTestApp } from "../test/integration/app";
import { signInForTest, signInThroughSecondStepForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
useTotpSecretKey();

// Computer pairing (design "one-click Computer login" §11 B, Tenny's
// conditions 937c6726; docs/contracts/computer-pairing.md): the Add Computer
// window's pairing, the Computer's device authorization linked to it by
// `pairingId`, and approval through it.

const PEPPER = "device-code-test-pepper-0123456789abcdef";
const APP_URL = "https://app.raft.test";

type TestApp = Awaited<ReturnType<typeof openTestApp>>;
/** What the stubbed Hands answers per channel: a version, an Error (network failure), or undefined (404). */
const hands: { versions: Record<string, string | Error | undefined>; calls: number } = { versions: {}, calls: 0 };
type Emitted = { room: string; event: string; payload: unknown };

async function withApp<T>(fn: (app: TestApp, ctx: { mailbox: EmailDelivery[]; emitted: Emitted[]; sink: MemoryTraceSink }) => Promise<T>): Promise<T> {
  const oldGate = process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  const oldPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  const oldAppUrl = process.env.APP_URL;
  delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = PEPPER;
  process.env.APP_URL = APP_URL;
  const mailbox: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => mailbox.push(delivery));
  // Hands: what each install channel serves (create pairs only from a Computer that takes --pair).
  __resetLatestComputerVersionForTest();
  hands.versions = { main: "1.25.8", alpha: "1.25.9-staging.20261120000000.sha.0123456789ab" };
  hands.calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://hands.build/")) return realFetch(input, init);
    hands.calls += 1;
    const answer = hands.versions[new URL(url).searchParams.get("channel") ?? ""];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return new Response("not found", { status: 404 });
    return Response.json({ release: { version: answer } });
  }) as typeof fetch;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  // What the routes emit, by room; and every span, to look for the raw id in.
  const emitted: Emitted[] = [];
  const realIo = app.app.get("io");
  app.app.set("io", { to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }) });
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  try {
    return await fn(app, { mailbox, emitted, sink });
  } finally {
    app.app.set("io", realIo);
    await app.close();
    globalThis.fetch = realFetch;
    __resetLatestComputerVersionForTest();
    __setEmailDeliveryObserverForTests(null);
    if (oldGate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = oldGate;
    if (oldPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
    else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = oldPepper;
    if (oldAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldAppUrl;
  }
}

async function seedUser(): Promise<{ id: string; bearer: string; familyId: string; refreshToken: string }> {
  const suffix = randomUUID();
  const [u] = await getDb().insert(users).values({
    email: `pairing-${suffix}@slock.test`,
    name: `pairing-${suffix}`,
    displayName: "Pairing Tester",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const web = await signInForTest(u!.id);
  return { id: u!.id, bearer: web.token, familyId: web.familyId, refreshToken: web.refreshToken };
}

async function post(app: TestApp, path: string, body: unknown, token?: string) {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

const ATTACH = { kind: "computer_attach", machineName: "mac-mini", hostname: "mac-mini.lan", os: "Linux x64" };

async function createPairing(app: TestApp, bearer: string, serverId: string) {
  const res = await post(app, `/api/servers/${serverId}/computer-pairings`, { channel: "main" }, bearer);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { pairingId: string; pairingRef: string; serverId: string; expiresAt: string };
}

/** What `raft-computer setup /<slug> --pair <id>` sends (an older Computer sends neither field). */
async function authorize(app: TestApp, extra: Record<string, unknown> = {}) {
  const res = await post(app, "/api/auth/device/authorize", { clientName: "raft-computer", grant: ATTACH, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { deviceCode: string; userCode: string; paired?: boolean };
}

const status = (app: TestApp, bearer: string, pairingId: string) => post(app, "/api/computer-pairings/status", { pairingId }, bearer);

async function approveByCode(app: TestApp, bearer: string, userCode: string, serverId: string) {
  const described = await post(app, "/api/auth/device/describe", { userCode }, bearer);
  assert.equal(described.status, 200, JSON.stringify(described.body));
  return post(app, "/api/auth/device/approve", { userCode, approvalTicket: described.body.approvalTicket, serverId }, bearer);
}

async function mailCount(mailbox: EmailDelivery[], n: number) {
  for (let i = 0; i < 100 && mailbox.length < n; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailbox.length, n);
}

async function pairingRow(pairingRef: string) {
  const [row] = await getDb().select().from(computerPairings).where(eq(computerPairings.id, pairingRef));
  return row!;
}

test("pairing end to end: create → authorize with pairingId → event and status show the request → approve through the pairing → the token poll gets the attach grant, mailed on attach", async () => {
  await withApp(async (app, { mailbox, emitted, sink }) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);

    const pairing = await createPairing(app, owner.bearer, server.id);
    assert.match(pairing.pairingId, /^[A-Za-z0-9_-]{43}$/, "256 random bits, base64url");
    assert.equal(pairing.serverId, server.id);
    const expiresIn = new Date(pairing.expiresAt).getTime() - Date.now();
    assert.ok(expiresIn > 590_000 && expiresIn <= 600_000, String(expiresIn));
    // Only the hash is stored.
    const stored = await pairingRow(pairing.pairingRef);
    assert.equal(stored.pairingHash, hashComputerPairingId(pairing.pairingId));
    assert.equal(stored.sessionFamilyId, owner.familyId);
    assert.deepEqual((await status(app, owner.bearer, pairing.pairingId)).body.state, "waiting");

    const login = await authorize(app, { pairingId: pairing.pairingId, serverSlug: `/${server.slug}` });
    assert.equal(login.paired, true);
    assert.match(login.userCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/, "the terminal still gets its code");
    // Only to the pairing's owner, and only the row id.
    assert.deepEqual(emitted, [{ room: `user:${owner.id}`, event: "computer_pairing:requested", payload: { pairingRef: pairing.pairingRef } }]);

    const requested = await status(app, owner.bearer, pairing.pairingId);
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    assert.equal(requested.body.state, "requested");
    const request = requested.body.request;
    assert.equal(request.userCode, login.userCode);
    assert.deepEqual(request.grant, { kind: "computer_attach", machineName: "mac-mini", hostname: "mac-mini.lan", os: "Linux x64" });
    assert.equal(request.clientName, "raft-computer");
    assert.ok("requester" in request && typeof request.requestedAt === "string");
    assert.equal(typeof request.approvalTicket, "string");

    // Approve needs the ticket status issued, as the device page's does.
    const noTicket = await post(app, "/api/computer-pairings/approve", { pairingId: pairing.pairingId }, owner.bearer);
    assert.deepEqual([noTicket.status, noTicket.body.code], [400, "approval_ticket_required"]);
    assert.equal((await pairingRow(pairing.pairingRef)).consumedAt, null, "a refused approval leaves the pairing usable");

    const pending = await post(app, "/api/auth/device/token", { deviceCode: login.deviceCode });
    assert.deepEqual([pending.status, pending.body.code], [400, "authorization_pending"]);

    const approved = await post(app, "/api/computer-pairings/approve", { pairingId: pairing.pairingId, approvalTicket: request.approvalTicket }, owner.bearer);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.action, "approved");
    assert.ok((await pairingRow(pairing.pairingRef)).consumedAt, "consumed");
    assert.equal((await status(app, owner.bearer, pairing.pairingId)).body.state, "approved");

    // The Computer's ordinary poll gets the ordinary grant, for the pairing's server.
    const token = await post(app, "/api/auth/device/token", { deviceCode: login.deviceCode });
    assert.equal(token.status, 200, JSON.stringify(token.body));
    assert.equal(token.body.kind, "computer_attach");
    assert.equal(token.body.serverId, server.id);
    assert.match(token.body.attachToken, /^dvat_/);
    const attached = await post(app, "/api/computer/attach", {}, token.body.attachToken);
    assert.equal(attached.status, 201, JSON.stringify(attached.body));
    await mailCount(mailbox, 1);
    assert.equal(mailbox[0]!.subject, "You added a machine to Acme — Raft");
    assert.match(mailbox[0]!.html, /\?revoke_device_login=dvcr_/);

    // Consumed: no second approval, no renew.
    const again = await post(app, "/api/computer-pairings/approve", { pairingId: pairing.pairingId, approvalTicket: request.approvalTicket }, owner.bearer);
    assert.deepEqual([again.status, again.body.code], [409, "computer_pairing_ended"]);
    const renew = await post(app, "/api/computer-pairings/renew", { pairingId: pairing.pairingId }, owner.bearer);
    assert.deepEqual([renew.status, renew.body.code], [409, "computer_pairing_ended"]);

    // Rule 4: traces and audit name the pairing by its row id, never the raw id.
    const spans = JSON.stringify(sink.getAllSpans());
    assert.ok(spans.includes(pairing.pairingRef), "traces name the pairing by its row id");
    assert.ok(spans.includes("computer_pairing.linked"));
    assert.ok(spans.includes("computer_pairing_ref"), "the approval trace names the pairing");
    assert.equal(spans.includes(pairing.pairingId), false, "no raw pairing id in any span");
    const audit = JSON.stringify(await getDb().select().from(integrationAuditEvents));
    assert.equal(audit.includes(pairing.pairingId), false, "no raw pairing id in the audit");
    assert.equal(JSON.stringify(emitted).includes(pairing.pairingId), false, "no raw pairing id in events");
  });
});

test("a second request with the same pairing id voids it: neither is approvable through it, both user codes still work on the device page", async () => {
  await withApp(async (app, { emitted }) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const pairing = await createPairing(app, owner.bearer, server.id);
    const mine = await authorize(app, { pairingId: pairing.pairingId, serverSlug: server.slug });
    const ticket = (await status(app, owner.bearer, pairing.pairingId)).body.request.approvalTicket;
    const theirs = await authorize(app, { pairingId: pairing.pairingId, serverSlug: server.slug });
    assert.equal(mine.paired, true);
    assert.equal(theirs.paired, false);
    assert.deepEqual(emitted.map((e) => [e.room, e.event, e.payload]), [
      [`user:${owner.id}`, "computer_pairing:requested", { pairingRef: pairing.pairingRef }],
      [`user:${owner.id}`, "computer_pairing:voided", { pairingRef: pairing.pairingRef, reason: "conflict" }],
    ]);
    const row = await pairingRow(pairing.pairingRef);
    assert.ok(row.conflictAt && row.voidedAt);
    assert.equal(row.voidReason, "conflict");

    const read = await status(app, owner.bearer, pairing.pairingId);
    assert.equal(read.body.state, "conflict");
    assert.equal("request" in read.body, false);
    // The ticket read before the conflict doesn't help either.
    const refused = await post(app, "/api/computer-pairings/approve", { pairingId: pairing.pairingId, approvalTicket: ticket }, owner.bearer);
    assert.deepEqual([refused.status, refused.body.code], [409, "computer_pairing_conflict"]);
    // A third request isn't linked either.
    assert.equal((await authorize(app, { pairingId: pairing.pairingId, serverSlug: server.slug })).paired, false);

    // Rule 5: both stay ordinary device authorizations.
    for (const login of [mine, theirs]) {
      const approved = await approveByCode(app, owner.bearer, login.userCode, server.id);
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
    }
  });
});

test("a conflict that lands after the window read the pairing as requested: the approval's claim refuses, nothing is approved", async () => {
  await withApp(async (app) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const pairing = await createPairing(app, owner.bearer, server.id);
    const mine = await authorize(app, { pairingId: pairing.pairingId, serverSlug: server.slug });
    const ticket = (await status(app, owner.bearer, pairing.pairingId)).body.request.approvalTicket;
    const linkedId = (await pairingRow(pairing.pairingRef)).linkedDeviceAuthorizationId!;
    // The route checked the pairing; then the second request voids it before the approval's transaction.
    await getDb().update(computerPairings).set({ conflictAt: new Date(), voidedAt: new Date(), voidReason: "conflict" }).where(eq(computerPairings.id, pairing.pairingRef));
    const result = await approveDeviceAuthorization({
      linkedAuthorizationId: linkedId,
      userId: owner.id,
      approve: true,
      approvalTicket: ticket,
      selection: { serverId: server.id },
      approverSessionFamilyId: owner.familyId,
      claim: claimComputerPairing(pairing.pairingRef, linkedId),
    });
    assert.deepEqual(result, { ok: false, error: "pairing_unavailable" });
    const [auth] = await getDb().select().from(deviceAuthorizations).where(eq(deviceAuthorizations.userCode, mine.userCode));
    assert.equal(auth!.status, "pending");
    assert.equal((await pairingRow(pairing.pairingRef)).consumedAt, null);
  });
});

test("only the sign-in that created the pairing can read, renew, cancel or approve through it (404 to another session and another person)", async () => {
  await withApp(async (app) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const pairing = await createPairing(app, owner.bearer, server.id);
    await authorize(app, { pairingId: pairing.pairingId, serverSlug: server.slug });
    const ticket = (await status(app, owner.bearer, pairing.pairingId)).body.request.approvalTicket;

    const otherSession = (await signInForTest(owner.id)).token;
    const otherPerson = await seedUser();
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: otherPerson.id, role: "admin" });
    for (const bearer of [otherSession, otherPerson.bearer]) {
      for (const path of ["status", "renew", "cancel", "approve"]) {
        const res = await post(app, `/api/computer-pairings/${path}`, { pairingId: pairing.pairingId, approvalTicket: ticket }, bearer);
        assert.deepEqual([path, res.status, res.body.code], [path, 404, "computer_pairing_not_found"]);
      }
    }
    // Unknown and malformed ids answer the same.
    for (const pairingId of [randomBytes(32).toString("base64url"), "nope", 42]) {
      const res = await post(app, "/api/computer-pairings/status", { pairingId }, owner.bearer);
      assert.deepEqual([res.status, res.body.code], [404, "computer_pairing_not_found"]);
    }
    // Signed out: no token at all.
    assert.equal((await post(app, "/api/computer-pairings/status", { pairingId: pairing.pairingId })).status, 401);
    assert.equal((await status(app, owner.bearer, pairing.pairingId)).body.state, "requested", "untouched");
  });
});

test("approving through the pairing needs the same two-step step-up as the device page", async () => {
  await withApp(async (app) => {
    // Signed in before two-step verification was turned on: this sign-in never passed it.
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const pairing = await createPairing(app, owner.bearer, server.id);
    await enrollSecondFactor(owner.id);
    await authorize(app, { pairingId: pairing.pairingId, serverSlug: server.slug });
    const ticket = (await status(app, owner.bearer, pairing.pairingId)).body.request.approvalTicket;
    const refused = await post(app, "/api/computer-pairings/approve", { pairingId: pairing.pairingId, approvalTicket: ticket }, owner.bearer);
    assert.deepEqual([refused.status, refused.body.code], [403, "second_factor_step_up_required"]);
    assert.equal((await status(app, owner.bearer, pairing.pairingId)).body.state, "requested");

    // A sign-in that passed its second step approves through its own pairing.
    const verified = await signInThroughSecondStepForTest(owner.id);
    const own = await createPairing(app, verified.token, server.id);
    await authorize(app, { pairingId: own.pairingId, serverSlug: server.slug });
    const ownTicket = (await status(app, verified.token, own.pairingId)).body.request.approvalTicket;
    const approved = await post(app, "/api/computer-pairings/approve", { pairingId: own.pairingId, approvalTicket: ownTicket }, verified.token);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
  });
});

test("deny through the pairing: the poll is denied and the pairing is over", async () => {
  await withApp(async (app) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const pairing = await createPairing(app, owner.bearer, server.id);
    const login = await authorize(app, { pairingId: pairing.pairingId, serverSlug: server.slug });
    const denied = await post(app, "/api/computer-pairings/approve", { pairingId: pairing.pairingId, approve: false }, owner.bearer);
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    assert.equal(denied.body.action, "denied");
    assert.equal((await status(app, owner.bearer, pairing.pairingId)).body.state, "denied");
    const token = await post(app, "/api/auth/device/token", { deviceCode: login.deviceCode });
    assert.deepEqual([token.status, token.body.code], [403, "access_denied"]);
  });
});

test("a linked request approved with its user code on the device page ends the pairing", async () => {
  await withApp(async (app) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const pairing = await createPairing(app, owner.bearer, server.id);
    const login = await authorize(app, { pairingId: pairing.pairingId, serverSlug: server.slug });
    const ticket = (await status(app, owner.bearer, pairing.pairingId)).body.request.approvalTicket;
    assert.equal((await approveByCode(app, owner.bearer, login.userCode, server.id)).status, 200);
    assert.equal((await status(app, owner.bearer, pairing.pairingId)).body.state, "approved");
    const refused = await post(app, "/api/computer-pairings/approve", { pairingId: pairing.pairingId, approvalTicket: ticket }, owner.bearer);
    assert.deepEqual([refused.status, refused.body.code], [409, "computer_pairing_ended"]);
    const renew = await post(app, "/api/computer-pairings/renew", { pairingId: pairing.pairingId }, owner.bearer);
    assert.equal(renew.status, 409);
  });
});

test("expired, cancelled and signed-out pairings: authorize proceeds as a normal device login, nothing is approvable through them", async () => {
  await withApp(async (app, { emitted }) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);

    const expired = await createPairing(app, owner.bearer, server.id);
    await getDb().update(computerPairings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(computerPairings.id, expired.pairingRef));
    const cancelled = await createPairing(app, owner.bearer, server.id);
    const cancel = await post(app, "/api/computer-pairings/cancel", { pairingId: cancelled.pairingId }, owner.bearer);
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal((await pairingRow(cancelled.pairingRef)).voidReason, "cancelled");

    for (const [pairing, state] of [[expired, "expired"], [cancelled, "voided"]] as const) {
      const login = await authorize(app, { pairingId: pairing.pairingId, serverSlug: server.slug });
      assert.equal(login.paired, false);
      assert.equal((await pairingRow(pairing.pairingRef)).linkedDeviceAuthorizationId, null);
      assert.equal((await status(app, owner.bearer, pairing.pairingId)).body.state, state);
      const refused = await post(app, "/api/computer-pairings/approve", { pairingId: pairing.pairingId, approvalTicket: "x" }, owner.bearer);
      assert.deepEqual([refused.status, refused.body.code], [409, "computer_pairing_ended"]);
      const renew = await post(app, "/api/computer-pairings/renew", { pairingId: pairing.pairingId }, owner.bearer);
      assert.equal(renew.status, 409);
      assert.equal((await approveByCode(app, owner.bearer, login.userCode, server.id)).status, 200, "the code still works");
    }

    // Signing the creating session out voids its pairings.
    const second = await signInForTest(owner.id);
    const signedOut = await createPairing(app, second.token, server.id);
    await revokeSession(second.refreshToken);
    const row = await pairingRow(signedOut.pairingRef);
    assert.equal(row.voidReason, "signed_out");
    assert.equal((await authorize(app, { pairingId: signedOut.pairingId, serverSlug: server.slug })).paired, false);
    assert.equal(emitted.length, 0, "no event for a pairing that wasn't linked");
  });
});

test("authorize links only a pairing for the server it names, a computer grant, and device mode; renew extends a live pairing", async () => {
  await withApp(async (app) => {
    const owner = await seedUser();
    const serverA = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const serverB = await createServer("Bravo", `bravo-${randomUUID()}`, owner.id);
    const pairing = await createPairing(app, owner.bearer, serverA.id);

    assert.equal((await authorize(app, { pairingId: pairing.pairingId, serverSlug: serverB.slug })).paired, false, "another server");
    assert.equal((await authorize(app, { pairingId: pairing.pairingId })).paired, false, "no server named");
    const agentKey = await post(app, "/api/auth/device/authorize", { clientName: "raft", grant: { kind: "agent_key" }, pairingId: pairing.pairingId, serverSlug: serverA.slug });
    assert.deepEqual([agentKey.status, agentKey.body.paired], [201, false], "not a computer grant");
    const session = await post(app, "/api/auth/device/authorize", { clientName: "raft", pairingId: pairing.pairingId, serverSlug: serverA.slug });
    assert.deepEqual([session.status, session.body.paired], [201, false], "a device session");
    assert.equal((await authorize(app, { pairingId: { nested: true }, serverSlug: serverA.slug })).paired, false, "malformed id: never an error");
    // None of those touched it: the right request still links.
    assert.equal((await status(app, owner.bearer, pairing.pairingId)).body.state, "waiting");

    const before = (await pairingRow(pairing.pairingRef)).expiresAt;
    await getDb().update(computerPairings).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(computerPairings.id, pairing.pairingRef));
    const renewed = await post(app, "/api/computer-pairings/renew", { pairingId: pairing.pairingId }, owner.bearer);
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.ok(new Date(renewed.body.expiresAt).getTime() >= before.getTime());

    const migrate = await post(app, "/api/auth/device/authorize", { clientName: "raft-computer", grant: { kind: "computer_migrate" }, pairingId: pairing.pairingId, serverSlug: serverA.slug });
    assert.deepEqual([migrate.status, migrate.body.paired], [201, true], "computer_migrate pairs too");
  });
});

test("an authorize without pairingId answers exactly as before", async () => {
  await withApp(async (app) => {
    const login = await authorize(app);
    assert.deepEqual(Object.keys(login).sort(), ["deviceCode", "expiresIn", "interval", "userCode", "verificationUri"]);
  });
});

test("create: only for a server the person may add Computers to, at most five live at once", async () => {
  await withApp(async (app) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const member = await seedUser();
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const refused = await post(app, `/api/servers/${server.id}/computer-pairings`, { channel: "main" }, member.bearer);
    assert.deepEqual([refused.status, refused.body.code], [403, "computer_pairing_not_allowed"]);
    const stranger = await seedUser();
    const notMember = await post(app, `/api/servers/${server.id}/computer-pairings`, { channel: "main" }, stranger.bearer);
    assert.deepEqual([notMember.status, notMember.body.code], [403, "computer_pairing_not_allowed"]);

    const created = [];
    for (let i = 0; i < MAX_ACTIVE_COMPUTER_PAIRINGS; i += 1) created.push(await createPairing(app, owner.bearer, server.id));
    const limited = await post(app, `/api/servers/${server.id}/computer-pairings`, { channel: "main" }, owner.bearer);
    assert.deepEqual([limited.status, limited.body.code], [429, "computer_pairing_limit"]);
    await post(app, "/api/computer-pairings/cancel", { pairingId: created[0]!.pairingId }, owner.bearer);
    await createPairing(app, owner.bearer, server.id);
  });
});

test("renew never takes a pairing past its maximum lifetime, however often the window renews (Tenny 9ee59a28)", async () => {
  await withApp(async (app) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const pairing = await createPairing(app, owner.bearer, server.id);

    // Created 59 minutes ago and kept alive: a renew stops at the 60-minute mark, not 10 minutes on.
    const createdAt = new Date(Date.now() - 59 * 60_000);
    await getDb().update(computerPairings).set({ createdAt }).where(eq(computerPairings.id, pairing.pairingRef));
    const capped = await post(app, "/api/computer-pairings/renew", { pairingId: pairing.pairingId }, owner.bearer);
    assert.equal(capped.status, 200, JSON.stringify(capped.body));
    const lifetimeEnd = createdAt.getTime() + COMPUTER_PAIRING_MAX_LIFETIME_MS;
    assert.ok(Date.parse(capped.body.expiresAt) <= lifetimeEnd, `renewed to ${capped.body.expiresAt}, past the lifetime`);
    assert.ok((await pairingRow(pairing.pairingRef)).expiresAt.getTime() <= lifetimeEnd);

    // Past the lifetime (still unexpired by the last renew): renew is refused.
    await getDb().update(computerPairings).set({
      createdAt: new Date(Date.now() - 61 * 60_000),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    }).where(eq(computerPairings.id, pairing.pairingRef));
    const refused = await post(app, "/api/computer-pairings/renew", { pairingId: pairing.pairingId }, owner.bearer);
    assert.equal(refused.status, 409);
  });
});

test("create pairs only when the window's install channel serves a Computer that takes --pair; anything unknown is no (Tenny 763d2d64)", async () => {
  await withApp(async (app) => {
    const owner = await seedUser();
    const server = await createServer("Acme", `acme-${randomUUID()}`, owner.id);
    const create = (body: unknown) => post(app, `/api/servers/${server.id}/computer-pairings`, body, owner.bearer);
    const unavailable = async (body: unknown, why: string) => {
      __resetLatestComputerVersionForTest();
      const res = await create(body);
      assert.deepEqual([res.status, res.body.code], [409, "computer_pairing_unavailable"], why);
    };

    // Only main and alpha; anything else is refused without asking Hands.
    const before = hands.calls;
    for (const channel of [undefined, "", "beta", "MAIN", ["main"], { main: 1 }]) await unavailable({ channel }, `channel ${JSON.stringify(channel)}`);
    assert.equal(hands.calls, before);

    // The channel's Computer predates --pair (1.25.7 is today's stable).
    hands.versions.main = "1.25.7";
    await unavailable({ channel: "main" }, "1.25.7 on main");
    hands.versions.alpha = "1.25.8-staging.20261119100004.sha.e006c0739be3";
    await unavailable({ channel: "alpha" }, "a 1.25.8 staging build (before the release, before #15620)");
    hands.versions.main = "1.25.8-rc.1";
    await unavailable({ channel: "main" }, "a prerelease of the minimum");
    // Unknown: Hands fails, answers 404, an unparseable version.
    hands.versions.main = new Error("network down");
    await unavailable({ channel: "main" }, "network failure");
    hands.versions.main = undefined;
    await unavailable({ channel: "main" }, "404");
    hands.versions.main = "latest";
    await unavailable({ channel: "main" }, "unparseable");

    // From the first release that takes --pair (and the next patch's staging builds).
    hands.versions.alpha = "1.25.9-staging.20261120000000.sha.0123456789ab";
    __resetLatestComputerVersionForTest();
    assert.equal((await create({ channel: "alpha" })).status, 201);
    hands.versions.main = "1.26.0";
    __resetLatestComputerVersionForTest();
    assert.equal((await create({ channel: "main" })).status, 201);
  });
});

test("the first Computer version that takes --pair is pinned: moving it is a release-checklist step (Computer release checklist)", () => {
  // Change this only together with the release checklist's check that the
  // version contains #15620 (raft-computer setup --pair).
  assert.equal(COMPUTER_PAIRING_MIN_COMPUTER_VERSION, "1.25.8");
});
