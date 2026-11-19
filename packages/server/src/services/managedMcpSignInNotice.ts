// Tell a person when an MCP App's OAuth Connection needs signing in again (#proj-apps:#70).
//
// An expired Connection refuses every Agent call with `login_required`, and a Connect card is
// posted only when the call carries the conversation it came from. Background calls raise none, so
// a Connection could sit expired for days with nobody told (production, 11-11 to 11-13). This
// sends one notice per expiry to the people who can sign it in again.
//
// One notice per expiry: the outbox `event_key` names the Connection and its `credential_version`
// (signing in again bumps it), and `(receiver_id, event_key)` is unique. A refused call reaches
// this on every retry, so before any lookup it checks a per-process memo of the expiries already
// handled: an Agent retrying in a loop costs no query after the first (Tenny ac632235).
//
// Plain English with no copy key, as `notifyNewComputerOwner`: a new key would reach mobile apps
// whose string tables do not have it. Acceptable for a rare notice; not a pattern for anything
// people read every day.

import { and, eq, inArray } from "drizzle-orm";
import type { ServerRole } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { managedMcpServers, serverMembers, servers } from "../db/schema";
import { serverRolesWithCapability } from "../lib/actorPermissions";
import { addTraceEvent } from "../tracing/semanticTrace";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { enqueueNotificationRows } from "./notifications/enqueue";
import type { NotificationNoticePayload } from "./notifications/envelope";

export type McpSignInNoticeTrigger = "oauth_write" | "admission";

/** What this needs of the Connection; every caller already has the row. */
export interface McpSignInNoticeConnection {
  id: string;
  authStatus: string;
  credentialVersion: number;
  isServerDefault: boolean;
  createdByUserId: string | null;
  /** Set once the Connection has been signed in; null for one that never was. */
  authorizedEndpointUrl: string | null;
}

/**
 * Whether the Connection is one a person has to sign in again: expired, or sent back to
 * `needs_auth` after it had been signed in (the App's address changed). A Connection that was never
 * signed in, or one whose sign-in is under way, is not.
 */
export function connectionNeedsSignInAgain(connection: Pick<McpSignInNoticeConnection, "authStatus" | "authorizedEndpointUrl">): boolean {
  return connection.authStatus === "expired"
    || (connection.authStatus === "needs_auth" && connection.authorizedEndpointUrl !== null);
}

export function mcpSignInNoticeEventKey(connectionId: string, credentialVersion: number): string {
  return `mcp_connection_signin:${connectionId}:${credentialVersion}`;
}

const MEMO_LIMIT = 5_000;
const handled = new Set<string>();

function remember(key: string): void {
  if (handled.size >= MEMO_LIMIT) {
    // Oldest first (a Set keeps insertion order). Forgetting one costs one more insert-or-ignore.
    const oldest = handled.values().next().value;
    if (oldest !== undefined) handled.delete(oldest);
  }
  handled.add(key);
}

export function __resetMcpSignInNoticeMemoForTests(): void {
  handled.clear();
}

/** Signing a Connection in again takes both (`POST /apps/:appId/connections/oauth/start`). */
function rolesThatCanSignIn(): ServerRole[] {
  const external = new Set(serverRolesWithCapability("manageExternalAuth"));
  return serverRolesWithCapability("manageIntegrations").filter((role) => external.has(role));
}

/** One line, at most `max` characters: names come from whoever set the App up. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Who is told: whoever signed the Connection in, while they can still sign it in again; for the
 * App's default Connection, also everyone else who can. When nobody qualifies, the Server's owners,
 * who can always give themselves what it takes or remove the Connection.
 */
async function recipients(serverId: string, connection: McpSignInNoticeConnection): Promise<string[]> {
  const members = await getDb()
    .select({ userId: serverMembers.userId, role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), inArray(serverMembers.role, rolesThatCanSignIn())));
  const chosen = new Set<string>();
  if (connection.createdByUserId && members.some((member) => member.userId === connection.createdByUserId)) {
    chosen.add(connection.createdByUserId);
  }
  if (connection.isServerDefault) for (const member of members) chosen.add(member.userId);
  if (chosen.size === 0) for (const member of members) if (member.role === "owner") chosen.add(member.userId);
  return [...chosen];
}

/**
 * Sends the notice for this expiry if it has not gone yet. After commit and best effort: it never
 * throws, so a refused call still answers its refusal.
 */
export async function notifyMcpConnectionNeedsSignIn(input: {
  trigger: McpSignInNoticeTrigger;
  serverId: string;
  mcpServerId: string;
  connection: McpSignInNoticeConnection;
}): Promise<void> {
  const trace = (outcome: "sent" | "duplicate" | "no_recipient" | "failed", recipientCount: number) =>
    addTraceEvent("server.managed_mcp.signin_notice", { outcome, trigger: input.trigger, recipient_count: recipientCount });
  if (!connectionNeedsSignInAgain(input.connection)) return;
  const eventKey = mcpSignInNoticeEventKey(input.connection.id, input.connection.credentialVersion);
  if (handled.has(eventKey)) {
    trace("duplicate", 0);
    return;
  }
  remember(eventKey);
  try {
    const receiverIds = await recipients(input.serverId, input.connection);
    if (receiverIds.length === 0) {
      trace("no_recipient", 0);
      return;
    }
    const [app] = await getDb()
      .select({ name: managedMcpServers.name, serverName: servers.name })
      .from(managedMcpServers)
      .innerJoin(servers, eq(servers.id, managedMcpServers.serverId))
      .where(and(eq(managedMcpServers.id, input.mcpServerId), eq(managedMcpServers.serverId, input.serverId)))
      .limit(1);
    if (!app) {
      trace("no_recipient", 0);
      return;
    }
    const appName = oneLine(app.name, 80);
    const serverName = oneLine(app.serverName, 80);
    const payload: NotificationNoticePayload = {
      title: `Sign in to ${appName} again`,
      body: `Agents on ${serverName} can't use ${appName} until someone signs in again: its sign-in was rejected. Settings › Apps › ${appName}.`,
      kind: "mention",
      event: "system_notice",
      route: { type: "channel", serverId: input.serverId, channelId: "", messageId: null },
      opensActivity: true,
    };
    const now = new Date();
    const inserted = await enqueueNotificationRows(receiverIds.map((receiverId) => ({
      receiverId,
      serverId: input.serverId,
      kind: null,
      sourceChannelId: null,
      messageId: null,
      messageSeq: null,
      activityAt: now,
      personalMention: true,
      eventKey,
      category: "system_notice" as const,
      payload: payload as unknown as Record<string, unknown>,
    })));
    trace(inserted.length > 0 ? "sent" : "duplicate", inserted.length);
  } catch (error) {
    // Forget it, so the next refused call tries again.
    handled.delete(eventKey);
    trace("failed", 0);
    console.error("[managed-mcp] sign-in notice failed:", serializeErrorForLog(error));
  }
}
