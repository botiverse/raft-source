import { useLocation } from "react-router-dom";
import { OpenInAppOffers } from "../deeplinks/OpenInAppOffers";
import LoginPage from "./LoginPage";
import type { LoginPageProps } from "./LoginPage";

/**
 * The sign-in page a signed-out person gets at the address they opened
 * (App.tsx). Deep links v1: someone who taps a Raft link in a chat app or
 * pastes it into a browser is usually signed out on the web and signed in to
 * the app, and what they need is "go to the app", not another sign-in. So at
 * a workspace address (`/s/…`, where the workspace itself would make the
 * offers once signed in) the page carries the same open-in-app offers
 * (OpenInAppOffers): a computer's banner under the brand bar, a phone's row
 * at the bottom. They hand over the landed address, by the same rules: the
 * landing (utils/pageLanding.ts), the addresses an app opens
 * (utils/appClaimedPath.ts), this browser's preference and quiet time.
 * Signed out their gate is the before-login flag (deepLinksFlag.ts).
 *
 * Nowhere else: sign-up, password reset, an invite and sign-in at any other
 * address have no offer.
 */
export function SignInPage(props: LoginPageProps) {
  const { pathname } = useLocation();
  const offers = pathname.startsWith("/s/");
  return (
    <LoginPage
      {...props}
      topStrip={offers ? <OpenInAppOffers slot="top" /> : undefined}
      bottomStrip={offers ? <OpenInAppOffers slot="bottom" /> : undefined}
    />
  );
}
