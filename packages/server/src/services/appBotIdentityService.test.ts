import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
import { dbTest } from "../test/integration/dbTest";

import {
  agents,
  appBotBindings,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema";
import { getDb } from "../db/index";
import { randomUUID } from "node:crypto";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createServer } from "./serverService";
import {
  createManagedAppBot,
  disableManagedAppBot,
  uninstallManagedAppBot,
  getManagedAppBot,
  isAppBotAgent,
  deriveAppBotHandle,
  AppBotHandleConflictError,
  AppBotInstallNotGrantedError,
} from "./appBotIdentityService";
import { createOAuthClient, uninstallMarketplaceOAuthClient } from "./oauthService";

const NOW = new Date("2026-10-14T08:00:00Z");

describe("appBotIdentityService", () => {
  dbTest("creates a managed bot agent and binding; seat-excluded", async ({ db, seed }) => {
    const owner = await seed.human({ name: `bot-owner-${randomUUID().slice(0, 6)}` });
    const server = await seed.server({ owner });
    const client = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `bot-${randomUUID().slice(0, 8)}`,
      name: "Bot App",
      enableBot: true,
    });
    const install = await installOnServer(client.client.id, server.id, owner.id);

    const bot = await db.transaction((tx) =>
      createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW }),
    );

    assert.equal(bot.installId, install.id);
    assert.equal(bot.serverId, server.id);
    assert.equal(bot.state, "active");
    assert.equal(bot.generation, 1);
    assert.equal(bot.handle, deriveAppBotHandle(client.client.clientId));

    const [agent] = await db.select().from(agents).where(eq(agents.id, bot.agentId));
    assert.ok(agent);
    assert.equal(agent.managedByAppInstallId, install.id);
    assert.equal(await isAppBotAgent(db, bot.agentId), true);
  });

  dbTest("is idempotent: repeat activation returns the same binding", async ({ db, seed }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const client = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `bot-${randomUUID().slice(0, 8)}`,
      name: "Bot App",
      enableBot: true,
    });
    const install = await installOnServer(client.client.id, server.id, owner.id);

    const first = await db.transaction((tx) =>
      createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW }),
    );
    const second = await db.transaction((tx) =>
      createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW }),
    );

    assert.equal(first.bindingId, second.bindingId);
    assert.equal(first.agentId, second.agentId);
  });

  dbTest("rejects activation when install did not grant the bot", async ({ db, seed }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const client = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `bot-${randomUUID().slice(0, 8)}`,
      name: "Bot App",
      enableBot: true,
    });
    const install = await installOnServer(client.client.id, server.id, owner.id, { botGrant: "pending" });

    await assert.rejects(
      db.transaction((tx) => createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW })),
      AppBotInstallNotGrantedError,
    );
  });

  dbTest("rejects activation when the app does not declare enableBot", async ({ db, seed }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const client = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `bot-${randomUUID().slice(0, 8)}`,
      name: "Bot App",
    });
    const install = await installOnServer(client.client.id, server.id, owner.id);

    await assert.rejects(
      db.transaction((tx) => createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW })),
      AppBotInstallNotGrantedError,
    );
  });

  dbTest("rejects when a non-managed agent already owns the handle", async ({ db, seed }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const client = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `bot-${randomUUID().slice(0, 8)}`,
      name: "Bot App",
      enableBot: true,
    });
    const install = await installOnServer(client.client.id, server.id, owner.id);

    const handle = deriveAppBotHandle(client.client.clientId);
    await db.insert(agents).values({
      serverId: server.id,
      name: handle,
      displayName: "Squatter",
      status: "active",
      creatorType: "user",
      creatorId: owner.id,
    });

    await assert.rejects(
      db.transaction((tx) => createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW })),
      AppBotHandleConflictError,
    );
  });

  dbTest("an assistant-shaped handle is refused alike whether or not someone has that assistant", async ({ db, seed }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const suffix = randomUUID().slice(0, 8);
    const taken = `taken-${suffix}-assistant`;
    // Another member's personal assistant holds one handle; the other is unused.
    await db.insert(agents).values({
      serverId: server.id,
      name: taken,
      displayName: "Ottie",
      status: "active",
      creatorType: "user",
      creatorId: owner.id,
      assistantOwnerUserId: owner.id,
    });
    const refusal = async (clientId: string) => {
      const client = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId, name: "Bot App", enableBot: true });
      const install = await installOnServer(client.client.id, server.id, owner.id);
      const err = await db.transaction((tx) => createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW })).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof AppBotHandleConflictError, String(err));
      return err.message.replace(deriveAppBotHandle(clientId), "<handle>");
    };
    assert.equal(await refusal(taken), await refusal(`free-${suffix}-assistant`));
  });

  dbTest("disable → uninstalled lifecycle; reinstall gets new generation", async ({ db, seed }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const client = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `bot-${randomUUID().slice(0, 8)}`,
      name: "Bot App",
      enableBot: true,
    });
    const install = await installOnServer(client.client.id, server.id, owner.id);

    const first = await db.transaction((tx) =>
      createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW }),
    );
    assert.equal(first.state, "active");

    await db.transaction((tx) => disableManagedAppBot(tx, { installId: install.id }));
    let bot = await getManagedAppBot(db, install.id);
    assert.equal(bot?.state, "disabled");

    await db.transaction((tx) => uninstallManagedAppBot(tx, { installId: install.id }));
    bot = await getManagedAppBot(db, install.id);
    assert.equal(bot, null, "uninstalled binding is gone");

    const second = await db.transaction((tx) =>
      createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW }),
    );
    assert.equal(second.state, "active");
    assert.equal(second.generation, 2);
    assert.notEqual(second.agentId, first.agentId);
  });

  dbTest("real marketplace uninstall tombstones bot binding + agent", async ({ db, seed }) => {
    const owner = await seed.human();
    const publisherServer = await seed.server({ owner });
    const installServer = await seed.server({ owner });
    const client = await createOAuthClient({
      serverId: publisherServer.id,
      createdByUserId: owner.id,
      clientId: `bot-${randomUUID().slice(0, 8)}`,
      name: "Bot App",
      appType: "third_party_global",
      enableBot: true,
    });
    await db.update(oauthClients).set({ publishStatus: "published" }).where(eq(oauthClients.id, client.client.id));
    const install = await installOnServer(client.client.id, installServer.id, owner.id);

    const bot = await db.transaction((tx) =>
      createManagedAppBot(tx, { installId: install.id, serverId: installServer.id, now: NOW }),
    );
    assert.equal(bot.state, "active");

    const result = await uninstallMarketplaceOAuthClient({
      serverId: installServer.id,
      clientId: client.client.id,
      revokedByUserId: owner.id,
    });
    assert.ok(result);

    const binding = await db.select().from(appBotBindings).where(eq(appBotBindings.id, bot.bindingId));
    assert.equal(binding.length, 0, "binding row is gone (cascade)");

    const agent = await db.select().from(agents).where(eq(agents.id, bot.agentId));
    assert.ok(agent[0]?.deletedAt, "bot agent is soft-deleted");

    const { getServerBillingUsage } = await import("./planService");
    const usage = await getServerBillingUsage(db, installServer.id);
    assert.equal(usage.agents, 0, "deleted bot not billed");
  });

  dbTest("managed bots are excluded from billing usage (Arne item 1)", async ({ db, seed }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const client = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `bot-${randomUUID().slice(0, 8)}`,
      name: "Bot App",
      enableBot: true,
    });
    const install = await installOnServer(client.client.id, server.id, owner.id);

    const [ordinary] = await db.insert(agents).values({
      serverId: server.id,
      name: `ordinary-${randomUUID().slice(0, 6)}`,
      displayName: "Ordinary",
      status: "active",
      creatorType: "user",
      creatorId: owner.id,
    }).returning();

    const { getServerBillingUsage } = await import("./planService");
    const before = await getServerBillingUsage(db, server.id);
    assert.equal(before.agents, 1, "ordinary agent counts");

    await db.transaction((tx) =>
      createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW }),
    );
    const after = await getServerBillingUsage(db, server.id);
    assert.equal(after.agents, 1, "managed bot is not billed");
    assert.equal(after.universalSeats, before.universalSeats);
  });

  dbTest("service: grant→create, revoke→disable", async ({ db, seed }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const client = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `bot-${randomUUID().slice(0, 8)}`,
      name: "Bot App",
      enableBot: true,
    });
    const install = await installOnServer(client.client.id, server.id, owner.id);

    const bot = await db.transaction((tx) =>
      createManagedAppBot(tx, { installId: install.id, serverId: server.id, now: NOW }),
    );
    assert.equal(bot.state, "active");

    await db.transaction((tx) => disableManagedAppBot(tx, { installId: install.id }));
    const [binding] = await db.select().from(appBotBindings).where(eq(appBotBindings.installId, install.id));
    assert.equal(binding?.state, "disabled");
    assert.ok(binding?.disabledAt);
  });
});

async function installOnServer(
  clientId: string,
  serverId: string,
  installedByUserId: string,
  opts?: { botGrant?: "pending" | "granted" | "revoked" },
) {
  const [row] = await getDb()
    .insert(oauthClientInstalls)
    .values({
      serverId,
      clientId,
      installedByUserId,
      status: "active",
      botGrant: opts?.botGrant ?? "granted",
    })
    .returning();
  return row!;
}
