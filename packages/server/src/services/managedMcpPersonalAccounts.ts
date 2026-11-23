/**
 * Who may hold a personal MCP Connection right now (RFC 087 §6, §10): the gate the personal sign-in
 * start, its callback and the agents API share. Kept free of the MCP services so the OAuth service
 * can ask it without an import cycle; callers turn a refusal into their own error.
 *
 * - The Server flag `mcp_personal_accounts` (featureFlagService.ts): off, or unreadable, refuses.
 * - The App's `members_can_connect` (D1): needed for a NEW personal Connection or a sign-in on one;
 *   turning it off keeps existing personal Connections and their grants (Q26).
 * - The person: a member of the Server who is not a guest (O3), account not retired.
 * - An App that signs in with OAuth: personal API-key Connections are not built (O2 undecided).
 */
import { and, eq } from "drizzle-orm";
import type { ServerRole } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { managedMcpServers, serverMembers, users } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { evaluateFeatureFlag, MCP_PERSONAL_ACCOUNTS_FEATURE_FLAG_KEY } from "./featureFlagService";

/** `mcp_personal_accounts` for this Server. A missing flag or an evaluation failure is off. */
export async function mcpPersonalAccountsEnabled(serverId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: MCP_PERSONAL_ACCOUNTS_FEATURE_FLAG_KEY, serverId }, executor)).enabled === true;
  } catch (error) {
    console.error("[managed-mcp] mcp_personal_accounts evaluation failed; treating as off:", serializeErrorForLog(error));
    return false;
  }
}

/** A member of the Server who is not a guest: who may own a personal Connection (O3). */
export function isNonGuestMemberRole(role: ServerRole | null | undefined): role is "owner" | "admin" | "member" {
  return role === "owner" || role === "admin" || role === "member";
}

export type PersonalAccountRefusal =
  /** The Server flag is off. */
  | "managed_mcp_personal_accounts_off"
  /** The App does not let members connect their own account. */
  | "managed_mcp_members_cannot_connect"
  /** Not a member of the Server, a guest, or a retired account. */
  | "managed_mcp_personal_not_member"
  /** An API-key or no-auth App: personal Connections are OAuth sign-ins only (O2). */
  | "managed_mcp_personal_oauth_only"
  | "managed_mcp_server_not_found";

export const PERSONAL_ACCOUNT_REFUSAL_MESSAGES: Record<PersonalAccountRefusal, string> = {
  managed_mcp_personal_accounts_off: "Members' own accounts are not available on this server yet.",
  managed_mcp_members_cannot_connect: "This App does not let members connect their own account. Ask an admin to turn it on.",
  managed_mcp_personal_not_member: "Only a member of this server (not a guest) can connect their own account.",
  managed_mcp_personal_oauth_only: "Only an App that signs in with OAuth can have members' own accounts.",
  managed_mcp_server_not_found: "MCP App not found",
};

/** The person's role on the Server, null when not a member or the account is retired. */
async function liveRole(executor: DatabaseExecutor, serverId: string, userId: string): Promise<ServerRole | null> {
  const [row] = await executor
    .select({ role: serverMembers.role, retiredAt: users.retiredAt })
    .from(serverMembers)
    .innerJoin(users, eq(users.id, serverMembers.userId))
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  return row && row.retiredAt === null ? row.role : null;
}

/** Whether the person may own a personal Connection on this Server now (flag, membership); null when yes. */
export async function personalOwnerRefusal(
  executor: DatabaseExecutor,
  input: { serverId: string; userId: string },
): Promise<PersonalAccountRefusal | null> {
  if (!await mcpPersonalAccountsEnabled(input.serverId, executor)) return "managed_mcp_personal_accounts_off";
  if (!isNonGuestMemberRole(await liveRole(executor, input.serverId, input.userId))) return "managed_mcp_personal_not_member";
  return null;
}

/**
 * Whether the person may sign in a personal Connection of this App now: everything
 * `personalOwnerRefusal` asks, an OAuth App, and its `members_can_connect` on. Read at the start
 * and again at the callback (§7.1); null when yes.
 */
export async function personalSignInRefusal(
  executor: DatabaseExecutor,
  input: { serverId: string; appId: string; userId: string },
): Promise<PersonalAccountRefusal | null> {
  const [app] = await executor
    .select({ authMode: managedMcpServers.authMode, membersCanConnect: managedMcpServers.membersCanConnect })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, input.appId), eq(managedMcpServers.serverId, input.serverId)))
    .limit(1);
  if (!app) return "managed_mcp_server_not_found";
  const owner = await personalOwnerRefusal(executor, input);
  if (owner) return owner;
  if (app.authMode !== "oauth") return "managed_mcp_personal_oauth_only";
  if (!app.membersCanConnect) return "managed_mcp_members_cannot_connect";
  return null;
}
