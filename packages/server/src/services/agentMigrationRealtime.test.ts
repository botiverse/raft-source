import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index.js";
import { serverMembers, users } from "../db/schema.js";
import { createAgent } from "./agentService.js";
import { beginAgentMigration } from "./agentMigrationService.js";
import { emitAgentMigrationUpdated } from "./agentMigrationRealtime.js";
import { registerMachine } from "./machineService.js";
import { createServer } from "./serverService.js";


afterEach(async () => {
  await closeTestDatabase();
});

test("migration realtime targets only current manageServer rooms and exposes only the support identity", async ({ db: database }) => {

  const db = getDb();
  const [owner, admin, member] = await db.insert(users).values([
    { email: "migration-realtime-owner@example.com", name: "migration-realtime-owner", passwordHash: "hash", emailVerified: true },
    { email: "migration-realtime-admin@example.com", name: "migration-realtime-admin", passwordHash: "hash", emailVerified: true },
    { email: "migration-realtime-member@example.com", name: "migration-realtime-member", passwordHash: "hash", emailVerified: true },
  ]).returning();
  const server = await createServer("Migration Realtime", "migration-realtime", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const { machine: sourceMachine } = await registerMachine(server.id, owner.id, "migration-source");
  const { machine: targetMachine } = await registerMachine(server.id, owner.id, "migration-target");
  const agent = await createAgent(server.id, "migration-agent", { runtime: "codex", machineId: sourceMachine.id });
  const migration = await beginAgentMigration({ agentId: agent.id, targetMachineId: targetMachine.id });

  const emitted: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: Record<string, unknown>) {
          emitted.push({ room, event, payload });
        },
      };
    },
  } as unknown as SocketServer;

  await emitAgentMigrationUpdated(io, migration);
  assert.deepEqual(emitted.map((entry) => entry.room).sort(), [`user:${admin.id}`, `user:${owner.id}`].sort());
  assert.ok(emitted.every((entry) => entry.event === "agent:migration-updated"));
  assert.ok(emitted.every((entry) => entry.payload.migrationRef === migration.supportRef));
  assert.ok(emitted.every((entry) => !("migrationId" in entry.payload)));
  assert.ok(emitted.every((entry) => !("grantKey" in entry.payload)));

  emitted.length = 0;
  await db.update(serverMembers)
    .set({ role: "member" })
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  await db.delete(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));

  await emitAgentMigrationUpdated(io, migration);
  assert.deepEqual(emitted, []);
});
