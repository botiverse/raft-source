/**
 * MCP App connection authorization: the viewer-scoped projection of who may authorize an Agent,
 * the call-origin check, and the `integration:connect_mcp` action card (raise, reuse, resolve).
 *
 * Moved out of the former registry service when the official-registry import was removed
 * (#wg-mcp, 2026-10-14). Behaviour is unchanged by the move.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { ActionCardAction } from "@botiverse/raft-shared";
import { ACTION_CARD_EXPIRY_MS, currentDate, type ActionCardMetadata } from "@botiverse/raft-shared";
import { actionCardPresentationFor, storedActionCardSpecNames } from "./actionCardPresentation";

import { getDb, type DatabaseExecutor } from "../db/index";
import {
  actionCards,
  agents,
  channelAgents,
  channels,
  managedMcpAssignments,
  managedMcpCredentials,
  managedMcpOAuthAttempts,
  managedMcpPersonalGrants,
  managedMcpServers,
  messages,
  users,
} from "../db/schema";
import {
  actorHasServerCapabilityInServer,
  getActorServerRoleInServer,
  userCanActOnAgentResource,
} from "../lib/actorPermissions";
import { prepareActionCard } from "./actionCardsService";
import { agentFindableBy } from "./agentMemberListPolicy";
import { mcpPersonalAccountsEnabled, personalOwnerRefusal } from "./managedMcpPersonalAccounts";
import { admittedMcpAccount, admittedMcpConnectionId } from "./managedMcpService";

/**
 * Drizzle wraps driver errors, so the Postgres SQLSTATE lives on the cause chain rather than on the
 * thrown error. Reading only the top level silently misses every unique violation -- which turns a
 * recoverable conflict into a 500 and, worse, makes the idempotent-replay branch unreachable.
 */
/**
 * The violated constraint's NAME, walked down the same cause chain as the SQLSTATE.
 *
 * Needed because SQLSTATE alone is too coarse to act on: every UNIQUE violation is 23505, so
 * "23505 means another request won the dedupe race" silently swallows a violation of any OTHER
 * unique constraint in the same transaction (@Huarong). Recovery must name the constraint it is
 * recovering from.
 */
export function postgresConstraintName(err: unknown): string | undefined {
  for (let current = err, depth = 0; current && depth < 5; depth++) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === "string") return name;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}


export function postgresErrorCode(err: unknown): string | undefined {
  for (let current = err, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}


/* ------------------------------------------------------------------ viewer-scoped projection */

/**
 * What a PARTICULAR viewer may do about an Agent that is blocked on an MCP Connection.
 *
 * This is computed fresh on every read and is never stored. That is the whole design constraint
 * (@peng): the durable `integration:connect_mcp` row holds App id, Agent id, reason and revision
 * and nothing else, so what a viewer is offered always reflects the App's Connections now.
 *
 * The candidates are the App's shared Connections this VIEWER may give the Agent: the server default
 * (followed, for anyone who may manage the Agent), and the others only for someone who may pin
 * (`manageExternalAuth`: pinning to a shared Connection is admin-only, RFC 087 §6). A member's
 * personal Connection is never a candidate here. Who may DO something is the viewer role (an observer
 * gets no ids and no counts). It is only a PROJECTION: which Connection an Agent may use is decided by
 * `admitManagedMcpCall` on the call path.
 */
export type McpConnectionViewerRole = "server_manager" | "agent_manager" | "observer";

export interface McpConnectionCandidate {
  connectionId: string;
  name: string | null;
  isServerDefault: boolean;
  status: "ready" | "pending" | "needs_auth" | "expired" | "error";
}

/**
 * The state of this Agent's CURRENT binding, expressed so the UI can act on all three cases.
 *
 * The middle one is the one that matters and the one a naive shape loses (@Tenny): an Agent can be
 * pinned to a Connection that no longer exists. It then fails closed at call time, and if the UI
 * could only render "stop using" on a visible candidate row, the operator would see a broken Agent
 * and NO button.
 *
 * ⚠️ A fail-closed state with no exit is not a safety measure; it converts a security property into
 * a support ticket. So `present` is reported independently of visibility, and clearing a binding
 * must never require being able to see what it points at.
 */
export interface McpConnectionBindingState {
  /** The assignment names a Connection. */
  present: boolean;
  /**
   * That Connection is among this viewer's candidates, i.e. they may see and re-select it. False for a
   * deleted Connection (calls are refused until the binding is changed) and for a pin this viewer may
   * not make (only the default is theirs to choose).
   */
  visibleToViewer: boolean;
  /** The exact id, ONLY when this viewer may see it. Never populated for an unreachable binding. */
  connectionId: string | null;
}

/**
 * A Connection THIS viewer signed in for THIS Agent (from its Connect card or the Agents tab) that the
 * Agent does not use yet: the card's "Ready to grant" state (D4).
 *
 * A finished sign-in never grants by itself; the Agent gets the Connection only when the viewer
 * clicks Grant. Without this, a page reload between the sign-in and that click lost the new
 * Connection from the card, and the viewer had to find it among the candidates again.
 */
export interface McpPendingGrant {
  connectionId: string;
  name: string | null;
}

/** How long after a sign-in the card still offers to grant it (D4). */
export const MCP_PENDING_GRANT_WINDOW_MS = 30 * 60_000;

export interface McpConnectionAuthorizationView {
  mcpServerId: string;
  agentId: string;
  viewerRole: McpConnectionViewerRole;
  /** The App, for the card's wording; null when it no longer exists. Names are not secret to members. */
  app: { name: string; authKind: "none" | "headers" | "oauth" } | null;
  candidates: McpConnectionCandidate[];
  binding: McpConnectionBindingState;
  /**
   * May create a Connection: manages the server's Apps, and for an OAuth App may also run the
   * sign-in (`manageExternalAuth`, which the callback re-checks). An API-key Connection is created
   * in the App's settings, where its key is entered.
   */
  canAuthorizeNew: boolean;
  /** May make a Connection the server default for every Agent (D1); never for an Agent manager. */
  canSetServerDefault: boolean;
  /**
   * A Connection this viewer creates now could be pinned to this Agent: the viewer may pin
   * (`manageExternalAuth`). Otherwise the Agent could use it only once it is the App's server default.
   */
  newConnectionPinnable: boolean;
  pendingGrant: McpPendingGrant | null;
  /**
   * RFC 087 §7.1 (D6): what this viewer may give the Agent, as choices. Present only while the
   * Server flag `mcp_personal_accounts` is on (off: the view is exactly the fields above). An empty
   * `personal` and no `shared` is "nothing to press: ask an admin".
   */
  options?: McpConnectionCardOptions;
  /**
   * RFC 087 §7.1: the account the Agent's calls use now (admission's own decision, the personal
   * grant first), for "Uses ops@acme.com"; null when its calls are refused, and for a viewer with
   * nothing to do here. Present only while the flag is on.
   */
  account?: McpConnectionCardAccount | null;
}

/** One account the viewer may give the Agent from the card. */
export interface McpConnectionCardAccountOption {
  connectionId: string;
  name: string | null;
  /** The provider's account label (an email, a workspace). */
  label: string | null;
  status: McpConnectionCandidate["status"];
  /** The Agents it is given to (personal grants) or pinned to it (shared), of those the viewer can find. */
  agentIds: string[];
}

export interface McpConnectionCardOptions {
  /**
   * The viewer's own ready personal Connections of this App (any may be given to the Agent: PUT
   * /api/mcp/connections/:connectionId/agents/:agentId), listed while the viewer may hold one (a
   * member, not a guest) and the Agent is one they can find. `canConnectPersonal`: they may also sign
   * in a new one (`oauth/start` with `kind: "personal"`): the App's members_can_connect is on and it
   * signs in with OAuth.
   */
  personal: { connections: McpConnectionCardAccountOption[]; canConnectPersonal: boolean };
  /**
   * Server managers only (`viewerRole: "server_manager"`): every ready shared Connection and the
   * default (`allAgents`, whatever its status), each with the Agents pinned to it. Choosing one pins
   * the Agent. `canConnectShared` is `canAuthorizeNew`.
   */
  shared?: { connections: Array<McpConnectionCardAccountOption & { allAgents: boolean }>; canConnectShared: boolean };
}

/**
 * The account an Agent uses (as the App view's `myAgents`, R15). `name`, `label` only for a server
 * manager, the Agent's manager or the personal account's owner; `connectionId` only for a server
 * manager or that owner. A personal account always says whose it is.
 */
export interface McpConnectionCardAccount {
  kind: "personal" | "shared";
  connectionId?: string;
  name: string | null;
  label: string | null;
  ownerUserId?: string;
  ownerDisplayName?: string | null;
}

/**
 * Who the viewer is with respect to one Agent's MCP Connections: a server manager
 * (`manageIntegrations`), someone who may grant this Agent Apps (`manageExternalAuth` or its
 * creator, the ordinary App grant rule), or an observer.
 * Shared by the authorization projection and the Agent's App catalogue, so the two never disagree
 * about who may see Connection names.
 */
export async function resolveMcpConnectionViewerRole(
  serverId: string,
  viewerUserId: string,
  agent: { creatorType: string | null; creatorId: string | null; assistantOwnerUserId: string | null } | null,
): Promise<McpConnectionViewerRole> {
  const role = await getActorServerRoleInServer(serverId, "user", viewerUserId);
  const isServerManager = await actorHasServerCapabilityInServer(
    serverId, "user", viewerUserId, "manageIntegrations",
  );
  const canManageAgent = agent
    ? userCanActOnAgentResource(role, viewerUserId, agent, "manageExternalAuth")
    : false;
  return isServerManager
    ? "server_manager"
    : canManageAgent
      ? "agent_manager"
      : "observer";
}

export async function projectMcpConnectionAuthorization(opts: {
  serverId: string;
  viewerUserId: string;
  mcpServerId: string;
  agentId: string;
}): Promise<McpConnectionAuthorizationView> {
  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id, creatorType: agents.creatorType, creatorId: agents.creatorId, assistantOwnerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, opts.agentId), eq(agents.serverId, opts.serverId)))
    .limit(1);

  const viewerRole = await resolveMcpConnectionViewerRole(opts.serverId, opts.viewerUserId, agent ?? null);
  const [appRow] = await db
    .select({ name: managedMcpServers.name, authMode: managedMcpServers.authMode, membersCanConnect: managedMcpServers.membersCanConnect })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, opts.mcpServerId), eq(managedMcpServers.serverId, opts.serverId)))
    .limit(1);
  const app = appRow ? { name: appRow.name, authKind: appRow.authMode } : null;

  // RFC 087 §7.1 (flag on): the viewer's own accounts and, for a server manager, the shared ones.
  const accountChoices = (view: McpConnectionAuthorizationView, canAuthorizeNew: boolean) =>
    withAccountChoices(view, { ...opts, agentFound: Boolean(agent), viewerRole, canAuthorizeNew, app: appRow ?? null });
  // An observer is told an authorization is pending and nothing else -- no Connection ids, no
  // counts, no hint about who could act. Returning early is what keeps that true: there is no
  // later filter that could be forgotten. (With the flag on, accountChoices adds only what is the
  // observer's own: their personal accounts, and the Agent's account once they have one to give.)
  if (viewerRole === "observer" || !agent || !app) {
    return accountChoices({
      mcpServerId: opts.mcpServerId,
      agentId: opts.agentId,
      viewerRole: "observer",
      app,
      candidates: [],
      // An observer learns nothing -- not the id, not the count, and not whether a binding exists.
      binding: { present: false, visibleToViewer: false, connectionId: null },
      canAuthorizeNew: false,
      canSetServerDefault: false,
      newConnectionPinnable: false,
      pendingGrant: null,
    }, false);
  }

  const rows = await db
    .select()
    .from(managedMcpCredentials)
    .where(and(
      eq(managedMcpCredentials.serverId, opts.serverId),
      eq(managedMcpCredentials.mcpServerId, opts.mcpServerId),
    ));

  // Shared Connections only; besides the default (followed), only for a viewer who may pin.
  const viewerMayPin = await actorHasServerCapabilityInServer(opts.serverId, "user", opts.viewerUserId, "manageExternalAuth");
  const candidates: McpConnectionCandidate[] = rows.filter((row) => mcpConnectionOffered(row, viewerMayPin)).map((row) => ({
    connectionId: row.id,
    name: row.name,
    isServerDefault: row.isServerDefault,
    status: row.authStatus,
  }));

  const [assignment] = await db
    .select({ connectionMode: managedMcpAssignments.connectionMode, boundConnectionId: managedMcpAssignments.boundConnectionId })
    .from(managedMcpAssignments)
    .where(and(
      eq(managedMcpAssignments.serverId, opts.serverId),
      eq(managedMcpAssignments.agentId, opts.agentId),
      eq(managedMcpAssignments.mcpServerId, opts.mcpServerId),
    ))
    .limit(1);
  const pinned = assignment?.connectionMode === "pinned";
  const boundId = pinned ? assignment?.boundConnectionId ?? null : null;
  // Visible only when it is still a candidate: a deleted Connection and someone else's both read as a
  // present binding the viewer cannot see, which the UI offers to replace.
  const boundExists = boundId !== null && candidates.some((c) => c.connectionId === boundId);
  const isServerManager = viewerRole === "server_manager";
  const canAuthorizeNew = isServerManager && app.authKind !== "none" && (app.authKind !== "oauth" || viewerMayPin);

  return accountChoices({
    mcpServerId: opts.mcpServerId,
    agentId: opts.agentId,
    viewerRole,
    app,
    candidates,
    binding: {
      // Pinned, including a pin whose Connection was deleted: the Agent is then refused, and the UI
      // must still offer a way out.
      present: pinned,
      visibleToViewer: boundExists,
      connectionId: boundExists ? boundId : null,
    },
    // Creating a Connection is a decision about the App, so it needs manageIntegrations.
    canAuthorizeNew,
    canSetServerDefault: isServerManager && app.authKind !== "none",
    newConnectionPinnable: viewerMayPin,
    pendingGrant: await findPendingMcpGrant(opts, viewerMayPin),
  }, canAuthorizeNew);
}

/**
 * Adds `options` and `account` (RFC 087 §7.1) while `mcp_personal_accounts` is on; otherwise the
 * view is returned as it is. Who may do what is §6's: a member's own accounts are theirs to give
 * (to any Agent they can find), shared ones a server manager's. Each choice is re-checked by the
 * write it leads to; this only lists them.
 */
async function withAccountChoices(view: McpConnectionAuthorizationView, ctx: {
  serverId: string;
  viewerUserId: string;
  mcpServerId: string;
  agentId: string;
  agentFound: boolean;
  viewerRole: McpConnectionViewerRole;
  canAuthorizeNew: boolean;
  app: { authMode: string; membersCanConnect: boolean } | null;
}): Promise<McpConnectionAuthorizationView> {
  const db = getDb();
  if (!await mcpPersonalAccountsEnabled(ctx.serverId, db)) return view;
  const nothing: McpConnectionAuthorizationView = { ...view, options: { personal: { connections: [], canConnectPersonal: false } }, account: null };
  if (!ctx.app) return nothing;
  // `agentFound` is the Agent on this Server; a deleted one, or one the viewer can't find (the route
  // already reads those as no Agent), is nothing to give an account to.
  const [agent] = ctx.agentFound ? await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, ctx.agentId), eq(agents.serverId, ctx.serverId), isNull(agents.deletedAt), agentFindableBy({ userId: ctx.viewerUserId })))
    .limit(1) : [];
  if (!agent) return nothing;

  const mayHoldPersonal = await personalOwnerRefusal(db, { serverId: ctx.serverId, userId: ctx.viewerUserId }) === null;
  const isServerManager = ctx.viewerRole === "server_manager";
  const rows = await db
    .select({
      id: managedMcpCredentials.id,
      name: managedMcpCredentials.name,
      accountLabel: managedMcpCredentials.accountLabel,
      authStatus: managedMcpCredentials.authStatus,
      isServerDefault: managedMcpCredentials.isServerDefault,
      ownerKind: managedMcpCredentials.ownerKind,
      ownerUserId: managedMcpCredentials.ownerUserId,
    })
    .from(managedMcpCredentials)
    .where(and(eq(managedMcpCredentials.serverId, ctx.serverId), eq(managedMcpCredentials.mcpServerId, ctx.mcpServerId)))
    .orderBy(asc(managedMcpCredentials.createdAt), asc(managedMcpCredentials.id));
  const mine = mayHoldPersonal
    ? rows.filter((row) => row.ownerKind === "personal" && row.ownerUserId === ctx.viewerUserId && row.authStatus === "ready")
    : [];
  const shared = isServerManager
    ? rows.filter((row) => row.ownerKind === "shared" && (row.authStatus === "ready" || row.isServerDefault))
    : [];
  const agentsOf = await agentsGivenConnections(db, ctx.serverId, ctx.viewerUserId, mine.map((row) => row.id), shared.map((row) => row.id));
  const option = (row: (typeof rows)[number]): McpConnectionCardAccountOption => ({
    connectionId: row.id,
    name: row.name,
    label: row.accountLabel,
    status: row.authStatus,
    agentIds: agentsOf.get(row.id) ?? [],
  });
  const options: McpConnectionCardOptions = {
    personal: {
      connections: mine.map(option),
      canConnectPersonal: mayHoldPersonal && ctx.app.authMode === "oauth" && ctx.app.membersCanConnect,
    },
    ...(isServerManager
      ? { shared: { connections: shared.map((row) => ({ ...option(row), allAgents: row.isServerDefault })), canConnectShared: ctx.canAuthorizeNew } }
      : {}),
  };
  // Someone with nothing to do here learns nothing more than an observer did (no account, no owner).
  const mayAct = ctx.viewerRole !== "observer" || options.personal.connections.length > 0 || options.personal.canConnectPersonal;
  return { ...view, options, account: mayAct ? await currentAccount(ctx, rows) : null };
}

/** The Agents each Connection is given (personal grants) or pinned (shared), of those the viewer can find. */
async function agentsGivenConnections(
  db: DatabaseExecutor,
  serverId: string,
  viewerUserId: string,
  personalIds: readonly string[],
  sharedIds: readonly string[],
): Promise<Map<string, string[]>> {
  const visible = and(eq(agents.serverId, serverId), isNull(agents.deletedAt), agentFindableBy({ userId: viewerUserId }));
  const [grants, pins] = await Promise.all([
    personalIds.length === 0 ? [] : db
      .select({ connectionId: managedMcpPersonalGrants.connectionId, agentId: managedMcpPersonalGrants.agentId })
      .from(managedMcpPersonalGrants)
      .innerJoin(agents, eq(agents.id, managedMcpPersonalGrants.agentId))
      .where(and(inArray(managedMcpPersonalGrants.connectionId, [...personalIds]), visible))
      .orderBy(asc(agents.createdAt), asc(agents.id)),
    sharedIds.length === 0 ? [] : db
      .select({ connectionId: sql<string>`${managedMcpAssignments.boundConnectionId}`, agentId: managedMcpAssignments.agentId })
      .from(managedMcpAssignments)
      .innerJoin(agents, eq(agents.id, managedMcpAssignments.agentId))
      .where(and(eq(managedMcpAssignments.connectionMode, "pinned"), inArray(managedMcpAssignments.boundConnectionId, [...sharedIds]), visible))
      .orderBy(asc(agents.createdAt), asc(agents.id)),
  ]);
  const byConnection = new Map<string, string[]>();
  for (const row of [...grants, ...pins]) byConnection.set(row.connectionId, [...byConnection.get(row.connectionId) ?? [], row.agentId]);
  return byConnection;
}

/** The Agent's account now (admittedMcpAccount), as this viewer may see it (McpConnectionCardAccount). */
async function currentAccount(
  ctx: { serverId: string; viewerUserId: string; mcpServerId: string; agentId: string; viewerRole: McpConnectionViewerRole },
  rows: ReadonlyArray<{ id: string; name: string | null; accountLabel: string | null; ownerKind: "shared" | "personal"; ownerUserId: string | null }>,
): Promise<McpConnectionCardAccount | null> {
  const admitted = await admittedMcpAccount(getDb(), ctx.serverId, ctx.agentId, ctx.mcpServerId);
  const used = admitted ? rows.find((row) => row.id === admitted.connectionId) : undefined;
  if (!admitted || !used) return null;
  const ownsIt = used.ownerKind === "personal" && used.ownerUserId === ctx.viewerUserId;
  const seeLabel = ctx.viewerRole !== "observer" || ownsIt;
  const seeId = ctx.viewerRole === "server_manager" || ownsIt;
  let owner: Pick<McpConnectionCardAccount, "ownerUserId" | "ownerDisplayName"> = {};
  if (used.ownerKind === "personal" && used.ownerUserId) {
    const [person] = await getDb()
      .select({ name: users.name, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, used.ownerUserId))
      .limit(1);
    owner = { ownerUserId: used.ownerUserId, ownerDisplayName: person?.displayName ?? person?.name ?? null };
  }
  return {
    kind: admitted.kind,
    ...(seeId ? { connectionId: used.id } : {}),
    name: seeLabel ? used.name : null,
    label: seeLabel ? used.accountLabel : null,
    ...owner,
  };
}

/** Whether the card offers this Connection to a viewer who may (or may not) pin. */
function mcpConnectionOffered(row: { isServerDefault: boolean; ownerKind: "shared" | "personal" }, viewerMayPin: boolean): boolean {
  return row.ownerKind === "shared" && (row.isServerDefault || viewerMayPin);
}

/**
 * The newest sign-in this viewer finished for this Agent within `MCP_PENDING_GRANT_WINDOW_MS` whose
 * Connection is ready and still exists, unless the Agent already uses it (`admittedMcpConnectionId`,
 * the call path's decision) or the viewer could not give it (`mcpConnectionOffered`).
 * See `McpPendingGrant`.
 */
async function findPendingMcpGrant(opts: {
  serverId: string;
  viewerUserId: string;
  mcpServerId: string;
  agentId: string;
}, viewerMayPin: boolean): Promise<McpPendingGrant | null> {
  const db = getDb();
  const [attempt] = await db
    .select({
      connectionId: managedMcpCredentials.id,
      name: managedMcpCredentials.name,
      isServerDefault: managedMcpCredentials.isServerDefault,
      ownerKind: managedMcpCredentials.ownerKind,
    })
    .from(managedMcpOAuthAttempts)
    .innerJoin(managedMcpCredentials, and(
      eq(managedMcpCredentials.id, managedMcpOAuthAttempts.connectionId),
      eq(managedMcpCredentials.mcpServerId, managedMcpOAuthAttempts.mcpServerId),
    ))
    .where(and(
      eq(managedMcpOAuthAttempts.serverId, opts.serverId),
      eq(managedMcpOAuthAttempts.mcpServerId, opts.mcpServerId),
      eq(managedMcpOAuthAttempts.userId, opts.viewerUserId),
      eq(managedMcpOAuthAttempts.status, "consumed"),
      gt(managedMcpOAuthAttempts.createdAt, new Date(currentDate().getTime() - MCP_PENDING_GRANT_WINDOW_MS)),
      sql`${managedMcpOAuthAttempts.intent} ->> 'agentId' = ${opts.agentId}`,
      eq(managedMcpCredentials.authStatus, "ready"),
    ))
    .orderBy(desc(managedMcpOAuthAttempts.createdAt))
    .limit(1);
  if (!attempt || !mcpConnectionOffered(attempt, viewerMayPin)) return null;
  const admitted = await admittedMcpConnectionId(db, opts.serverId, opts.agentId, opts.mcpServerId);
  return admitted === attempt.connectionId ? null : { connectionId: attempt.connectionId, name: attempt.name };
}

/* ------------------------------------------------------------------ authenticated call origin */

/**
 * Resolves the FOREGROUND conversation that triggered an MCP tool call, so a refused call can put
 * its connection card back where the operator is already looking (@peng).
 *
 * The caller hands over a message id and nothing else. This function derives the channel itself and
 * then re-checks it independently:
 *
 *   · the message exists
 *   · its channel belongs to THIS server
 *   · the acting Agent is actually a member of that channel
 *
 * ⚠️ Every failure returns `null` — "treated as absent" — rather than a reason. A caller cannot
 * learn from the return value whether a message id exists, belongs to another server, or belongs to
 * a channel they are not in. Absent and refused are deliberately the same answer, because the
 * difference is exactly what a probe would be looking for.
 *
 * ⚠️ There is no code path here that accepts a channel id from the caller. That is the whole point:
 * a caller-chosen delivery target is the misdelivery this guards against.
 */
export async function resolveMcpCallOrigin(opts: {
  serverId: string;
  actingAgentId: string;
  origin?: { sourceMessageId: string } | undefined;
}): Promise<{ channelId: string } | null> {
  const sourceMessageId = opts.origin?.sourceMessageId;
  if (!sourceMessageId) return null;

  const db = getDb();
  const [row] = await db
    .select({ channelId: messages.channelId, channelServerId: channels.serverId })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(eq(messages.id, sourceMessageId))
    .limit(1);
  if (!row) return null;
  // Same-server check is separate from the membership check on purpose: a message in another
  // server must not become a delivery target even if this Agent somehow shares a channel id.
  if (row.channelServerId !== opts.serverId) return null;

  const [membership] = await db
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(
      eq(channelAgents.channelId, row.channelId),
      eq(channelAgents.agentId, opts.actingAgentId),
    ))
    .limit(1);
  if (!membership) return null;

  return { channelId: row.channelId };
}

/* ------------------------------------------------------------------ connection card producer */

/**
 * Raises (or reuses) the `integration:connect_mcp` card for an Agent that was refused for want of
 * an authorized MCP Connection.
 *
 * Three rules from @peng, and each one is a thing this must NOT do:
 *
 *   · It must not GUESS a channel. The card goes to the conversation the refused call actually came
 *     from, resolved and re-validated server-side. No origin, or an origin that fails validation,
 *     means NO CARD -- not a creator DM, not an admin channel, not a broadcast.
 *   · It must not SPAM. A tool call can repeat every few seconds, so at most one unresolved card
 *     exists per (server, App, Agent). A repeat call reuses the open one and posts no new message.
 *   · It must not become a silent success. When no card can be raised the caller still gets
 *     `login_required`; the refusal never softens just because nobody could be told about it.
 *
 * "Pending" needs no storage of its own: an Agent is pending exactly when
 * `admitManagedMcpCall` refuses it, which Settings can compute from state it already reads.
 * A dedicated pending table would be a second source of truth that can disagree with admission.
 */
/**
 * Test seam for the production card producer, matching this package's `__set*ForTests` convention.
 *
 * It exists for one assertion that is otherwise unreachable: the route calls the producer
 * best-effort and must return the ORIGINAL `login_required` even when card production throws.
 * With a direct import that catch branch can never be executed from a route test, so the behaviour
 * was implemented and unprotected (@Huarong). A seam is the cheapest way to make a failure
 * injectable without giving production a second way to reach the producer.
 */
type McpConnectionCardProducer = typeof ensureMcpConnectionCard;
let connectionCardProducerOverride: McpConnectionCardProducer | null = null;

export function __setMcpConnectionCardProducerForTests(fn: McpConnectionCardProducer | null): void {
  connectionCardProducerOverride = fn;
}

/** What production calls. Routes must use this rather than importing the producer directly. */
export const produceMcpConnectionCard: McpConnectionCardProducer = (opts, deps) =>
  (connectionCardProducerOverride ?? ensureMcpConnectionCard)(opts, deps);

/**
 * Close the open `integration:connect_mcp` card for (Server, Agent, MCP) once the authorization it
 * asked for exists -- however it was granted.
 *
 * Without this, authorizing from Settings (rather than from the card's own dialog) leaves the card
 * `prepared` forever: nothing else consults it, so the operator keeps seeing a request that has
 * already been satisfied, and the next refusal cannot raise a fresh card because reuse finds the
 * stale one.
 *
 * ⚠️ Deliberately does NOT run the card's channel-visibility checks. The caller has already been
 * authorized to make the binding (`manageExternalAuth` or the Agent's creator, membership fence on the route), and
 * the operator who authorizes in Settings is frequently not a member of the channel the card was
 * posted into. Requiring visibility here would mean the card can only be closed by someone who can
 * see it, which is exactly the population that does not need this path.
 *
 * ⚠️ The caller passes `authorized`, computed with the SAME predicate the runtime uses. This
 * function never decides authorization itself -- a second predicate here would be the drift
 * `isMcpConnectionAuthorized` exists to prevent.
 */
export async function resolveOpenMcpConnectionCard(
  tx: DatabaseExecutor,
  opts: {
    serverId: string;
    agentId: string;
    mcpServerId: string;
    userId: string;
    authorized: boolean;
  },
): Promise<{ messageId: string } | null> {
  if (!opts.authorized) return null;
  // Deliberately the SAME predicate `ensureMcpConnectionCard` uses to decide a card is reusable.
  // Matching on `dedupeKey` instead would miss any card minted before that column existed, and
  // would let "reusable" and "resolvable" drift apart -- the two must name the same row.
  const [open] = await tx
    .select({ messageId: actionCards.messageId, id: actionCards.id })
    .from(actionCards)
    .where(openConnectionCardWhere(opts))
    .limit(1);
  if (!open) return null;

  const [messageRow] = await tx
    .select({ actionMetadata: messages.actionMetadata })
    .from(messages)
    .where(eq(messages.id, open.messageId))
    .limit(1);
  const existing = (messageRow?.actionMetadata ?? null) as Partial<ActionCardMetadata> | null;
  if (!existing || existing.kind !== "action-card" || !existing.action) return null;
  if (existing.action.type !== "integration:connect_mcp") return null;

  const [actor] = await tx
    .select({ name: users.name, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, opts.userId))
    .limit(1);
  const result = { kind: "mcp-connection" as const, mcpServerId: opts.mcpServerId, agentId: opts.agentId };
  const executedAt = new Date();
  await tx.update(actionCards).set({
    state: "executed",
    executedAt,
    executedByUserId: opts.userId,
    result: result as unknown as object,
    updatedAt: executedAt,
  }).where(eq(actionCards.id, open.id));
  await tx.update(messages).set({
    actionMetadata: {
      ...existing,
      kind: "action-card",
      presentation: actionCardPresentationFor(existing.action, { result, names: storedActionCardSpecNames(existing.presentation) }),
      state: "executed",
      executedAt: executedAt.toISOString(),
      executedByUserId: opts.userId,
      executedByUserName: actor?.displayName ?? actor?.name ?? null,
      result,
    } as ActionCardMetadata,
    updatedAt: executedAt,
  }).where(eq(messages.id, open.messageId));
  return { messageId: open.messageId };
}

export async function ensureMcpConnectionCard(opts: {
  serverId: string;
  agentId: string;
  mcpServerId: string;
  revision: number;
  origin?: { sourceMessageId: string } | undefined;
  /**
   * A conversation the caller already resolved and checked (`raft integration login --target`,
   * through `channelService.resolveChannelByName` for this Agent), used instead of a call origin.
   */
  targetChannelId?: string;
}, deps?: {
  prepare?: (args: {
    serverId: string;
    requesterAgentId: string;
    targetChannelId: string;
    action: ActionCardAction;
  }) => Promise<{ messageId: string }>;
}): Promise<{ cardMessageId: string | null; reused: boolean }> {
  const db = getDb();

  // Reuse first, and BEFORE resolving the origin: an already-open card is the answer regardless of
  // where this particular call came from, and checking it first is what makes a retry loop cheap.
  const [open] = await db
    .select({ messageId: actionCards.messageId })
    .from(actionCards)
    .where(openConnectionCardWhere(opts))
    .limit(1);
  if (open) return { cardMessageId: open.messageId, reused: true };

  const resolved = opts.targetChannelId
    ? { channelId: opts.targetChannelId }
    : await resolveMcpCallOrigin({
      serverId: opts.serverId,
      actingAgentId: opts.agentId,
      ...(opts.origin ? { origin: opts.origin } : {}),
    });
  // Background work, or an origin that did not survive validation: record nothing, post nothing.
  // The next call that carries a valid foreground origin is what materialises the card.
  if (!resolved) return { cardMessageId: null, reused: false };

  const action: ActionCardAction = {
    type: "integration:connect_mcp",
    mcpServerId: opts.mcpServerId,
    agentId: opts.agentId,
    reason: "login_required",
    revision: opts.revision,
  };
  // ⭐ The dedupe key makes "one open card per (server, Agent, MCP)" a DATABASE fact. The read above
  // is only a fast path; it cannot be the guarantee, because it runs in a different transaction from
  // the insert -- two concurrent refusals both saw nothing and both posted (@Huarong).
  const dedupeKey = openConnectionCardDedupeKey(opts.serverId, opts.agentId, opts.mcpServerId);
  // A card open past its 30 days is not reused (nobody can complete it: it reads as expired). It
  // gives up the dedupe key so this one can be posted, and otherwise stays as it is (`prepared`).
  await db.update(actionCards).set({ dedupeKey: null }).where(and(
    eq(actionCards.dedupeKey, dedupeKey),
    eq(actionCards.state, "prepared"),
    lt(actionCards.createdAt, connectionCardCutoff()),
  ));
  try {
    const prepared = await (deps?.prepare ?? prepareActionCard)({
      serverId: opts.serverId,
      requesterAgentId: opts.agentId,
      targetChannelId: resolved.channelId,
      action,
      dedupeKey,
    });
    return { cardMessageId: prepared.messageId, reused: false };
  } catch (err) {
    // We lost the race: another refusal inserted the open card between our read and our insert.
    // That is a SUCCESS for the caller -- the card they needed exists -- so resolve to the winner's
    // card rather than surfacing a constraint violation.
    //
    // ⚠️ Narrowed to OUR constraint by name, not just by SQLSTATE. Every unique violation is 23505,
    // so matching on the code alone would swallow a violation of any other unique constraint inside
    // `prepareActionCard()`'s transaction -- and, finding no winner, report `{cardMessageId: null}`,
    // dressing a real write failure up as "no card was needed" (@Huarong). Anything that is not this
    // index is not ours to interpret.
    if (
      postgresErrorCode(err) !== "23505"
      || postgresConstraintName(err) !== "idx_action_cards_open_dedupe"
    ) throw err;
    const [winner] = await db
      .select({ messageId: actionCards.messageId })
      .from(actionCards)
      .where(and(eq(actionCards.dedupeKey, dedupeKey), eq(actionCards.state, "prepared")))
      .limit(1);
    // Our own constraint fired, so an open card existed a moment ago. If it has since been resolved
    // there is nothing open to point at; report no card rather than inventing one, and the next
    // refusal raises a fresh one.
    return winner ? { cardMessageId: winner.messageId, reused: true } : { cardMessageId: null, reused: false };
  }
}

/** Prepared before this, a connect card is past its 30 days (ACTION_CARD_EXPIRY_MS): never reused or resolved. */
const connectionCardCutoff = () => new Date(Date.now() - ACTION_CARD_EXPIRY_MS);

/**
 * "The open Connect card for this Agent and this MCP server": prepared, and within its 30 days.
 * The one predicate for both reuse (ensureMcpConnectionCard) and resolution
 * (resolveOpenMcpConnectionCard), so the two always name the same row.
 */
function openConnectionCardWhere(opts: { serverId: string; agentId: string; mcpServerId: string }) {
  return and(
    eq(actionCards.serverId, opts.serverId),
    eq(actionCards.requesterAgentId, opts.agentId),
    eq(actionCards.actionType, "integration:connect_mcp"),
    eq(actionCards.state, "prepared"),
    gte(actionCards.createdAt, connectionCardCutoff()),
    sql`${actionCards.payload} ->> 'mcpServerId' = ${opts.mcpServerId}`,
  );
}

/**
 * The stable identity of "the open Connect card for this Agent and this MCP server".
 *
 * Exported so the uniqueness contract is readable in one place rather than being re-derived by
 * string concatenation at each site. Components are ids, never names: a renamed Agent or server must
 * not silently become a different request.
 */
export function openConnectionCardDedupeKey(serverId: string, agentId: string, mcpServerId: string): string {
  return `integration:connect_mcp:${serverId}:${agentId}:${mcpServerId}`;
}
