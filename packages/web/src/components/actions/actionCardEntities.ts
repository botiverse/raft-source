// Looking up the entities an action card names by reference (`EntityRef`, a
// Msg param, a Field value, a navigate target). The card carries only the id
// and the name the server saw; the viewer's own stores say whether the viewer
// can see the entity and what it is called now. Not visible, or on another
// server than the viewer's: none, and the card shows the server's `fallback`.
// A person or an agent is named by display name (ActionCardEntityRef).

import { createContext, useCallback, useContext } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ActionCardSpecEntityRef, ActionCardSpecNavigateTarget, ServerId } from "@botiverse/raft-shared";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import type { ServerMember } from "../../store/serverStore";

/**
 * The server a card's references default to: `metadata.sourceServerId` (the
 * card's server, not necessarily the viewer's). `undefined` is an older server
 * that sends none, read as the viewer's; `null` is a card whose owner is gone.
 */
export const ActionCardServerContext = createContext<ServerId | null | undefined>(undefined);

/**
 * Whether an entity on `serverId` (absent: the card's server) is in the
 * viewer's local stores, which hold the viewer's current server only.
 */
function isOnViewerServer(serverId: string | undefined, cardServerId: ServerId | null | undefined, viewerServerId: string | undefined): boolean {
  const entityServerId = serverId ?? (cardServerId === undefined ? viewerServerId : cardServerId);
  return viewerServerId !== undefined && entityServerId === viewerServerId;
}

/** `name` is what the card shows: a person's or agent's display name (`handle` for the hover card). */
export type ResolvedEntity =
  | { kind: "user"; id: string; name: string; handle: string; member: ServerMember }
  | { kind: "agent"; id: string; name: string; handle: string; agent: Agent }
  | { kind: "channel"; id: string; name: string; channel: Channel }
  | { kind: "computer"; id: string; name: string };

type Machine = ReturnType<typeof useMachineStore.getState>["machines"][number];
// Channels the viewer can see are in the store (public ones and private ones they belong to); never a DM.
const findMember = (members: readonly ServerMember[], id: string) => members.find((m) => m.userId === id);
const findAgent = (agents: readonly Agent[], id: string) => agents.find((a) => a.id === id);
const findChannel = (channels: readonly Channel[], id: string) => channels.find((c) => c.id === id && c.type !== "dm" && c.type !== "thread");
const findComputer = (machines: readonly Machine[], id: string) => machines.find((m) => m.id === id && m.isComputer);

/** A reference as this viewer sees it, from the entity its store holds (none: not visible to them here). */
function resolved(ref: ActionCardSpecEntityRef, found: { member?: ServerMember; agent?: Agent; channel?: Channel; computer?: Machine }): ResolvedEntity | null {
  switch (ref.kind) {
    case "user":
      return found.member ? { kind: "user", id: ref.id, name: found.member.displayName || found.member.name, handle: found.member.name, member: found.member } : null;
    case "agent":
      return found.agent ? { kind: "agent", id: ref.id, name: found.agent.displayName || found.agent.name, handle: found.agent.name, agent: found.agent } : null;
    case "channel":
      return found.channel ? { kind: "channel", id: ref.id, name: found.channel.name, channel: found.channel } : null;
    case "computer":
      return found.computer ? { kind: "computer", id: ref.id, name: found.computer.name } : null;
  }
}

/**
 * Looks entities up as this viewer sees them: null when not visible to them
 * here. Re-renders its caller when the stores that hold them change: any
 * entity, for places that name references they only meet later (button
 * labels, a select's options). Where the references are known up front, use
 * useEntityLookupFor.
 */
function useEntityLookup(): (ref: ActionCardSpecEntityRef) => ResolvedEntity | null {
  const cardServerId = useContext(ActionCardServerContext);
  const viewerServerId = useServerStore((state) => state.current?.id);
  const members = useServerStore((state) => state.members);
  const agents = useAgentStore((state) => state.agents);
  const channels = useChannelStore((state) => state.channels);
  const machines = useMachineStore((state) => state.machines);
  return useCallback((ref: ActionCardSpecEntityRef): ResolvedEntity | null => {
    if (!isOnViewerServer(ref.serverId, cardServerId, viewerServerId)) return null;
    return resolved(ref, {
      member: ref.kind === "user" ? findMember(members, ref.id) : undefined,
      agent: ref.kind === "agent" ? findAgent(agents, ref.id) : undefined,
      channel: ref.kind === "channel" ? findChannel(channels, ref.id) : undefined,
      computer: ref.kind === "computer" ? findComputer(machines, ref.id) : undefined,
    });
  }, [agents, cardServerId, channels, machines, members, viewerServerId]);
}

/**
 * useEntityLookup for references known up front: it follows only those
 * entities, by id, so another agent, member, channel or Computer changing
 * re-renders nothing (a folded done card's header, a chip). A reference
 * outside `refs` is looked up as not visible.
 */
export function useEntityLookupFor(refs: readonly ActionCardSpecEntityRef[]): (ref: ActionCardSpecEntityRef) => ResolvedEntity | null {
  const cardServerId = useContext(ActionCardServerContext);
  const viewerServerId = useServerStore((state) => state.current?.id);
  const visible = refs.filter((ref) => isOnViewerServer(ref.serverId, cardServerId, viewerServerId));
  const ids = (kind: ActionCardSpecEntityRef["kind"]) => visible.filter((ref) => ref.kind === kind).map((ref) => ref.id);
  const userIds = ids("user");
  const agentIds = ids("agent");
  const channelIds = ids("channel");
  const computerIds = ids("computer");
  const members = useServerStore(useShallow((state) => userIds.map((id) => findMember(state.members, id))));
  const agents = useAgentStore(useShallow((state) => agentIds.map((id) => findAgent(state.agents, id))));
  const channels = useChannelStore(useShallow((state) => channelIds.map((id) => findChannel(state.channels, id))));
  const computers = useMachineStore(useShallow((state) => computerIds.map((id) => findComputer(state.machines, id))));
  // Each list is the entities found (shallow-equal, so it keeps its identity while they do).
  return useCallback((ref: ActionCardSpecEntityRef): ResolvedEntity | null => {
    if (!isOnViewerServer(ref.serverId, cardServerId, viewerServerId)) return null;
    return resolved(ref, {
      member: ref.kind === "user" ? members.find((member) => member?.userId === ref.id) : undefined,
      agent: ref.kind === "agent" ? agents.find((agent) => agent?.id === ref.id) : undefined,
      channel: ref.kind === "channel" ? channels.find((channel) => channel?.id === ref.id) : undefined,
      computer: ref.kind === "computer" ? computers.find((computer) => computer?.id === ref.id) : undefined,
    });
  }, [agents, cardServerId, channels, computers, members, viewerServerId]);
}

/** Names for text-only places (button labels, a dialog's title): the name the viewer knows, else the fallback. */
export function useEntityNameResolver(): (ref: ActionCardSpecEntityRef) => string {
  const lookup = useEntityLookup();
  return useCallback((ref: ActionCardSpecEntityRef) => lookup(ref)?.name ?? ref.fallback, [lookup]);
}

/** Whether a navigate target is on the viewer's server, so the app can open it. */
export function useIsNavigableTarget(target: ActionCardSpecNavigateTarget | null): boolean {
  const cardServerId = useContext(ActionCardServerContext);
  const viewerServerId = useServerStore((state) => state.current?.id);
  return target !== null && isOnViewerServer(target.serverId, cardServerId, viewerServerId);
}
