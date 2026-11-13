// Registration and family-revoke behaviour of pushService.ts. Delivery
// (policy, providers, retries, revocation on terminal errors, traces) is
// covered by notifications/dispatcher.test.ts; wire formats by
// notifications/transports/*.test.ts.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { pushRegistrations, serverMembers, servers, sessionFamilies, sessions, users } from "../db/schema";
import {
  ensureFamilyRevokeCapability,
  revokePushFamilyByCapability,
  revokePushRegistration,
  unbindPushInstallation,
  upsertPushRegistration,
} from "./pushService";
import { loadMobileRegistrations } from "./notifications/dispatcher";
import { runWithTraceSpan } from "../tracing/semanticTrace";

process.env.JWT_SECRET ||= "push-service-test-secret";

async function seedPushFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "mobile-push-owner@test.com",
    name: "MobilePushOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Mobile Push",
    slug: "mobile-push",
    ownerId: owner!.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [family] = await db.insert(sessionFamilies).values({ userId: owner!.id }).returning();
  await db.insert(sessions).values({
    userId: owner!.id,
    familyId: family!.id,
    tokenHash: `token-${family!.id}`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { owner: owner!, server: server!, family: family! };
}

test("unbind and revoke record the cleared user in revoked_user_id; rebinding clears it", async ({ db }) => {
  void db;
  const { owner, server, family } = await seedPushFixture();
  const input = {
    installationId: "revoked-user-install",
    provider: "apns" as const,
    userId: owner.id,
    serverId: server.id,
    sessionFamilyId: family.id,
    deviceToken: "revoked-user-token",
    topic: "build.raft.app",
    env: "production" as const,
  };
  const readRow = async (id: string) =>
    (await getDb().select().from(pushRegistrations).where(eq(pushRegistrations.id, id)))[0]!;

  const registration = await upsertPushRegistration(input);
  assert.equal(registration.revokedUserId, null);

  assert.equal(await unbindPushInstallation({ installationId: input.installationId, userId: owner.id, serverId: server.id }), 1);
  let row = await readRow(registration.id);
  assert.equal(row.userId, null);
  assert.equal(row.revokedUserId, owner.id, "unbind keeps who the row belonged to");

  await revokePushRegistration({ registrationId: registration.id, reason: "BadDeviceToken" });
  row = await readRow(registration.id);
  assert.ok(row.revokedAt);
  assert.equal(row.revokedUserId, owner.id, "revoking an unbound row does not overwrite the recorded user with null");

  await upsertPushRegistration(input);
  row = await readRow(registration.id);
  assert.equal(row.userId, owner.id);
  assert.equal(row.revokedAt, null);
  assert.equal(row.revokedUserId, null, "rebinding clears the diagnostic copy");

  await revokePushRegistration({ registrationId: registration.id, reason: "Unregistered" });
  row = await readRow(registration.id);
  assert.equal(row.userId, null);
  assert.equal(row.revokedUserId, owner.id, "revoking a bound row records its user");
});

test("revoking a session family by capability takes its registrations out of delivery", async ({ db }) => {
  void db;
  const { owner, server, family } = await seedPushFixture();
  await upsertPushRegistration({
    installationId: "dead-family-install",
    provider: "apns",
    userId: owner.id,
    serverId: server.id,
    sessionFamilyId: family.id,
    deviceToken: "dead-family-token",
    topic: "build.raft.app",
    env: "production",
  });
  assert.equal((await loadMobileRegistrations([owner.id])).get(owner.id)?.length, 1, "live before the revoke");

  const capability = await ensureFamilyRevokeCapability({ familyId: family.id, userId: owner.id });
  assert.ok(capability);
  assert.equal(await ensureFamilyRevokeCapability({ familyId: family.id, userId: owner.id }), capability, "the capability is stable");
  assert.equal(await revokePushFamilyByCapability(capability), "revoked");
  assert.equal(await revokePushFamilyByCapability(capability), "already_revoked");
  assert.equal(await revokePushFamilyByCapability(`${capability.slice(0, -1)}${capability.endsWith("A") ? "B" : "A"}`), "invalid");
  assert.equal(await ensureFamilyRevokeCapability({ familyId: family.id, userId: owner.id }), null, "no new capability for a revoked family");

  assert.equal((await loadMobileRegistrations([owner.id])).get(owner.id), undefined, "a revoked family's registrations are not delivered to");
});

test("registration traces never contain raw installation, device token, topic, or revoke capability values", async ({ db }) => {
  void db;
  const { owner, server, family } = await seedPushFixture();
  const installationId = "alice@example.com secret installation";
  const deviceToken = "secret-device-token-marker";
  const topic = "secret.topic.marker";
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "f".repeat(32),
    spanIdGenerator: () => "1".repeat(16),
  });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  let capability = "";

  await runWithTraceSpan(span, async () => {
    const registration = await upsertPushRegistration({
      installationId,
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken,
      topic,
      env: "production",
    });
    await revokePushRegistration({ registrationId: registration.id, reason: "BadDeviceToken" });
    await upsertPushRegistration({
      installationId,
      provider: "apns",
      userId: owner.id,
      serverId: server.id,
      sessionFamilyId: family.id,
      deviceToken,
      topic,
      env: "production",
    });
    await unbindPushInstallation({ installationId, userId: owner.id, serverId: server.id });
    capability = (await ensureFamilyRevokeCapability({ familyId: family.id, userId: owner.id })) ?? "";
    assert.ok(capability);
    await revokePushFamilyByCapability(capability);
  }, tracer);
  span.end();

  const events = sink.getAllSpans().flatMap((recorded) => recorded.events);
  assert.ok(events.some((event) => event.name === "push.registration.upserted"), "the trace captured the registration");
  const traceValues = JSON.stringify(events.map((event) => event.attrs));
  for (const secret of [installationId, deviceToken, topic, capability]) {
    assert.equal(traceValues.includes(secret), false, `trace attrs must not contain ${secret}`);
  }
});
