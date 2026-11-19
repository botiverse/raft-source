import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/**
 * Where the Login with Raft setup (pages/HumanLoginSetupPage.tsx) reads its
 * request from and sends its answer to. On the page it is the address bar:
 * `window.location.search` in, `window.location.assign` out. In Raft Desktop,
 * for a page of the built-in browser, the same setup is shown in a sheet in
 * the app's own window (features/desktopBrowserSignIn): the request comes
 * from the shell (the query Raft's server answered with) and the answer goes
 * back to it, which loads it in the tab that asked.
 */
export interface LoginSetupHost {
  /** The setup address's query (`?flow=oidc&client_id=…`). */
  search: string;
  /** On to the App: its return address with the code, or with the error it is owed. */
  deliver(url: string): void;
  /**
   * In a sheet: the setup as the parts of the raft-ui Dialog it is rendered in (EmbeddedLoginSetup.tsx: the App's
   * name as the title, the facts in the scrolling body, Cancel and the approving button in the footer), without the
   * page's header, side card, in-app links or standing explanations.
   */
  embedded: boolean;
  /** In a sheet: what the host says first in the body (where the answer goes). */
  notice?: ReactNode;
  /** The Server to pick first when the App is ready or installable there; the person can change it. */
  preferredServerId?: string | null;
  /** Sent with the authorization, for its audit event only (`desktop_browser`). */
  source?: "desktop_browser";
  /**
   * Only the App as registered with this very return address is shown: a
   * Server whose lookup names another return address reads as one where the
   * App is not available, so its name and icon are never shown for a request
   * that would not be answered there.
   */
  registeredReturnOnly?: boolean;
  /**
   * The buttons that approve take no press for this long after they could
   * first be pressed, and again after the window regains the focus
   * (useApproveLock.ts). Unset: never locked.
   */
  approveAfterMs?: number;
}

const PAGE_HOST: LoginSetupHost = {
  get search() {
    return window.location.search;
  },
  deliver: (url) => window.location.assign(url),
  embedded: false,
};

export const LoginSetupHostContext = createContext<LoginSetupHost>(PAGE_HOST);

export function useLoginSetupHost(): LoginSetupHost {
  return useContext(LoginSetupHostContext);
}
