/**
 * RFC 085 §4.3, the summary templates of the `card` list
 * (delegableCardRoutes.ts), by its entries' `summaryTemplate`. Templates live
 * with the list, and change with the same review.
 *
 * A template turns a route's request (its path params and body) into the
 * summary model the person approves, and says how the card draws it. The
 * model holds ids and values only, never a display name: it is rebuilt at
 * commit and compared with what was prepared (a rename is not a change; a
 * different Computer, member or role is). The card draws it from message keys
 * (actionCardMessages, every locale) over EntityRefs, so each viewer's
 * client names what it can see.
 *
 * The first templates (§7): starting and stopping an agent, and lowering a
 * channel member's role. The routeAuthorityClassification structure test
 * refuses a `card` entry whose template has no entry here.
 *
 * Services are imported where they are used: the structure test reads this
 * module before it captures the app's routes, so it stays as light as the
 * list.
 */
import type { ActionCardSpecNames, PreparedRequestDisplay, PreparedRequestModel, ServerId } from "@botiverse/raft-shared";
import type { DelegableRefusal } from "./delegableCardRoutes";

/**
 * Whose eyes a template builds or names for:
 * - `agent`: the preparing agent (prepare; again before a changed card may be
 *   confirmed; its result);
 * - `user`: the person committing it;
 * - `conversation`: everyone in the conversation the card is in, for the
 *   card's own fallback names (a neutral name, "a private channel", unless
 *   they all may see the real one, §4.4).
 */
export type DelegableViewer =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | { kind: "conversation"; channelId: string };

export interface DelegableTemplateContext {
  serverId: ServerId;
  viewer: DelegableViewer;
}

/** A route's request as the card stores and runs it. */
export interface DelegableRequest {
  params: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
}

export interface DelegableSummaryTemplate {
  /** The card's copy: message keys for its title, its confirm verb and its fields (each over one model entry). */
  display: PreparedRequestDisplay;
  /**
   * The summary model of `request` as things are now. Something `viewer`
   * can't see is the uniform refusal reading it would be: at prepare and
   * before a changed card is offered again that viewer is the preparing agent
   * (RFC 085 §4.2, Warden), at commit the person.
   */
  model(request: DelegableRequest, ctx: DelegableTemplateContext): Promise<{ ok: true; model: PreparedRequestModel } | DelegableRefusal>;
  /** Names for the model's entities as `viewer` may see them (none: the client's own name, or a short id). */
  names(model: PreparedRequestModel, ctx: DelegableTemplateContext): Promise<ActionCardSpecNames>;
}

// ── Who sees what ───────────────────────────────────────────────────────────

/**
 * The one refusal for a person or an agent the viewer can't see, as reading
 * them by name gets it (`raft user info`): the same code and sentence whether
 * they exist or not.
 */
export const DELEGABLE_PERSON_NOT_FOUND: DelegableRefusal = {
  ok: false,
  status: 404,
  refusal: {
    code: "user_not_found",
    error: "Not found, or you don't have access: nobody you can see on this server has that name, so check the name against who is on the server.",
  },
};

/** A channel the viewer can't see, as reading it gets it (AGENT_CHANNEL_NOT_FOUND_REFUSAL's code and sentence). */
export async function delegableChannelNotFound(): Promise<DelegableRefusal> {
  const { AGENT_CHANNEL_NOT_FOUND_REFUSAL } = await import("../routes/agentRouteRefusals");
  return { ok: false, status: 404, refusal: AGENT_CHANNEL_NOT_FOUND_REFUSAL };
}

/**
 * Whether an id may be looked up at all: a uuid. The entries' params schemas
 * already hold every id to one; this keeps a template's own reads from
 * handing anything else to the database (a 500, not a refusal) if a schema
 * were ever loosened.
 */
async function isId(value: string | undefined): Promise<boolean> {
  const { looksLikeUuid } = await import("@botiverse/raft-shared");
  return typeof value === "string" && looksLikeUuid(value);
}

/** A live agent of this server `viewer` may find (another person's personal assistant is no one to them), else null. */
export async function agentSeenBy(agentId: string, ctx: DelegableTemplateContext) {
  const { getAgent } = await import("./agentService");
  const { isAgentFindableBy } = await import("./agentMemberListPolicy");
  if (!await isId(agentId)) return null;
  const agent = await getAgent(agentId);
  if (!agent || agent.serverId !== ctx.serverId) return null;
  const { viewer } = ctx;
  if (viewer.kind === "agent" && !isAgentFindableBy({ agentId: viewer.agentId }, agent)) return null;
  if (viewer.kind === "user" && !isAgentFindableBy({ userId: viewer.userId }, agent)) return null;
  // Everyone in a conversation: never a personal assistant (only its owner finds it).
  if (viewer.kind === "conversation" && agent.assistantOwnerUserId) return null;
  return agent;
}

/** A channel of this server `viewer` may see, else null (everyone in a conversation: conversationMaySee decides its name). */
export async function channelSeenBy(channelId: string, ctx: DelegableTemplateContext) {
  const channelService = await import("./channelService");
  if (!await isId(channelId)) return null;
  const channel = await channelService.getChannel(channelId);
  if (!channel || channel.serverId !== ctx.serverId) return null;
  const { viewer } = ctx;
  if (viewer.kind === "agent" && !await channelService.canAgentAccessChannel(channel.id, viewer.agentId)) return null;
  if (viewer.kind === "user" && !await channelService.canUserAccessChannel(channel.id, viewer.userId, ctx.serverId)) return null;
  return channel;
}

/**
 * Whether a person is a member of this server `viewer` may name: an agent
 * sees the server's people unless the server hides its people from agents
 * (the directory `raft server info` shows); a person or a conversation sees
 * the server's members (the route checks the committing person itself).
 */
export async function personSeenBy(userId: string, ctx: DelegableTemplateContext): Promise<boolean> {
  const serverService = await import("./serverService");
  if (!await isId(userId) || !await serverService.isMember(ctx.serverId, userId)) return false;
  if (ctx.viewer.kind === "agent") return !await serverService.shouldHideHumanDirectoryFromAgentRequester(ctx.serverId, ctx.viewer.agentId);
  return true;
}

/** The conversation a card is in, at its root (a thread's or a task's parent channel). */
async function rootConversation(channelId: string) {
  const channelService = await import("./channelService");
  const { isSubConversationType } = await import("@botiverse/raft-shared");
  const channel = await channelService.getChannel(channelId);
  if (!channel) return null;
  if (isSubConversationType(channel.type) && channel.parentChannelId) return channelService.getChannel(channel.parentChannelId);
  return channel;
}

/**
 * Whether everyone in the conversation a card is posted in may see an entity
 * (RFC 085 §4.4: the card's fallback names stay neutral otherwise; each
 * client still names what its own viewer sees). Conservative: a member of
 * that conversation is seen by everyone in it; an agent (never a personal
 * assistant, agentSeenBy) or a public channel of this server is seen by
 * everyone outside a Joint channel, whose readers include other servers'
 * people.
 */
async function conversationMaySee(conversationId: string, entity: { kind: "user" | "agent" | "channel"; id: string }): Promise<boolean> {
  const channelService = await import("./channelService");
  const root = await rootConversation(conversationId);
  if (!root) return false;
  if (entity.kind === "channel") {
    if (entity.id === root.id) return true;
    const channel = await channelService.getChannel(entity.id);
    return !!channel && channel.type === "channel" && root.type !== "joint" && channel.serverId === root.serverId;
  }
  if (entity.kind === "user") return channelService.isChannelHuman(root.id, entity.id);
  if (await channelService.isChannelAgent(root.id, entity.id)) return true;
  return root.type !== "joint";
}

/** An agent's handle for `ctx.viewer`, when it may see it. */
async function agentNames(agentId: string, ctx: DelegableTemplateContext): Promise<ActionCardSpecNames> {
  const agent = await agentSeenBy(agentId, ctx);
  if (!agent) return {};
  if (ctx.viewer.kind === "conversation" && !await conversationMaySee(ctx.viewer.channelId, { kind: "agent", id: agent.id })) return {};
  return { agents: { [agent.id]: agent.name } };
}

// ── The templates ───────────────────────────────────────────────────────────

/**
 * Starting or stopping an agent (POST /api/agents/:id/start, /stop): the
 * person approves the agent, by id. Its Computer is not in the model: the
 * route runs or stops the agent where it is, and no card names a Computer.
 */
function agentLifecycleTemplate(display: PreparedRequestDisplay): DelegableSummaryTemplate {
  return {
    display,
    async model(request, ctx) {
      const agent = await agentSeenBy(request.params.id!, ctx);
      if (!agent) return DELEGABLE_PERSON_NOT_FOUND;
      return { ok: true, model: { agent: { kind: "agent", id: agent.id } } };
    },
    async names(model, ctx) {
      const entry = model.agent;
      return entry && entry.kind === "agent" ? agentNames(entry.id, ctx) : {};
    },
  };
}

/**
 * Lowering a channel member's role (PATCH
 * /api/channels/:id/members/:targetType/:memberId/role with `role: member`):
 * the person approves the channel, the member (a person or an agent, by id)
 * and the role it becomes, which the entry's body schema holds to `member`
 * (the same route also promotes; promoting is never delegable, RFC 085 §5).
 */
const removeChannelAdminTemplate: DelegableSummaryTemplate = {
  display: {
    title: "actionCard.preparedRequest.removeChannelAdmin.title",
    verb: "actionCard.preparedRequest.removeChannelAdmin.verb",
    fields: [
      { label: "actionCard.field.channel", value: "channel" },
      { label: "actionCard.preparedRequest.field.member", value: "member" },
    ],
  },
  async model(request, ctx) {
    const channelService = await import("./channelService");
    // The body first: whatever the list's schema took, a summary never says a role but member.
    if (request.body.role !== "member") {
      return { ok: false, status: 400, refusal: { code: "invalid_args", error: "A request card only lowers a channel member's role to member: it never makes anyone an admin." } };
    }
    const channel = await channelSeenBy(request.params.id!, ctx);
    if (!channel) return delegableChannelNotFound();
    const { targetType, memberId } = request.params;
    if (targetType === "user") {
      if (!await personSeenBy(memberId!, ctx) || !await channelService.isChannelHuman(channel.id, memberId!)) return DELEGABLE_PERSON_NOT_FOUND;
    } else if (targetType === "agent") {
      const agent = await agentSeenBy(memberId!, ctx);
      if (!agent || !await channelService.isChannelAgent(channel.id, agent.id)) return DELEGABLE_PERSON_NOT_FOUND;
    } else {
      return DELEGABLE_PERSON_NOT_FOUND;
    }
    return {
      ok: true,
      model: {
        channel: { kind: "channel", id: channel.id },
        member: { kind: targetType, id: memberId! },
        role: { kind: "text", text: "member" },
      },
    };
  },
  async names(model, ctx) {
    const names: ActionCardSpecNames = {};
    const channel = model.channel;
    if (channel && channel.kind === "channel") {
      const seen = await channelSeenBy(channel.id, ctx);
      if (seen && (ctx.viewer.kind !== "conversation" || await conversationMaySee(ctx.viewer.channelId, { kind: "channel", id: seen.id }))) {
        names.channels = { [seen.id]: seen.name };
      }
    }
    const member = model.member;
    if (member && member.kind === "agent") Object.assign(names, await agentNames(member.id, ctx));
    if (member && member.kind === "user" && await personSeenBy(member.id, ctx)
      && (ctx.viewer.kind !== "conversation" || await conversationMaySee(ctx.viewer.channelId, { kind: "user", id: member.id }))) {
      const { getDb } = await import("../db/index");
      const { users } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");
      const [person] = await getDb().select({ name: users.name }).from(users).where(eq(users.id, member.id)).limit(1);
      if (person) names.users = { [member.id]: person.name };
    }
    return names;
  },
};

export const DELEGABLE_SUMMARY_TEMPLATES: Readonly<Record<string, DelegableSummaryTemplate>> = {
  "agent.start": agentLifecycleTemplate({
    title: "actionCard.preparedRequest.agentStart.title",
    verb: "actionCard.preparedRequest.agentStart.verb",
    fields: [{ label: "actionCard.field.agent", value: "agent" }],
  }),
  "agent.stop": agentLifecycleTemplate({
    title: "actionCard.preparedRequest.agentStop.title",
    verb: "actionCard.preparedRequest.agentStop.verb",
    fields: [{ label: "actionCard.field.agent", value: "agent" }],
  }),
  "channel.admin.remove": removeChannelAdminTemplate,
};
