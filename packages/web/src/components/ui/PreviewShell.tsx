import { Card } from "@botiverse/raft-ui";
import type { ReactNode } from "react";

/**
 * Canonical "subtle preview surface" skin (route B, locked by stdrc 2026-05-16
 * #proj-theme:441c8b2b: a hairline, the card surface, no shadow, hover adds a
 * faint wash). This is the ONE place the preview-card skin lives — surfaces
 * that preview another message route their outer wrapper through
 * `<PreviewShell>` so hover state stays aligned (stdrc 2026-05-22
 * #proj-theme:441c8b2b 7d19c377 / 4365db5a — direct component reuse, not just
 * a shared border fragment).
 *
 * Raft Design System: a preview is content, not a control — the card surface
 * (`bg-layer-card`), a hairline (`line`), the container radius from raft-ui's
 * Card, never an ink line or a lift. A preview is a card people read, so
 * hover lays the subtle tier over the surface (`overlay-subtle`) and press
 * the medium tier (`overlay-medium`), like every clickable thing (Raft
 * Design System › States › Hover and press); the card keeps its fill.
 *
 * Layout is caller-supplied via `className`: PreviewShell only owns the
 * polymorphic root + skin tokens. QuotedMessageCard passes `group w-full
 * text-left` for the block-preview case.
 */

/** Static border recipe only — exported for any future surface that wants
 *  the border tokens without the full bg + hover-bg skin. */
export const PREVIEW_SHELL_BORDER = "border border-line-hairline";

/** Full default skin: hairline + card surface + explicitly NO shadow. */
export const PREVIEW_SHELL_SKIN = `${PREVIEW_SHELL_BORDER} bg-layer-card shadow-none`;

/** The subtle tier on hover and the medium tier on press: only a preview that
 *  is a button reacts like one. */
const PREVIEW_SHELL_PRESS = "hover:overlay-subtle active:overlay-medium";

/** Muted / unavailable variant — the sunken fill with ink-3 text: the message
 *  it pointed at is gone, so there is nothing to lift on hover. */
export const PREVIEW_SHELL_SKIN_MUTED =
  "border border-line-hairline bg-fill-muted text-foreground-hint shadow-none";

export type PreviewShellVariant = "default" | "muted";

export interface PreviewShellProps {
  variant?: PreviewShellVariant;
  /** Click → renders a polymorphic <button>; otherwise a <div>. */
  onClick?: () => void;
  /** Layout + any per-callsite overrides. Appended AFTER the skin so callers
   *  can override individual tokens via Tailwind's `!` important modifier. */
  className?: string;
  "data-testid"?: string;
  title?: string;
  "aria-busy"?: "true" | "false";
  children: ReactNode;
}

/**
 * Polymorphic root + skin for the canonical preview surface. Layout is
 * caller-owned (passed via `className`).
 */
export default function PreviewShell({
  variant = "default",
  onClick,
  className,
  children,
  ...rest
}: PreviewShellProps) {
  const Root = onClick ? "button" : "div";
  const skin = variant === "muted" ? PREVIEW_SHELL_SKIN_MUTED : PREVIEW_SHELL_SKIN;
  // A clickable preview is reachable by keyboard: the shared DS focus ring.
  const focus = onClick ? " outline-none focus-visible:shadow-focus" : "";
  const press = onClick && variant !== "muted" ? ` ${PREVIEW_SHELL_PRESS}` : "";
  return (
    <Card
      render={<Root />}
      {...(onClick ? { type: "button" as const, onClick } : {})}
      {...rest}
      className={`${skin}${press}${focus}${className ? ` ${className}` : ""}`}
    >
      {children}
    </Card>
  );
}
