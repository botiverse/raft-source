import { Button } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import RaftBrandLockup from "../../components/brand/RaftBrandLockup";
import { useAuthStore } from "../../store/authStore";

// DS Button drawn on a link, so it stays a link for assistive tech.
const GHOST_LINK_BUTTON_CLASS = "inline-flex h-8 items-center rounded-control px-2.5 text-footnote font-bold text-foreground no-underline outline-none hover:bg-fill-medium active:bg-fill-medium focus-visible:shadow-focus";

/** The setup page's header: "Login with [Raft]", then Back and Log Out. */
export function LoginSetupHeader() {
  const { formatMessage } = useIntl();
  const logout = useAuthStore((s) => s.logout);
  const handleLogout = useCallback(() => logout(), [logout]);
  return (
    <header className="border-b border-line-seam bg-layer-canvas">
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
        {/* The logo is the sentence's "Raft" (role="img", named Raft), where
            each language puts it: "Login with [Raft]", 「使用 [Raft] 登录」,
            "[Raft] でログイン". */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-footnote font-bold text-foreground-hint sm:gap-2 sm:text-subhead" data-testid="login-setup-heading">
          {formatMessage({ id: "pages.humanLogin.loginWith" }, {
            raft: <RaftBrandLockup key="raft" className="h-5 w-auto shrink-0 sm:h-6" adaptToDarkMode />,
          })}
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-4">
          <a className={GHOST_LINK_BUTTON_CLASS} href="/">{formatMessage({ id: "pages.humanLogin.back" })}</a>
          <Button onClick={handleLogout} size="md" variant="outline">
            {formatMessage({ id: "pages.humanLogin.logOut" })}
          </Button>
        </div>
      </div>
    </header>
  );
}
