import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import type { Database } from "../db";
import { channels, durableTasks, messages } from "../db/schema";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { publishExternalConnection, type ExternalConnection } from "../services/externalInviteConnectService";
import { createHttpClient } from "./integration/http";

/**
 * External channel system messages (#wg-rbac:#40) and the retired self-DM
 * notices (#wg-rbac:#42 option A), as the suites that connect, disconnect and
 * join check them.
 */

/** The system messages a member reads in their copy of a channel (the history API), oldest first. */
export async function channelSystemLines(baseUrl: string, who: { id: string }, server: { id: string }, channelId: string): Promise<string[]> {
  const response = await createHttpClient(baseUrl).as(who, server).get(`/api/messages/channel/${channelId}?limit=100`);
  assert.equal(response.status, 200, `${who.id} reads ${channelId}`);
  const body = await response.json() as { messages: Array<{ content: string; messageType: string }> };
  return body.messages.filter((message) => message.messageType === "system").map((message) => message.content);
}

/** Every stored system message of one producer, wherever it is. */
export async function storedSystemMessages(db: Database, producer: string): Promise<Array<{ content: string; channelId: string }>> {
  return db.select({ content: messages.content, channelId: messages.channelId }).from(messages).where(eq(messages.systemSubtype, producer));
}

/** No system message in any DM (the admins' self-DM notices are gone), and no notice task queued. */
export async function assertNoDmNotice(db: Database): Promise<void> {
  const inDms = await db.select({ id: messages.id, content: messages.content }).from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(and(eq(channels.type, "dm"), eq(messages.messageType, "system")));
  assert.deepEqual(inDms, [], "no system message in any DM");
  assert.deepEqual(await db.select({ id: durableTasks.id }).from(durableTasks).where(eq(durableTasks.kind, "server.admin_notice")), [], "no server.admin_notice task");
}

/** What server.ts gives the conversion worker: the publish (with its system message) of each connection it commits. */
export function workerPublish(app: { get(key: string): unknown }): (connection: ExternalConnection) => Promise<void> {
  return (connection) => publishExternalConnection({
    io: app.get("io") as SocketServer | undefined,
    orchestrator: app.get("agentOrchestrator") as AgentOrchestrator | undefined,
  }, connection);
}
