/**
 * RFC 085 §4.1, the `card` list: the human-session routes an agent may prepare
 * for a named person as a card. The person sees a summary the server writes,
 * confirms, and the server runs that exact request as them (§4.2). A route is
 * `card` only through an entry here, with its row in
 * src/test/routeAuthorityClassification.ts marked `delegable: "card"`.
 *
 * routeAuthorityClassification.structure.test.ts pins this list by content,
 * so adding or removing a route changes that test, which is the permission
 * owner's (Warden's) review. It also refuses an entry that lacks any of the
 * three fields below, and keeps every security-sensitive route (§3.1) `never`
 * through its deny list and keyword rules.
 *
 * Phase 1 (§7) lists the first two templates: agent start and stop, and
 * lowering a channel member's role. Read at runtime only through
 * delegableCardRegistry.ts (the request:prepare card, preparedRequestCards.ts).
 *
 * Beside each entry: its review against the never-delegable classes (§3.1,
 * §5 "not in any batch"). The runtime body backstop
 * (delegableRouteBackstop.ts delegableBodyBackstopKey) is a denylist behind
 * this allowlist, so each entry's own body schema must admit nothing of
 * those classes on its own (Tenny).
 *
 * This list is the ONLY runtime source of truth for what a card may run (Tenny,
 * #proj-apps:#62 msg ab83c67e): the request:prepare dispatcher allows a route
 * only if it has an entry here. The classification table lives under src/test
 * and product code must never import it.
 *
 * A card request carries the route's path parameters (validated by
 * `paramsSchema`) and a body (`bodySchema`), and never a query string.
 */
import type { ServerCapability, ServerId } from "@botiverse/raft-shared";
import { z, type ZodObject, type ZodType } from "zod";
import type { RefusalInput, RefusalStatus } from "../lib/refusal";
import { agentSeenBy, delegableChannelNotFound, DELEGABLE_PERSON_NOT_FOUND, personSeenBy } from "./delegableSummaryTemplates";

/** A person's route as the classification names it: method and Express-registered full path under /api. */
export type DelegableRouteKey = `${"POST" | "PUT" | "PATCH" | "DELETE"} /api/${string}`;

/** What a `card` route declares (RFC 085 §4.1). */
export interface DelegableCardRoute {
  /** The server-side summary template the card is drawn from (§4.3), never agent text. */
  summaryTemplate: string;
  /**
   * The route's path parameters the card binds, each validated and each shown
   * in the summary: a strict object whose keys are exactly the key's `:name`
   * segments (the structure test checks both).
   */
  paramsSchema: ZodObject;
  /**
   * The request body the card may carry: a strict object, which refuses
   * unknown keys rather than stripping them, and never admits a sensitive key
   * such as `serverRole` or `envVars` (Warden, #14720). Only its parsed output
   * reaches the route, so a route that does more than the card should (PATCH
   * /api/agents/:id) is narrowed here.
   */
  bodySchema: ZodType;
  /**
   * The server capability the committing person needs: without it they see
   * the card folded (§4.4). The route's own checks still decide at commit.
   */
  permission: ServerCapability;
  /** What agents call it and how their args become this route's request (§4.2: agents name operations, not routes). */
  operation: DelegableOperation;
}

/** A refusal the card answers with: a status and the shared refusal envelope (docs/contracts/agent-api-refusals.md). */
export interface DelegableRefusal {
  ok: false;
  status: RefusalStatus;
  refusal: RefusalInput;
}

/**
 * An operation an agent may prepare for a person (RFC 085 §4.2). The route is
 * a server-side detail behind it and may change without breaking agents.
 */
export interface DelegableOperation {
  /** The stable agent-facing name, `noun:verb` (`agent:stop`), unique across the list. */
  name: string;
  /** The args in the agent's own words (`@alice`, `#ops`, a role): a strict object. */
  argsSchema: ZodObject;
  /**
   * The args (as argsSchema parsed them) as the route's path params and body,
   * resolved under the preparing agent's visibility in the conversation the
   * card goes to. Anything the agent can't see is the same uniform refusal as
   * reading it would be (the same code and sentence), so prepare can't probe.
   * What it returns is then checked against paramsSchema and bodySchema, and
   * only their parsed output is kept.
   */
  resolve(args: Readonly<Record<string, unknown>>, ctx: DelegableResolveContext): Promise<DelegableResolution>;
  /** What `raft action prepare --list` tells an agent about it (§4.2, discovery). */
  doc: DelegableOperationDoc;
}

/**
 * An operation as agents discover it (`raft action prepare --list`, GET
 * /internal/agent-api/prepare-action/operations). Server-written, one line
 * each; what the person sees comes from the template's copy.
 */
export interface DelegableOperationDoc {
  /** What a confirm does, in one sentence. */
  summary: string;
  /** Each key of argsSchema: what to write there, in the agent's own words. */
  args: Readonly<Record<string, string>>;
  /** Whom to ask: who can confirm it (the route still decides). */
  confirmer: string;
  /** Example args, each as an agent would write it. */
  example: Readonly<Record<string, string>>;
}

export interface DelegableResolveContext {
  serverId: ServerId;
  /** The preparing agent: whose visibility decides. */
  agentId: string;
  /** The conversation the card is posted in. */
  channelId: string;
}

export type DelegableResolution =
  | { ok: true; params: Record<string, string>; body: Record<string, unknown> }
  | DelegableRefusal;

// ── Resolving agents' args ──────────────────────────────────────────────────

/** An agent the preparing agent may find by its handle (`@builder`); another person's personal assistant is no one. */
async function resolveAgentArg(ref: unknown, ctx: DelegableResolveContext): Promise<string | null> {
  const { extractHandleName } = await import("@botiverse/raft-shared");
  const channelService = await import("./channelService");
  const handle = extractHandleName(String(ref), "@");
  return handle ? channelService.resolveAgentByName(ctx.serverId, handle, { agentId: ctx.agentId }) : null;
}

/** `agent:start` / `agent:stop`: the agent by its handle; the route takes no body. */
async function resolveAgentLifecycle(args: Readonly<Record<string, unknown>>, ctx: DelegableResolveContext): Promise<DelegableResolution> {
  const id = await resolveAgentArg(args.agent, ctx);
  return id ? { ok: true, params: { id }, body: {} } : DELEGABLE_PERSON_NOT_FOUND;
}

function refusal(status: RefusalStatus, code: string, error: string): DelegableRefusal {
  return { ok: false, status, refusal: { code, error } };
}

/**
 * `channel:remove_admin`: the channel by name (one the agent can see, with
 * channel roles), and a channel admin in it by handle (`@alice`, or
 * `@alice~human` / `@scout~agent` where a person and an agent share the name),
 * whose role becomes `member`. Refused here, before any card: someone the agent
 * can't see (the uniform refusals), a server owner or admin (always a channel
 * admin; the route refuses them too), and someone who isn't a channel admin
 * (nothing to lower).
 */
async function resolveRemoveChannelAdmin(args: Readonly<Record<string, unknown>>, ctx: DelegableResolveContext): Promise<DelegableResolution> {
  const { channelSupportsRoles, parseDmPeerRef, extractHandleName } = await import("@botiverse/raft-shared");
  const channelService = await import("./channelService");
  const { getActorServerRoleInServer } = await import("../lib/actorPermissions");
  const found = await channelService.resolveChannelByName(ctx.serverId, ctx.agentId, String(args.channel)).catch(() => null);
  const channel = found && await channelService.canAgentAccessChannel(found.channelId, ctx.agentId) ? await channelService.getChannel(found.channelId) : null;
  if (!channel || channel.serverId !== ctx.serverId) return delegableChannelNotFound();
  if (!channelSupportsRoles(channel.type, channel.name)) {
    return refusal(400, "channel_roles_unsupported", `#${channel.name} has no channel roles: only public, private and Joint channels other than #all do.`);
  }

  const parsed = parseDmPeerRef(extractHandleName(String(args.member), "@"));
  if (!parsed.ok) return DELEGABLE_PERSON_NOT_FOUND;
  const { peerName, peerKind } = parsed;
  const seen = { serverId: ctx.serverId, viewer: { kind: "agent" as const, agentId: ctx.agentId } };
  const userId = peerKind === "agent" ? null : await channelService.resolveUserByName(ctx.serverId, peerName);
  const person = userId && await personSeenBy(userId, seen) && await channelService.isChannelHuman(channel.id, userId) ? userId : null;
  const agentId = peerKind === "human" ? null : await resolveAgentArg(peerName, ctx);
  const agent = agentId && await agentSeenBy(agentId, seen) && await channelService.isChannelAgent(channel.id, agentId) ? agentId : null;
  if (person && agent) {
    return refusal(400, "ambiguous_member", `A person and an agent in #${channel.name} are both called @${peerName}: write @${peerName}~human or @${peerName}~agent.`);
  }
  const target = person ? { type: "user" as const, id: person } : agent ? { type: "agent" as const, id: agent } : null;
  if (!target) return DELEGABLE_PERSON_NOT_FOUND;

  const serverRole = await getActorServerRoleInServer(ctx.serverId, target.type, target.id);
  if (serverRole === "owner" || serverRole === "admin") {
    return refusal(409, "protected_server_role", `@${peerName} is a server ${serverRole}, so they stay a channel admin in every channel; only their server role can change that, and a request card never changes a server role.`);
  }
  if (await channelRoleOf(channel.id, target) !== "admin") {
    return refusal(409, "not_channel_admin", `@${peerName} is not a channel admin of #${channel.name}, so there is no role to lower.`);
  }
  return { ok: true, params: { id: channel.id, targetType: target.type, memberId: target.id }, body: { role: "member" } };
}

/** A member's own role row in a channel (`admin` or `member`), or null without one. */
async function channelRoleOf(channelId: string, target: { type: "user" | "agent"; id: string }): Promise<string | null> {
  const { getDb } = await import("../db/index");
  const { channelAgents, channelHumans } = await import("../db/schema");
  const { and, eq } = await import("drizzle-orm");
  const [row] = target.type === "user"
    ? await getDb().select({ role: channelHumans.role }).from(channelHumans).where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, target.id))).limit(1)
    : await getDb().select({ role: channelAgents.role }).from(channelAgents).where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, target.id))).limit(1);
  return row?.role ?? null;
}

const agentArgs = () => z.strictObject({ agent: z.string().trim().min(1).max(200) });

// ── The list ────────────────────────────────────────────────────────────────

export const DELEGABLE_CARD_ROUTES: Readonly<Record<DelegableRouteKey, DelegableCardRoute>> = {
  // Never-delegable review (§3.1, §5): no body (the route reads none, and `{}` strict admits no key); the one
  // param is the agent's uuid. Not credentials or keys (starting launches the agent on the Computer it is already
  // assigned to; the runner credential that Computer mints per launch is the agent's own, returned to no one, and
  // no Computer is assigned or changed), not a seat or a payment, not a role, scope or grant, nothing made
  // public or sent outside the server. Its side effects are the route's own, run as the person: lifting an
  // admin's pause of a personal assistant is its owner's alone (and no agent finds another's assistant), and an
  // auto-start migration completes under the person's own fenced authority. Starting an agent lets it work and
  // so spend, which §5 puts in the first batch on purpose: no change to its model or limits rides along.
  "POST /api/agents/:id/start": {
    summaryTemplate: "agent.start",
    paramsSchema: z.strictObject({ id: z.uuid() }),
    bodySchema: z.strictObject({}),
    permission: "controlAgentRuntime",
    operation: {
      name: "agent:start",
      argsSchema: agentArgs(),
      resolve: resolveAgentLifecycle,
      doc: {
        summary: "Start a stopped agent on the Computer it is assigned to.",
        args: { agent: "the agent's handle, as `raft server info --agents` lists it" },
        confirmer: "any server member except a guest",
        example: { agent: "@builder" },
      },
    },
  },
  // Never-delegable review (§3.1, §5): no body (strict `{}`); the one param is the agent's uuid. Stopping
  // changes no credential, seat, role, scope, grant or visibility, and sends nothing outside the server. A
  // server owner or admin stopping a personal assistant pauses it (the route tells its owner), a route side
  // effect the person sees on the card's verb; no agent finds another's assistant to prepare it.
  "POST /api/agents/:id/stop": {
    summaryTemplate: "agent.stop",
    paramsSchema: z.strictObject({ id: z.uuid() }),
    bodySchema: z.strictObject({}),
    permission: "stopAgents",
    operation: {
      name: "agent:stop",
      argsSchema: agentArgs(),
      resolve: resolveAgentLifecycle,
      doc: {
        summary: "Stop an agent.",
        args: { agent: "the agent's handle, as `raft server info --agents` lists it" },
        confirmer: "a server owner or admin, or the agent's creator",
        example: { agent: "@builder" },
      },
    },
  },
  // Never-delegable review (§3.1, §5): the body is exactly `{ role: "member" }`: the route also promotes
  // (`admin`), and promoting a channel role is never delegable (§5, Warden on #13987), so the schema is the
  // literal and nothing else. Params: the channel's and member's uuids and `targetType` as the route's own
  // enum (user | agent). A channel role is not a server role (a server owner or admin is refused at prepare
  // and by the route, protected_server_role); no credential, seat, scope, grant, visibility key or invite
  // rides it, and a Joint channel's role changes only this server's projection (the route's own rule).
  "PATCH /api/channels/:id/members/:targetType/:memberId/role": {
    summaryTemplate: "channel.admin.remove",
    paramsSchema: z.strictObject({ id: z.uuid(), targetType: z.enum(["user", "agent"]), memberId: z.uuid() }),
    bodySchema: z.strictObject({ role: z.literal("member") }),
    permission: "changeChannelMemberRoles",
    operation: {
      name: "channel:remove_admin",
      argsSchema: z.strictObject({ channel: z.string().trim().min(1).max(200), member: z.string().trim().min(1).max(200) }),
      resolve: resolveRemoveChannelAdmin,
      doc: {
        summary: "Make a channel admin an ordinary member of the channel (never the other way).",
        args: {
          channel: "the channel, as #name",
          member: "the channel admin's handle (@name; @name~human or @name~agent when a person and an agent share it)",
        },
        confirmer: "a server owner or admin, or a channel admin of that channel",
        example: { channel: "#ops", member: "@alice" },
      },
    },
  },
};
