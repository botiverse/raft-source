/** A server a joint channel connects (a channel's `jointServers`). */
export interface ChannelJointServer {
  serverId: string;
  serverName: string;
  serverSlug: string;
  /** The server's logo for origin marks; null for a pending server or none. Absent from older servers. */
  serverAvatarUrl?: string | null;
  role: "host" | "participant" | null;
  status: "active" | "pending";
  isCurrentServer?: boolean;
  /** Free or paid as the joint's free-server cap counts it; absent from older servers. */
  plan?: "free" | "paid";
  /** Active servers: the channel's name on that server (names are per server). */
  channelName?: string;
}
