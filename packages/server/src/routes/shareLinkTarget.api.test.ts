// Private share links are bound to one target Server and used once
// (#proj-apps:769a57d4). The creator names the target by slug; whether the
// slug names a Server is never answered, and anyone who can't install the link
// on its target gets exactly what a bad token gets.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../db/index";
import { integrationAuditEvents, oauthClientInstalls, oauthClientShareLinks, serverMembers, servers } from "../db/schema";
import { createOAuthClient } from "../services/oauthService";
import { apiTest as test } from "../test/integration/apiTest";
import { expectedAppPermissionsBody } from "../test/integration/appPermissions";
import { seedBoundGuest } from "../test/guestFixture";
import type { createHttpClient } from "../test/integration/http";
import type { createSeed } from "../test/integration/seed";

type Http = ReturnType<typeof createHttpClient>;
type Seed = ReturnType<typeof createSeed>;
type Human = Awaited<ReturnType<Seed["human"]>>;
type ShareCreated = {
  client: Record<string, unknown>;
  link: { id: string; targetServerSlug: string | null } & Record<string, unknown>;
  token: string;
};

const INVALID_INVITE = { error: "This private app invite is invalid or has expired", code: "private_app_invite_invalid" };

async function seedSharedApp(seed: Seed) {
  const owner = await seed.human();
  const source = await seed.server({ owner, name: "Share Source" });
  const { client } = await createOAuthClient({
    serverId: source.id,
    createdByUserId: owner.id,
    clientId: `bound-${randomUUID().slice(0, 8)}`,
    name: "Bound App",
    allowedScopes: ["openid", "profile"],
  });
  return { owner, source, client };
}

type SharedApp = Awaited<ReturnType<typeof seedSharedApp>>;

async function seedTarget(seed: Seed, name: string) {
  const owner = await seed.human();
  const server = await seed.server({ owner, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}-${randomUUID().slice(0, 8)}` });
  return { owner, server };
}

function createLink(http: Http, f: SharedApp, targetServerSlug: string) {
  return http.as(f.owner, f.source).request(`/api/integrations/clients/${f.client.id}/share-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetServerSlug }),
  });
}

async function createdLink(http: Http, f: SharedApp, targetServerSlug: string): Promise<ShareCreated> {
  const res = await createLink(http, f, targetServerSlug);
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as ShareCreated;
}

async function listLinks(http: Http, f: SharedApp) {
  const res = await http.as(f.owner, f.source).get(`/api/integrations/clients/${f.client.id}/share-links`);
  assert.equal(res.status, 200);
  return (await res.json() as { links: Array<{ id: string; targetServerSlug: string | null }> }).links;
}

function viewInvite(http: Http, human: Human, token: string) {
  return http.as(human).get(`/api/integration-invites/${token}`);
}

async function install(http: Http, human: Human, token: string, serverId: string, clientId: string) {
  return http.as(human).request(`/api/integration-invites/${token}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, ...await expectedAppPermissionsBody(clientId) }),
  });
}

async function assertInvalid(res: Response, label: string) {
  assert.equal(res.status, 404, label);
  assert.deepEqual(await res.json(), INVALID_INVITE, label);
}

/** A member of the target without owner/admin is told whom to ask: they are in that Server already. */
async function assertAdminRequired(res: Response, server: { name: string; slug: string }, label: string) {
  assert.equal(res.status, 403, label);
  assert.deepEqual(await res.json(), {
    error: `An owner or admin of ${server.name} needs to install this app`,
    code: "private_app_invite_admin_required",
    targetServer: { name: server.name, slug: server.slug },
  }, label);
}

function installRows(clientId: string) {
  return getDb().select({ serverId: oauthClientInstalls.serverId }).from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, clientId));
}

function shapeOf(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value === null ? "null" : typeof value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, shapeOf(inner)]));
}

test("an unknown slug answers like a known one and never installs, even after a Server takes that slug", async ({ seed, http }) => {
  const f = await seedSharedApp(seed);
  const target = await seedTarget(seed, "Known Target");
  const unknownSlug = `nobody-${randomUUID().slice(0, 8)}`;

  const knownRes = await createLink(http, f, target.server.slug);
  const unknownRes = await createLink(http, f, unknownSlug);
  assert.equal(knownRes.status, 200);
  assert.equal(unknownRes.status, knownRes.status);
  const knownText = await knownRes.text();
  const known = JSON.parse(knownText) as ShareCreated;
  const unknown = await unknownRes.json() as ShareCreated;
  assert.deepEqual(shapeOf(unknown), shapeOf(known), "the same success shape either way");
  assert.equal(unknown.link.targetServerSlug, unknownSlug);
  assert.equal(knownText.includes(target.server.id), false);
  assert.equal(knownText.includes(target.server.name), false);
  assert.deepEqual((await listLinks(http, f)).map((link) => link.targetServerSlug).sort(), [unknownSlug, target.server.slug].sort());

  const stored = await getDb().select({ id: oauthClientShareLinks.id, targetServerId: oauthClientShareLinks.targetServerId })
    .from(oauthClientShareLinks).where(eq(oauthClientShareLinks.clientId, f.client.id));
  assert.equal(stored.find((row) => row.id === unknown.link.id)?.targetServerId, null, "an unknown slug stores no target");
  assert.equal(stored.find((row) => row.id === known.link.id)?.targetServerId, target.server.id);

  // A Server created later with that slug is still not the link's target.
  const late = await seed.human();
  const lateServer = await seed.server({ owner: late, name: "Late Server", slug: unknownSlug });
  await assertInvalid(await viewInvite(http, late, unknown.token), "late owner views the unknown-slug link");
  await assertInvalid(await install(http, late, unknown.token, lateServer.id, f.client.id), "late owner installs the unknown-slug link");
  assert.deepEqual((await installRows(f.client.id)).map((row) => row.serverId), [f.source.id]);

  // Witness: the known slug's link works for its target.
  assert.equal((await viewInvite(http, target.owner, known.token)).status, 200);
});

test("a link installs only on its target, by an owner or admin there, and only once", async ({ seed, http }) => {
  const f = await seedSharedApp(seed);
  const target = await seedTarget(seed, "Target");
  const other = await seedTarget(seed, "Other");
  const targetMember = await seed.human();
  const targetGuest = await seed.human();
  const targetAdmin = await seed.human();
  await getDb().insert(serverMembers).values([
    { serverId: target.server.id, userId: targetMember.id, role: "member" },
    { serverId: target.server.id, userId: targetAdmin.id, role: "admin" },
    // An owner of both: still only the target counts.
    { serverId: other.server.id, userId: targetAdmin.id, role: "owner" },
    // A member of the target who owns another Server: still told to ask the target's admins.
    { serverId: other.server.id, userId: targetMember.id, role: "admin" },
  ]);
  await seedBoundGuest({ serverId: target.server.id, userId: targetGuest.id });
  const share = await createdLink(http, f, target.server.slug);

  // Not in the target: the bad-token answer.
  await assertInvalid(await viewInvite(http, other.owner, share.token), "owner of another Server views");
  await assertInvalid(await install(http, other.owner, share.token, other.server.id, f.client.id), "owner of another Server installs there");
  await assertInvalid(await install(http, targetAdmin, share.token, other.server.id, f.client.id), "target admin installs on another Server they own");
  // In the target without the role: who to ask.
  await assertAdminRequired(await viewInvite(http, targetMember, share.token), target.server, "member of the target views");
  await assertAdminRequired(await viewInvite(http, targetGuest, share.token), target.server, "guest of the target views");
  await assertAdminRequired(await install(http, targetMember, share.token, target.server.id, f.client.id), target.server, "member of the target installs");
  await assertAdminRequired(await install(http, targetMember, share.token, other.server.id, f.client.id), target.server, "member of the target installs on a Server they administer");
  assert.deepEqual((await installRows(f.client.id)).map((row) => row.serverId), [f.source.id], "nothing installed by the refusals");

  const view = await viewInvite(http, targetAdmin, share.token);
  assert.equal(view.status, 200);
  const invite = await view.json() as { manageableServers: Array<{ id: string; role: string }>; link: { targetServerSlug: string | null } };
  assert.deepEqual(invite.manageableServers.map((server) => [server.id, server.role]), [[target.server.id, "admin"]],
    "the one target, never the other Servers the viewer manages");
  assert.equal(invite.link.targetServerSlug, target.server.slug);

  const installed = await install(http, targetAdmin, share.token, target.server.id, f.client.id);
  assert.equal(installed.status, 200, await installed.clone().text());
  const body = await installed.json() as { client: { installedAt: string | null }; link: { consumedAt: string | null } };
  assert.ok(body.client.installedAt);
  assert.ok(body.link.consumedAt);
  assert.deepEqual((await installRows(f.client.id)).map((row) => row.serverId).sort(), [f.source.id, target.server.id].sort());

  // Used: the same answer as a bad token, for the installer, the target's owner and its members alike.
  await assertInvalid(await install(http, targetAdmin, share.token, target.server.id, f.client.id), "second use");
  await assertInvalid(await viewInvite(http, target.owner, share.token), "view after use");
  await assertInvalid(await viewInvite(http, targetMember, share.token), "member views after use");
  assert.deepEqual(await listLinks(http, f), []);
});

test("two installs racing on one link make one installation and spend the link once", async ({ seed, http }) => {
  const f = await seedSharedApp(seed);
  const target = await seedTarget(seed, "Race Target");
  const share = await createdLink(http, f, target.server.slug);

  const results = await Promise.all([
    install(http, target.owner, share.token, target.server.id, f.client.id),
    install(http, target.owner, share.token, target.server.id, f.client.id),
  ]);
  assert.deepEqual(results.map((res) => res.status).sort(), [200, 404]);

  const [link] = await getDb().select().from(oauthClientShareLinks).where(eq(oauthClientShareLinks.id, share.link.id));
  assert.ok(link?.consumedAt);
  const installedEvents = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, f.client.id), eq(integrationAuditEvents.eventType, "private_share.installed")));
  assert.equal(installedEvents.length, 1);
});

test("links for several targets coexist; a new one replaces only its target's, and revoking one leaves the rest", async ({ seed, http }) => {
  const f = await seedSharedApp(seed);
  const alpha = await seedTarget(seed, "Alpha");
  const beta = await seedTarget(seed, "Beta");

  const alpha1 = await createdLink(http, f, alpha.server.slug);
  const betaLink = await createdLink(http, f, beta.server.slug);
  assert.deepEqual((await listLinks(http, f)).map((link) => link.id).sort(), [betaLink.link.id, alpha1.link.id].sort());

  const alpha2 = await createdLink(http, f, alpha.server.slug);
  assert.deepEqual((await listLinks(http, f)).map((link) => link.id).sort(), [alpha2.link.id, betaLink.link.id].sort());
  await assertInvalid(await viewInvite(http, alpha.owner, alpha1.token), "replaced link");
  assert.equal((await viewInvite(http, alpha.owner, alpha2.token)).status, 200);

  const revoke = (linkId: string) => http.as(f.owner, f.source).request(`/api/integrations/clients/${f.client.id}/share-links/${linkId}`, { method: "DELETE" });
  const revoked = await revoke(betaLink.link.id);
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json() as { id: string; revokedAt: string | null }).revokedAt !== null, true);
  assert.deepEqual((await listLinks(http, f)).map((link) => link.id), [alpha2.link.id]);
  await assertInvalid(await viewInvite(http, beta.owner, betaLink.token), "revoked link");
  assert.equal((await viewInvite(http, alpha.owner, alpha2.token)).status, 200, "the other target's link still works");
  assert.equal((await revoke(betaLink.link.id)).status, 404, "nothing active left to revoke");

  // Another App's link is not this App's to revoke.
  const g = await seedSharedApp(seed);
  const foreign = await createdLink(http, g, alpha.server.slug);
  assert.equal((await revoke(foreign.link.id)).status, 404);
  assert.equal((await viewInvite(http, alpha.owner, foreign.token)).status, 200);

  const active = await getDb().select({ id: oauthClientShareLinks.id }).from(oauthClientShareLinks)
    .where(and(eq(oauthClientShareLinks.clientId, f.client.id), isNull(oauthClientShareLinks.revokedAt)));
  assert.deepEqual(active.map((row) => row.id), [alpha2.link.id]);
});

test("creating a link requires a slug-shaped target", async ({ seed, http }) => {
  const f = await seedSharedApp(seed);
  for (const targetServerSlug of [undefined, "", "   ", "Not A Slug", "__joint_storage__", "a".repeat(101)]) {
    const res = await http.as(f.owner, f.source).request(`/api/integrations/clients/${f.client.id}/share-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(targetServerSlug === undefined ? {} : { targetServerSlug }),
    });
    assert.equal(res.status, 400, String(targetServerSlug));
    assert.equal((await res.json() as { code: string }).code, "share_link_target_required");
  }
  assert.deepEqual(await listLinks(http, f), []);
});

test("the joint-storage namespace is never a link's target", async ({ seed, http }) => {
  const f = await seedSharedApp(seed);
  const nsOwner = await seed.human();
  const [namespace] = await getDb().insert(servers).values({
    name: "Joint Storage Namespace",
    slug: `jointns-${randomUUID().slice(0, 8)}`,
    kind: "joint_storage",
    ownerId: nsOwner.id,
  }).returning();
  await getDb().insert(serverMembers).values({ serverId: namespace.id, userId: nsOwner.id, role: "owner" });

  const share = await createdLink(http, f, namespace.slug);
  const [row] = await getDb().select({ targetServerId: oauthClientShareLinks.targetServerId })
    .from(oauthClientShareLinks).where(eq(oauthClientShareLinks.id, share.link.id));
  assert.equal(row?.targetServerId, null, "the slug does not resolve to the namespace");

  // Even a link bound to it by hand is refused.
  await getDb().update(oauthClientShareLinks).set({ targetServerId: namespace.id }).where(eq(oauthClientShareLinks.id, share.link.id));
  await assertInvalid(await viewInvite(http, nsOwner, share.token), "namespace owner views");
  await assertInvalid(await install(http, nsOwner, share.token, namespace.id, f.client.id), "namespace owner installs");
});
