import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { createOAuthClient } from "../services/oauthService";
import { integrationAuditEvents, oauthAppCardEncryptionKids, oauthAppLinkPreviews } from "../db/schema";
import { __setPreviewHttpForTests } from "../services/appLinkPreviewService";
import type { Database } from "../db";
import type { createSeed } from "../test/integration/seed";

// RFC 086 §5.2: an App registers the public key card SecretInputs are sealed
// to, on its link-preview registration, with its own client credentials only.
const test = createApiTest();
afterEach(() => { __setPreviewHttpForTests(null); });

const origin = "https://sealed.example.test";
const registration = { origin, endpoint: `${origin}/preview`, paths: ["/keys"], action_endpoint: `${origin}/actions` };
const KEY_EVENTS = ["app.card_encryption_key_set", "app.card_encryption_key_removed"] as const;

/** A fresh P-256 key as the App would publish it, and its private member for the refusal tests. */
function p256(kid: string) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { x, y, d } = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  return { jwk: { kty: "EC", crv: "P-256", use: "enc", alg: "ECDH-ES", kid, x, y }, d };
}

type Fixtures = { app: { baseUrl: string }; db: Database; seed: ReturnType<typeof createSeed> };

async function setup({ app, db, seed }: Fixtures, clientKey: string) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: clientKey, name: "Sealed" });
  const basic = { Authorization: "Basic " + Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/json" };
  const call = (method: "PUT" | "DELETE", path: string, body?: unknown, headers: Record<string, string> = basic) =>
    fetch(`${app.baseUrl}/api/oauth/${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const setKey = (body: unknown, headers?: Record<string, string>) => call("PUT", "link-preview/encryption-key", body, headers);
  const removeKey = (headers?: Record<string, string>) => call("DELETE", "link-preview/encryption-key", undefined, headers);
  const register = async () => {
    __setPreviewHttpForTests(async () => ({ client_id: client.clientId }));
    const response = await call("PUT", "link-preview", registration);
    assert.equal(response.status, 200, await response.clone().text());
  };
  const stored = async () => {
    const [row] = await db.select({ key: oauthAppLinkPreviews.cardEncryptionKey, kid: oauthAppLinkPreviews.cardEncryptionKid, setAt: oauthAppLinkPreviews.cardEncryptionKeySetAt })
      .from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id));
    return row ?? null;
  };
  const events = () => db.select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, client.id), inArray(integrationAuditEvents.eventType, [...KEY_EVENTS])))
    .orderBy(integrationAuditEvents.createdAt);
  return { owner, server, client, basic, call, setKey, removeKey, register, stored, events };
}

test("the App's own credential sets its key (audited with the kid), reads it back, and a repeat changes nothing", async ({ app, db, seed }) => {
  const ctx = { app, db, seed };
  const t = await setup(ctx, "sealed-set");
  await t.register();
  const { jwk } = p256("vault-1");
  const response = await t.setKey({ jwk });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json() as { encryption_key: { jwk: unknown; kid: string; set_at: string } };
  assert.deepEqual(body.encryption_key.jwk, jwk);
  assert.equal(body.encryption_key.kid, "vault-1");
  const row = await t.stored();
  assert.deepEqual(row?.key, jwk);
  assert.equal(row?.kid, "vault-1");
  assert.equal(row?.setAt?.toISOString(), body.encryption_key.set_at);

  const [event, ...rest] = await t.events();
  assert.equal(rest.length, 0);
  assert.equal(event!.eventType, "app.card_encryption_key_set");
  assert.equal(event!.eventCategory, "registration");
  assert.equal(event!.source, "api");
  assert.equal(event!.actorType, "system");
  assert.equal(event!.requesterType, "app");
  assert.equal(event!.requesterId, t.client.id);
  assert.equal(event!.serverId, t.server.id);
  assert.deepEqual(event!.metadata, { clientKey: "sealed-set", kid: "vault-1" }, "the kid, never the key");

  const read = await fetch(`${ctx.app.baseUrl}/api/oauth/link-preview`, { headers: t.basic });
  const { registration: shown } = await read.json() as { registration: { cardEncryptionKey: unknown; cardEncryptionKid: string } };
  assert.deepEqual(shown.cardEncryptionKey, jwk);
  assert.equal(shown.cardEncryptionKid, "vault-1");

  // A deploy script may PUT the same key on every start.
  assert.equal((await t.setKey({ jwk })).status, 200);
  assert.equal((await t.stored())?.setAt?.toISOString(), body.encryption_key.set_at);
  assert.equal((await t.events()).length, 1);
  // Re-registering link previews keeps the key.
  await t.register();
  assert.equal((await t.stored())?.kid, "vault-1");
});

test("only the App's credential: no credentials, a wrong secret, or a Server admin's session are refused and store nothing", async ({ app, db, seed }) => {
  const ctx = { app, db, seed };
  const t = await setup(ctx, "sealed-auth");
  await t.register();
  const { jwk } = p256("k1");
  const admin = { Authorization: `Bearer ${await tokenForHuman(t.owner.email)}`, "X-Server-Id": t.server.id, "Content-Type": "application/json" };
  const wrongSecret = { ...t.basic, Authorization: "Basic " + Buffer.from(`${t.client.clientId}:not-the-secret`).toString("base64") };
  for (const [what, headers] of [["none", { "Content-Type": "application/json" }], ["wrong secret", wrongSecret], ["Server owner session", admin]] as const) {
    assert.equal((await t.setKey({ jwk }, headers)).status, 401, `set: ${what}`);
  }
  assert.equal((await t.stored())?.key, null);
  // The server-scoped OAuth mount does not serve it.
  const scoped = await fetch(`${ctx.app.baseUrl}/oidc/${t.server.id}/api/oauth/link-preview/encryption-key`, { method: "PUT", headers: t.basic, body: JSON.stringify({ jwk }) });
  assert.equal(scoped.status, 404);
  assert.equal((await t.stored())?.key, null);

  assert.equal((await t.setKey({ jwk })).status, 200);
  for (const [what, headers] of [["none", {}], ["wrong secret", wrongSecret], ["Server owner session", admin]] as const) {
    assert.equal((await t.removeKey(headers)).status, 401, `remove: ${what}`);
  }
  assert.equal((await t.stored())?.kid, "k1");
  assert.deepEqual((await t.events()).map((event) => event.eventType), ["app.card_encryption_key_set"]);
});

test("a private key, another curve or key type, extra members and a point off the curve are refused without echoing the key", async ({ app, db, seed }) => {
  const ctx = { app, db, seed };
  const t = await setup(ctx, "sealed-invalid");
  await t.register();
  const { jwk, d } = p256("k1");
  const refused: Array<[string, unknown]> = [
    ["private key", { jwk: { ...jwk, d } }],
    ["P-384", { jwk: { ...jwk, crv: "P-384" } }],
    ["RSA", { jwk: { ...jwk, kty: "RSA" } }],
    ["OKP", { jwk: { kty: "OKP", crv: "X25519", use: "enc", alg: "ECDH-ES", kid: "k1", x: jwk.x } }],
    ["signing key", { jwk: { ...jwk, use: "sig" } }],
    ["key wrapping alg", { jwk: { ...jwk, alg: "ECDH-ES+A256KW" } }],
    ["extra member", { jwk: { ...jwk, ext: true } }],
    ["extra body field", { jwk, note: "x" }],
    ["off the curve", { jwk: { ...jwk, y: jwk.x } }],
    ["bare JWK", jwk],
    ["no body", undefined],
  ];
  for (const [what, body] of refused) {
    const response = await t.setKey(body);
    const text = await response.text();
    assert.equal(response.status, 400, `${what}: ${text}`);
    assert.equal(JSON.parse(text).code, "INVALID_ENCRYPTION_KEY", what);
    assert.ok(!text.includes(d) && !text.includes(jwk.x), `${what}: the answer echoes nothing of the key`);
  }
  assert.equal((await t.stored())?.key, null);
  assert.equal((await t.events()).length, 0);
});

test("without a link-preview registration the key is refused; deleting the registration removes the key and audits it", async ({ app, db, seed }) => {
  const ctx = { app, db, seed };
  const t = await setup(ctx, "sealed-unregistered");
  const { jwk } = p256("k1");
  const refused = await t.setKey({ jwk });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "LINK_PREVIEW_NOT_REGISTERED");
  assert.equal(await t.stored(), null);
  assert.equal((await t.removeKey()).status, 204, "removing none is a no-op");
  assert.equal((await t.events()).length, 0);

  await t.register();
  assert.equal((await t.setKey({ jwk })).status, 200);
  assert.equal((await t.call("DELETE", "link-preview")).status, 204);
  assert.equal(await t.stored(), null);
  const removed = (await t.events()).at(-1)!;
  assert.equal(removed.eventType, "app.card_encryption_key_removed");
  assert.equal(removed.requesterId, t.client.id);
  assert.deepEqual(removed.metadata, { clientKey: "sealed-unregistered", kid: "k1", reason: "registration_deleted" });
  // A new registration starts without a key.
  await t.register();
  assert.equal((await t.stored())?.key, null);
});

test("rotation replaces the kid (a new key needs a kid the App never used: not the one in force, not a rotated or removed one); DELETE removes it and audits once", async ({ app, db, seed }) => {
  const ctx = { app, db, seed };
  const t = await setup(ctx, "sealed-rotate");
  await t.register();
  const first = p256("2026-11-a");
  const second = p256("2026-11-b");
  assert.equal((await t.setKey({ jwk: first.jwk })).status, 200);
  const reused = await t.setKey({ jwk: { ...second.jwk, kid: "2026-11-a" } });
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).code, "KID_IN_USE");
  assert.deepEqual((await t.stored())?.key, first.jwk);

  assert.equal((await t.setKey({ jwk: second.jwk })).status, 200);
  const row = await t.stored();
  assert.deepEqual(row?.key, second.jwk);
  assert.equal(row?.kid, "2026-11-b");
  const rotated = (await t.events()).at(-1)!;
  assert.deepEqual(rotated.metadata, { clientKey: "sealed-rotate", kid: "2026-11-b", previousKid: "2026-11-a" });

  // A kid names one key for the App's lifetime (Tenny): a rotated-away kid is refused for a new key too.
  const back = await t.setKey({ jwk: { ...p256("x").jwk, kid: "2026-11-a" } });
  assert.equal(back.status, 409);
  assert.equal((await back.json()).code, "KID_IN_USE");
  assert.deepEqual((await t.stored())?.key, second.jwk);

  const deleted = await t.removeKey();
  assert.equal(deleted.status, 204);
  assert.deepEqual(await t.stored(), { key: null, kid: null, setAt: null });
  assert.equal((await t.removeKey()).status, 204);
  // So is a removed one, even for the very key it named; a fresh kid is taken.
  for (const jwk of [{ ...p256("x").jwk, kid: "2026-11-b" }, second.jwk, first.jwk]) {
    const refused = await t.setKey({ jwk });
    assert.equal(refused.status, 409, jwk.kid);
    assert.equal((await refused.json()).code, "KID_IN_USE");
  }
  assert.deepEqual(await t.stored(), { key: null, kid: null, setAt: null });
  const used = await db.select({ kid: oauthAppCardEncryptionKids.kid }).from(oauthAppCardEncryptionKids).where(eq(oauthAppCardEncryptionKids.clientId, t.client.id));
  assert.deepEqual(used.map((row) => row.kid).sort(), ["2026-11-a", "2026-11-b"]);
  const events = await t.events();
  assert.deepEqual(events.map((event) => event.eventType), ["app.card_encryption_key_set", "app.card_encryption_key_set", "app.card_encryption_key_removed"]);
  const removed = events.at(-1)!;
  assert.equal(removed.eventCategory, "revocation");
  assert.equal(removed.requesterType, "app");
  assert.equal(removed.requesterId, t.client.id);
  assert.deepEqual(removed.metadata, { clientKey: "sealed-rotate", kid: "2026-11-b", reason: "removed" });
});

test("a key set before the kid history existed: its kid is remembered when it's replaced (no backfill needed)", async ({ app, db, seed }) => {
  const t = await setup({ app, db, seed }, "sealed-legacy");
  await t.register();
  assert.equal((await t.setKey({ jwk: p256("old").jwk })).status, 200);
  // As before the history table: the key in force has no history row.
  await db.delete(oauthAppCardEncryptionKids).where(eq(oauthAppCardEncryptionKids.clientId, t.client.id));
  assert.equal((await t.setKey({ jwk: p256("new").jwk })).status, 200);
  const reused = await t.setKey({ jwk: p256("old").jwk });
  assert.equal(reused.status, 409);
  assert.equal((await reused.json() as { code: string }).code, "KID_IN_USE");
});

test("an origin taken over by another App takes the holder's key with its registration (system removal, audited)", async ({ app, db, seed }) => {
  const ctx = { app, db, seed };
  const t = await setup(ctx, "sealed-holder");
  await t.register();
  assert.equal((await t.setKey({ jwk: p256("held").jwk })).status, 200);
  const other = await createOAuthClient({ serverId: t.server.id, createdByUserId: t.owner.id, clientId: "sealed-taker", name: "Taker" });
  __setPreviewHttpForTests(async () => ({ client_id: other.client.clientId }));
  const takeover = await fetch(`${ctx.app.baseUrl}/api/oauth/link-preview`, {
    method: "PUT", headers: { Authorization: "Basic " + Buffer.from(`${other.client.clientId}:${other.clientSecret}`).toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify(registration),
  });
  assert.equal(takeover.status, 200);
  assert.equal(await t.stored(), null);
  const removed = (await t.events()).at(-1)!;
  assert.equal(removed.eventType, "app.card_encryption_key_removed");
  assert.equal(removed.source, "system");
  assert.equal(removed.requesterType, null);
  assert.ok(removed.correlationId, "shares the takeover's correlation id");
  assert.deepEqual(removed.metadata, { clientKey: "sealed-holder", kid: "held", reason: "taken_over" });
  // The new holder doesn't inherit the key (Warden): its registration starts with none.
  const takerRead = await fetch(`${ctx.app.baseUrl}/api/oauth/link-preview`, {
    headers: { Authorization: "Basic " + Buffer.from(`${other.client.clientId}:${other.clientSecret}`).toString("base64") },
  });
  assert.equal(takerRead.status, 200);
  const { registration: taker } = await takerRead.json() as { registration: Record<string, unknown> | null };
  assert.ok(taker, "the taker holds the registration");
  assert.equal(taker.cardEncryptionKey, null);
  assert.equal(taker.cardEncryptionKid, null);
  assert.equal(taker.cardEncryptionKeySetAt, null);
  // The kids it used stay its own: they survive the registration, and another App's history is its own.
  const takerKey = await fetch(`${ctx.app.baseUrl}/api/oauth/link-preview/encryption-key`, {
    method: "PUT", headers: { Authorization: "Basic " + Buffer.from(`${other.client.clientId}:${other.clientSecret}`).toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify({ jwk: p256("held").jwk }),
  });
  assert.equal(takerKey.status, 200, "another App may use the same kid for its own key");
  const used = await db.select({ kid: oauthAppCardEncryptionKids.kid }).from(oauthAppCardEncryptionKids).where(eq(oauthAppCardEncryptionKids.clientId, t.client.id));
  assert.deepEqual(used.map((row) => row.kid), ["held"]);
});
