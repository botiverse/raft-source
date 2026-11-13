import type { Agent } from "../../store/agentStore";
import { useAgentStore } from "../../store/agentStore";
import type { Channel } from "../../store/channelStore";
import type { ServerMember } from "../../store/serverStore";
import { useServerStore } from "../../store/serverStore";
import { useShallow } from "zustand/react/shallow";
import { resolveAgentDmProfileSource } from "./agentDmProfileSource";

/** A DM's peer as the DM channel copied it: a snapshot taken when the DM was loaded. */
export type DmPeerAvatarSnapshot = Pick<Channel, "peerType" | "peerId" | "peerAvatarUrl">;

export interface DmPeerAvatar {
  avatarUrl: string | null;
}

/** The peer as the live directory knows it: only what an avatar renders. */
type LivePeerAvatar = DmPeerAvatar;

/**
 * A DM peer's avatar. The live directory (agents, server members) is the
 * source once it knows the peer, a null avatar included: null is the default
 * avatar, not "unknown", so falling back to the snapshot would keep showing an
 * avatar that was reset (#10271). The DM snapshot only covers a peer neither
 * directory knows (yet).
 */
export function resolveDmPeerAvatar(snapshot: DmPeerAvatarSnapshot, live: LivePeerAvatar | undefined): DmPeerAvatar {
  return live ?? { avatarUrl: snapshot.peerAvatarUrl ?? null };
}

// id -> record per directory list, built once per list (the stores replace the
// list on every load), so each avatar's lookup is a map read, not a scan.
const agentIndexes = new WeakMap<readonly Agent[], Map<string, Agent>>();
const memberIndexes = new WeakMap<readonly ServerMember[], Map<string, ServerMember>>();

function indexed<T>(cache: WeakMap<readonly T[], Map<string, T>>, list: readonly T[], idOf: (entry: T) => string): Map<string, T> {
  let index = cache.get(list);
  if (!index) {
    index = new Map(list.map((entry) => [idOf(entry), entry]));
    cache.set(list, index);
  }
  return index;
}

/** The live agent's avatar for an agent peer the directory knows, else undefined. */
function liveAgentAvatar(snapshot: DmPeerAvatarSnapshot, agents: readonly Agent[]): LivePeerAvatar | undefined {
  if (snapshot.peerType !== "agent" || !snapshot.peerId) return undefined;
  const agent = indexed(agentIndexes, agents, (entry) => entry.id).get(snapshot.peerId);
  return agent ? { avatarUrl: resolveAgentDmProfileSource(agent).avatarUrl } : undefined;
}

/** The live member's avatar for a person peer the member list knows, else undefined. */
function liveMemberAvatar(snapshot: DmPeerAvatarSnapshot, members: readonly ServerMember[]): LivePeerAvatar | undefined {
  if (snapshot.peerType === "agent" || !snapshot.peerId) return undefined;
  const member = indexed(memberIndexes, members, (entry) => entry.userId).get(snapshot.peerId);
  return member ? { avatarUrl: member.avatarUrl ?? null } : undefined;
}

/** `resolveDmPeerAvatar` against directory lists a caller already holds (the agents and server members stores' lists). */
export function resolveDmPeerAvatarFromDirectory(
  snapshot: DmPeerAvatarSnapshot,
  agents: readonly Agent[],
  members: readonly ServerMember[],
): DmPeerAvatar {
  return resolveDmPeerAvatar(snapshot, liveAgentAvatar(snapshot, agents) ?? liveMemberAvatar(snapshot, members));
}

/**
 * `resolveDmPeerAvatar` against the live stores. The selectors return only
 * the rendered fields (compared shallowly), so a directory reload re-renders
 * an avatar only when its own peer's face changed.
 */
export function useDmPeerAvatar(snapshot: DmPeerAvatarSnapshot): DmPeerAvatar {
  const { peerType, peerId } = snapshot;
  const agent = useAgentStore(useShallow((s) => liveAgentAvatar({ peerType, peerId }, s.agents)));
  const member = useServerStore(useShallow((s) => liveMemberAvatar({ peerType, peerId }, s.members)));
  return resolveDmPeerAvatar(snapshot, agent ?? member);
}
