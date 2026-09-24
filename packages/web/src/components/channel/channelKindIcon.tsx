import { GitBranch, Hash, Lock } from "lucide-react";
import type { Channel } from "../../store/channelStore";

export const CHANNEL_KIND_ICON_SIZE = 14;

export function ChannelKindIcon({
  type,
  size = CHANNEL_KIND_ICON_SIZE,
  className,
}: {
  type: Channel["type"];
  size?: number;
  className?: string;
}) {
  if (type === "private") return <Lock size={size} className={className} />;
  if (type === "joint") return <GitBranch size={size} className={className} />;
  if (type === "channel") return <Hash size={size} className={className} />;
  return null;
}
