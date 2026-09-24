import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import RaftBrandLockup from "../brand/RaftBrandLockup";
import { AUTH_BRAND_TOP_BAR_CLASS } from "../brand/AuthBrandShell";
import { useAuthStore } from "../../store/authStore";
import TextLink from "../ui/TextLink";
import SignedInAs from "./SignedInAs";

export const ONBOARDING_CREATE_SHELL_CLASS =
  "flex min-h-screen w-full flex-col bg-white font-display safe-top safe-bottom";

export const ONBOARDING_CREATE_GRID_CLASS =
  "grid w-full flex-1 lg:grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]";

export const ONBOARDING_CREATE_FORM_PANEL_CLASS =
  "relative flex w-full flex-col justify-center overflow-y-auto bg-white px-6 py-10 sm:px-10 lg:border-r-2 lg:border-black";

export const ONBOARDING_CREATE_DOT_GRID_CLASS =
  "absolute inset-0 opacity-60 [background-image:radial-gradient(#111_1px,transparent_1px)] [background-size:16px_16px]";

// Narrow screens render the onboarding flow as a plain auth form page — the
// same yellow brand bar as sign in / sign up, and no demo pane. Wide screens
// drop the bar and move the brand mark into the top-left of the form column.
export function OnboardingBrandBar() {
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

  if (!user) return null;

  return (
    <p className="text-center text-sm text-black/60" data-testid="onboarding-session-footer">
      <SignedInAs user={user} nameClassName="font-normal" suffix=". " />
      <TextLink variant="muted" onClick={() => logout()} disabled={loading}>
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
      className="relative hidden overflow-hidden bg-brutal-cream lg:flex"
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
      <OnboardingBrandBar />
      <div className={ONBOARDING_CREATE_GRID_CLASS}>
        <section className={ONBOARDING_CREATE_FORM_PANEL_CLASS}>
          <OnboardingFormBrandMark />
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            {children}
            {showSessionFooter ? <OnboardingSessionFooter /> : null}
          </div>
        </section>
        <OnboardingCreateDotPane testId={previewTestId}>{preview}</OnboardingCreateDotPane>
      </div>
    </div>
  );
}
