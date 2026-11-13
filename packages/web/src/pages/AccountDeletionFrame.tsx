/**
 * The frame of the pages that stand in for the app while an account deletion
 * is requested or pending (AccountDeletionGate): the sign-in page's, or, in
 * the App's in-app WebView (the host shell owns the title bar, embed.ts), the
 * content alone, scrolling, so the web's brand bar isn't drawn under the
 * native one. `AccountDeletionHeading` is their top (v7): a yellow sticker
 * with the page's icon, the title, and a line under it.
 */
import type { ReactNode } from "react";
import { ScrollArea } from "@botiverse/raft-ui";

import AuthPageFrame from "../components/auth/AuthPageFrame";
import { isHostShell } from "../embed";

export function AccountDeletionFrame({ children }: { children: ReactNode }) {
  if (!isHostShell()) return <AuthPageFrame>{children}</AuthPageFrame>;
  return (
    // raft-ui ScrollArea: the content alone scrolls; its padding is the content's.
    <ScrollArea className="min-h-0 flex-1 bg-layer-canvas" contentClassName="flex justify-center px-4 pb-6 pt-8 safe-bottom" data-embed-shell="host">
      <div className="w-full max-w-md">{children}</div>
    </ScrollArea>
  );
}

export function AccountDeletionHeading({ icon, title, children }: {
  /** A 28px Lucide icon. */
  icon: ReactNode;
  title: ReactNode;
  /** The line under the title. */
  children?: ReactNode;
}) {
  return (
    <div className="mb-5 text-center">
      {/* The `you` sticker: yellow in every theme, ink edge and icon (DS: the location tile's look, at 56px). */}
      <span
        aria-hidden
        className="mx-auto mb-5 flex size-14 items-center justify-center rounded-sticker border-[1.5px] border-sticker-ink bg-you text-sticker-ink shadow-sticker [&_svg]:size-7"
      >
        {icon}
      </span>
      {/* Balanced, so a phone never leaves the last word on a line of its own. */}
      <h1 className="text-title text-balance text-foreground">{title}</h1>
      {children ? <p className="mt-2 text-subhead text-foreground-muted">{children}</p> : null}
    </div>
  );
}
