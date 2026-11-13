import type { ReactElement } from "react";
import AvatarSlot from "../ui/AvatarSlot";
import type { AvatarSlotProps } from "../ui/AvatarSlot";
import { useDmPeerAvatar } from "./dmPeerAvatar";
import type { DmPeerAvatarSnapshot } from "./dmPeerAvatar";

/**
 * A DM peer's face, read from the live agent / member directory and falling
 * back to the DM's snapshot (`useDmPeerAvatar`), so an avatar set or reset
 * elsewhere shows here at once, without a reload.
 */
export function DmPeerAvatarSlot({ peerType, peerId, peerAvatarUrl, context, badge }: DmPeerAvatarSnapshot & {
  context: AvatarSlotProps["context"];
  badge?: ReactElement;
}) {
  const { avatarUrl } = useDmPeerAvatar({ peerType, peerId, peerAvatarUrl });
  return peerType === "agent" ? (
    <AvatarSlot context={context} type="agent" agentAvatarUrl={avatarUrl} badge={badge} />
  ) : (
    <AvatarSlot
      context={context}
      type="human"
      humanAvatarUrl={avatarUrl}
      badge={badge}
    />
  );
}
