/**
 * RFC 085 §4.2, preparing a `request:prepare` card (what happens after it is
 * posted: preparedRequestCards.ts). Behind the server flag
 * `prepared_request_card_v0`: actionCardsService.prepareActionCard hands the
 * type here only where it is on, and refuses it anywhere else as a type it
 * doesn't know.
 *
 *   1. the operation must be an entry of the delegable list
 *      (delegableCardRegistry.ts; the list is the only source of what a card
 *      may run) whose route the runtime backstop lets through
 *      (delegableRouteBackstop.ts), and the args fit its args schema;
 *   2. the person it is for is a member who can act on cards in this
 *      conversation;
 *   3. the args resolve to the route's path params and body under the
 *      preparing agent's visibility, with the uniform refusal reading them
 *      would get (so prepare can't probe), then are checked against the
 *      route's params and body schemas, of which only the parsed output is
 *      kept: never a query string, never a key the body schema doesn't take,
 *      and every path param an id;
 *   4. the summary model is built under the agent's visibility too, and the
 *      card stored with the digest of route, params, body and model;
 *   5. the agent is told the summary the person sees (with the names it may
 *      see), whom it is for, and that the result comes back as a reply.
 * Asking is bounded per agent and person, in the posting transaction
 * (preparedRequestCards.assertPreparedRequestBudget): 5 open, 20 in any 24
 * hours, and none of a request for 24 hours after the person declined it.
 */
import {
  PREPARED_REQUEST_ACTION_TYPE,
  PREPARED_REQUEST_CARD_FEATURE_FLAG_KEY,
  actionCardSchemaIssues,
  asServerId,
  extractHandleName,
  formatInvalidActionCardFields,
  looksLikeUuid,
  preparedRequestActionSchema,
  preparedRequestAgentActionSchema,
  type ActionCardSpecNames,
  type AgentApiActionOperationsResponse,
  type PreparedRequestAction,
} from "@botiverse/raft-shared";
import type { z, ZodObject, ZodType } from "zod";
import { RefusalError } from "../lib/refusal";
import { evaluateFeatureFlag } from "./featureFlagService";
import type { ActionCardToPost, PrepareActionCardArgs } from "./actionCardsService";
import { delegableCardEntries, delegableCardEntryForOperation } from "./delegableCardRegistry";
import { delegableBodyBackstopKey, delegableRouteBackstopRule } from "./delegableRouteBackstop";
import { englishOf, preparedRequestDigest, preparedRequestEchoFor, preparedRequestParamAllowed, preparedRequestRouteRequest } from "./preparedRequestCards";

/** Whether agents on this server may prepare request cards (`prepared_request_card_v0`; missing or failing = off). */
export async function isPreparedRequestCardEnabled(serverId: string): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: PREPARED_REQUEST_CARD_FEATURE_FLAG_KEY, serverId })).enabled;
  } catch (err) {
    console.warn("[request-cards] flag evaluation failed; reading it as off", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * What an agent may prepare here (RFC 085 §4.2 discovery, `raft action prepare
 * --list`): with request cards on for the server, every entry of the list the
 * runtime backstop lets through, as prepare would take it, from the entry's own
 * doc and its template's copy (English; `<name>` stands for what the args
 * resolve to). Off, nothing, as prepare would refuse every one.
 */
export async function preparableOperations(serverId: string): Promise<AgentApiActionOperationsResponse> {
  if (!await isPreparedRequestCardEnabled(serverId)) return { enabled: false, operations: [] };
  const placeholders = (text: string) => text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, "<$1>");
  const operations = delegableCardEntries()
    .filter((entry) => !delegableRouteBackstopRule(entry.routeKey))
    .map(({ route, template }) => {
      const shape = route.operation.argsSchema.shape as Record<string, ZodType>;
      return {
        operation: route.operation.name,
        summary: route.operation.doc.summary,
        args: Object.keys(shape).map((name) => ({
          name,
          description: route.operation.doc.args[name] ?? "",
          required: !shape[name]!.safeParse(undefined).success,
        })),
        confirmer: route.operation.doc.confirmer,
        personSees: { title: placeholders(englishOf(template.display.title, {})), button: englishOf(template.display.verb, {}) },
        example: { ...route.operation.doc.example },
      };
    });
  return { enabled: true, operations };
}

/** The issues of a failed parse as the card checks write them ("args.agent: required"), at most ten. */
function issuesOf(prefix: string, input: unknown, error: z.ZodError): string {
  return formatInvalidActionCardFields(actionCardSchemaIssues(input, error).map((issue) => ({ ...issue, path: prefix ? `${prefix}.${issue.path}`.replace(/\.$/, "") : issue.path })));
}

/** The person a request card is for: a member by their handle (or id), named the way their row has it. */
async function resolveAddressee(serverId: string, to: string): Promise<{ userId: string; handle: string }> {
  const { getDb } = await import("../db/index");
  const { users } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const channelService = await import("./channelService");
  const serverService = await import("./serverService");
  const handle = extractHandleName(to, "@");
  const userId = looksLikeUuid(handle)
    ? (await serverService.isMember(serverId, handle) ? handle : null)
    : await channelService.resolveUserByName(serverId, handle);
  const [person] = userId ? await getDb().select({ id: users.id, name: users.name }).from(users).where(eq(users.id, userId)).limit(1) : [];
  if (!person) {
    // As reading a person by a name nobody here has (GET /internal/agent-api/users): the same code and sentence.
    throw new RefusalError(404, {
      code: "user_not_found",
      error: "Not found, or you don't have access: nobody you can see on this server has that name, so check the name against who is on the server.",
    });
  }
  return { userId: person.id, handle: person.name };
}

/** `METHOD /concrete/path`: the route with its (id) params filled in, as the runtime backstop reads a request that would run. */
function concreteRoute(routeKey: string, params: Readonly<Record<string, string>>, paramsSchema: ZodObject): string {
  const request = preparedRequestRouteRequest({ route: routeKey, params, body: {} }, paramsSchema);
  return `${request.method} ${request.path}`;
}

/** Resolves an agent's request card into the card prepare posts (actionCardsService.postActionCard). */
export async function resolvePreparedRequestForPost(args: PrepareActionCardArgs): Promise<ActionCardToPost> {
  const parsed = preparedRequestAgentActionSchema.safeParse(args.action);
  if (!parsed.success) {
    throw new RefusalError(400, {
      code: "INVALID_ACTION",
      error: `The request card failed validation: ${issuesOf("", args.action, parsed.error)}. Fix those fields and prepare it again.`,
    });
  }
  const sent = parsed.data;
  const entry = delegableCardEntryForOperation(sent.operation);
  // A route of a class that never runs from a card is refused whatever the list says (the runtime backstop).
  const blocked = entry ? delegableRouteBackstopRule(entry.routeKey) : null;
  if (blocked) console.error("[request-cards] the runtime backstop refused a listed route", entry!.routeKey, blocked.name);
  if (!entry || blocked) {
    throw new RefusalError(400, {
      code: "unknown_operation",
      error: `No operation named "${sent.operation}" can be prepared as a request card on this server: check the operation's name.`,
    });
  }
  const args_ = entry.route.operation.argsSchema.safeParse(sent.args);
  if (!args_.success) {
    throw new RefusalError(400, {
      code: "invalid_args",
      error: `The args don't fit ${sent.operation}: ${issuesOf("args", sent.args, args_.error)}. Fix them and prepare it again.`,
    });
  }

  // The preparing agent, and the conversation it posts in: as any card (actionCardsService's own checks).
  const agentService = await import("./agentService");
  const channelService = await import("./channelService");
  const { ActionCardError, canPersonAnswerQuestionIn } = await import("./actionCardsService");
  const agent = await agentService.getAgent(args.requesterAgentId);
  if (!agent || agent.serverId !== args.serverId) throw new ActionCardError(404, "AGENT_NOT_FOUND", "Requester agent not found in this server");
  const target = await channelService.getChannel(args.targetChannelId);
  if (!target || target.serverId !== args.serverId) throw new ActionCardError(404, "TARGET_NOT_FOUND", "Target channel not found in this server");
  if (!await channelService.canAgentPostToChannel(args.targetChannelId, args.requesterAgentId)) {
    throw new ActionCardError(403, "TARGET_NOT_ACCESSIBLE", "Requester agent cannot post to this target");
  }

  const addressee = await resolveAddressee(args.serverId, sent.to);
  if (!await canPersonAnswerQuestionIn(args.serverId, target.id, addressee.userId)) {
    throw new RefusalError(409, {
      code: "addressee_cannot_act_here",
      error: `@${addressee.handle} can't act on cards in this conversation (they can't see it, or are a guest), so they couldn't confirm it here: post it where they can, such as a DM with them.`,
    });
  }

  // The args as the route's request, under the agent's visibility; only the schemas' output is kept.
  const serverId = asServerId(args.serverId);
  const resolved = await entry.route.operation.resolve(args_.data, { serverId, agentId: args.requesterAgentId, channelId: target.id });
  if (!resolved.ok) throw new RefusalError(resolved.status, resolved.refusal);
  const params = entry.route.paramsSchema.safeParse(resolved.params);
  const body = entry.route.bodySchema.safeParse(resolved.body);
  // Path params are uuids, or a word their enum lists, only (preparedRequestRouteRequest): never `.`, `..`, `/`,
  // anything to encode, or a word such as `me` in an id's place.
  const shape = entry.route.paramsSchema.shape as Record<string, unknown>;
  const loose = params.success ? Object.entries(params.data as Record<string, unknown>).find(([name, value]) => !preparedRequestParamAllowed(shape[name], value)) : undefined;
  if (loose) {
    throw new RefusalError(400, {
      code: "invalid_args",
      error: `The args don't make a request ${sent.operation} takes: ${loose[0]} is not an id. Fix them and prepare it again.`,
    });
  }
  // The request as it would run, its params filled in: a param can't carry a refused route in (the backstop again).
  if (params.success && delegableRouteBackstopRule(concreteRoute(entry.routeKey, params.data as Record<string, string>, entry.route.paramsSchema))) {
    throw new RefusalError(400, {
      code: "unknown_operation",
      error: `No operation named "${sent.operation}" can be prepared as a request card on this server: check the operation's name.`,
    });
  }
  // A body field a card never sends (making content public, a secret, a role or scopes), at any depth.
  const forbidden = body.success ? delegableBodyBackstopKey(body.data) : null;
  if (forbidden) {
    console.error("[request-cards] the runtime backstop refused a body field", entry.routeKey, forbidden);
    throw new RefusalError(400, {
      code: "invalid_args",
      error: `The args don't make a request ${sent.operation} takes: ${forbidden} is never sent from a request card. Prepare it without that.`,
    });
  }
  if (!params.success || !body.success) {
    throw new RefusalError(400, {
      code: "invalid_args",
      error: `The args don't make a request ${sent.operation} takes: ${!params.success ? issuesOf("params", resolved.params, params.error) : issuesOf("body", resolved.body, (body as { error: z.ZodError }).error)}. Fix them and prepare it again.`,
    });
  }

  // The summary model, under the agent's visibility as well (Warden).
  const built = await entry.template.model({ params: params.data as Record<string, string>, body: body.data as Record<string, unknown> }, { serverId, viewer: { kind: "agent", agentId: args.requesterAgentId } });
  if (!built.ok) throw new RefusalError(built.status, built.refusal);
  const unsigned = {
    type: PREPARED_REQUEST_ACTION_TYPE,
    operation: sent.operation,
    route: entry.routeKey,
    params: params.data as Record<string, string>,
    body: body.data as PreparedRequestAction["body"],
    permission: entry.route.permission,
    addressee: { kind: "user" as const, userId: addressee.userId, handle: addressee.handle },
    ...(sent.note ? { note: sent.note } : {}),
    template: entry.route.summaryTemplate,
    summaryModel: built.model,
    display: entry.template.display,
    attempt: 1,
  };
  const stored = preparedRequestActionSchema.safeParse({ ...unsigned, digest: preparedRequestDigest(unsigned) });
  if (!stored.success) {
    // The route's template or schemas built what no card may hold: the list's fault, not the agent's.
    throw new Error(`request card for ${entry.routeKey} does not fit the stored schema: ${stored.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const action = stored.data;

  // The card's fallback names: what everyone in the conversation may see, and who prepared it and for whom.
  const conversationNames = await entry.template.names(action.summaryModel, { serverId, viewer: { kind: "conversation", channelId: target.id } });
  const cardNames: ActionCardSpecNames = {
    ...conversationNames,
    users: { ...conversationNames.users, [addressee.userId]: addressee.handle },
    agents: { ...conversationNames.agents, [agent.id]: agent.displayName || agent.name },
  };
  const agentNames = await entry.template.names(action.summaryModel, { serverId, viewer: { kind: "agent", agentId: args.requesterAgentId } });
  return {
    action,
    storedAction: action,
    cardPayload: action,
    cardNames,
    agent,
    target,
    currentComputerId: null,
    preparedRequest: preparedRequestEchoFor(action, agentNames),
  };
}
