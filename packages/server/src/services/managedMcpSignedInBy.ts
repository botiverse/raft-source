/**
 * MCP App Connections signed in with a person's own account
 * (`managed_mcp_credentials.signed_in_by_user_id`: who last completed the OAuth sign-in or saved the
 * API key). When that person leaves the server the Connection keeps acting as them; nothing is
 * revoked then. Instead:
 *
 * - The manager-only Connection view says so: `signedInBy.departed` is computed on read (no
 *   member row in the Connection's server, or the account retired), so rejoining clears it.
 * - Leaving (serverService.ts finishRemovedMember, after commit): one notice to the server's owners
 *   and admins listing the Connections, and for OAuth ones one email to the person (an API key
 *   need not be personal).
 * - Asking to delete the account (accountDeletion/requests.ts, after commit): the same notice on
 *   every server with such Connections, saying when the OAuth ones stop; their list goes into the
 *   "scheduled for deletion" email.
 * - The deletion itself (accountDeletion/cleanup.ts `revoke_managed_mcp_sign_ins`): every OAuth
 *   Connection the person signed in is disconnected (tokens deleted, `needs_auth`); the row, its
 *   default flag and its pins stay. API-key Connections are left alone.
 *
 * Notices are `system_notice` outbox rows, as managedMcpSignInNotice.ts sends; plain English with
 * no copy key, for the same reason. Each is best effort and never throws.
 */
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { managedMcpCredentials, managedMcpServers, serverMembers, servers, users } from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { formatAccountDeletionDate, sendMcpConnectionsAfterLeavingEmail } from "./emailService";
import { disconnectManagedMcpOAuthConnection } from "./managedMcpOAuthService";
import { oneLine, rolesThatCanSignIn } from "./managedMcpSignInNotice";
import { enqueueNotificationRows } from "./notifications/enqueue";
import type { NotificationNoticePayload } from "./notifications/envelope";

/** On the manager-only Connection view; null when nobody's sign-in is recorded. */
export type ManagedMcpSignedInBy = { userId: string; departed: boolean } | null;

/**
 * Whether each signer has left the server: no member row there, or a retired account. One read for
 * every Connection of a response. A signer with no users row reads as departed.
 */
export async function readSignedInByDeparted(db: DatabaseExecutor, serverId: string, userIds: ReadonlyArray<string | null>): Promise<Map<string, boolean>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: users.id,
      departed: sql<boolean>`(${users.retiredAt} is not null or not exists (
        select 1 from ${serverMembers} where ${serverMembers.serverId} = ${serverId} and ${serverMembers.userId} = ${users.id}
      ))`,
    })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((row) => [row.id, row.departed === true]));
}

export function signedInByView(userId: string | null, departed: ReadonlyMap<string, boolean>): ManagedMcpSignedInBy {
  return userId === null ? null : { userId, departed: departed.get(userId) ?? true };
}

export type SignedInConnection = {
  serverId: string;
  serverName: string;
  appId: string;
  appName: string;
  connectionId: string;
  connectionName: string | null;
  accountLabel: string | null;
  authKind: "oauth" | "headers";
};

/** The Connections whose secret acts as this person, on live servers (or one server), oldest first. */
export async function findConnectionsSignedInBy(db: DatabaseExecutor, userId: string, serverId?: string): Promise<SignedInConnection[]> {
  const rows = await db
    .select({
      serverId: managedMcpCredentials.serverId,
      serverName: servers.name,
      appId: managedMcpServers.id,
      appName: managedMcpServers.name,
      appAuthMode: managedMcpServers.authMode,
      connectionId: managedMcpCredentials.id,
      connectionName: managedMcpCredentials.name,
      accountLabel: managedMcpCredentials.accountLabel,
      authKind: managedMcpCredentials.authKind,
    })
    .from(managedMcpCredentials)
    .innerJoin(managedMcpServers, eq(managedMcpServers.id, managedMcpCredentials.mcpServerId))
    .innerJoin(servers, eq(servers.id, managedMcpCredentials.serverId))
    .where(and(
      eq(managedMcpCredentials.signedInByUserId, userId),
      serverId ? eq(managedMcpCredentials.serverId, serverId) : undefined,
      isNull(servers.deletedAt),
    ))
    .orderBy(asc(managedMcpCredentials.serverId), asc(managedMcpServers.name), asc(managedMcpCredentials.createdAt), asc(managedMcpCredentials.id));
  return rows.map(({ appAuthMode, authKind, ...row }) => ({
    ...row,
    // NULL auth_kind: a row older than 0409, read from its App.
    authKind: authKind ?? (appAuthMode === "oauth" ? "oauth" : "headers"),
  }));
}

/** "Notion › Work (Acme workspace)": the App, the Connection's name when it differs, the account. */
export function signedInConnectionLabel(connection: Pick<SignedInConnection, "appName" | "connectionName" | "accountLabel">): string {
  const app = oneLine(connection.appName, 60);
  const name = connection.connectionName ? oneLine(connection.connectionName, 60) : null;
  const label = connection.accountLabel ? oneLine(connection.accountLabel, 60) : null;
  return `${app}${name && name !== app ? ` › ${name}` : ""}${label ? ` (${label})` : ""}`;
}

const NOTICE_MAX_LISTED = 4;

function listed(items: string[]): string {
  const shown = items.slice(0, NOTICE_MAX_LISTED);
  const more = items.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

/** The person's name as notices show it. */
async function personOf(userId: string): Promise<{ name: string; email: string; retired: boolean } | null> {
  const [row] = await getDb()
    .select({ name: users.name, displayName: users.displayName, email: users.email, retiredAt: users.retiredAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ? { name: row.displayName || row.name, email: row.email, retired: row.retiredAt !== null } : null;
}

/**
 * The notice text for one server. `stopsOn`: an account deletion's date (OAuth Connections are
 * disconnected then); absent, the person has left.
 */
export function departedSignInNoticeText(input: {
  personName: string;
  serverName: string;
  connections: ReadonlyArray<Pick<SignedInConnection, "appName" | "connectionName" | "accountLabel" | "authKind">>;
  stopsOn?: Date;
}): { title: string; body: string } {
  const person = oneLine(input.personName, 60);
  const server = oneLine(input.serverName, 80);
  const items = input.connections.map((connection) => {
    const label = signedInConnectionLabel(connection);
    if (input.stopsOn) {
      return connection.authKind === "oauth"
        ? `${label}, signed in by ${person}: this stops on ${formatAccountDeletionDate(input.stopsOn)}`
        : `${label}, added by ${person}`;
    }
    return connection.authKind === "oauth" ? `${label}, signed in by ${person}, who has left` : `${label}, added by ${person}, who has left`;
  });
  return input.stopsOn
    ? {
      title: `${person} is deleting their account`,
      body: `Agents on ${server} use these Connections as ${person}: ${listed(items)}. Reconnect them with your own account: Settings › Apps.`,
    }
    : {
      title: `Connections still signed in as ${person}`,
      body: `${person} has left ${server}. Agents there still use these Connections as them: ${listed(items)}. Reconnect them with your own account: Settings › Apps.`,
    };
}

/** One notice per owner and admin of the server who can sign Connections in, never the person themselves. */
async function noticeServerManagers(input: {
  serverId: string;
  personUserId: string;
  eventKey: string;
  text: { title: string; body: string };
}): Promise<number> {
  const managers = await getDb()
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(
      eq(serverMembers.serverId, input.serverId),
      inArray(serverMembers.role, rolesThatCanSignIn()),
      ne(serverMembers.userId, input.personUserId),
    ));
  if (managers.length === 0) return 0;
  const payload: NotificationNoticePayload = {
    ...input.text,
    kind: "mention",
    event: "system_notice",
    route: { type: "channel", serverId: input.serverId, channelId: "", messageId: null },
    opensActivity: true,
  };
  const now = new Date();
  // (receiver_id, event_key) is unique: a repeat for the same departure or request inserts nothing.
  const inserted = await enqueueNotificationRows(managers.map((manager) => ({
    receiverId: manager.userId,
    serverId: input.serverId,
    kind: null,
    sourceChannelId: null,
    messageId: null,
    messageSeq: null,
    activityAt: now,
    personalMention: true,
    eventKey: input.eventKey,
    category: "system_notice" as const,
    payload: payload as unknown as Record<string, unknown>,
  })));
  return inserted.length;
}

export type DepartedSignInDeps = {
  /** Overridable for tests; production sends through emailService. */
  sendLeftEmail?: typeof sendMcpConnectionsAfterLeavingEmail;
};

/**
 * After a membership ended (its commit): the server's Connections signed in by the person. Tells
 * the owners and admins once, and emails the person about the OAuth ones. Never throws.
 */
export async function noticeConnectionsOfDepartedMember(
  input: { serverId: string; userId: string; departedAt: Date },
  deps: DepartedSignInDeps = {},
): Promise<void> {
  const trace = (outcome: "none" | "sent" | "failed", recipients: number, emailed: boolean) =>
    addTraceEvent("server.managed_mcp.departed_signin_notice", { trigger: "member_left", outcome, recipient_count: recipients, emailed });
  try {
    const connections = await findConnectionsSignedInBy(getDb(), input.userId, input.serverId);
    if (connections.length === 0) {
      trace("none", 0, false);
      return;
    }
    const person = await personOf(input.userId);
    const serverName = connections[0]!.serverName;
    const departure = `${input.serverId}:${input.userId}:${input.departedAt.getTime()}`;
    const recipients = await noticeServerManagers({
      serverId: input.serverId,
      personUserId: input.userId,
      eventKey: `mcp_connections_departed:${departure}`,
      text: departedSignInNoticeText({ personName: person?.name ?? "Someone", serverName, connections }),
    });
    const oauth = connections.filter((connection) => connection.authKind === "oauth");
    let emailed = false;
    if (oauth.length > 0 && person && !person.retired && person.email) {
      try {
        await (deps.sendLeftEmail ?? sendMcpConnectionsAfterLeavingEmail)(person.email, person.name, {
          serverName,
          connections: oauth.map(signedInConnectionLabel),
        }, `mcp-connections-departed/${departure}`);
        emailed = true;
      } catch (error) {
        console.error("[managed-mcp] departed sign-in email failed:", serializeErrorForLog(error));
      }
    }
    trace("sent", recipients, emailed);
  } catch (error) {
    trace("failed", 0, false);
    console.error("[managed-mcp] departed sign-in notice failed:", serializeErrorForLog(error));
  }
}

/**
 * After an account deletion request committed: on every server with Connections signed in by the
 * person, its owners and admins are told, with the date the OAuth ones stop. Returns the OAuth ones
 * per server for the "scheduled for deletion" email. Never throws (an empty list on failure).
 */
export async function noticeConnectionsBeforeAccountDeletion(input: {
  requestId: string;
  userId: string;
  personName: string;
  scheduledFor: Date;
}): Promise<{ serverName: string; connections: string[] }[]> {
  try {
    const connections = await findConnectionsSignedInBy(getDb(), input.userId);
    const byServer = new Map<string, SignedInConnection[]>();
    for (const connection of connections) byServer.set(connection.serverId, [...byServer.get(connection.serverId) ?? [], connection]);
    const ending: { serverName: string; connections: string[] }[] = [];
    for (const [serverId, list] of byServer) {
      try {
        await noticeServerManagers({
          serverId,
          personUserId: input.userId,
          eventKey: `mcp_connections_account_deletion:${input.requestId}:${serverId}`,
          text: departedSignInNoticeText({ personName: input.personName, serverName: list[0]!.serverName, connections: list, stopsOn: input.scheduledFor }),
        });
      } catch (error) {
        console.error("[managed-mcp] account deletion sign-in notice failed:", serializeErrorForLog(error));
      }
      const oauth = list.filter((connection) => connection.authKind === "oauth");
      if (oauth.length > 0) ending.push({ serverName: oneLine(list[0]!.serverName, 80), connections: oauth.map(signedInConnectionLabel) });
    }
    addTraceEvent("server.managed_mcp.departed_signin_notice", { trigger: "account_deletion_requested", outcome: byServer.size > 0 ? "sent" : "none", server_count: byServer.size });
    return ending;
  } catch (error) {
    console.error("[managed-mcp] account deletion sign-in lookup failed:", serializeErrorForLog(error));
    return [];
  }
}

/**
 * The account deletion's revoke: every OAuth Connection still signed in by the person, on any
 * server, is disconnected as its Disconnect does (disconnectManagedMcpOAuthConnection: tokens
 * deleted, `needs_auth`, row, default flag and pins kept). One that someone else signed in again
 * since no longer names the person and is left alone. Throws after trying them all if any failed,
 * so the cleanup step runs again.
 */
export async function revokeOAuthConnectionsSignedInBy(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: managedMcpCredentials.id, serverId: managedMcpCredentials.serverId, mcpServerId: managedMcpCredentials.mcpServerId })
    .from(managedMcpCredentials)
    .innerJoin(managedMcpServers, eq(managedMcpServers.id, managedMcpCredentials.mcpServerId))
    .where(and(
      eq(managedMcpCredentials.signedInByUserId, userId),
      sql`coalesce(${managedMcpCredentials.authKind}, ${managedMcpServers.authMode}) = 'oauth'`,
    ));
  let failed = 0;
  for (const row of rows) {
    try {
      await disconnectManagedMcpOAuthConnection(row.serverId, row.mcpServerId, row.id);
    } catch (error) {
      failed += 1;
      console.error(`[managed-mcp] revoking Connection ${row.id} of a deleted account failed:`, serializeErrorForLog(error));
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${rows.length} MCP Connections could not be disconnected`);
  return rows.length;
}
