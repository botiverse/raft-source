// Shared seeding for the app-written agent reminder message tests
// (PGlite route tests and the real-PostgreSQL concurrency test).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { oauthClientInstalls, oauthClients, officialAppRegistry, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createOAuthClient } from "../services/oauthService";
import { createServer } from "../services/serverService";
import { fixturePasswordHash } from "./integration/credentials";

export async function seedReminderWorld() {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `reminder-owner-${suffix}@slock.test`,
    name: `reminder-owner-${suffix}`,
    displayName: "Reminder Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const publisher = await createServer("Official Publisher", `reminder-publisher-${suffix}`, owner.id);
  const server = await createServer("Reminder Server", `reminder-server-${suffix}`, owner.id);
  const foreign = await createServer("Foreign Server", `reminder-foreign-${suffix}`, owner.id);
  // The protected official trust root: only apps published from it are official.
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = publisher.id;
  const agent = await createAgent(server.id, `RemLocal${suffix}`, { runtime: "claude", model: "sonnet" });
  const externalAgent = await createAgent(server.id, `RemExt${suffix}`, { runtime: "external", model: "external" });
  const foreignAgent = await createAgent(foreign.id, `RemForeign${suffix}`, { runtime: "claude", model: "sonnet" });
  const agentKey = (await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "reminder-test", issuedVia: "computer", createdByUserId: null })).apiKey;
  const externalAgentKey = (await mintAgentCredential({ agentId: externalAgent.id, scopes: ["send", "read"], name: "reminder-test", issuedVia: "computer", createdByUserId: null })).apiKey;
  return { owner, publisher, server, foreign, agent, agentKey, externalAgent, externalAgentKey, foreignAgent };
}

export type ReminderWorld = Awaited<ReturnType<typeof seedReminderWorld>>;

/**
 * An app published from the trust root (official when listed in the registry),
 * installed on the world's server with `groups`, and an installation token.
 */
export async function seedReminderApp(baseUrl: string, world: ReminderWorld, opts: {
  official: boolean;
  groups: string[];
  installServerId?: string;
}) {
  const suffix = randomUUID().slice(0, 8);
  const { client, clientSecret } = await createOAuthClient({
    serverId: world.publisher.id,
    createdByUserId: world.owner.id,
    name: "Reminder App",
    clientId: `reminder-app-${suffix}`,
  });
  await getDb().update(oauthClients).set({ outboundCurrentGroups: opts.groups }).where(eq(oauthClients.id, client.id));
  if (opts.official) {
    await getDb().insert(officialAppRegistry).values({
      oauthClientId: client.id,
      clientKey: client.clientId,
      publisherServerId: world.publisher.id,
      purpose: "Agent reminders",
      status: "approved",
    });
  }
  const [installation] = await getDb().insert(oauthClientInstalls).values({
    serverId: opts.installServerId ?? world.server.id,
    clientId: client.id,
    installedBySystem: true,
    approvedGroups: opts.groups,
  }).returning();
  const minted = await fetch(`${baseUrl}/api/oauth/installation-token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ installation_id: installation.id }),
  });
  const body = await minted.json() as { access_token: string; error?: string };
  assert.equal(minted.status, 200, body.error);
  return { client, installation, token: body.access_token };
}

export async function postReminder(baseUrl: string, token: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api/app-installation/agent-reminder-messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

export async function agentApi(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}
