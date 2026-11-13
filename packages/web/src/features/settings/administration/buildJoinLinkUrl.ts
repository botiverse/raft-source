import { shareableWebOrigin } from "../../../utils/desktopShell";

// Shareable web origin, not window.location.origin: the desktop shell's origin
// is `app://raft`, which produces an unopenable invite link. Web is unchanged.
export function buildJoinLinkUrl(token: string) {
  return `${shareableWebOrigin()}/join/${token}`;
}
