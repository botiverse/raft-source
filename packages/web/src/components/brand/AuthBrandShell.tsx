import type { ReactNode } from "react";
import { ScrollArea } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import RaftBrandLockup from "./RaftBrandLockup";
import { useHostTitleBar } from "../topbar/overlayTitleBar";
import { useSystemBarSurface } from "../../theme/systemBarColor";

// Raft Design System: the auth screen is white paper under the brand frame —
// the top bar is the frame (yellow in light, the neutral #0d0d0b frame in
// dark, with the seam under it), the content is paper.
export const AUTH_BRAND_FRAME_CLASS =
  "flex min-h-0 flex-1 flex-col bg-layer-canvas font-sans text-foreground";

// The status-bar strip above the brand bar is the frame too. It sits outside
// the scroller, so it stays put while the form scrolls under it.
export const AUTH_BRAND_TOP_INSET_CLASS =
  "h-[env(safe-area-inset-top,0px)] shrink-0 bg-layer-frame";

// The scroller: a raft-ui ScrollArea (its overlay scrollbar shows while the
// page is pointed at or scrolls, as on every page scroller). The stack is its
// content, at least as tall as the view, with the bottom safe-area room.
export const AUTH_BRAND_SHELL_CLASS =
  "min-h-0 flex-1";

export const AUTH_BRAND_STACK_CLASS =
  "flex min-h-full w-full flex-col safe-bottom";

export const AUTH_BRAND_TOP_BAR_CLASS =
  "flex h-panel-header shrink-0 items-center border-b border-line-seam bg-layer-frame text-foreground-on-frame px-4 sm:px-6 md:px-8";

// Centred with auto margins, not `items-center`: when the card is taller than
// the viewport, align-items centring pushes its top (the logo and title) above
// the scroller's start, where it cannot be scrolled to. An auto margin drops
// to zero instead, so the card starts at the top padding and scrolls; when it
// fits it sits centred as before. `flex-auto` (not `min-h-0 flex-1`) keeps the
// row at least as tall as the card.
const AUTH_BRAND_CONTENT_CLASS =
  "flex flex-auto justify-center px-5 pb-10 pt-10 sm:px-8 sm:pb-14 sm:pt-14";

/** The frame-coloured safe-area strip; the system bar follows the frame. */
export function AuthBrandTopInset() {
  useSystemBarSurface("frame");
  return <div aria-hidden="true" className={AUTH_BRAND_TOP_INSET_CLASS} data-testid="auth-brand-top-inset" />;
}

// The logo goes home (app.raft.build), like most sites; a full load, so a
// half-finished sign-in such as /login/app leaves no state behind.
function AuthBrandHomeLink() {
  const { formatMessage } = useIntl();
  return (
    <a
      href="/"
      aria-label={formatMessage({ id: "brand.productName" })}
      className="-m-1.5 inline-flex items-center rounded-control p-1.5 outline-none focus-visible:shadow-focus pointer-coarse:-m-3 pointer-coarse:p-3"
    >
      <RaftBrandLockup className="h-5 w-auto [color-scheme:only_light]" />
    </a>
  );
}

export function AuthBrandTopBar() {
  // In a shell whose top row is the window's title bar (the desktop app, the
  // installed web app under the Window Controls Overlay) the window's own top strip
  // (StandInTitleBar) already carries the RAFT logo + the drag region, so rendering
  // this brand bar too produced two stacked signal-colored bars (task #85). Suppress
  // it there; a browser tab and a standalone installed app keep their brand bar.
  const hostTitleBar = useHostTitleBar();
  if (hostTitleBar) return null;
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
      <AuthBrandHomeLink />
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
        className="mx-auto mb-4 size-9 dark:invert"
        aria-hidden="true"
      />
      <h1 className="text-title text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2 text-subhead text-foreground-muted">{description}</p>
      ) : null}
      {children}
    </div>
  );
}

export default function AuthBrandShell({
  children,
  maxWidthClass = "max-w-md",
  topStrip,
  bottomStrip,
}: {
  children: ReactNode;
  maxWidthClass?: string;
  /** A strip about the whole window, across its width under the brand bar (the open-in-app banner on a sign-in page). */
  topStrip?: ReactNode;
  /** A strip at the window's bottom, in flow under the scroller, so it never covers the form (the open-in-app row). */
  bottomStrip?: ReactNode;
}) {
  return (
    <div className={AUTH_BRAND_FRAME_CLASS}>
      <AuthBrandTopInset />
      <ScrollArea className={AUTH_BRAND_SHELL_CLASS} contentClassName={AUTH_BRAND_STACK_CLASS} data-testid="auth-brand-scroller">
        <AuthBrandTopBar />
        {topStrip}
        <div className={AUTH_BRAND_CONTENT_CLASS}>
          <div className={`my-auto w-full ${maxWidthClass}`}>
            {children}
          </div>
        </div>
      </ScrollArea>
      {bottomStrip}
    </div>
  );
}
