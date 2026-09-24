import type { ReactNode } from "react";
import RaftBrandLockup from "./RaftBrandLockup";

export const AUTH_BRAND_SHELL_CLASS =
  "min-h-0 flex-1 overflow-y-auto bg-white font-display safe-top safe-bottom";

export const AUTH_BRAND_STACK_CLASS =
  "flex min-h-full w-full flex-col";

export const AUTH_BRAND_TOP_BAR_CLASS =
  "flex h-panel-header shrink-0 items-center border-b-2 border-black bg-soft-signal px-4 sm:px-6 md:px-8";

const AUTH_BRAND_CONTENT_CLASS =
  "flex min-h-0 flex-1 items-center justify-center px-5 pb-10 pt-10 sm:px-8 sm:pb-14 sm:pt-14";

export function AuthBrandTopBar() {
  return (
    <div className={AUTH_BRAND_TOP_BAR_CLASS}>
      {/* #123: the bar itself does NOT opt out of browser auto/force-dark, so under
          force-dark it darkens to a dark brand bar (product goal: no bright-yellow bar
          in dark). We scope `color-scheme: only light` to just the logo subtree — the
          RAFT wordmark is an SVG image that auto-dark would otherwise invert into an
          illegible smear; this opt-out keeps its glyphs crisp on the dark bar, while
          normal light mode still renders the original yellow bar + dark wordmark. Only
          the logo opts out; bar, content and body keep a dark-capable scheme. Verified
          on real Blink (cell B of the 2x2 matrix). */}
      <RaftBrandLockup className="h-5 w-auto [color-scheme:only_light]" />
    </div>
  );
}

export function AuthBrandIntro({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-5 text-center">
      <img
        src="/brand/raft-icon.svg"
        alt=""
        className="mx-auto mb-4 size-9"
        aria-hidden="true"
      />
      <h1 className="text-xl font-bold">{title}</h1>
      {description ? (
        <p className="mt-2 text-sm text-black/60">{description}</p>
      ) : null}
      {children}
    </div>
  );
}

export default function AuthBrandShell({
  children,
  maxWidthClass = "max-w-md",
}: {
  children: ReactNode;
  maxWidthClass?: string;
}) {
  return (
    <div className={AUTH_BRAND_SHELL_CLASS}>
      <div className={AUTH_BRAND_STACK_CLASS}>
        <AuthBrandTopBar />
        <div className={AUTH_BRAND_CONTENT_CLASS}>
          <div className={`w-full ${maxWidthClass}`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
