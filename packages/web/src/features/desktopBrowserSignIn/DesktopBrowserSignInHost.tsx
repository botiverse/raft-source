import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DesktopWebPreviewRaftSignInBridge } from "@botiverse/raft-shared";

import { lazyDialog } from "../../boot/deferredUi";
import { useAuthStore } from "../../store/authStore";
import {
  DESKTOP_BROWSER_RAFT_SIGN_IN_FLAG_KEY,
  prefetchServerFeatureFlags,
  readServerFeatureFlag,
  subscribeServerFeatureFlags,
} from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import { getDesktopBridge } from "../../utils/desktopBridge";
import { desktopBrowserSignInRequest, isRegisteredReturnAddress, lookUpRegisteredReturnAddresses } from "./desktopBrowserSignInRequest";
import type { DesktopBrowserSignInRequest } from "./desktopBrowserSignInRequest";

// Only a desktop shell with the feature on ever opens it (and it brings the whole setup page): not in the shell bundle.
const DesktopBrowserSignInSheet = lazyDialog(() => import("./DesktopBrowserSignInSheet").then((module) => ({ default: module.DesktopBrowserSignInSheet })));

const notOnServer = () => false;

/**
 * Whether desktop_browser_raft_sign_in_v0 is on for the Server, as the last
 * evaluation says. Not useServerFeatureFlag: that keeps a flag on for a
 * mounted reader after it is turned off, and this host is always mounted, so
 * turning the flag off would not reach it until the app restarted.
 */
function useSignInFlag(serverId: string | null): boolean {
  useEffect(() => {
    void prefetchServerFeatureFlags(serverId);
  }, [serverId]);
  const read = useCallback(() => readServerFeatureFlag(serverId, DESKTOP_BROWSER_RAFT_SIGN_IN_FLAG_KEY), [serverId]);
  return useSyncExternalStore(subscribeServerFeatureFlags, read, notOnServer);
}

interface ShownRequest extends DesktopBrowserSignInRequest {
  /** Who was signed in, and which Server showed, when it arrived. */
  accountId: string;
  serverId: string | null;
}

function SignInHost({ bridge }: { bridge: DesktopWebPreviewRaftSignInBridge }) {
  const accountId = useAuthStore((state) => state.user?.id ?? null);
  // Signed out for certain: the session was read and there is none (not "still loading", not "server unreachable").
  const signedOut = useAuthStore((state) => state.initialized && !state.user && !state.accessToken && !state.refreshToken);
  const serverId = useServerStore((state) => state.current?.id ?? null);
  const enabled = useSignInFlag(serverId);
  const [shown, setShown] = useState<ShownRequest | null>(null);
  /** The request whose App is being looked up before anything is shown, if any. */
  const checking = useRef<string | null>(null);

  // Listening before the shell is armed: no request can arrive unheard.
  useEffect(() => {
    // Not shown, and not by the person's choice: the shell ends it and its tab says Raft's sign-in was not available
    // there (`refuse`; a shell that predates it only ends it).
    const refuse = (requestId: string) => (bridge.refuse ? bridge.refuse(requestId) : bridge.cancel(requestId));
    const offRequest = bridge.onRequest((raw) => {
      const request = desktopBrowserSignInRequest(raw);
      const account = useAuthStore.getState().user?.id ?? null;
      if (!request || !account) {
        // Not shown (it would print a page's own text, or nobody is signed in): the shell forgets it.
        if (raw && typeof raw.requestId === "string") refuse(raw.requestId);
        return;
      }
      // One request at a time: the shell has ended the one before (`onClosed`), so only the newest is looked up.
      checking.current = request.requestId;
      const serverId = useServerStore.getState().current?.id ?? null;
      const serverIds = useServerStore.getState().servers.map((server) => server.id);
      // Before anything shows: the request must name the return address the App is registered with.
      void lookUpRegisteredReturnAddresses(request, serverIds).then((registered) => {
        // Ended by the shell, or replaced, while the App was looked up.
        if (checking.current !== request.requestId) return;
        checking.current = null;
        if (!isRegisteredReturnAddress(request.returnUrl, registered) || useAuthStore.getState().user?.id !== account) {
          // No sheet, no name: the shell forgets it, its tab says so and raises nothing for a while.
          refuse(request.requestId);
          return;
        }
        setShown({ ...request, accountId: account, serverId });
      });
    });
    const offClosed = bridge.onClosed((requestId) => {
      if (checking.current === requestId) checking.current = null;
      setShown((current) => (current?.requestId === requestId ? null : current));
    });
    return () => {
      offRequest();
      offClosed();
      checking.current = null;
    };
  }, [bridge]);

  // Whoever is signed in, with the flag on or off, and before arming: an account that follows another with no
  // signed-out state in between (on a Server where the flag is off it is never armed) must not find the apps of the
  // one before still signed in. The shell empties the browser's storage when its record names another account.
  useEffect(() => {
    if (accountId) bridge.account?.(accountId);
  }, [accountId, bridge]);

  useEffect(() => {
    if (!enabled || !accountId) return;
    bridge.arm(accountId);
    return () => bridge.disarm();
  }, [accountId, bridge, enabled]);

  // Every sign-out, whether or not the flag is on now: the shell empties the browser's storage if this feature ever served it.
  useEffect(() => {
    if (signedOut) bridge.signedOut();
  }, [bridge, signedOut]);

  const requestId = shown?.requestId ?? null;
  const handleResult = useCallback((url: string) => {
    if (requestId) bridge.complete(requestId, url);
    setShown(null);
  }, [bridge, requestId]);
  const handleClose = useCallback(() => {
    if (requestId) bridge.cancel(requestId);
    setShown(null);
  }, [bridge, requestId]);

  // A request raised for another account is never shown to this one (the shell has dropped it too).
  if (!shown || shown.accountId !== accountId) return null;
  return (
    <DesktopBrowserSignInSheet
      key={shown.requestId}
      request={shown}
      preferredServerId={shown.serverId}
      onResult={handleResult}
      onClose={handleClose}
    />
  );
}

/**
 * Raft Desktop: "Sign in with Raft" pressed on a page of the built-in browser
 * finishes here, without a second Raft sign-in (desktop_browser_raft_sign_in_v0).
 * Mounted once in the app. It tells the shell who is signed in (`account`,
 * whatever the flag says), when the feature is on for that account (`arm`)
 * and when nobody is signed in (`signedOut`), and
 * shows the consent sheet for each request the shell raises. In a browser, or
 * on a shell without `webPreview.raftSignIn`, it is nothing.
 */
export function DesktopBrowserSignInHost() {
  const bridge = getDesktopBridge()?.webPreview?.raftSignIn ?? null;
  return bridge ? <SignInHost bridge={bridge} /> : null;
}
