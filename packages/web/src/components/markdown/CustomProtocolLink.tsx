import { useCallback, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  MarkdownLink,
} from "@botiverse/raft-ui";
import { STANDARD_EXTERNAL_LINK_SCHEMES } from "@botiverse/raft-shared";

const STANDARD_LINK_PROTOCOLS = new Set(STANDARD_EXTERNAL_LINK_SCHEMES);

/**
 * True when an href carries a non-standard scheme (obsidian:// and friends)
 * that hands off to an external application instead of navigating in the
 * browser. Scheme-relative and scheme-less hrefs are ordinary links.
 */
export function isCustomProtocolHref(href: string | undefined | null): href is string {
  if (!href) return false;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (!match) return false;
  return !STANDARD_LINK_PROTOCOLS.has(match[1].toLowerCase());
}

/**
 * Message-body link with a custom protocol (obsidian:// and friends — the
 * sanitize allowlist in `markdownSanitizeSchema.ts` decides which schemes can
 * reach this point). Clicking asks for confirmation naming the protocol and
 * target before handing the URL to the OS handler (task #734); http/https/
 * mailto links never render through this component.
 */
export function CustomProtocolLink({ href, children }: { href: string; children?: ReactNode }) {
  const { formatMessage } = useIntl();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const protocol = href.slice(0, href.indexOf(":")).toLowerCase();

  const handleConfirmOpen = useCallback(() => {
    window.open(href, "_blank", "noopener,noreferrer");
    setConfirmOpen(false);
  }, [href]);

  const handleClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    setConfirmOpen(true);
  }, []);
  const handleAuxClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    setConfirmOpen(true);
  }, []);

  return (
    <>
      <MarkdownLink
        href={href}
        onClick={handleClick}
        // A middle click fires auxclick, not click, and the browser would open
        // the href as a new window; on desktop that reaches the shell's
        // window-open path, which opens these schemes. Ask first here too.
        onAuxClick={handleAuxClick}
      >
        {children}
      </MarkdownLink>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="custom-protocol-link-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{formatMessage({ id: "message.messageItem.customProtocolLink.title" })}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>
            {formatMessage({ id: "message.messageItem.customProtocolLink.body" }, { protocol })}
            <span className="mt-1 block break-all font-mono text-[0.875em]">{href}</span>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel size="lg">{formatMessage({ id: "message.messageItem.customProtocolLink.cancel" })}</AlertDialogCancel>
            <AlertDialogAction size="lg" onClick={handleConfirmOpen}>
              {formatMessage({ id: "message.messageItem.customProtocolLink.confirm" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
