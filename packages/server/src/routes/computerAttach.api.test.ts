import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { asMachineId } from "@botiverse/raft-shared";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach } from "vitest";

import argon2 from "argon2";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { users, computers, onboardingEmailJourneys } from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import { signAccessToken } from "../middleware/auth.js";
import { createServer, addMember, transitionMemberRole } from "../services/serverService.js";
import { getMachine } from "../services/machineService.js";
import {
  resetComputerMobileAppEmailJourneyTestOverrides,
  setComputerMobileAppEmailJourneyConfigForTest,
} from "../services/computerMobileAppEmailJourneyService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// task #30 PR-B regression guard — user-authed Computer attach
// (RFC v0.8 contract v3 §6/§9). Pins: env gate, requireAuth, name as a
// display label only (same user/server/name collides, never resumes by name),
// the zero-enumeration uniform 403, and the end-to-end property that the
// issued sk_computer_* actually authenticates the §9 preflight surface.

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

beforeEach(() => {
  setComputerMobileAppEmailJourneyConfigForTest({ mode: "dry_run", delayHours: 48 });
});

afterEach(() => {
  resetComputerMobileAppEmailJourneyTestOverrides();
});

// Default-on gate semantics (v8.1): `enabled=true` → unset env (default-on
// path); `enabled=false` → explicit "false" (kill switch). See deviceAuth
// test for the full kill-switch matrix.
async function withEnv<T>(
  enabled: boolean | { gate: string | undefined },
  fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<T>,
): Promise<T> {
  const oldGate = process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  if (typeof enabled === "object") {
    if (enabled.gate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = enabled.gate;
  } else if (enabled) {
    delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  } else {
    process.env.SLOCK_DEVICE_LOGIN_ENABLED = "false";
  }
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    return await fn(app);
  } finally {
    await app.close();
    if (oldGate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = oldGate;
  }
}

async function seedUser(): Promise<{ id: string; bearer: string }> {
  const db = getDb();
  const suffix = randomUUID();
  const [u] = await db
    .insert(users)
    .values({
      email: `attach-${suffix}@slock.test`,
      name: `attach-${suffix}`,
      displayName: "Attach Tester",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
    })
    .returning();
  return { id: u.id, bearer: signAccessToken(u.id) };
}

test("attach surface is NOT mounted when gate explicitly disabled", async () => {
  await withEnv(false, async (app) => {
    const { bearer } = await seedUser();
    const res = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: randomUUID() }),
    });
    assert.equal(res.status, 404);
  });
});

// v8.1 default-on regression: surface mounted when env unset.
test("attach surface IS mounted when gate unset (default-on)", async () => {
  await withEnv({ gate: undefined }, async (app) => {
    const { bearer } = await seedUser();
    const res = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: randomUUID() }),
    });
    // Not 404 (mounted). Expect 403 zero-enumeration since the random
    // slug doesn't resolve — that path proves the route is mounted and
    // serving the canonical attach contract.
    assert.notEqual(res.status, 404);
    assert.equal(res.status, 403);
  });
});

test("attach requires user auth — unauthenticated rejected", async () => {
  await withEnv(true, async (app) => {
    const res = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ serverSlug: randomUUID() }),
    });
    assert.equal(res.status, 401);
  });
});

test("attach requires serverSlug; legacy serverId body is not accepted", async () => {
  await withEnv(true, async (app) => {
    const { bearer } = await seedUser();
    const res = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverId: randomUUID(), name: "raft-computer" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { code?: string }).code, "server_slug_required");
  });
});

test("attach: member → sk_computer_* issued; same-user same-name collides without rotating", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Attach Co", `attach-${randomUUID()}`, userId);

    const first = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
    });
    assert.equal(first.status, 201);
    const a = (await first.json()) as {
      apiKey: string;
      serverMachineId: string;
      serverId: string;
      serverSlug: string;
      resumed: boolean;
    };
    assert.ok(a.apiKey.startsWith("sk_computer_"));
    assert.ok(a.serverMachineId);
    assert.equal(a.serverId, server.id);
    assert.equal(a.serverSlug, server.slug);
    assert.equal(a.resumed, false);

    const [mobileJourney] = await getDb().select()
      .from(onboardingEmailJourneys)
      .where(and(
        eq(onboardingEmailJourneys.userId, userId),
        eq(onboardingEmailJourneys.journeyKey, "first_computer_mobile_app_48h"),
      ));
    assert.equal(mobileJourney?.day1Status, "dry_run");
    assert.equal(
      mobileJourney?.day1ScheduledAt?.getTime(),
      (mobileJourney?.qualifiedAt.getTime() ?? 0) + 48 * 60 * 60 * 1000,
    );

    // Re-attach same (server, user, display-name) must not prove identity.
    // The server rejects it instead of rotating the existing row by name.
    const second = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json() as { code?: string }).code, "COMPUTER_NAME_COLLISION");

    // End-to-end: the issued sk_computer_* authenticates the §9
    // read-only preflight surface (proves real principal wiring) after the
    // collision, so the rejected duplicate did not rotate the credential.
    const pre = await fetch(`${app.baseUrl}/internal/computer/preflight`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${a.apiKey}` }),
      body: "{}",
    });
    assert.equal(pre.status, 200);
    const pj = (await pre.json()) as { ok?: boolean; serverSlug?: string; principal?: { kind?: string } };
    assert.equal(pj.ok, true);
    assert.equal(pj.serverSlug, server.slug);
    assert.equal(pj.principal?.kind, "computer");

    const db = getDb();
    const rows = await db
      .select({ id: computers.id })
      .from(computers)
      .where(
        and(
          eq(computers.serverId, server.id),
          eq(computers.attachedByUserId, userId),
          eq(computers.name, "raft-computer"),
        ),
      );
    assert.deepEqual(rows.map((row) => row.id), [a.serverMachineId]);
  });
});

test("attach remains successful when the mobile lifecycle email provider fails", async () => {
  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "all",
    sendEmail: async () => {
      throw new Error("provider unavailable");
    },
  });

  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Attach Email Failure", `attach-email-${randomUUID()}`, userId);
    const response = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "email-failure-computer" }),
    });

    assert.equal(response.status, 201);
    const [journey] = await getDb().select()
      .from(onboardingEmailJourneys)
      .where(and(
        eq(onboardingEmailJourneys.userId, userId),
        eq(onboardingEmailJourneys.journeyKey, "first_computer_mobile_app_48h"),
      ));
    assert.equal(journey?.day1Status, "failed");
    assert.equal(journey?.lastError, "provider unavailable");
  });
});

test("attach succeeds and compensates when the ledger fails after provider acceptance", async () => {
  const canceled: string[] = [];
  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "all",
    sendEmail: async () => "accepted-provider-email",
    persistAcceptedEmail: async () => {
      throw new Error("ledger unavailable after provider acceptance");
    },
    cancelEmail: async (emailId) => {
      canceled.push(emailId);
    },
  });

  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Attach Accepted Ledger Failure", `attach-accepted-ledger-${randomUUID()}`, userId);
    const response = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "accepted-ledger-failure-computer" }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(canceled, ["accepted-provider-email"]);
    const [journey] = await getDb().select()
      .from(onboardingEmailJourneys)
      .where(and(
        eq(onboardingEmailJourneys.userId, userId),
        eq(onboardingEmailJourneys.journeyKey, "first_computer_mobile_app_48h"),
      ));
    assert.equal(journey?.day1Status, "failed");
    assert.equal(journey?.day1EmailId, "accepted-provider-email");
    assert.equal(journey?.cancelReason, "schedule_persist_failed");
    assert.ok(journey?.canceledAt);
  });
});

test("attach remains successful when lifecycle enqueue throws before its own failure boundary", async () => {
  setComputerMobileAppEmailJourneyConfigForTest({
    mode: "all",
    beforeEnqueue: () => {
      throw new Error("ledger unavailable");
    },
  });

  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Attach Ledger Failure", `attach-ledger-${randomUUID()}`, userId);
    const response = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "ledger-failure-computer" }),
    });

    assert.equal(response.status, 201);
    const body = await response.json() as { serverMachineId?: string };
    assert.ok(body.serverMachineId);
    const [computer] = await getDb().select({ id: computers.id })
      .from(computers)
      .where(eq(computers.id, body.serverMachineId!));
    assert.equal(computer?.id, body.serverMachineId);
    const journeys = await getDb().select({ id: onboardingEmailJourneys.id })
      .from(onboardingEmailJourneys)
      .where(and(
        eq(onboardingEmailJourneys.userId, userId),
        eq(onboardingEmailJourneys.journeyKey, "first_computer_mobile_app_48h"),
      ));
    assert.equal(journeys.length, 0);
  });
});

test("attach: non-member and nonexistent server collapse to uniform 403 not_authorized", async () => {
  await withEnv(true, async (app) => {
    // user is authenticated but NOT a member of the target server.
    const owner = await seedUser();
    const stranger = await seedUser();
    const server = await createServer("Closed Co", `closed-${randomUUID()}`, owner.id);

    const nonMember = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${stranger.bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
    });
    assert.equal(nonMember.status, 403);
    assert.equal((await nonMember.json() as { code?: string }).code, "not_authorized");

    const ghost = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${stranger.bearer}` }),
      body: JSON.stringify({ serverSlug: randomUUID(), name: "raft-computer" }),
    });
    assert.equal(ghost.status, 403);
    assert.equal((await ghost.json() as { code?: string }).code, "not_authorized");

    // Added as a plain member, the SAME request is still rejected — but now
    // with the distinct `requires_admin` code, NOT `not_authorized`. A member
    // already knows the server exists, so disclosing the role requirement is
    // not an enumeration leak.
    await addMember(server.id, stranger.id, "member");
    const plainMember = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${stranger.bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
    });
    assert.equal(plainMember.status, 403);
    assert.equal((await plainMember.json() as { code?: string }).code, "requires_admin");

    // Elevated to admin (manageMachines = true), the SAME request succeeds —
    // proves the 403s were authorization, not a malformed request.
    await transitionMemberRole({
      serverId: server.id,
      actorUserId: owner.id,
      targetUserId: stranger.id,
      nextRole: "admin",
      guestTransitionsEnabled: true,
    });
    const nowAdmin = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${stranger.bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
    });
    assert.equal(nowAdmin.status, 201);
  });
});

// Role gate regression (tygg 2026-06-05 #wg-raft-computer): attaching a
// Computer mints a machine principal, so it requires the manageMachines
// capability — owner / admin allowed, member denied with requires_admin.
// Before this gate a plain member could attach via CLI/API even though the
// UI hid the action; the gate makes the rule a real authorization boundary.
test("attach: role gate — owner & admin allowed, plain member denied with requires_admin", async () => {
  await withEnv(true, async (app) => {
    // Owner (server creator) — manageMachines = true → 201.
    const owner = await seedUser();
    const server = await createServer("Role Gate Co", `rolegate-${randomUUID()}`, owner.id);
    const ownerRes = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${owner.bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "owner-box" }),
    });
    assert.equal(ownerRes.status, 201);

    // Admin — manageMachines = true → 201.
    const admin = await seedUser();
    await addMember(server.id, admin.id, "admin");
    const adminRes = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${admin.bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "admin-box" }),
    });
    assert.equal(adminRes.status, 201);

    // Plain member — manageMachines = false → 403 requires_admin, and no
    // computer row is created for them.
    const member = await seedUser();
    await addMember(server.id, member.id, "member");
    const memberRes = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${member.bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "member-box" }),
    });
    assert.equal(memberRes.status, 403);
    assert.equal((await memberRes.json() as { code?: string }).code, "requires_admin");

    const db = getDb();
    const memberComputers = await db
      .select({ id: computers.id })
      .from(computers)
      .where(eq(computers.attachedByUserId, member.id));
    assert.equal(memberComputers.length, 0);
  });
});

test("attach: UUID-shaped input is treated as a slug, not a serverId compatibility alias", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Slug Only Co", `slug-only-${randomUUID()}`, userId);

    const byId = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.id, name: "raft-computer" }),
    });
    assert.equal(byId.status, 403);
    assert.equal((await byId.json() as { code?: string }).code, "not_authorized");

    const bySlug = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
    });
    assert.equal(bySlug.status, 201);
  });
});

test("attach PR-F: links a machines row (computers.machineId); name collision preserves it", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Bridge Co", `bridge-${randomUUID()}`, userId);

    const first = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
    });
    assert.equal(first.status, 201);
    const a = (await first.json()) as { serverMachineId: string };

    const db = getDb();
    const [c1] = await db
      .select({ machineId: computers.machineId })
      .from(computers)
      .where(eq(computers.id, a.serverMachineId));
    assert.ok(c1.machineId, "attach must link a machines row (computers.machineId)");
    const m1 = await getMachine(asMachineId(c1.machineId));
    assert.ok(m1, "the linked machine row must exist");
    assert.equal(m1?.serverId, server.id);

    // Same server/user/display-name collides and must not mint a duplicate
    // machine or relink the existing Computer by name.
    const second = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "raft-computer" }),
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json() as { code?: string }).code, "COMPUTER_NAME_COLLISION");
    const [c2] = await db
      .select({ machineId: computers.machineId })
      .from(computers)
      .where(eq(computers.id, a.serverMachineId));
    assert.equal(c2.machineId, c1.machineId, "collision must preserve the linked machine");
  });
});

test("attach: display-name collision is scoped to the attaching user; cross-user same name is allowed", async () => {
  await withEnv(true, async (app) => {
    const owner = await seedUser();
    const other = await seedUser();
    const server = await createServer("Name Co", `name-${randomUUID()}`, owner.id);
    // `other` needs the manageMachines capability to attach — admin, not a
    // plain member (the role gate is exercised in its own test above). This
    // test isolates per-user display-name scoping, not the role boundary.
    await addMember(server.id, other.id, "admin");

    const first = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${owner.bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "Build-Mac" }),
    });
    assert.equal(first.status, 201);
    const a = (await first.json()) as { serverMachineId: string; apiKey: string };

    const duplicate = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${owner.bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "Build-Mac" }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as { code?: string }).code, "COMPUTER_NAME_COLLISION");

    const crossUserSameName = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${other.bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "Build-Mac" }),
    });
    assert.equal(crossUserSameName.status, 201);
    const c = (await crossUserSameName.json()) as { serverMachineId: string; resumed: boolean };
    assert.equal(c.resumed, false);
    assert.notEqual(c.serverMachineId, a.serverMachineId);
  });
});

test("ordinary Computer credential cannot reach attachment self-revoke surface", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("No Revoke Co", `no-revoke-${randomUUID()}`, userId);

    const attach = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ serverSlug: server.slug, name: "Build-Mac" }),
    });
    assert.equal(attach.status, 201);
    const attached = (await attach.json()) as { serverMachineId: string; apiKey: string };

    const revoke = await fetch(`${app.baseUrl}/internal/computer/attachment/revoke`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${attached.apiKey}` }),
      body: JSON.stringify({ serverMachineId: attached.serverMachineId }),
    });
    assert.equal(revoke.status, 401);
    assert.equal((await revoke.json() as { code?: string }).code, "auth_policy_unregistered_path");

    const db = getDb();
    const [row] = await db
      .select({ revokedAt: computers.revokedAt })
      .from(computers)
      .where(eq(computers.id, attached.serverMachineId));
    assert.equal(row.revokedAt, null);
  });
});
