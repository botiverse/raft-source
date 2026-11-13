import { memo } from "react";
import type { ReactNode } from "react";
import { humanAvatarImageSrc, useHumanAvatarArt } from "./humanPixelAvatarArt";

/**
 * The avatar filling its frame (put it inside an AvatarSlot or raft-ui
 * Avatar). The whole picture at every size, scaled nearest-neighbour:
 * `image-rendering: pixelated` on the image, crisp edges in the SVG.
 * `fallback` shows if the art can't be loaded.
 */
export const HumanPixelAvatar = memo(function HumanPixelAvatar({
  avatarUrl,
  fallback = null,
}: {
  avatarUrl: string;
  fallback?: ReactNode;
}) {
  const { art, failed } = useHumanAvatarArt();
  if (failed) return <>{fallback}</>;
  const src = art ? humanAvatarImageSrc(avatarUrl, art) : null;
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className="size-full shrink-0 rounded-[2px]"
      style={{ imageRendering: "pixelated" }}
      data-human-pixel-avatar={avatarUrl}
    />
  );
});
