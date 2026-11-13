import DesktopAppLinkBanner from "./DesktopAppLinkBanner";
import OpenInAppOffer from "./OpenInAppOffer";
import { usePageLandingLifetime } from "./deepLinksFlag";

/**
 * Deep links v1: the open-in-app offers, in a frame's two strips: the
 * workspace's (ShellFrame's `topStrip` and `bottomStrip`, from MainLayout)
 * and, signed out, the sign-in page's at a workspace address (AuthBrandShell's,
 * from auth/SignInPage). A browser that landed on a Raft address from outside
 * may offer Raft Desktop (frame c, a computer) or the Raft app (frame b, a
 * phone). They are about the window, not one conversation, so they show on
 * any workspace page: a channel, the Tasks page, a phone's Home.
 *
 * - `top`: the Raft Desktop banner, across the window under the top bar.
 * - `bottom`: the phone's row, at the bottom within thumb reach, directly
 *   above whatever holds the bottom of the page: the tab bar here, or the
 *   composer through the slot in its footer (openInAppRowSlots.ts).
 *
 * At most one shows (a computer or a phone), each only for an address its app
 * opens (utils/appClaimedPath.ts) and only while the landed page is on
 * screen: the top one, always mounted, reports where the app is, and the
 * landing is spent once the person goes elsewhere (utils/pageLanding.ts). A
 * message link that can't be shown spends it too (MessageLinkUnavailable).
 * An offer answered on the sign-in page is not made again by the workspace
 * that loads after it.
 */
export function OpenInAppOffers({ slot }: { slot: "top" | "bottom" }) {
  return slot === "top" ? <OpenInAppTopOffer /> : <OpenInAppOffer />;
}

function OpenInAppTopOffer() {
  usePageLandingLifetime();
  return <DesktopAppLinkBanner />;
}
