// RFC 080 §4.2: what an assistant may do with its act-as-owner credential.
//
// One table, keyed by Agent API route. A route that is not here is refused
// (`assistant_delegation_not_allowed`): new routes are never delegable by
// default. Changing this table is a permission change; it goes through review
// (Tenny, Warden), and the pinned count in assistantDelegationPolicy.test.ts
// has to be changed with it.
//
// - `read`: read within the owner's visibility, with no read-state side effect
//   for the owner or the assistant (RFC 080 §4.3).
// - `search`: search within the owner's visibility.
// - `send`: post with the owner as author and `delegated_by` set; also needs
//   the owner's send-as-me switch, checked on every send.
import type { AgentApiRouteKey } from "./agentApiContract";

export type AssistantDelegationCategory = "read" | "search" | "send";

export const ASSISTANT_DELEGATION_POLICY = {
  historyRead: "read",
  inboxList: "read",
  userChannels: "read",
  messageSearch: "search",
  messageSendV2: "send",
} as const satisfies Partial<Record<AgentApiRouteKey, AssistantDelegationCategory>>;

export type AssistantDelegableRouteKey = keyof typeof ASSISTANT_DELEGATION_POLICY;

/** The category a route may be delegated under, or null: refuse. */
export function assistantDelegationCategory(routeKey: string): AssistantDelegationCategory | null {
  return Object.prototype.hasOwnProperty.call(ASSISTANT_DELEGATION_POLICY, routeKey)
    ? ASSISTANT_DELEGATION_POLICY[routeKey as AssistantDelegableRouteKey]
    : null;
}

export const ASSISTANT_DELEGATION_NOT_ALLOWED_CODE = "assistant_delegation_not_allowed";

/**
 * The phrase for `{action}` in the refusal text (RFC 080 §7.1), per route the
 * assistant is likely to try. A route without a phrase reads "do this", so a
 * route key never appears mid-sentence.
 */
export const ASSISTANT_DELEGATION_REFUSED_ACTION: Partial<Record<AgentApiRouteKey, string>> = {
  messageReactionAdd: "add a reaction",
  messageReactionRemove: "remove a reaction",
  messageCardUpdate: "update a card message",
  channelCreate: "create a channel",
  taskCreate: "create a task",
  taskClaim: "claim a task",
  taskAssign: "assign a task",
  taskUpdateStatus: "change a task's status",
  taskReply: "reply in a task",
  threadFollow: "follow a thread",
  threadUnfollow: "unfollow a thread",
  // RFC 081: they move the assistant's own read state (RFC 080 §4.3: delegated reads have none).
  inboxRead: "read an inbox item",
  inboxDismiss: "dismiss inbox items",
};

/** RFC 080 §7.1 `assistant_delegation_not_allowed`. */
export function assistantDelegationRefusedText(input: { owner: string; routeKey: string }): string {
  const action = ASSISTANT_DELEGATION_REFUSED_ACTION[input.routeKey as AgentApiRouteKey] ?? "do this";
  return `${input.owner} has to do this themselves: an assistant can't ${action} as its owner. Tell ${input.owner} in your DM what to do.`;
}
