import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  nativeNotificationCredentials,
  nativeNotificationDevices,
  nativeNotificationEnrollmentGrants,
  nativeNotificationEvents,
  sessionFamilies,
  users,
} from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { __setNativeNotificationLiveWriteHookForTests } from "./notifications.js";
import {
  __setNativeNotificationAttestationVerifierForTests,
  buildEnrollmentProofTranscript,
  buildRotationProofTranscript,
  persistNativeNotificationIntents,
  revokeCurrentNativeCredential,
} from "../services/nativeNotificationService.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(email: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name: `native-${randomUUID()}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function login(baseUrl: string, email: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<{ accessToken: string; refreshToken: string }>;
}

function sessionHeaders(accessToken: string) {
  return { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
}

function makeNativeBinding() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    request: {
      appId: "ai.slock.desktop",
      protocolVersion: 1,
      appVersion: "1.0.0-test",
      releaseChannel: "staging",
      appInstanceId: randomUUID(),
      publicKey: (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
    },
  };
}

async function requestGrant(baseUrl: string, accessToken: string, request: ReturnType<typeof makeNativeBinding>["request"]) {
  const response = await fetch(`${baseUrl}/api/notifications/enrollment-grants`, {
    method: "POST",
    headers: sessionHeaders(accessToken),
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<{ grant: string; expiresAt: string }>;
}

async function exchangeGrant(
  baseUrl: string,
  grant: string,
  request: ReturnType<typeof makeNativeBinding>["request"],
  privateKey: KeyObject,
) {
  const proof = sign(null, buildEnrollmentProofTranscript(grant, request), privateKey).toString("base64url");
  return fetch(`${baseUrl}/api/notifications/enrollment-exchanges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant, proof }),
  });
}

async function enroll(baseUrl: string, accessToken: string) {
  const native = makeNativeBinding();
  const { grant } = await requestGrant(baseUrl, accessToken, native.request);
  const response = await exchangeGrant(baseUrl, grant, native.request, native.privateKey);
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json() as {
    credential: string;
    credentialId: string;
    deviceId: string;
    scope: string;
    expiresAt: string;
  };
  return { ...native, ...result, grant };
}

async function readSseEvents(body: ReadableStream<Uint8Array>, count: number, timeoutMs = 5_000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ id: string; data: Record<string, unknown> }> = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(25, deadline - Date.now()))),
    ]);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let separator: number;
    while ((separator = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      if (!frame.includes("event: native-notification.v1")) continue;
      const id = frame.split("\n").find((line) => line.startsWith("id: "))?.slice(4) ?? "";
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
      events.push({ id, data: JSON.parse(data) as Record<string, unknown> });
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

async function waitForSseClose(body: ReadableStream<Uint8Array>, timeoutMs = 2_000): Promise<boolean> {
  const reader = body.getReader();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(25, deadline - Date.now()))),
      ]);
      if (result === null) return false;
      if (result.done) return true;
    }
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function readSseEventsUntilClose(body: ReadableStream<Uint8Array>, timeoutMs = 2_000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ id: string; data: Record<string, unknown> }> = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(25, deadline - Date.now()))),
      ]);
      if (result === null) return { events, closed: false };
      if (result.done) return { events, closed: true };
      buffer += decoder.decode(result.value, { stream: true });
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (!frame.includes("event: native-notification.v1")) continue;
        const id = frame.split("\n").find((line) => line.startsWith("id: "))?.slice(4) ?? "";
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
        events.push({ id, data: JSON.parse(data) as Record<string, unknown> });
      }
    }
    return { events, closed: false };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

test("the default-off kill switch closes routes and ledger persistence", async () => {
  process.env.SLOCK_NATIVE_NOTIFICATIONS_ENABLED = "false";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const route = await fetch(`${app.baseUrl}/api/notifications/stream`);
    assert.equal(route.status, 404);
    assert.equal(await persistNativeNotificationIntents([{
      recipientUserId: randomUUID(),
      eventKey: `disabled:${randomUUID()}`,
      serverId: randomUUID(),
      kind: "channel",
      channelId: randomUUID(),
      threadId: null,
      parentChannelId: null,
      parentMessageId: null,
      messageId: randomUUID(),
      title: "disabled",
      body: "disabled",
      createdAt: new Date(),
    }]), 0);
  } finally {
    delete process.env.SLOCK_NATIVE_NOTIFICATIONS_ENABLED;
    await app.close();
  }
});

test("enrollment is key-bound, <=60s, hash-only, and single-use", async ({ app }) => {
  const user = await seedUser(`native-enroll-${randomUUID()}@slock.test`);
  const session = await login(app.baseUrl, user.email);
  const native = makeNativeBinding();
  const issuedAt = Date.now();
  const { grant, expiresAt } = await requestGrant(app.baseUrl, session.accessToken, native.request);
  assert.match(grant, /^rng1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
  assert.ok(Date.parse(expiresAt) - issuedAt <= 60_500);

  const [persistedGrant] = await getDb().select().from(nativeNotificationEnrollmentGrants);
  assert.ok(persistedGrant);
  assert.notEqual(persistedGrant.secretHash, grant);
  assert.equal(JSON.stringify(persistedGrant).includes(grant), false);

  const wrongKey = makeNativeBinding();
  const wrongProof = sign(null, buildEnrollmentProofTranscript(grant, native.request), wrongKey.privateKey).toString("base64url");
  const denied = await fetch(`${app.baseUrl}/api/notifications/enrollment-exchanges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant, proof: wrongProof }),
  });
  assert.equal(denied.status, 403);

  const concurrent = await Promise.all([
    exchangeGrant(app.baseUrl, grant, native.request, native.privateKey),
    exchangeGrant(app.baseUrl, grant, native.request, native.privateKey),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 403], "concurrent exchange must mint exactly once");
  const exchanged = concurrent.find((response) => response.status === 201)!;
  const body = await exchanged.json() as { credential: string; credentialId: string; deviceId: string; scope: string };
  assert.match(body.credential, /^rnc1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
  assert.equal(body.scope, "notifications:stream");

  const replay = await exchangeGrant(app.baseUrl, grant, native.request, native.privateKey);
  assert.equal(replay.status, 403, "a consumed grant must never mint a later credential");

  const [credentialRow] = await getDb().select().from(nativeNotificationCredentials).where(eq(nativeNotificationCredentials.id, body.credentialId));
  assert.ok(credentialRow);
  assert.equal(JSON.stringify(credentialRow).includes(body.credential), false);

  const listed = await fetch(`${app.baseUrl}/api/notifications/devices`, { headers: sessionHeaders(session.accessToken) });
  assert.equal(listed.status, 200);
  const listedText = await listed.text();
  assert.equal(listedText.includes("secretHash"), false);
  assert.equal(listedText.includes("publicKey"), false);
  assert.equal(listedText.includes(body.credential), false);
});

test("preview/no-proof, expired grant, and dead session-family fail closed", async ({ app }) => {
  const user = await seedUser(`native-negative-${randomUUID()}@slock.test`);
  const session = await login(app.baseUrl, user.email);
  const native = makeNativeBinding();
  const { grant } = await requestGrant(app.baseUrl, session.accessToken, native.request);

  const noProof = await fetch(`${app.baseUrl}/api/notifications/enrollment-exchanges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant }),
  });
  assert.equal(noProof.status, 403);

  const alteredBindingProof = sign(null, buildEnrollmentProofTranscript(grant, {
    ...native.request,
    nonce: randomBytes(32).toString("base64url"),
  }), native.privateKey).toString("base64url");
  const alteredBinding = await fetch(`${app.baseUrl}/api/notifications/enrollment-exchanges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant, proof: alteredBindingProof }),
  });
  assert.equal(alteredBinding.status, 403, "a proof over an altered nonce/binding must fail");

  const grantId = grant.split(".")[1]!;
  await getDb().update(nativeNotificationEnrollmentGrants).set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(nativeNotificationEnrollmentGrants.id, grantId));
  const expired = await exchangeGrant(app.baseUrl, grant, native.request, native.privateKey);
  assert.equal(expired.status, 403);

  const second = await requestGrant(app.baseUrl, session.accessToken, native.request);
  const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, user.id));
  assert.ok(family);
  await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "test" }).where(eq(sessionFamilies.id, family.id));
  const deadFamily = await exchangeGrant(app.baseUrl, second.grant, native.request, native.privateKey);
  assert.equal(deadFamily.status, 403);
});

test("enforced attestation fails closed unless the signed-app verifier accepts the evidence", async () => {
  process.env.NATIVE_NOTIFICATION_ATTESTATION_MODE = "enforce";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const user = await seedUser(`native-attestation-${randomUUID()}@slock.test`);
    const session = await login(app.baseUrl, user.email);
    const native = makeNativeBinding();
    const missing = await fetch(`${app.baseUrl}/api/notifications/enrollment-grants`, {
      method: "POST",
      headers: sessionHeaders(session.accessToken),
      body: JSON.stringify(native.request),
    });
    assert.equal(missing.status, 403);

    const evidence = "bounded-signed-app-attestation-test-evidence";
    __setNativeNotificationAttestationVerifierForTests((candidate) => candidate === evidence);
    const accepted = await fetch(`${app.baseUrl}/api/notifications/enrollment-grants`, {
      method: "POST",
      headers: sessionHeaders(session.accessToken),
      body: JSON.stringify({ ...native.request, attestation: evidence }),
    });
    assert.equal(accepted.status, 201, await accepted.clone().text());
  } finally {
    __setNativeNotificationAttestationVerifierForTests(null);
    delete process.env.NATIVE_NOTIFICATION_ATTESTATION_MODE;
    await app.close();
  }
});

test("SSE rejects user sessions, starts at latest, replays by user-scoped event ID, and closes on logout", async () => {
  process.env.NATIVE_NOTIFICATION_STREAM_POLL_MS = "250";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const user = await seedUser(`native-stream-${randomUUID()}@slock.test`);
    const session = await login(app.baseUrl, user.email);
    const native = await enroll(app.baseUrl, session.accessToken);
    const server = await createServer("Native Stream", `native-stream-${randomUUID()}`, user.id);
    const channelId = randomUUID();

    const sessionDenied = await fetch(`${app.baseUrl}/api/notifications/stream`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(sessionDenied.status, 401);
    assert.doesNotMatch(sessionDenied.headers.get("content-type") ?? "", /text\/event-stream/);

    const makeIntent = (messageId: string, body: string) => ({
      recipientUserId: user.id,
      eventKey: `stream-test:${messageId}`,
      serverId: server.id,
      kind: "channel" as const,
      channelId,
      threadId: null,
      parentChannelId: null,
      parentMessageId: null,
      messageId,
      title: "Native title",
      body,
      createdAt: new Date(),
    });

    const beforeConnect = makeIntent(randomUUID(), "before connect");
    await persistNativeNotificationIntents([beforeConnect, beforeConnect]);
    const duplicateRows = await getDb().select().from(nativeNotificationEvents)
      .where(eq(nativeNotificationEvents.dedupeKey, beforeConnect.eventKey));
    assert.equal(duplicateRows.length, 1, "intent dedupe must retain one stable event");
    const stream = await fetch(`${app.baseUrl}/api/notifications/stream`, {
      headers: { authorization: `Bearer ${native.credential}`, accept: "text/event-stream" },
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);

    const firstMessageId = randomUUID();
    await persistNativeNotificationIntents([makeIntent(firstMessageId, "after connect")]);
    const [first] = await readSseEvents(stream.body!, 1);
    assert.ok(first);
    assert.equal(first.data.version, 1);
    assert.equal(first.data.body, "after connect", "a cursorless connect must not replay the pre-connect event");
    assert.deepEqual(Object.keys(first.data).sort(), ["body", "createdAt", "eventId", "serverId", "targetUri", "title", "version"]);
    assert.match(String(first.data.targetUri), /^raft:\/\/v1\/servers\/[0-9a-f-]{36}\/channels\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}$/);

    await persistNativeNotificationIntents([
      makeIntent(randomUUID(), "replay one"),
      makeIntent(randomUUID(), "replay two"),
    ]);
    const replayStream = await fetch(`${app.baseUrl}/api/notifications/stream`, {
      headers: { authorization: `Bearer ${native.credential}`, "last-event-id": first.id },
    });
    assert.equal(replayStream.status, 200);
    const replay = await readSseEvents(replayStream.body!, 2);
    assert.deepEqual(replay.map((event) => event.data.body), ["replay one", "replay two"]);
    assert.equal(new Set(replay.map((event) => event.id)).size, 2);

    const foreignUser = await seedUser(`native-foreign-${randomUUID()}@slock.test`);
    const dormantForeignIntent = { ...makeIntent(randomUUID(), "dormant foreign"), recipientUserId: foreignUser.id, eventKey: `foreign-dormant:${randomUUID()}` };
    assert.equal(await persistNativeNotificationIntents([dormantForeignIntent]), 0, "users without a live native credential must not grow the ledger");
    const foreignSession = await login(app.baseUrl, foreignUser.email);
    await enroll(app.baseUrl, foreignSession.accessToken);
    await persistNativeNotificationIntents([{ ...makeIntent(randomUUID(), "foreign"), recipientUserId: foreignUser.id, eventKey: `foreign:${randomUUID()}` }]);
    const [foreignEvent] = await getDb().select().from(nativeNotificationEvents)
      .where(eq(nativeNotificationEvents.recipientUserId, foreignUser.id));
    const foreignCursor = await fetch(`${app.baseUrl}/api/notifications/stream`, {
      headers: { authorization: `Bearer ${native.credential}`, "last-event-id": foreignEvent!.eventId },
    });
    assert.equal(foreignCursor.status, 409);
    assert.doesNotMatch(foreignCursor.headers.get("content-type") ?? "", /text\/event-stream/);

    const liveAtLogout = await fetch(`${app.baseUrl}/api/notifications/stream`, {
      headers: { authorization: `Bearer ${native.credential}` },
    });
    assert.equal(liveAtLogout.status, 200);

    const logout = await fetch(`${app.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    assert.equal(logout.status, 200, await logout.clone().text());
    assert.equal(await waitForSseClose(liveAtLogout.body!, 1_500), true, "logout must actively close the live stream before another event");
    const afterLogout = await fetch(`${app.baseUrl}/api/notifications/stream`, {
      headers: { authorization: `Bearer ${native.credential}` },
    });
    assert.equal(afterLogout.status, 401);
    assert.doesNotMatch(afterLogout.headers.get("content-type") ?? "", /text\/event-stream/);
  } finally {
    delete process.env.NATIVE_NOTIFICATION_STREAM_POLL_MS;
    await app.close();
  }
});

test("live SSE reauthenticates before every frame and stops a revoked in-flight batch", async () => {
  process.env.NATIVE_NOTIFICATION_STREAM_POLL_MS = "250";
  try {
    for (const revocation of ["credential", "session-family"] as const) {
      const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
      try {
        const user = await seedUser(`native-mid-batch-${revocation}-${randomUUID()}@slock.test`);
        const session = await login(app.baseUrl, user.email);
        const native = await enroll(app.baseUrl, session.accessToken);
        const server = await createServer("Native Mid Batch", `native-mid-batch-${randomUUID()}`, user.id);
        const channelId = randomUUID();
        const stream = await fetch(`${app.baseUrl}/api/notifications/stream`, {
          headers: { authorization: `Bearer ${native.credential}`, accept: "text/event-stream" },
        });
        assert.equal(stream.status, 200);

        let hookCalls = 0;
        __setNativeNotificationLiveWriteHookForTests(async ({ index, eventCount }) => {
          hookCalls += 1;
          assert.equal(eventCount, 2);
          if (index !== 1) return;
          if (revocation === "credential") {
            await revokeCurrentNativeCredential(native.credential);
            return;
          }
          const logout = await fetch(`${app.baseUrl}/api/auth/logout`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken: session.refreshToken }),
          });
          assert.equal(logout.status, 200, await logout.clone().text());
        });

        const makeIntent = (body: string) => {
          const messageId = randomUUID();
          return {
            recipientUserId: user.id,
            eventKey: `mid-batch:${messageId}`,
            serverId: server.id,
            kind: "channel" as const,
            channelId,
            threadId: null,
            parentChannelId: null,
            parentMessageId: null,
            messageId,
            title: "Native title",
            body,
            createdAt: new Date(),
          };
        };
        await persistNativeNotificationIntents([makeIntent("first allowed"), makeIntent("second revoked")]);

        const result = await readSseEventsUntilClose(stream.body!, 2_000);
        assert.equal(result.closed, true, `${revocation} revocation during an already-read batch must close the stream`);
        assert.deepEqual(result.events.map((event) => event.data.body), ["first allowed"]);
        assert.equal(hookCalls, 2, "the revocation seam must run between the first and second frame");
      } finally {
        __setNativeNotificationLiveWriteHookForTests(null);
        await app.close();
      }
    }
  } finally {
    __setNativeNotificationLiveWriteHookForTests(null);
    delete process.env.NATIVE_NOTIFICATION_STREAM_POLL_MS;
  }
});

test("credential rotation is key-bound; expiry and device revoke invalidate credentials", async ({ app }) => {
  const user = await seedUser(`native-rotate-${randomUUID()}@slock.test`);
  const session = await login(app.baseUrl, user.email);
  const native = await enroll(app.baseUrl, session.accessToken);
  const proof = sign(null, buildRotationProofTranscript(native.credential, native.deviceId), native.privateKey).toString("base64url");
  const rotated = await fetch(`${app.baseUrl}/api/notifications/credentials/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${native.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ proof }),
  });
  assert.equal(rotated.status, 201, await rotated.clone().text());
  const replacement = await rotated.json() as { credential: string; credentialId: string };

  const oldDenied = await fetch(`${app.baseUrl}/api/notifications/stream`, {
    headers: { authorization: `Bearer ${native.credential}` },
  });
  assert.equal(oldDenied.status, 401);

  await getDb().update(nativeNotificationCredentials).set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(nativeNotificationCredentials.id, replacement.credentialId));
  const expiredDenied = await fetch(`${app.baseUrl}/api/notifications/stream`, {
    headers: { authorization: `Bearer ${replacement.credential}` },
  });
  assert.equal(expiredDenied.status, 401);
  const afterExpiry = await fetch(`${app.baseUrl}/api/notifications/devices`, { headers: sessionHeaders(session.accessToken) });
  const afterExpiryBody = await afterExpiry.json() as { devices: Array<{ deviceId: string; status: string }> };
  assert.equal(afterExpiryBody.devices.find((device) => device.deviceId === native.deviceId)?.status, "inactive");

  const secondNative = await enroll(app.baseUrl, session.accessToken);

  const revoke = await fetch(`${app.baseUrl}/api/notifications/devices/${secondNative.deviceId}`, {
    method: "DELETE",
    headers: sessionHeaders(session.accessToken),
  });
  assert.equal(revoke.status, 204, await revoke.clone().text());
  const replacementDenied = await fetch(`${app.baseUrl}/api/notifications/stream`, {
    headers: { authorization: `Bearer ${secondNative.credential}` },
  });
  assert.equal(replacementDenied.status, 401);

  const [device] = await getDb().select().from(nativeNotificationDevices).where(eq(nativeNotificationDevices.id, secondNative.deviceId));
  assert.ok(device?.revokedAt);
  const afterRevoke = await fetch(`${app.baseUrl}/api/notifications/devices`, { headers: sessionHeaders(session.accessToken) });
  const afterRevokeBody = await afterRevoke.json() as { devices: Array<{ deviceId: string; status: string }> };
  assert.equal(afterRevokeBody.devices.find((candidate) => candidate.deviceId === secondNative.deviceId)?.status, "revoked");

  const selfRevokedNative = await enroll(app.baseUrl, session.accessToken);
  const selfRevoke = await fetch(`${app.baseUrl}/api/notifications/credentials/current`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${selfRevokedNative.credential}` },
  });
  assert.equal(selfRevoke.status, 204);
  const selfRevokedDenied = await fetch(`${app.baseUrl}/api/notifications/stream`, {
    headers: { authorization: `Bearer ${selfRevokedNative.credential}` },
  });
  assert.equal(selfRevokedDenied.status, 401);
});

test("native notification logs never contain submitted or persisted sensitive values", async ({ app }) => {

  const originalError = console.error;
  const originalWarn = console.warn;
  const captured: string[] = [];
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
  try {
    const user = await seedUser(`native-log-scrub-${randomUUID()}@slock.test`);
    const session = await login(app.baseUrl, user.email);
    const native = await enroll(app.baseUrl, session.accessToken);
    const [credentialRow] = await getDb().select().from(nativeNotificationCredentials)
      .where(eq(nativeNotificationCredentials.id, native.credentialId));
    assert.ok(credentialRow);

    const proof = randomBytes(64).toString("base64url");
    const denied = await fetch(`${app.baseUrl}/api/notifications/credentials/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${native.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ proof }),
    });
    assert.equal(denied.status, 403);

    const server = await createServer("Native Log Scrub", `native-log-scrub-${randomUUID()}`, user.id);
    const title = `title-${randomUUID()}`;
    const body = `body-${randomUUID()}`;
    await persistNativeNotificationIntents([{
      recipientUserId: user.id,
      eventKey: `log-scrub:${randomUUID()}`,
      serverId: server.id,
      kind: "channel",
      channelId: randomUUID(),
      threadId: null,
      parentChannelId: null,
      parentMessageId: null,
      messageId: randomUUID(),
      title,
      body,
      createdAt: new Date(),
    }]);

    const output = captured.join("\n");
    for (const forbidden of [
      native.grant,
      native.credential,
      credentialRow.secretHash,
      proof,
      session.accessToken,
      title,
      body,
    ]) {
      assert.equal(output.includes(forbidden), false, "logs must remain free of native secrets and notification content");
    }
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    await app.close();
  }
});

test("replay overflow and expired cursors fail before SSE headers", async ({ app }) => {
  const user = await seedUser(`native-overflow-${randomUUID()}@slock.test`);
  const session = await login(app.baseUrl, user.email);
  const native = await enroll(app.baseUrl, session.accessToken);
  const server = await createServer("Native Overflow", `native-overflow-${randomUUID()}`, user.id);
  const channelId = randomUUID();
  const intents = Array.from({ length: 514 }, (_, index) => {
    const messageId = randomUUID();
    return {
      recipientUserId: user.id,
      eventKey: `overflow:${index}:${messageId}`,
      serverId: server.id,
      kind: "channel" as const,
      channelId,
      threadId: null,
      parentChannelId: null,
      parentMessageId: null,
      messageId,
      title: "Overflow",
      body: `event ${index}`,
      createdAt: new Date(),
    };
  });
  await persistNativeNotificationIntents(intents);
  const rows = await getDb().select().from(nativeNotificationEvents)
    .where(eq(nativeNotificationEvents.recipientUserId, user.id))
    .orderBy(asc(nativeNotificationEvents.streamSeq));
  assert.equal(rows.length, 514);

  const overflow = await fetch(`${app.baseUrl}/api/notifications/stream`, {
    headers: { authorization: `Bearer ${native.credential}`, "last-event-id": rows[0]!.eventId },
  });
  assert.equal(overflow.status, 409);
  assert.equal((await overflow.json() as { code: string }).code, "replay_window_exceeded");
  assert.doesNotMatch(overflow.headers.get("content-type") ?? "", /text\/event-stream/);

  await getDb().update(nativeNotificationEvents).set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(nativeNotificationEvents.eventId, rows[0]!.eventId));
  const expired = await fetch(`${app.baseUrl}/api/notifications/stream`, {
    headers: { authorization: `Bearer ${native.credential}`, "last-event-id": rows[0]!.eventId },
  });
  assert.equal(expired.status, 409);
  assert.equal((await expired.json() as { code: string }).code, "replay_cursor_unavailable");
});
