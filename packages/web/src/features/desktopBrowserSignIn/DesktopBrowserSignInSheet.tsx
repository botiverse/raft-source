import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { Dialog, DialogContent } from "@botiverse/raft-ui";

import Banner from "../../components/ui/Banner";
import { useSecondFactorStepUpStore } from "../../components/settings/secondFactorStepUp";
import HumanLoginSetupPage from "../../pages/HumanLoginSetupPage";
import { LoginSetupHostContext } from "../login-with-raft/loginSetupHost";
import type { LoginSetupHost } from "../login-with-raft/loginSetupHost";
import { APPROVE_AFTER_MS } from "./desktopBrowserSignInRequest";
import type { DesktopBrowserSignInRequest } from "./desktopBrowserSignInRequest";

/**
 * Raft Desktop: Login with Raft for a page of the built-in browser, in the
 * app's own window (desktop_browser_raft_sign_in_v0). A page cannot draw
 * here: the sheet is a raft-ui Dialog over the whole window, and while it is
 * open the browser's native view is hidden behind a still of the page under
 * the scrim (webPreviewOverlays.ts), so the page can neither cover the sheet
 * nor take a press meant for it.
 *
 * What it shows is Raft's: the Login with Raft setup itself, as the dialog's
 * parts (features/login-with-raft/EmbeddedLoginSetup.tsx). The title is the
 * App's registered name from the lookup; the body, which scrolls in a short
 * window, starts with the host the answer will go to, then the account, the
 * App, the Server and what is asked for, fed the request Raft's server
 * answered with; the footer, always in view, holds Cancel and the setup's own
 * approving button. Nothing is approved without a press on that button, every
 * time, and not in the first APPROVE_AFTER_MS it can be pressed, nor in the
 * first after the window regains the focus (useApproveLock.ts: the setup
 * keeps the lock, since only it knows when its button appears); "Verify it's
 * you" opens over it as on the page. Only the App registered with the
 * request's own return address is shown (the host checks it before the sheet
 * opens).
 *
 * Closing (×, Cancel, Esc) cancels the request. The focus starts on ×, the
 * first control in the dialog, so Enter or Space on a sheet that has only just
 * appeared cancels. A press outside does not close it
 * (the scrim covers a web page the person may be trying to click), and
 * nothing closes it while "Verify it's you" is open over it.
 */
export function DesktopBrowserSignInSheet({ request, preferredServerId, onResult, onClose }: {
  request: DesktopBrowserSignInRequest;
  /** The Server of the conversation the browser sits beside. */
  preferredServerId: string | null;
  /** The address the setup would have gone to: the App's return address with the code, or with its error. */
  onResult: (url: string) => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const { returnHost } = request;
  const host = useMemo<LoginSetupHost>(() => ({
    search: request.setupSearch,
    deliver: onResult,
    embedded: true,
    notice: (
      <Banner intent="info" density="sm" data-testid="desktop-browser-sign-in-notice">
        {formatMessage(
          { id: "desktopBrowserSignIn.notice" },
          { host: returnHost, b: (chunks) => <strong key="host" className="break-all">{chunks}</strong> },
        )}
      </Banner>
    ),
    preferredServerId,
    source: "desktop_browser",
    registeredReturnOnly: true,
    approveAfterMs: APPROVE_AFTER_MS,
  }), [formatMessage, onResult, preferredServerId, request.setupSearch, returnHost]);
  const handleOpenChange = useCallback((open: boolean) => {
    if (open || useSecondFactorStepUpStore.getState().pending) return;
    onClose();
  }, [onClose]);
  return (
    <Dialog open disablePointerDismissal onOpenChange={handleOpenChange}>
      <DialogContent size="lg" data-testid="desktop-browser-sign-in">
        <LoginSetupHostContext.Provider value={host}>
          <HumanLoginSetupPage />
        </LoginSetupHostContext.Provider>
      </DialogContent>
    </Dialog>
  );
}
