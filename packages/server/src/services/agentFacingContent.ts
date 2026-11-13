// The content an agent reads for each message it is handed, on every path that
// hands one over: the legacy receive (`GET /internal/agent/:id/receive`), the
// agent API's `/events` (the SDK, hosted agents, `raft message check`), a
// re-read of one event (`raft message read --target agent-event:<id>`), and
// the pushes to a managed daemon (`agent:deliver`, `agent:start`'s wake and
// resume messages: renderPushedMessages).
//
// The boundary (docs/development/third-party-rendering.md):
// - An external app's event (an OAuth client's: `third_party_agent_events.client_id`
//   set) is rendered inert: ref-shaped text (`@name`, `#channel`, task and message
//   refs) is rewritten so the app can't fake a mention or a target.
// - Raft's own system apps (`system_app` set, `client_id` empty: Artifacts'
//   notices, the assistant, RaftBench) write their text themselves, quoting what
//   members of the server wrote, as trusted as those members' own messages.
//   Their content is rendered as an ordinary message's: their `@name`s stay
//   handles, and their next steps (`--target "#channel:abcd1234"`) stay runnable.
// - Which is which is read from the event's row only, never from the message,
//   its payload or its content. An event whose row isn't found reads as an
//   external app's (fail closed).
// - A message an external system mirrored in (`external_message`) was rendered
//   when it was queued and is passed through unchanged.
import { withInboxItemTargets } from "./inboxItemsLaunch";
import { renderThirdPartyInertText, type AgentMessage } from "@botiverse/raft-shared";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { thirdPartyAgentEvents } from "../db/schema";
import * as agentPermalinkRenderService from "./agentPermalinkRenderService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type HandedMessage = Pick<AgentMessage, "content" | "sender_type" | "third_party_event"> & { external_message?: unknown; message_id?: unknown };

/** A third-party app message's event id: its `third_party_event.id`, else (an event message) its message id. */
function eventIdOf(message: HandedMessage): string | null {
  if (message.sender_type !== "third_party_app") return null;
  const id = message.third_party_event?.id ?? message.message_id;
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
}

/**
 * The ids, among `eventIds`, of this agent's events from Raft's own system
 * apps: a row with `system_app` set and `client_id` empty. Anything else (an
 * OAuth client's, another agent's, no row at all) is left out.
 */
export async function raftAuthoredAppEventIds(
  agentId: string,
  eventIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(eventIds.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return new Set();
  const rows = await executor.select({ id: thirdPartyAgentEvents.id }).from(thirdPartyAgentEvents).where(and(
    eq(thirdPartyAgentEvents.agentId, agentId),
    inArray(thirdPartyAgentEvents.id, ids),
    isNotNull(thirdPartyAgentEvents.systemApp),
    isNull(thirdPartyAgentEvents.clientId),
  ));
  return new Set(rows.map((row) => row.id.toLowerCase()));
}

/**
 * Whether a handed message is Raft's own writing, given the ids
 * raftAuthoredAppEventIds found: every message that isn't a third-party app's
 * is, and a third-party app message is when its event is a system app's.
 */
export function isRaftAuthoredMessage(message: HandedMessage, raftAuthored: ReadonlySet<string>): boolean {
  if (message.sender_type !== "third_party_app") return true;
  const id = eventIdOf(message);
  return id !== null && raftAuthored.has(id);
}

/**
 * The content each message is handed over with, in order: an ordinary
 * message's rendering (same-server permalinks as Raft refs) for Raft's own
 * writing, including system apps' events; an external app's event inert; a
 * mirrored external message as queued.
 */
export async function renderAgentFacingContents(
  messages: readonly HandedMessage[],
  agentId: string,
  serverId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<string[]> {
  const eventIds = messages.flatMap((message) => (message.external_message ? [] : [eventIdOf(message)].filter((id): id is string => id !== null)));
  const [rendered, raftAuthored] = await Promise.all([
    agentPermalinkRenderService.renderAgentReadablePermalinksInTexts(messages.map((message) => message.content ?? ""), serverId),
    raftAuthoredAppEventIds(agentId, eventIds, executor),
  ]);
  return messages.map((message, index) => {
    if (message.sender_type === "third_party_app" && message.external_message) return message.content ?? "";
    return isRaftAuthoredMessage(message, raftAuthored)
      ? rendered[index]!
      : renderThirdPartyInertText({ field: "tool_result", value: message.content });
  });
}

const isAppEvent = (message: HandedMessage) => message.sender_type === "third_party_app" && !message.external_message;

/**
 * Messages about to be pushed to a managed daemon (`agent:deliver`, and
 * `agent:start`'s wake and resume messages), which hands them to the agent as
 * they arrive (its own `/events` answers from that inbox too): each app
 * event's content as renderAgentFacingContents hands it over on the pull
 * paths; every other message unchanged (an ordinary message is rendered when
 * it is written). Never throws: if the lookup fails, app events go out inert.
 */
export async function renderPushedMessages<M extends HandedMessage>(
  messages: readonly M[],
  agentId: string,
  serverId: string | undefined,
  executor?: DatabaseExecutor,
): Promise<M[]> {
  if (!messages.some(isAppEvent)) return [...messages];
  const events = messages.filter(isAppEvent);
  let contents: string[];
  try {
    contents = await renderAgentFacingContents(events, agentId, serverId ?? "", executor);
  } catch (err) {
    console.warn(`[AgentFacingContent] app event lookup failed for agent ${agentId}; pushing ${events.length} inert:`, err);
    contents = events.map((message) => renderThirdPartyInertText({ field: "tool_result", value: message.content }));
  }
  let next = 0;
  const rendered = messages.map((message) => (isAppEvent(message) ? { ...message, content: contents[next++]! } : message));
  // RFC 081: each app event that is an inbox item says which (`third_party_event.inbox_item_target`).
  return withInboxItemTargets(rendered, agentId, serverId, executor);
}
