import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ServerRole } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { oauthClientInstalls, oauthClients, users } from "../db/schema";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { seedJointChannel } from "../test/integration/jointFixture";
import { seedBoundGuest } from "../test/guestFixture";
import { addHuman } from "../services/channelService";
import { addMember, createServer } from "../services/serverService";
import {
  createOAuthClient,
  createOAuthClientShareLink,
  installMarketplaceOAuthClient,
  installOAuthClientShareInvite,
} from "../services/oauthService";

// The rows, seed and browser/app steps of the human Login with Raft matrix,
// shared by oauthLoginAllowedMatrix.api.test.ts (what each row is allowed or
// refused) and oauthServerModeFrozen.api.test.ts (the exact bytes each row is
// answered with today, RFC 079 phase 3a PR 0). One seed, so the freeze cannot
// drift from the matrix it freezes.

export const RETURN_URL = "https://allowed.example.test/login/raft/callback";
export const DEFAULT_SCOPES = ["openid", "profile"];

/** Who logs in, relative to S, the Server they pick. */
export type Role = ServerRole | "non-member" | "joint-channel participant";
type AppType = "server_local" | "third_party_global" | "unknown client";
/** Where the app stands on S. */
type Installed =
  | "registered on S"
  | "registered on S, disabled"
  | "registered on another Server"
  | "active"
  | "active, bot pending"
  | "active, approved fewer scopes than asked"
  | "by share link"
  | "source of a private share"
  | "on the Marketplace, not installed"
  | "private, not installed"
  | "suspended"
  | "none";
/**
 * setup: the setup page's lookup on S, its continue, then the code exchange.
 * oidc: GET /api/oauth/authorize first; the setup page continues in its OIDC
 * flow (PKCE) with what the redirect carried. The /oidc/<server> paths start
 * at the Server-scoped issuer, whose segment the setup page sends back as the
 * `server` hint, and exchange at the same mount.
 * marketplace: the setup page's "Install and continue", then the continue.
 */
type Path = "setup" | "oidc" | "oidc /oidc/<slug>" | "oidc /oidc/<id>" | "marketplace";

export type Row = {
  name: string;
  appType: AppType;
  installed: Installed;
  path: Path;
} & (
  | {
    /** The lookup offers the login, the continue issues a code for S, and the code exchanges for a token naming the person, S and their role. */
    expect: "login";
    role: ServerRole;
    scopes?: { ask: string[]; granted: string[] };
  }
  | {
    /** The lookup and the continue give the one 403, byte for byte, and no code is issued. */
    expect: "app_not_available";
    role: Role;
    /** How S's id is written in the lookup and the continue; canonical when absent. */
    serverIdWritten?: "with braces" | "without hyphens";
  }
  | {
    /** The lookup says suspended; the continue gives its own 403, and no code is issued. */
    expect: "installation_suspended";
    role: Role;
  }
);

export const LOGINS: Row[] = [
  // Every role on both kinds of availability. Guests may log in in server mode (D19).
  { name: "owner, server-local app", role: "owner", appType: "server_local", installed: "registered on S", path: "setup", expect: "login" },
  { name: "admin, server-local app", role: "admin", appType: "server_local", installed: "registered on S", path: "setup", expect: "login" },
  { name: "member, server-local app", role: "member", appType: "server_local", installed: "registered on S", path: "setup", expect: "login" },
  { name: "guest, server-local app", role: "guest", appType: "server_local", installed: "registered on S", path: "setup", expect: "login" },
  { name: "owner, installed third-party app", role: "owner", appType: "third_party_global", installed: "active", path: "setup", expect: "login" },
  { name: "admin, installed third-party app", role: "admin", appType: "third_party_global", installed: "active", path: "setup", expect: "login" },
  { name: "member, installed third-party app", role: "member", appType: "third_party_global", installed: "active", path: "setup", expect: "login" },
  { name: "guest, installed third-party app", role: "guest", appType: "third_party_global", installed: "active", path: "setup", expect: "login" },
  // Install states the availability gate does not read.
  { name: "member, disabled server-local app (enabled gates third-party apps only)", role: "member", appType: "server_local", installed: "registered on S, disabled", path: "setup", expect: "login" },
  { name: "member, installed app whose bot is still pending", role: "member", appType: "third_party_global", installed: "active, bot pending", path: "setup", expect: "login" },
  { name: "member, installed app asking more scopes than S approved: granted the approved ones (#11251)", role: "member", appType: "third_party_global", installed: "active, approved fewer scopes than asked", path: "setup", expect: "login", scopes: { ask: ["openid", "profile", "email"], granted: ["openid", "profile"] } },
  { name: "member, private app installed on S by share link", role: "member", appType: "third_party_global", installed: "by share link", path: "setup", expect: "login" },
  { name: "member, S's own app after a share link made it private third-party", role: "member", appType: "third_party_global", installed: "source of a private share", path: "setup", expect: "login" },
  // OIDC, unscoped and Server-scoped.
  { name: "member, server-local app, OIDC", role: "member", appType: "server_local", installed: "registered on S", path: "oidc", expect: "login" },
  { name: "guest, installed third-party app, OIDC", role: "guest", appType: "third_party_global", installed: "active", path: "oidc", expect: "login" },
  { name: "member, server-local app, Server-scoped issuer by slug", role: "member", appType: "server_local", installed: "registered on S", path: "oidc /oidc/<slug>", expect: "login" },
  { name: "member, installed third-party app, Server-scoped issuer by slug", role: "member", appType: "third_party_global", installed: "active", path: "oidc /oidc/<slug>", expect: "login" },
  { name: "admin, installed third-party app, Server-scoped issuer by id", role: "admin", appType: "third_party_global", installed: "active", path: "oidc /oidc/<id>", expect: "login" },
  // The Marketplace offer: an owner or admin installs inline, then continues (D5).
  { name: "owner, Marketplace app installed from the setup page", role: "owner", appType: "third_party_global", installed: "on the Marketplace, not installed", path: "marketplace", expect: "login" },
  { name: "admin, Marketplace app installed from the setup page", role: "admin", appType: "third_party_global", installed: "on the Marketplace, not installed", path: "marketplace", expect: "login" },
];

export const REFUSALS: Row[] = [
  { name: "non-member, server-local app of S", role: "non-member", appType: "server_local", installed: "registered on S", path: "setup", expect: "app_not_available" },
  { name: "non-member, app installed on S", role: "non-member", appType: "third_party_global", installed: "active", path: "oidc", expect: "app_not_available" },
  { name: "joint-channel participant: sharing a channel with S is not membership of S", role: "joint-channel participant", appType: "server_local", installed: "registered on S", path: "setup", expect: "app_not_available" },
  { name: "joint-channel participant, app installed on S, Server-scoped issuer", role: "joint-channel participant", appType: "third_party_global", installed: "active", path: "oidc /oidc/<slug>", expect: "app_not_available" },
  { name: "member, private third-party app not installed on S", role: "member", appType: "third_party_global", installed: "private, not installed", path: "setup", expect: "app_not_available" },
  { name: "member, server-local app of another Server", role: "member", appType: "server_local", installed: "registered on another Server", path: "setup", expect: "app_not_available" },
  { name: "member, unknown client", role: "member", appType: "unknown client", installed: "none", path: "setup", expect: "app_not_available" },
  { name: "member, suspended installation keeps its own answer", role: "member", appType: "third_party_global", installed: "suspended", path: "setup", expect: "installation_suspended" },
  { name: "non-member, suspended installation: membership is decided first (L1)", role: "non-member", appType: "third_party_global", installed: "suspended", path: "setup", expect: "app_not_available" },
  // S's id in a form Postgres would parse but that isn't canonical: refused, not resolved (Tenny, 4b13dada).
  { name: "member, server-local app of S, S's id in braces", role: "member", appType: "server_local", installed: "registered on S", path: "setup", expect: "app_not_available", serverIdWritten: "with braces" },
  { name: "member, server-local app of S, S's id without hyphens", role: "member", appType: "server_local", installed: "registered on S", path: "setup", expect: "app_not_available", serverIdWritten: "without hyphens" },
  { name: "member, app installed on S, S's id in braces", role: "member", appType: "third_party_global", installed: "active", path: "oidc", expect: "app_not_available", serverIdWritten: "with braces" },
  { name: "member, app installed on S, S's id without hyphens", role: "member", appType: "third_party_global", installed: "active", path: "oidc", expect: "app_not_available", serverIdWritten: "without hyphens" },
];

type Base = { baseUrl: string };
type Person = typeof users.$inferSelect & { bearer: string };
export type RegisteredApp = { id: string; clientId: string; clientSecret: string };

async function seedUser(label: string): Promise<Person> {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return { ...user, bearer: await tokenForHuman(user.email) };
}

type World = {
  suffix: string;
  owner: Person;
  /** S: the Server the person picks. */
  server: Awaited<ReturnType<typeof createServer>>;
  /** P: another Server, where third-party apps are registered. */
  publisher: Awaited<ReturnType<typeof createServer>>;
};

/** The person who logs in, in the row's relation to S. */
async function seedPerson(role: Role, { suffix, owner, server, publisher }: World): Promise<Person> {
  if (role === "owner") return owner;
  const user = await seedUser(`allowed-${role.replace(/\W+/g, "-")}`);
  if (role === "non-member") {
    // In a Server, just not in S.
    await addMember(publisher.id, user.id, "member");
  } else if (role === "joint-channel participant") {
    const partner = await createServer("Allowed Partner", `allowed-partner-${suffix}`, owner.id);
    await addMember(partner.id, user.id, "member");
    const joint = await seedJointChannel({ name: `allowed-joint-${suffix}`, serverIds: [server.id, partner.id], createdByUserId: owner.id });
    assert.ok(await addHuman(joint.projections[1]!.id, user.id), "fixture: in a channel S hosts");
  } else if (role === "guest") {
    // Every Guest has its one channel (server_members_guest_has_channel).
    await seedBoundGuest({ serverId: server.id, userId: user.id });
  } else {
    await addMember(server.id, user.id, role);
  }
  return user;
}

/** The app, in the row's state on S; null for an unknown client. */
async function seedApp(installed: Installed, { suffix, owner, server, publisher }: World): Promise<RegisteredApp | null> {
  const register = async (serverId: string, appType: "server_local" | "third_party_global", options: { enableBot?: boolean } = {}): Promise<RegisteredApp> => {
    const { client, clientSecret } = await createOAuthClient({
      serverId,
      createdByUserId: owner.id,
      appType,
      clientId: `allowed-${suffix}`,
      name: "Allowed App",
      returnUrl: RETURN_URL,
      allowedScopes: DEFAULT_SCOPES,
      ...options,
    });
    return { id: client.id, clientId: client.clientId, clientSecret };
  };
  const marketplaceApp = async (options: { enableBot?: boolean } = {}) => {
    const client = await register(publisher.id, "third_party_global", options);
    await getDb().update(oauthClients)
      .set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true })
      .where(eq(oauthClients.id, client.id));
    return client;
  };
  const installOnS = async (client: RegisteredApp) => {
    const result = await installMarketplaceOAuthClient({
      serverId: server.id,
      clientId: client.id,
      installedByUserId: owner.id,
      expected: await currentAppPermissions(client.id),
    });
    assert.ok(result, "fixture: installed on S");
    return result;
  };

  switch (installed) {
    case "registered on S":
      return register(server.id, "server_local");
    case "registered on S, disabled": {
      const client = await register(server.id, "server_local");
      await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, client.id));
      return client;
    }
    case "registered on another Server":
      return register(publisher.id, "server_local");
    case "active": {
      const client = await marketplaceApp();
      await installOnS(client);
      return client;
    }
    case "active, bot pending": {
      const client = await marketplaceApp({ enableBot: true });
      const result = await installOnS(client) as { bot?: { grant?: string } };
      assert.equal(result.bot?.grant, "pending", "fixture: the bot is offered, not yet added");
      return client;
    }
    case "active, approved fewer scopes than asked": {
      const client = await marketplaceApp();
      await installOnS(client);
      // The developer widens the app after S installed it; S's admin hasn't approved the update.
      await getDb().update(oauthClients).set({ allowedScopes: ["openid", "profile", "email"] }).where(eq(oauthClients.id, client.id));
      return client;
    }
    case "by share link": {
      const client = await register(publisher.id, "server_local");
      const share = await createOAuthClientShareLink({ serverId: publisher.id, clientId: client.id, targetServerSlug: server.slug, createdByUserId: owner.id });
      assert.ok(share, "fixture: share link created");
      const redeemed = await installOAuthClientShareInvite({ token: share.token, userId: owner.id, serverId: server.id, expected: await currentAppPermissions(client.id) });
      assert.equal(redeemed?.status, "ok", "fixture: installed on S by the link");
      return client;
    }
    case "source of a private share": {
      const client = await register(server.id, "server_local");
      assert.ok(await createOAuthClientShareLink({ serverId: server.id, clientId: client.id, targetServerSlug: publisher.slug, createdByUserId: owner.id }), "fixture: share link created");
      return client;
    }
    case "on the Marketplace, not installed":
      return marketplaceApp();
    case "private, not installed":
      return register(publisher.id, "third_party_global");
    case "suspended": {
      const client = await marketplaceApp();
      await installOnS(client);
      await getDb().update(oauthClientInstalls).set({ status: "suspended" })
        .where(and(eq(oauthClientInstalls.clientId, client.id), eq(oauthClientInstalls.serverId, server.id)));
      return client;
    }
    case "none":
      return null;
  }
}

export async function seed(row: Row) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("allowed-owner");
  const world: World = {
    suffix,
    owner,
    server: await createServer("Allowed", `allowed-${suffix}`, owner.id),
    publisher: await createServer("Allowed Publisher", `allowed-pub-${suffix}`, owner.id),
  };
  const person = await seedPerson(row.role, world);
  const client = await seedApp(row.installed, world);

  // The row's appType column is checked against the stored app, so it can't drift from the fixture.
  const [stored] = client
    ? await getDb().select({ appType: oauthClients.appType }).from(oauthClients).where(eq(oauthClients.id, client.id))
    : [];
  assert.equal(stored?.appType ?? "unknown client", row.appType, "fixture: appType column");

  return {
    server: world.server,
    person,
    client,
    clientKey: client?.clientId ?? `allowed-unknown-${suffix}`,
    // What the server-mode freeze also needs: P, S's owner, and the random part of every name.
    publisher: world.publisher,
    owner: world.owner,
    suffix,
  };
}

export type Seeded = Awaited<ReturnType<typeof seed>>;

export function lookup(app: Base, bearer: string, clientKey: string, serverId: string, scopes: string[]) {
  return fetch(`${app.baseUrl}/api/oauth/clients/lookup?${new URLSearchParams({ client_id: clientKey, server_id: serverId, scope: scopes.join(" ") })}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

export function continueLogin(app: Base, bearer: string, body: Record<string, unknown>) {
  return fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

export function writeServerId(serverId: string, written: "with braces" | "without hyphens" | undefined) {
  if (written === "with braces") return `{${serverId}}`;
  if (written === "without hyphens") return serverId.replaceAll("-", "");
  return serverId;
}

/**
 * Where the browser starts. For the OIDC paths it is the authorize endpoint,
 * whose redirect hands the setup page what it sends on; the other paths start
 * on the setup page with the app's registered callback. `authorize` is the
 * authorize endpoint's redirect, its body unread (null on the other paths).
 */
export async function start(app: Base, row: Row, f: Seeded, scopes: string[], serverId: string) {
  if (!row.path.startsWith("oidc")) {
    return { mount: "", body: { clientId: f.clientKey, serverId, returnUrl: RETURN_URL, scopes }, verifier: null, authorize: null };
  }
  const segment = row.path === "oidc /oidc/<slug>" ? f.server.slug : row.path === "oidc /oidc/<id>" ? f.server.id : null;
  const mount = segment ? `/oidc/${segment}` : "";
  const verifier = randomBytes(32).toString("base64url");
  const authorize = await fetch(`${app.baseUrl}${mount}/api/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: f.clientKey,
    redirect_uri: RETURN_URL,
    scope: scopes.join(" "),
    state: `state-${randomUUID()}`,
    nonce: `nonce-${randomUUID()}`,
    code_challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
    code_challenge_method: "S256",
  })}`, { redirect: "manual" });
  assert.equal(authorize.status, 302, `authorize: ${await authorize.clone().text()}`);
  const setup = new URL(authorize.headers.get("location")!);
  assert.equal(setup.pathname, "/login-with-raft/setup");
  const hint = setup.searchParams.get("server");
  assert.equal(hint, segment, "the scoped issuer's segment reaches the setup page");
  return {
    mount,
    verifier,
    authorize,
    // What HumanLoginSetupPage posts in its OIDC flow.
    body: {
      clientId: setup.searchParams.get("client_id"),
      serverId,
      returnUrl: setup.searchParams.get("return_to"),
      scopes: setup.searchParams.get("scope")!.split(" "),
      oidc: true,
      nonce: setup.searchParams.get("nonce"),
      codeChallenge: setup.searchParams.get("code_challenge"),
      codeChallengeMethod: setup.searchParams.get("code_challenge_method"),
      ...(hint ? { server: hint } : {}),
    },
  };
}

export function exchange(app: Base, client: RegisteredApp, code: string, mount: string, verifier: string | null) {
  if (verifier === null) {
    return fetch(`${app.baseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, grantType: "authorization_code", code }),
    });
  }
  return fetch(`${app.baseUrl}${mount}/api/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: RETURN_URL, code_verifier: verifier }),
  });
}
