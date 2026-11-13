import { useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import RaftBrandLockup from "../brand/RaftBrandLockup";
import { AUTH_BRAND_TOP_BAR_CLASS, AuthBrandTopInset } from "../brand/AuthBrandShell";
import { useHostTitleBar } from "../topbar/overlayTitleBar";
import { useAuthStore } from "../../store/authStore";
import SignedInAs from "./SignedInAs";
import { ScrollArea, TextLink } from "@botiverse/raft-ui";

// Fills the space it is given (#root's column, or the desktop's row under its
// title strip), not the viewport: under a title strip a 100vh minimum pushed
// the page's bottom 48px out of the window, where #root clips it.
export const ONBOARDING_CREATE_SHELL_CLASS =
  "flex min-h-0 w-full flex-1 flex-col bg-layer-canvas font-display safe-bottom";

export const ONBOARDING_CREATE_GRID_CLASS =
  "grid w-full flex-1 lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]";

// The form column scrolls in a raft-ui ScrollArea (the <section>). Its gutters
// layer is the column's zero-height first row, so the form centres with auto
// margins (my-auto) rather than justify-center, which would move the gutters
// down with it and cut off the top of a form taller than the window.
export const ONBOARDING_CREATE_FORM_PANEL_CLASS =
  "relative flex w-full flex-col bg-layer-canvas px-6 py-10 sm:px-10 lg:border-r lg:border-line-seam";

// The brand pane is the onboarding's yellow frame (DS ScreenOnboarding): the
// frame colour with a halftone behind the tilted preview stickers. In dark the
// frame token goes neutral, the stickers keep their colours.
export const ONBOARDING_CREATE_DOT_GRID_CLASS =
  "absolute inset-0 opacity-70 [background-image:radial-gradient(var(--line-seam)_1.5px,transparent_1.5px)] [background-size:14px_14px]";

// Narrow screens render the onboarding flow as a plain auth form page — the
// same yellow brand bar as sign in / sign up, and no demo pane. Wide screens
// drop the bar and move the brand mark into the top-left of the form column.
export function OnboardingBrandBar() {
  // A title-bar shell (the desktop app, the installed web app under the Window
  // Controls Overlay): the window's own top strip carries the RAFT logo (task #85), so
  // this brand bar would stack a second signal-colored bar under it. Suppress there.
  const hostTitleBar = useHostTitleBar();
  if (hostTitleBar) return null;
  return (
    <div className={`${AUTH_BRAND_TOP_BAR_CLASS} lg:hidden`}>
      <RaftBrandLockup className="h-5 w-auto" />
    </div>
  );
}

// The lockup sets its own `inline-flex`, which would beat a `hidden` passed into
// it, so the breakpoint gate lives on a wrapper.
export function OnboardingFormBrandMark() {
  return (
    <div className="absolute left-6 top-8 hidden sm:left-10 lg:block">
      <RaftBrandLockup className="h-5 w-auto" />
    </div>
  );
}

// Every onboarding page is reached with a live session, so each one states that
// session the same way and offers the same way out — both at the foot of the
// form. The shell owns it so neither can drift page to page.
export function OnboardingSessionFooter() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((state) => state.user);
  const loading = useAuthStore((state) => state.loading);
  const logout = useAuthStore((state) => state.logout);
  const handleLogout = useCallback(() => {
    void logout();
  }, [logout]);

  if (!user) return null;

  return (
    <p className="text-center text-footnote text-foreground-muted" data-testid="onboarding-session-footer">
      <SignedInAs user={user} nameClassName="font-normal" suffix=". " />
      <TextLink variant="strong" onClick={handleLogout} disabled={loading}>
        {formatMessage({ id: "pages.serverSelector.logOut" })}
      </TextLink>
    </p>
  );
}

export function OnboardingCreateDotPane({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <aside
      className="relative hidden overflow-hidden bg-layer-frame text-foreground-on-frame lg:flex"
      data-testid={testId}
    >
      <div className={ONBOARDING_CREATE_DOT_GRID_CLASS} aria-hidden="true" />
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-6 xl:p-8">
        {children}
      </div>
    </aside>
  );
}

export default function OnboardingCreateShell({
  children,
  preview,
  previewTestId,
  showSessionFooter = true,
}: {
  children: ReactNode;
  preview: ReactNode;
  previewTestId?: string;
  // Dev/fixture previews render without a real session, so they opt out.
  showSessionFooter?: boolean;
}) {
  return (
    <div className={ONBOARDING_CREATE_SHELL_CLASS}>
      {/* The status-bar strip is the frame, continuing the brand bar (and the
          frame pane beside the form at lg). */}
      <AuthBrandTopInset />
      <OnboardingBrandBar />
      <div className={ONBOARDING_CREATE_GRID_CLASS}>
        <ScrollArea render={<section />} className={ONBOARDING_CREATE_FORM_PANEL_CLASS}>
          <OnboardingFormBrandMark />
          <div className="m-auto flex w-full max-w-md flex-col gap-4">
            {children}
            {showSessionFooter ? <OnboardingSessionFooter /> : null}
          </div>
        </ScrollArea>
        <OnboardingCreateDotPane testId={previewTestId}>{preview}</OnboardingCreateDotPane>
      </div>
    </div>
  );
}
