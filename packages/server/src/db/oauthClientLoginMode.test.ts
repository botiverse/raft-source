import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { test } from "vitest";
import { getDb } from "./index";
import { oauthClients } from "./schema";
import { dbTest } from "../test/integration/dbTest";
import { createOAuthClient } from "../services/oauthService";
import {
  createSlackBridgeProvisioningControlPlane,
  slackBridgeProvisioningManifestHash,
  SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
} from "../services/slackBridgeProvisioningControlPlane";
import type { SlackBridgeProvisioningProvider } from "../services/slackBridgeProvisioningControlPlane";

/**
 * RFC 079 phase 0: oauth_clients.login_mode exists and every app is `server`,
 * with no behaviour change. Existing apps get it at deploy, every creation path
 * gets it from the database default, and the database admits only `server` and
 * `account`.
 */

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const TAG_SUFFIX = "_oauth_clients_login_mode";

type JournalEntry = { idx: number; tag: string };

async function journalEntries(): Promise<JournalEntry[]> {
  const journal = JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

// One transaction per migration, as the deploy runner applies them.
async function apply(client: PGlite, entries: JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    const migration = await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    await client.exec(`BEGIN;\n${migration}\n;COMMIT;`);
  }
}

function checkViolation(constraint: string) {
  return (error: unknown) => {
    const messages = [error, (error as { cause?: unknown })?.cause]
      .map((candidate) => (candidate instanceof Error ? candidate.message : ""))
      .join("\n");
    assert.match(messages, new RegExp(`violates check constraint "${constraint}"`));
    return true;
  };
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const SERVER = "22222222-2222-4222-8222-222222222222";
const LOCAL_APP = "33333333-3333-4333-8333-333333333331";
const GLOBAL_APP = "33333333-3333-4333-8333-333333333332";
const BUILTIN_APP = "33333333-3333-4333-8333-333333333333";

test("the migration gives every existing app login_mode = 'server' and a validated CHECK", async () => {
  const entries = await journalEntries();
  const target = entries.find((entry) => entry.tag.endsWith(TAG_SUFFIX));
  assert.ok(target, `journal has a *${TAG_SUFFIX} migration`);
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < target.idx));
    // Apps as the previous release wrote them: one per distribution, including
    // the retired slock_builtin tombstone.
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('${OWNER}', 'login-mode-owner@example.test', 'login-mode-owner', 'fixture-value-not-a-credential');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('${SERVER}', 'Login mode', 'login-mode', '${OWNER}');
      INSERT INTO "oauth_clients" ("id", "server_id", "client_id", "client_secret_hash", "name", "created_by_user_id", "app_type", "publish_status")
      VALUES
        ('${LOCAL_APP}', '${SERVER}', 'local-app', 'hash-1', 'Local App', '${OWNER}', 'server_local', 'private'),
        ('${GLOBAL_APP}', '${SERVER}', 'global-app', 'hash-2', 'Global App', '${OWNER}', 'third_party_global', 'published'),
        ('${BUILTIN_APP}', '${SERVER}', 'builtin-app', 'hash-3', 'Builtin App', '${OWNER}', 'slock_builtin', 'published');
    `);
    await apply(client, [target]);

    const { rows } = await client.query<{ id: string; login_mode: string }>(
      `SELECT "id", "login_mode" FROM "oauth_clients" ORDER BY "id"`,
    );
    assert.deepEqual(rows, [
      { id: LOCAL_APP, login_mode: "server" },
      { id: GLOBAL_APP, login_mode: "server" },
      { id: BUILTIN_APP, login_mode: "server" },
    ]);
    const constraint = await client.query<{ convalidated: boolean }>(
      `SELECT "convalidated" FROM "pg_constraint" WHERE "conname" = 'oauth_clients_login_mode_valid'`,
    );
    assert.deepEqual(constraint.rows, [{ convalidated: true }], "a full constraint, not NOT VALID");
  } finally {
    await client.close();
  }
});

const SLACK_BRIDGE_REGISTRATION_ID = "44444444-4444-4444-8444-444444444444";
const OAUTH_REDIRECT_URI = "https://raft.example/api/slack-bridge/oauth/callback";
const EVENTS_REQUEST_URL = "https://bridge.example/api/slack-bridge/events";
const SLACK_BRIDGE_BOOTSTRAP = {
  registrationId: SLACK_BRIDGE_REGISTRATION_ID,
  environment: "test" as const,
  providerAppId: "A_LOGIN_MODE",
  providerOAuthClientId: "login-mode-client",
  oauthRedirectUri: OAUTH_REDIRECT_URI,
  eventsRequestUrl: EVENTS_REQUEST_URL,
  capabilityManifestVersion: 1,
  capabilityManifestHash: slackBridgeProvisioningManifestHash({
    oauthRedirectUri: OAUTH_REDIRECT_URI,
    eventsRequestUrl: EVENTS_REQUEST_URL,
  }),
  requiredCapabilities: SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
  signingSecret: {
    encryptedSecretRef: "env:SLACK_BRIDGE_SIGNING_SECRET",
    envelopeKeyId: "env:process",
    secretRevision: 1,
  },
  oauthClientSecret: {
    encryptedSecretRef: "env:SLACK_BRIDGE_OAUTH_CLIENT_SECRET",
    envelopeKeyId: "env:process",
    secretRevision: 1,
  },
};
const unverifiedSlackProvider: SlackBridgeProvisioningProvider = {
  async readInstallGrant() { return { kind: "unverified" }; },
  async readWorkspace() { return { oauth: "unverified", directory: { kind: "unverified" } }; },
  async readConversationAudience() { return { kind: "unverified" }; },
};

dbTest("every path that creates an app stores login_mode = 'server' and does not return it", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const suffix = randomUUID().slice(0, 8);

  // The human route and the agent register-app card both create through here.
  const local = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, name: "Local App", clientId: `local-${suffix}` });
  const global = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, name: "Global App", clientId: `global-${suffix}`, appType: "third_party_global" });
  // The first-party Slack Bridge inserts its own third_party_global client.
  const controlPlane = createSlackBridgeProvisioningControlPlane({ db: getDb(), bootstrap: SLACK_BRIDGE_BOOTSTRAP, provider: unverifiedSlackProvider });
  await controlPlane.connect({ serverId: server.id, requestingUserId: owner.id, now: new Date() });

  const rows = await getDb().select({ clientId: oauthClients.clientId, appType: oauthClients.appType, loginMode: oauthClients.loginMode })
    .from(oauthClients).where(eq(oauthClients.serverId, server.id));
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.clientId, [row.appType, row.loginMode]])), {
    [`local-${suffix}`]: ["server_local", "server"],
    [`global-${suffix}`]: ["third_party_global", "server"],
    [`slack-bridge:${SLACK_BRIDGE_REGISTRATION_ID}`]: ["third_party_global", "server"],
  });
  // Phase 0 exposes nothing: the app record the API returns has no login mode.
  assert.equal("loginMode" in local.client, false);
  assert.equal("loginMode" in global.client, false);
});

dbTest("the database refuses a login mode other than server or account", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const suffix = randomUUID().slice(0, 8);
  const insert = (clientId: string, loginMode: string) => getDb().execute(sql`
    INSERT INTO "oauth_clients" ("id", "server_id", "client_id", "client_secret_hash", "name", "created_by_user_id", "login_mode")
    VALUES (${randomUUID()}, ${server.id}, ${clientId}, 'fixture-hash', 'Mode App', ${owner.id}, ${loginMode})
  `);

  await assert.rejects(insert(`other-${suffix}`, "other"), checkViolation("oauth_clients_login_mode_valid"));
  await assert.rejects(insert(`upper-${suffix}`, "SERVER"), checkViolation("oauth_clients_login_mode_valid"));

  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, name: "Mode App", clientId: `mode-${suffix}` });
  await assert.rejects(
    getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'other' WHERE "id" = ${client.id}`),
    checkViolation("oauth_clients_login_mode_valid"),
  );
  // The reserved value is admitted; no code writes it yet.
  await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${client.id}`);
  const [row] = await getDb().select({ loginMode: oauthClients.loginMode }).from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(row?.loginMode, "account");
});
