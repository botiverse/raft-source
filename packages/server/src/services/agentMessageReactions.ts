// A message's reactions as an agent reads them (the agent API's message
// envelope, shared AgentApiMessageReaction): per emoji its count and who
// reacted, by handle and kind, at most AGENT_API_MESSAGE_REACTION_REACTORS_MAX
// of them. Not gated by any flag.
//
// The envelope already carried the web's summary per emoji (`emoji`, `count`,
// `reactorIds`, `reactorNames`: display names, every reactor), untyped. This
// adds `reactors` to that same entry rather than a second list; the web's
// fields stay as they were for clients that read them.
import { inArray } from "drizzle-orm";
import { AGENT_API_MESSAGE_REACTION_REACTORS_MAX, type AgentApiMessageReactor } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import { UUID_RE } from "../lib/messageId";

type WebReactionSummary = { emoji: string; count: number; reactorIds: readonly string[]; reactorNames: readonly string[] };

function isWebReactionSummary(value: unknown): value is WebReactionSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Partial<WebReactionSummary>;
  return typeof summary.emoji === "string" && typeof summary.count === "number"
    && Array.isArray(summary.reactorIds) && Array.isArray(summary.reactorNames);
}

/**
 * These messages with `reactors` on each of their reactions: the first
 * AGENT_API_MESSAGE_REACTION_REACTORS_MAX per emoji, in the order they
 * reacted. A person or an agent is named by handle (no `@`, so the text
 * pings no one); someone mirrored from another service, or whose row is
 * gone, by the name the web shows, as `external`. Two queries for the page
 * however many messages, none when no message has a reaction.
 */
export async function withAgentMessageReactions<T extends { reactions?: unknown }>(messages: readonly T[]): Promise<T[]> {
  const shownIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.reactions)) continue;
    for (const reaction of message.reactions) {
      if (!isWebReactionSummary(reaction)) continue;
      for (const id of reaction.reactorIds.slice(0, AGENT_API_MESSAGE_REACTION_REACTORS_MAX)) {
        if (typeof id === "string" && UUID_RE.test(id)) shownIds.add(id);
      }
    }
  }
  if (shownIds.size === 0) return [...messages];
  const ids = [...shownIds];
  const db = getDb();
  const [userRows, agentRows] = await Promise.all([
    db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)),
    db.select({ id: agents.id, name: agents.name, deletedAt: agents.deletedAt }).from(agents).where(inArray(agents.id, ids)),
  ]);
  const people = new Map(userRows.map((row) => [row.id, row.name]));
  const agentsById = new Map(agentRows.map((row) => [row.id, row]));
  const reactorOf = (id: string, shownName: string): AgentApiMessageReactor => {
    const agent = agentsById.get(id);
    // A deleted agent's handle may be another agent's now: the name it is shown by.
    if (agent) return { name: agent.deletedAt ? shownName : agent.name, kind: "agent" };
    if (people.has(id)) return { name: people.get(id) || shownName, kind: "human" };
    return { name: shownName, kind: "external" };
  };
  return messages.map((message) => {
    if (!Array.isArray(message.reactions) || message.reactions.length === 0) return message;
    return {
      ...message,
      reactions: message.reactions.map((reaction: unknown) => {
        if (!isWebReactionSummary(reaction)) return reaction;
        const reactors = reaction.reactorIds.slice(0, AGENT_API_MESSAGE_REACTION_REACTORS_MAX)
          .map((id, index) => reactorOf(String(id), String(reaction.reactorNames[index] ?? "")));
        return { ...reaction, reactors };
      }),
    };
  });
}
