import { getServerCapabilities } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb } from "../db/index.js";
import { agentMigrations, serverMembers } from "../db/schema.js";
import {
  projectAgentMigrationUpdatedPayload,
  type AgentMigrationRow,
} from "./agentMigrationService.js";

export async function emitAgentMigrationUpdated(
  io: SocketServer | undefined,
  migration: AgentMigrationRow,
): Promise<void> {
  if (!io) return;
  const memberships = await getDb().select({
    userId: serverMembers.userId,
    role: serverMembers.role,
  })
    .from(serverMembers)
    .where(eq(serverMembers.serverId, migration.serverId));
  const payload = projectAgentMigrationUpdatedPayload(migration);
  for (const membership of memberships) {
    if (!getServerCapabilities(membership.role).migrateAgents) continue;
    io.to(`user:${membership.userId}`).emit("agent:migration-updated", payload);
  }
}

export async function emitAgentMigrationUpdatedByRef(
  io: SocketServer | undefined,
  serverId: string,
  migrationRef: string,
): Promise<void> {
  if (!io) return;
  const [migration] = await getDb().select()
    .from(agentMigrations)
    .where(eq(agentMigrations.supportRef, migrationRef))
    .limit(1);
  if (!migration || migration.serverId !== serverId) return;
  await emitAgentMigrationUpdated(io, migration);
}
