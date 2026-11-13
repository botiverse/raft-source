import { STORED_ACTION_CARD_ACTION_TYPES, type StoredActionCardActionType } from "./actionCards";
import type { ServerCapability } from "./serverPermissions";

/**
 * What a person needs, beyond operating cards in the card's channel, to run
 * (execute) or complete (mark-executed) an action card of a type. One
 * exhaustive table: a new type does not compile without its row.
 *
 * - `capability`: the server capability the action itself takes, the same one
 *   its own route asks for (POST /api/channels takes createChannels, ...).
 * - `agent`: the capability, or the authority over the card's Agent its own
 *   route accepts instead (its creator / assistant owner).
 * - `none`: the type takes no server permission; `why` says what decides instead.
 *
 * Resource checks stay where the action runs (the target channel's add rule,
 * the held call's decider, an MCP Connection really authorized, ...).
 */
export type ActionCardTypeAuthority =
  | { kind: "capability"; capability: ServerCapability; why: string; code?: string }
  | { kind: "agent"; capability: ServerCapability; why: string }
  | { kind: "none"; why: string };

function assertNeverActionCardType(type: never): never {
  throw new Error(`Action card type without an authority row: ${String(type)}`);
}

export function actionCardTypeAuthority(type: StoredActionCardActionType): ActionCardTypeAuthority {
  switch (type) {
    case "channel:create":
      return { kind: "capability", capability: "createChannels", why: "creates a channel, as POST /api/channels" };
    case "agent:create":
      return { kind: "capability", capability: "createAgents", why: "creates an Agent, as the Create Agent dialog" };
    case "channel:add_member":
      return { kind: "capability", capability: "addChannelMembers", why: "adds people; the target channel's own add rule is checked at commit" };
    case "integration:approve_agent_login":
      return { kind: "capability", capability: "manageExternalAuth", why: "grants an Agent an app login" };
    case "integration:install_marketplace_app":
      return { kind: "capability", capability: "manageIntegrations", why: "installs an app on the server" };
    case "integration:register_app":
      return { kind: "capability", capability: "manageIntegrations", why: "registers a Login with Raft app" };
    case "integration:update_app_registration":
      return { kind: "capability", capability: "manageIntegrations", why: "changes an app registration (cards for it are disabled)" };
    case "integration:recover_app_owner":
      return { kind: "capability", capability: "manageIntegrations", why: "moves an app's ownership" };
    case "agent:migrate":
      return { kind: "agent", capability: "migrateAgents", why: "moves the Agent to another computer, as POST /api/agents/:id/migrate (its creator, or migrateAgents)" };
    case "integration:connect_mcp":
      return { kind: "agent", capability: "manageExternalAuth", why: "chooses an MCP Connection for the Agent, as its assignment route" };
    case "plan:upgrade":
      return { kind: "capability", capability: "viewMembers", why: "opens the upgrade dialog, where someone who can't pay messages an owner from the member list" };
    case "seats:add":
      return { kind: "capability", capability: "manageBilling", why: "pays for seats (an owner), only through its own route", code: "OWNER_ONLY" };
    case "feedback:submit":
      return { kind: "none", why: "anyone in the channel may send product feedback (rate-limited)" };
    case "agent:approve_call":
      return { kind: "none", why: "the decider (the Agent's owner, else a server owner or admin) is checked when the call is decided" };
    case "question:ask":
      return { kind: "none", why: "answering an Agent's question in the channel takes no server permission" };
    case "assistant:owner_action":
      return { kind: "none", why: "only the assistant's owner may decide (its form handler); a confirmed card runs the owner's own route on their own session, with that route's checks" };
    default:
      return assertNeverActionCardType(type);
  }
}

/** The types `actionCardTypeAuthority` marks `none`: all a Guest, holding no capability, may run. */
export const ACTION_CARD_TYPES_WITHOUT_AUTHORITY: ReadonlySet<string> = new Set(
  STORED_ACTION_CARD_ACTION_TYPES.filter((type) => actionCardTypeAuthority(type).kind === "none"),
);
