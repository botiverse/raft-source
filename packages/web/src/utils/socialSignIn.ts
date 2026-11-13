// What a social sign-in button does. In Raft Desktop the web runs the loopback
// flow itself (desktopOAuth.ts: the provider page opens in the system browser);
// in a browser the page goes to the server's start URL, as before.

import type { IntlShape } from "react-intl";
import type { SocialAuthProviderId } from "../hooks/useAuthProviders";
import { getDesktopAuth, runDesktopSocialSignIn } from "./desktopOAuth";
import { buildSocialAuthStartUrl } from "./socialAuth";


export function startSocialSignIn(provider: SocialAuthProviderId, returnTo: string, formatMessage: IntlShape["formatMessage"]): void {
  if (getDesktopAuth()) {
    void runDesktopSocialSignIn(provider, formatMessage);
    return;
  }
  window.location.href = buildSocialAuthStartUrl(provider, returnTo);
}
