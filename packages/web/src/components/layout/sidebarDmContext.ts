import type { Channel } from "../../store/channelStore";

export type SidebarDmContextTarget =
  | { type: "agent"; id: string }
  | { type: "human"; id: string }
  | { type: "dm"; id: string };

export function getSidebarDmContextTarget(
  dm: Channel,
  peers: {
    agentIds: ReadonlySet<string>;
    humanIds: ReadonlySet<string>;
  },
): SidebarDmContextTarget {
  if (dm.peerType === "agent" && dm.peerId && peers.agentIds.has(dm.peerId)) {
    return { type: "agent", id: dm.peerId };
  }

  if (dm.peerType !== "agent" && dm.peerId && peers.humanIds.has(dm.peerId)) {
    return { type: "human", id: dm.peerId };
  }

  return { type: "dm", id: dm.id };
}
