import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/index";
import { featureFlagRules, featureFlags, serverMembers, serverSsoConnections, serverSsoDomains, sessionFamilies, ssoIdentities, users } from "../../db/schema";
import { SERVER_SSO_FEATURE_FLAG_KEY } from "../featureFlagService";
import { dbTest } from "../../test/integration/dbTest";
import { seedBoundGuest } from "../../test/guestFixture";
import { CURRENT_LEGAL_ACCEPTANCE, HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { isAutoHumanAvatarUrl } from "@botiverse/raft-shared/src/humanAvatar";
import { autoJoinAfterSsoSignIn, completeSsoSignIn, type SsoProfile } from "./ssoSignIn";

// Who an SSO sign-in is, and what it does to the account (rfcs/083-server-sso.md §5.3, §5.4, §6.1).

const LEGAL = { acceptTerms: true, termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion, privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion };

async function connectionFor(serverId: string, options: { status?: "draft" | "active"; domain?: string | null; autoJoin?: boolean } = {}) {
  await getDb().insert(featureFlags)
    .values({ key: SERVER_SSO_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: true })
    .onConflictDoNothing();
  const [connection] = await getDb().insert(serverSsoConnections).values({
    serverId,
    protocol: "oidc",
    status: options.status ?? "active",
    displayName: "Acme",
    config: { protocol: "oidc", issuer: "https://acme.okta.com", clientId: "raft" },
    autoJoin: options.autoJoin ?? false,
  }).returning();
  if (options.domain !== null) {
    await getDb().insert(serverSsoDomains).values({
      serverId,
      domain: options.domain ?? "acme.test",
      verificationToken: randomUUID(),
      verifiedAt: new Date(),
    });
  }
  return connection!;
}

function profile(overrides: Partial<SsoProfile> = {}): SsoProfile {
  return { subject: `sub-${randomUUID()}`, email: `alice-${randomUUID().slice(0, 6)}@acme.test`, emailVerified: true, displayName: "Alice", linkByEmail: "link_and_move", ...overrides };
}

dbTest("refuses an inactive connection, an unverified email and an email off the verified domains", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const draft = await connectionFor(server.id, { status: "draft", domain: null });
  assert.deepEqual(await completeSsoSignIn({ connectionId: draft.id, profile: profile(), legalAcceptance: LEGAL }), { kind: "refused", reason: "connection_inactive" });

  const other = await seed.server({ owner });
  const active = await connectionFor(other.id);
  assert.deepEqual(await completeSsoSignIn({ connectionId: active.id, profile: profile({ emailVerified: false }), legalAcceptance: LEGAL }), { kind: "refused", reason: "email_unverified" });
  assert.deepEqual(await completeSsoSignIn({ connectionId: active.id, profile: profile({ email: "bob@elsewhere.test" }), legalAcceptance: LEGAL }), { kind: "refused", reason: "domain_not_verified" });
  // A subdomain is not covered by its parent.
  assert.deepEqual(await completeSsoSignIn({ connectionId: active.id, profile: profile({ email: "bob@eu.acme.test" }), legalAcceptance: LEGAL }), { kind: "refused", reason: "domain_not_verified" });

  await getDb().update(serverSsoDomains).set({ verifiedAt: null }).where(eq(serverSsoDomains.serverId, other.id));
  assert.deepEqual(await completeSsoSignIn({ connectionId: active.id, profile: profile(), legalAcceptance: LEGAL }), { kind: "refused", reason: "domain_not_verified" }, "a lapsed domain links no one");
});

dbTest("a new SSO account gets a built avatar only where human_avatar_builder_v0 is on for the connection's server", async ({ seed }) => {
  const owner = await seed.human();
  const off = await seed.server({ owner });
  const offConnection = await connectionFor(off.id, { domain: "off-avatar.test" });
  const offSignIn = await completeSsoSignIn({ connectionId: offConnection.id, profile: profile({ email: `a-${randomUUID().slice(0, 6)}@off-avatar.test` }), legalAcceptance: LEGAL });
  assert.equal(offSignIn.kind, "signed_in");
  if (offSignIn.kind !== "signed_in") return;
  const [offUser] = await getDb().select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, offSignIn.userId));
  assert.equal(offUser!.avatarUrl, null, "missing flag = off: the generic person icon");

  const on = await seed.server({ owner });
  await getDb().insert(featureFlags)
    .values({ key: HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(), flagKey: HUMAN_AVATAR_BUILDER_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [on.id],
  });
  const onConnection = await connectionFor(on.id, { domain: "on-avatar.test" });
  const onSignIn = await completeSsoSignIn({ connectionId: onConnection.id, profile: profile({ email: `b-${randomUUID().slice(0, 6)}@on-avatar.test` }), legalAcceptance: LEGAL });
  assert.equal(onSignIn.kind, "signed_in");
  if (onSignIn.kind !== "signed_in") return;
  const [onUser] = await getDb().select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, onSignIn.userId));
  assert.ok(isAutoHumanAvatarUrl(onUser!.avatarUrl), `the Server's pick: ${onUser!.avatarUrl}`);
});

dbTest("creates the account on first sign-in (with legal acceptance) and signs the family in by SSO", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const connection = await connectionFor(server.id);
  const alice = profile();

  assert.deepEqual(await completeSsoSignIn({ connectionId: connection.id, profile: alice }), { kind: "refused", reason: "legal_acceptance_required" });
  assert.equal((await getDb().select().from(users).where(eq(users.email, alice.email))).length, 0, "nothing written without acceptance");

  const signedIn = await completeSsoSignIn({ connectionId: connection.id, profile: alice, legalAcceptance: LEGAL });
  assert.equal(signedIn.kind, "signed_in");
  if (signedIn.kind !== "signed_in") return;
  assert.equal(signedIn.createdAccount, true);
  const [user] = await getDb().select().from(users).where(eq(users.id, signedIn.userId));
  assert.equal(user!.email, alice.email);
  assert.equal(user!.emailVerified, true);
  assert.equal(user!.passwordCredentialEstablishedAt, null);
  const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, signedIn.session.familyId));
  assert.equal(family!.ssoConnectionId, connection.id);
  assert.ok(family!.ssoAuthenticatedAt);

  // The second time it is the identity that decides, whatever email the IdP now asserts.
  const again = await completeSsoSignIn({ connectionId: connection.id, profile: { ...alice, email: "renamed@elsewhere.test" } });
  assert.equal(again.kind === "signed_in" && again.userId, signedIn.userId);
  assert.equal(again.kind === "signed_in" && again.linked, false);
});

dbTest("links an account that verified its email, and keeps everything it has", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const connection = await connectionFor(server.id);
  const existing = await seed.human({ email: "carol@acme.test" });
  const result = await completeSsoSignIn({ connectionId: connection.id, profile: profile({ email: "Carol@ACME.test" }) });
  assert.equal(result.kind === "signed_in" && result.userId, existing.id);
  const [after] = await getDb().select().from(users).where(eq(users.id, existing.id));
  assert.equal(after!.passwordHash, existing.passwordHash);
  const [identity] = await getDb().select().from(ssoIdentities).where(eq(ssoIdentities.userId, existing.id));
  assert.equal(identity!.connectionId, connection.id);
});

dbTest("an account that never verified its email is refused and left untouched (claim it by password reset)", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const connection = await connectionFor(server.id);
  const squatter = await seed.human({ email: "dave@acme.test", emailVerified: false });
  const [squatterFamily] = await getDb().insert(sessionFamilies).values({ userId: squatter.id }).returning();
  assert.deepEqual(
    await completeSsoSignIn({ connectionId: connection.id, profile: profile({ email: "dave@acme.test" }), legalAcceptance: LEGAL }),
    { kind: "refused", reason: "account_email_unverified" },
  );
  assert.equal((await getDb().select().from(ssoIdentities).where(eq(ssoIdentities.userId, squatter.id))).length, 0);
  const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, squatterFamily!.id));
  assert.equal(family!.revokedAt, null, "nothing is changed by a refusal");
});

dbTest("a linked identity of a retired account is refused, not an error", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const connection = await connectionFor(server.id);
  const hank = await seed.human({ email: "hank@acme.test" });
  const first = profile({ email: "hank@acme.test" });
  assert.equal((await completeSsoSignIn({ connectionId: connection.id, profile: first })).kind, "signed_in");
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, hank.id));
  assert.deepEqual(await completeSsoSignIn({ connectionId: connection.id, profile: first }), { kind: "refused", reason: "account_unavailable" });
});

dbTest("an IdP that re-provisions the person (a new subject) moves the link", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const connection = await connectionFor(server.id);
  const ivy = await seed.human({ email: "ivy@acme.test" });
  await completeSsoSignIn({ connectionId: connection.id, profile: profile({ email: "ivy@acme.test", subject: "old" }) });
  const again = await completeSsoSignIn({ connectionId: connection.id, profile: profile({ email: "ivy@acme.test", subject: "new" }) });
  assert.equal(again.kind === "signed_in" && again.userId, ivy.id);
  const identities = await getDb().select().from(ssoIdentities).where(eq(ssoIdentities.userId, ivy.id));
  assert.deepEqual(identities.map((row) => row.subject), ["new"]);
});

dbTest("a person who turned two-step verification on still takes the second step", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const connection = await connectionFor(server.id);
  const erin = await seed.human({ email: "erin@acme.test", secondFactorRequiredAt: new Date() });
  assert.deepEqual(
    await completeSsoSignIn({ connectionId: connection.id, profile: profile({ email: "erin@acme.test" }) }),
    { kind: "second_factor_required", userId: erin.id, connectionId: connection.id },
  );
});

dbTest("auto-join adds a member only when on, and never changes an existing membership", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const off = await connectionFor(server.id);
  const person = await seed.human({ email: "frank@acme.test" });
  const signedIn = await completeSsoSignIn({ connectionId: off.id, profile: profile({ email: "frank@acme.test" }) });
  assert.equal(signedIn.kind, "signed_in");
  if (signedIn.kind !== "signed_in") return;
  assert.deepEqual(await autoJoinAfterSsoSignIn(signedIn), { kind: "off" });

  await getDb().update(serverSsoConnections).set({ autoJoin: true }).where(eq(serverSsoConnections.id, off.id));
  await getDb().update(serverSsoDomains).set({ verifiedAt: null }).where(eq(serverSsoDomains.serverId, server.id));
  assert.deepEqual(await autoJoinAfterSsoSignIn(signedIn), { kind: "off" }, "a lapsed domain joins no one");
  await getDb().update(serverSsoDomains).set({ verifiedAt: new Date() }).where(eq(serverSsoDomains.serverId, server.id));
  assert.deepEqual(await autoJoinAfterSsoSignIn(signedIn), { kind: "joined" });
  const [member] = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, person.id)));
  assert.equal(member!.role, "member");

  const guest = await seed.human({ email: "gina@acme.test" });
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  const guestSignIn = await completeSsoSignIn({ connectionId: off.id, profile: profile({ email: "gina@acme.test" }) });
  assert.equal(guestSignIn.kind, "signed_in");
  if (guestSignIn.kind !== "signed_in") return;
  assert.deepEqual(await autoJoinAfterSsoSignIn(guestSignIn), { kind: "already_member" });
  const [stillGuest] = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, guest.id)));
  assert.equal(stillGuest!.role, "guest", "a guest stays a guest");
});

dbTest("server_sso_v1 turned off stops sign-ins at once", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const connection = await connectionFor(server.id);
  await seed.human({ email: "jo@acme.test" });
  await getDb().update(featureFlags).set({ defaultEnabled: false }).where(eq(featureFlags.key, SERVER_SSO_FEATURE_FLAG_KEY));
  assert.deepEqual(await completeSsoSignIn({ connectionId: connection.id, profile: profile({ email: "jo@acme.test" }) }), { kind: "refused", reason: "connection_inactive" });
  await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, SERVER_SSO_FEATURE_FLAG_KEY));
});

dbTest("an email whose domain is not in its normalized form is refused (no look-alike accounts)", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const connection = await connectionFor(server.id);
  await seed.human({ email: "kim@acme.test" });
  assert.deepEqual(
    await completeSsoSignIn({ connectionId: connection.id, profile: profile({ email: "kim@ａｃｍｅ.test" }), legalAcceptance: LEGAL }),
    { kind: "refused", reason: "email_not_canonical" },
  );
  assert.equal((await getDb().select().from(users).where(eq(users.email, "kim@ａｃｍｅ.test"))).length, 0);
});
