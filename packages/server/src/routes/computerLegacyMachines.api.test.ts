import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { users, machines } from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import { signAccessToken } from "../middleware/auth.js";
import { createServer, addMember } from "../services/serverService.js";
import {
  extractApiKeyFingerprint,
  registerMachine,
} from "../services/machineService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// RFC v9.9 §X.2 + Jianwei msg=a87a44a9 + Cody msg=ec68c27f / msg=ce91881f
// regression guard for `GET /api/computer/legacy-machines`.
//
// Acceptance matrix:
//   1. gate off                         → 404 (Express default — router unmounted)
//   2. unauthenticated                  → 401 auth_required
//   3. missing serverSlug query         → 400 server_slug_required
//   4. unknown serverSlug               → 403 not_authorized (cloak)
//   5. soft-deleted server              → 403 not_authorized (cloak)
//   6. non-member of existing server    → 403 not_authorized (cloak)
//   7. cloak symmetry: 4/5/6 identical body + status (anti-enumeration)
//   8. happy path → 200, entries scoped to (userId, serverId), fingerprint-emitted
//   9. NULL apiKeyFingerprint rows excluded (pre-handshake legacy)
//  10. includeAll=1 returns NULL-fingerprint rows in the redacted manual shape
//  11. legacyKeyMigratedAt non-null rows included for recovery (already adopted)
//  12. SECRET REDLINE: response body must NEVER include apiKeyHash /
//      apiKeyPrefix / raw apiKey / hash material
//  13. cross-user isolation: user-A cannot see user-B's daemons even on
//      shared server membership

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

async function withEnv<T>(
  enabled: boolean,
  fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<T>,
): Promise<T> {
  const oldGate = process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  if (enabled) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  else process.env.SLOCK_DEVICE_LOGIN_ENABLED = "false";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    return await fn(app);
  } finally {
    await app.close();
    if (oldGate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = oldGate;
  }
}

async function seedUser(label = "roster"): Promise<{ id: string; bearer: string }> {
  const db = getDb();
  const suffix = randomUUID();
  const [u] = await db
    .insert(users)
    .values({
      email: `${label}-${suffix}@slock.test`,
      name: `${label}-${suffix}`,
      displayName: "Roster Tester",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();
  return { id: u.id, bearer: signAccessToken(u.id) };
}

test("legacy-machines: gate off → 404 (router not mounted)", async () => {
  await withEnv(false, async (app) => {
    const { bearer } = await seedUser();
    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=anything`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    assert.equal(res.status, 404);
  });
});

test("legacy-machines: unauthenticated → 401 auth_required", async () => {
  await withEnv(true, async (app) => {
    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=anything`,
      { method: "GET" },
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { code?: string }).code, "auth_required");
  });
});

test("legacy-machines: missing serverSlug query → 400 server_slug_required", async () => {
  await withEnv(true, async (app) => {
    const { bearer } = await seedUser();
    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { code?: string }).code, "server_slug_required");
  });
});

test("legacy-machines: cloak symmetry — unknown / deleted / non-member all return identical 403", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser("a");

    // unknown slug
    const unknownRes = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=nonexistent-${randomUUID()}`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const unknownBody = await unknownRes.json();

    // soft-deleted server (user is owner BEFORE delete; deletion soft so row stays)
    const deletedSlug = `deleted-${randomUUID()}`;
    const deletedSrv = await createServer("Doomed Co", deletedSlug, userId);
    const db = getDb();
    const { servers: serversTable } = await import("../db/schema.js");
    await db
      .update(serversTable)
      .set({ deletedAt: new Date() })
      .where(eq(serversTable.id, deletedSrv.id));
    const deletedRes = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${deletedSlug}`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const deletedBody = await deletedRes.json();

    // non-member of an existing server
    const owner = await seedUser("owner");
    const otherSlug = `other-${randomUUID()}`;
    await createServer("Other Co", otherSlug, owner.id);
    const nonmemberRes = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${otherSlug}`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const nonmemberBody = await nonmemberRes.json();

    assert.equal(unknownRes.status, 403);
    assert.equal(deletedRes.status, 403);
    assert.equal(nonmemberRes.status, 403);
    // Cody msg=ce91881f cloak: identical bodies — no enumeration leak.
    assert.deepEqual(unknownBody, deletedBody);
    assert.deepEqual(unknownBody, nonmemberBody);
    assert.equal((unknownBody as { code?: string }).code, "not_authorized");
  });
});

test("legacy-machines: includeAll preserves cloak symmetry", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser("a");

    const unknownRes = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=nonexistent-${randomUUID()}&includeAll=1`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const unknownBody = await unknownRes.json();

    const deletedSlug = `deleted-${randomUUID()}`;
    const deletedSrv = await createServer("Doomed Co", deletedSlug, userId);
    const db = getDb();
    const { servers: serversTable } = await import("../db/schema.js");
    await db
      .update(serversTable)
      .set({ deletedAt: new Date() })
      .where(eq(serversTable.id, deletedSrv.id));
    const deletedRes = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${deletedSlug}&includeAll=1`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const deletedBody = await deletedRes.json();

    const owner = await seedUser("owner");
    const otherSlug = `other-${randomUUID()}`;
    await createServer("Other Co", otherSlug, owner.id);
    const nonmemberRes = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${otherSlug}&includeAll=1`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const nonmemberBody = await nonmemberRes.json();

    assert.equal(unknownRes.status, 403);
    assert.equal(deletedRes.status, 403);
    assert.equal(nonmemberRes.status, 403);
    assert.deepEqual(unknownBody, deletedBody);
    assert.deepEqual(unknownBody, nonmemberBody);
    assert.equal((unknownBody as { code?: string }).code, "not_authorized");
  });
});

test("legacy-machines: happy path — 200 + entries scoped to (userId, serverId) with fingerprint", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const slug = `roster-${randomUUID()}`;
    const server = await createServer("Roster Co", slug, userId);

    // Two daemons on this server for this user.
    const reg1 = await registerMachine(server.id, userId, "alpha");
    const reg2 = await registerMachine(server.id, userId, "beta");
    const fp1 = extractApiKeyFingerprint(reg1.apiKey);
    const fp2 = extractApiKeyFingerprint(reg2.apiKey);

    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${slug}`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      entries: Array<{
        daemonId: string;
        apiKeyFingerprint: string;
        machineName: string;
        hostname: string | null;
        lastSeenAt: string | null;
        hasFingerprint: boolean;
      }>;
    };
    assert.equal(body.entries.length, 2);
    const byName = new Map(body.entries.map((e) => [e.machineName, e]));
    assert.equal(byName.get("alpha")?.daemonId, reg1.machine.id);
    assert.equal(byName.get("alpha")?.apiKeyFingerprint, fp1);
    assert.equal(byName.get("alpha")?.hasFingerprint, true);
    assert.equal(byName.get("beta")?.daemonId, reg2.machine.id);
    assert.equal(byName.get("beta")?.apiKeyFingerprint, fp2);
    assert.equal(byName.get("beta")?.hasFingerprint, true);
  });
});

test("legacy-machines: NULL apiKeyFingerprint rows excluded (pre-handshake legacy)", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const slug = `roster-${randomUUID()}`;
    const server = await createServer("Roster Co", slug, userId);

    // Register normally then null out the fingerprint to simulate a
    // pre-v9.9 daemon row that hasn't yet hit /daemon/connect.
    const reg = await registerMachine(server.id, userId, "pre-handshake");
    const db = getDb();
    await db
      .update(machines)
      .set({ apiKeyFingerprint: null })
      .where(eq(machines.id, reg.machine.id));

    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${slug}`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: unknown[] };
    assert.equal(body.entries.length, 0);
  });
});

test("legacy-machines: includeAll=1 includes NULL-fingerprint rows without fingerprint bytes", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const slug = `roster-${randomUUID()}`;
    const server = await createServer("Roster Co", slug, userId);

    const withFingerprint = await registerMachine(server.id, userId, "has-fp");
    const withoutFingerprint = await registerMachine(server.id, userId, "null-fp");
    const fp = extractApiKeyFingerprint(withFingerprint.apiKey);

    const db = getDb();
    await db
      .update(machines)
      .set({ apiKeyFingerprint: null })
      .where(eq(machines.id, withoutFingerprint.machine.id));

    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${slug}&includeAll=1`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(text.includes("apiKeyFingerprint"), false);
    assert.equal(text.includes(fp), false);
    const body = JSON.parse(text) as {
      entries: Array<{
        daemonId: string;
        apiKeyFingerprint?: string;
        hasFingerprint: boolean;
        machineName: string;
        hostname: string | null;
        lastSeenAt: string | null;
      }>;
    };
    assert.equal(body.entries.length, 2);
    const byName = new Map(body.entries.map((e) => [e.machineName, e]));
    assert.equal(byName.get("has-fp")?.daemonId, withFingerprint.machine.id);
    assert.equal(byName.get("has-fp")?.hasFingerprint, true);
    assert.equal(Object.hasOwn(byName.get("has-fp") ?? {}, "apiKeyFingerprint"), false);
    assert.equal(byName.get("null-fp")?.daemonId, withoutFingerprint.machine.id);
    assert.equal(byName.get("null-fp")?.hasFingerprint, false);
    assert.equal(Object.hasOwn(byName.get("null-fp") ?? {}, "apiKeyFingerprint"), false);
  });
});

test("legacy-machines: already-migrated rows included for interrupted-adoption recovery", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const slug = `roster-${randomUUID()}`;
    const server = await createServer("Roster Co", slug, userId);

    const live = await registerMachine(server.id, userId, "live");
    const migrated = await registerMachine(server.id, userId, "already-adopted");
    const db = getDb();
    const migratedAt = new Date();
    await db
      .update(machines)
      .set({ legacyKeyMigratedAt: migratedAt })
      .where(eq(machines.id, migrated.machine.id));

    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${slug}`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const body = (await res.json()) as {
      entries: Array<{ daemonId: string; machineName: string; legacyKeyMigratedAt: string | null }>;
    };
    assert.equal(res.status, 200);
    assert.equal(body.entries.length, 2);
    assert.equal(body.entries[0].machineName, "live");
    assert.equal(body.entries[0].daemonId, live.machine.id);
    assert.equal(body.entries[0].legacyKeyMigratedAt, null);
    assert.equal(body.entries[1].machineName, "already-adopted");
    assert.equal(body.entries[1].daemonId, migrated.machine.id);
    assert.equal(body.entries[1].legacyKeyMigratedAt, migratedAt.toISOString());
  });
});

test("legacy-machines: SECRET REDLINE — response never contains apiKeyHash / apiKeyPrefix / raw apiKey", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const slug = `roster-${randomUUID()}`;
    const server = await createServer("Roster Co", slug, userId);
    const reg = await registerMachine(server.id, userId, "alpha");

    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${slug}`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const text = await res.text();
    assert.equal(res.status, 200);
    // Whole-body grep for credential-like substrings.
    assert.equal(
      text.includes("apiKeyHash"),
      false,
      "response must not include apiKeyHash field",
    );
    assert.equal(
      text.includes("apiKeyPrefix"),
      false,
      "response must not include apiKeyPrefix field",
    );
    assert.equal(
      text.includes("api_key_hash"),
      false,
      "response must not include api_key_hash column name",
    );
    assert.equal(
      text.includes(reg.apiKey),
      false,
      "response must not echo the raw legacy apiKey",
    );
    assert.equal(
      text.includes(reg.apiKey.slice(0, 20)),
      false,
      "response must not echo the apiKeyPrefix material",
    );
  });
});

test("legacy-machines: cross-user isolation — caller never sees another user's daemons on a shared server", async () => {
  await withEnv(true, async (app) => {
    const owner = await seedUser("owner");
    const member = await seedUser("member");
    const slug = `shared-${randomUUID()}`;
    const server = await createServer("Shared Co", slug, owner.id);
    await addMember(server.id, member.id, "member");

    // Owner has a legacy daemon on this server. Member also has one.
    await registerMachine(server.id, owner.id, "owner-daemon");
    const memberMachine = await registerMachine(server.id, member.id, "member-daemon");

    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${slug}`,
      { method: "GET", headers: { Authorization: `Bearer ${member.bearer}` } },
    );
    const body = (await res.json()) as {
      entries: Array<{ daemonId: string; machineName: string }>;
    };
    assert.equal(res.status, 200);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].machineName, "member-daemon");
    assert.equal(body.entries[0].daemonId, memberMachine.machine.id);
  });
});

test("legacy-machines: fingerprint matches handshake backfill from findMachineByApiKey", async () => {
  // Cross-verify the wire-format fingerprint is byte-identical to the
  // value the daemon writes into owner.json (sha256(apiKey)[0..15]) — the
  // intersection key invariant the picker depends on.
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const slug = `roster-${randomUUID()}`;
    const server = await createServer("Roster Co", slug, userId);
    const reg = await registerMachine(server.id, userId, "alpha");
    const expected = extractApiKeyFingerprint(reg.apiKey);

    const res = await fetch(
      `${app.baseUrl}/api/computer/legacy-machines?serverSlug=${slug}`,
      { method: "GET", headers: { Authorization: `Bearer ${bearer}` } },
    );
    const body = (await res.json()) as {
      entries: Array<{ apiKeyFingerprint: string }>;
    };
    assert.equal(body.entries[0].apiKeyFingerprint.length, 16);
    assert.equal(body.entries[0].apiKeyFingerprint, expected);
  });
});
