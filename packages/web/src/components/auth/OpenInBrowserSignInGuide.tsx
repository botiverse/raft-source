import { useCallback, useState } from "react";
import { AuthBrandTopInset } from "../brand/AuthBrandShell";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import { CenteredCardBrandHeader } from "./CenteredCardFrame";
import { Button, ScrollArea, TextLink } from "@botiverse/raft-ui";

export default function OpenInBrowserSignInGuide({
  loginUrl,
  onBack,
}: {
  loginUrl: string;
  onBack?: () => void;
}) {
  const { formatMessage } = useIntl();
  // Holds a MessageId, not text. The default is the hint the guide shows before
  // any copy attempt — dropping it would silently remove that line.
  const [copyStatus, setCopyStatus] = useState<MessageId>("auth.openInBrowser.copyHint");

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopyStatus("auth.openInBrowser.copied");
    } catch {
      setCopyStatus("auth.openInBrowser.copyFailed");
    }
  }, [loginUrl]);

  const handleCopyClick = useCallback(() => {
    void copyLink();
  }, [copyLink]);

  return (
    // The status-bar inset belongs to the brand bar's frame, outside the scroller,
    // as on the other auth pages (AuthBrandShell, docs/frontend/pwa-system-bars.md).
    <div className="flex min-h-0 flex-1 flex-col">
    <AuthBrandTopInset />
    {/* raft-ui ScrollArea, as AuthBrandShell's: the stack is its content. */}
    <ScrollArea className="min-h-0 flex-1 bg-layer-canvas font-display" contentClassName="flex min-h-full w-full flex-col safe-bottom" data-testid="open-in-browser-scroller">
      <CenteredCardBrandHeader />
      <main className="flex min-h-0 flex-1 px-5 pb-10 pt-8 sm:px-8 sm:pt-12">
        <div className="w-full max-w-lg pt-[5vh] sm:pt-[4vh]">
          <h1 className="text-title text-foreground sm:text-display">
            {formatMessage({ id: "auth.openInBrowser.title" })}
          </h1>
          <p className="mt-4 text-body text-foreground-muted">
            {formatMessage({ id: "auth.openInBrowser.description" })}
          </p>
          <div className="mt-7 grid gap-3 sm:flex sm:items-center">
            <Button
              variant="primary"
              size="lg"
              className="w-full sm:w-auto"
              // Raft's own sign-in page, handed to the system browser: a sign-in
              // and not another site, so no ↗ (Navigation › Links that leave Raft).
              render={<a href={loginUrl} target="_blank" rel="noopener noreferrer" aria-label={formatMessage({ id: "auth.openInBrowser.openBrowser" })} />}
            >
              {formatMessage({ id: "auth.openInBrowser.openBrowser" })}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
              onClick={handleCopyClick}
            >
              {formatMessage({ id: "auth.openInBrowser.copyLink" })}
            </Button>
          </div>
          <p className="mt-3 text-caption text-foreground-hint">{formatMessage({ id: copyStatus })}</p>
          {onBack ? (
            <TextLink
              onClick={onBack}
              className="mt-5 text-footnote"
            >
              {formatMessage({ id: "auth.openInBrowser.backToOptions" })}
            </TextLink>
          ) : null}
        </div>
      </main>
    </ScrollArea>
    </div>
  );
}
