/**
 * MCP App connection authorization: the viewer-scoped projection of who may authorize an Agent,
 * the call-origin check, and the `integration:connect_mcp` action card (raise, reuse, resolve).
 *
 * Moved out of the former registry service when the official-registry import was removed
 * (#wg-mcp, 2026-10-14). Behaviour is unchanged by the move.
 */
import { and, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
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
import { admittedMcpConnectionId } from "./managedMcpService";
import { mcpAgentOwnerUserId, mcpConnectionUsableByAgent } from "./managedMcpConnectionOwnership";

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
 * The candidates are the Connections THIS AGENT may use (`mcpConnectionUsableByAgent`: the App's
 * server default, and the ones its owner created), whoever is looking: a server manager still manages
 * every Connection in the App's settings, but may only pin this Agent to one of these. Who may DO
 * something is the viewer role (an observer gets no ids and no counts). It is only a PROJECTION: which
 * Connection an Agent may use is decided by `admitManagedMcpCall` on the call path.
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
   * deleted Connection and for one this Agent may no longer use (someone else's); either way calls are
   * refused until the binding is changed.
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
   * A Connection this viewer creates now could be pinned to this Agent: the viewer is the Agent's
   * owner. Otherwise the Agent could use it only once it is the App's server default.
   */
  newConnectionPinnable: boolean;
  pendingGrant: McpPendingGrant | null;
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
    .select({ name: managedMcpServers.name, authMode: managedMcpServers.authMode })
    .from(managedMcpServers)
    .where(and(eq(managedMcpServers.id, opts.mcpServerId), eq(managedMcpServers.serverId, opts.serverId)))
    .limit(1);
  const app = appRow ? { name: appRow.name, authKind: appRow.authMode } : null;

  // An observer is told an authorization is pending and nothing else -- no Connection ids, no
  // counts, no hint about who could act. Returning early is what keeps that true: there is no
  // later filter that could be forgotten.
  if (viewerRole === "observer" || !agent || !app) {
    return {
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
    };
  }

  const rows = await db
    .select()
    .from(managedMcpCredentials)
    .where(and(
      eq(managedMcpCredentials.serverId, opts.serverId),
      eq(managedMcpCredentials.mcpServerId, opts.mcpServerId),
    ));

  // Only the Connections this Agent may use: the server default and its owner's own. Another
  // person's Connection carries their account; it is never offered, whoever is looking.
  const agentOwnerUserId = mcpAgentOwnerUserId(agent);
  const candidates: McpConnectionCandidate[] = rows.filter((row) => mcpConnectionUsableByAgent(row, agentOwnerUserId)).map((row) => ({
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
  const canAuthorizeNew = isServerManager && app.authKind !== "none" && (
    app.authKind !== "oauth"
    || await actorHasServerCapabilityInServer(opts.serverId, "user", opts.viewerUserId, "manageExternalAuth")
  );

  return {
    mcpServerId: opts.mcpServerId,
    agentId: opts.agentId,
    viewerRole,
    app,
    candidates,
    binding: {
      // Pinned, including a pin whose Connection was deleted or is no longer usable by this Agent:
      // the Agent is then refused, and the UI must still offer a way out.
      present: pinned,
      visibleToViewer: boundExists,
      connectionId: boundExists ? boundId : null,
    },
    // Creating a Connection is a decision about the App, so it needs manageIntegrations.
    canAuthorizeNew,
    canSetServerDefault: isServerManager && app.authKind !== "none",
    newConnectionPinnable: agentOwnerUserId !== null && agentOwnerUserId === opts.viewerUserId,
    pendingGrant: await findPendingMcpGrant(opts, agentOwnerUserId),
  };
}

/**
 * The newest sign-in this viewer finished for this Agent within `MCP_PENDING_GRANT_WINDOW_MS` whose
 * Connection is ready and still exists, unless the Agent already uses it (`admittedMcpConnectionId`,
 * the call path's decision) or may not use it (another person's, see `mcpConnectionUsableByAgent`).
 * See `McpPendingGrant`.
 */
async function findPendingMcpGrant(opts: {
  serverId: string;
  viewerUserId: string;
  mcpServerId: string;
  agentId: string;
}, agentOwnerUserId: string | null): Promise<McpPendingGrant | null> {
  const db = getDb();
  const [attempt] = await db
    .select({
      connectionId: managedMcpCredentials.id,
      name: managedMcpCredentials.name,
      isServerDefault: managedMcpCredentials.isServerDefault,
      createdByUserId: managedMcpCredentials.createdByUserId,
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
  if (!attempt || !mcpConnectionUsableByAgent(attempt, agentOwnerUserId)) return null;
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
