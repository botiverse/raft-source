import { useState } from "react";
import { User } from "lucide-react";
import { isHumanPixelAvatarUrl, isRaftUploadedHumanAvatarUrl } from "../../utils/humanAvatar";
import { HumanPixelAvatar } from "./HumanPixelAvatar";

interface PersonAvatarProps {
  /** The person's `avatarUrl`. Only an avatar Raft stores, or one they
   *  built (`pixel-human:v1:...`), is drawn. */
  avatarUrl?: string | null;
  /** Size of the User placeholder icon. */
  iconSize?: number;
}

/**
 * A person's face: their stored avatar, the pixel avatar they built, else the
 * User placeholder (also when the image fails to load). Any other `avatarUrl`
 * (an old social-provider picture) is ignored, and no third-party avatar
 * service is asked. No avatar at all stays the placeholder: nothing is made up.
 */
export function PersonAvatar({ avatarUrl, iconSize = 16 }: PersonAvatarProps) {
  const storedAvatarUrl = isRaftUploadedHumanAvatarUrl(avatarUrl) ? avatarUrl : null;
  // Load failure belongs to one URL: a new URL gets a fresh attempt.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (storedAvatarUrl && failedUrl !== storedAvatarUrl) {
    return (
      <img
        src={storedAvatarUrl}
        alt=""
        className="h-full w-full object-cover"
        onError={() => setFailedUrl(storedAvatarUrl)}
      />
    );
  }
  if (isHumanPixelAvatarUrl(avatarUrl)) {
    return <HumanPixelAvatar avatarUrl={avatarUrl} fallback={<User size={iconSize} />} />;
  }
  return <User size={iconSize} />;
}
