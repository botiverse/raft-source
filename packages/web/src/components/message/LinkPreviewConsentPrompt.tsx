import { useCallback, useId } from "react";
import { useIntl } from "react-intl";
import { Button, MessageEmbed, MessageEmbedFooter, MessageEmbedHeader, Skeleton } from "@botiverse/raft-ui";
import { TriangleAlert } from "lucide-react";
import type { LinkPreviewApp } from "../../store/linkPreviewConsentStore";
import { ConnectedAppLogo } from "../settings/ConnectedAppLogo";

/**
 * The App's logo, or its initials when it has none or the image fails: the
 * same ConnectedAppLogo as every other App surface, at its `xs` step (27px,
 * the size of a `sm` IconTile, which the prompt's layout is measured on).
 * Decorative: the App's name is always written next to it.
 */
export function LinkPreviewAppLogo({ app }: { app: LinkPreviewApp }) {
  return (
    <span aria-hidden="true" className="flex shrink-0" data-link-preview-app-logo="">
      <ConnectedAppLogo name={app.name} logoUrl={app.icon} seed={app.id} size="xs" />
    </span>
  );
}

export type LinkPreviewPromptState = "idle" | "allowing" | "declining" | "failed";

/**
 * The first-view question in the link-card slot under a message: may this App
 * show previews of its links here? Built on MessageEmbed like the card it
 * replaces, and smaller than one. It names the App and says what allowing
 * tells it; nothing about the link itself. A neutral request: Allow is the
 * ink-bordered button, Don't Allow the frameless one, neither pink nor orange.
 */
export function LinkPreviewConsentPrompt({
  app,
  state,
  onAllow,
  onDecline,
}: {
  app: LinkPreviewApp;
  state: LinkPreviewPromptState;
  onAllow: (app: LinkPreviewApp) => void;
  onDecline: (app: LinkPreviewApp) => void;
}) {
  const { formatMessage } = useIntl();
  const titleId = useId();
  const allow = useCallback(() => onAllow(app), [app, onAllow]);
  const decline = useCallback(() => onDecline(app), [app, onDecline]);
  return (
    <MessageEmbed size="item" role="group" aria-labelledby={titleId} data-app-link-preview-prompt={app.id}>
      <MessageEmbedHeader className="flex items-start gap-2 pt-3 pb-1.5">
        <LinkPreviewAppLogo app={app} />
        <div className="min-w-0 flex-1 pt-[calc((27px-1lh)/2)] text-subhead text-foreground">
          <p id={titleId} className="m-0 break-words [overflow-wrap:anywhere]">
            {formatMessage(
              { id: "message.linkPreviewPrompt.title" },
              { app: app.name, b: (chunks) => <span key="b" className="font-semibold">{chunks}</span> },
            )}
          </p>
          {state === "failed" ? (
            <p role="alert" className="m-0 mt-0.5 flex items-start gap-1.5 text-footnote text-foreground" data-link-preview-prompt-error="">
              <TriangleAlert aria-hidden size={14} className="mt-[calc((1lh-14px)/2)] shrink-0 text-warning-strong" />
              <span className="min-w-0">{formatMessage({ id: "message.linkPreviewPrompt.allowFailed" }, { app: app.name })}</span>
            </p>
          ) : (
            <p className="m-0 mt-0.5 text-footnote text-foreground-muted">
              {formatMessage({ id: "message.linkPreviewPrompt.disclosure" }, { app: app.name })}
            </p>
          )}
        </div>
      </MessageEmbedHeader>
      {/* The buttons sit under the text, past the tile, on every width: on a
          phone there is no room beside it. */}
      <MessageEmbedFooter className="flex flex-wrap items-center gap-2 pt-0 pb-2.5 pl-[calc(0.75rem+27px+0.5rem)]">
        {/* focusableWhenDisabled: a busy button keeps keyboard focus (it is
            aria-disabled, not disabled), so a failed answer leaves focus on
            it (Allow becomes Retry) instead of dropping it to the page. */}
        <Button
          focusableWhenDisabled
          variant="default"
          loading={state === "allowing"}
          loadingLabel={formatMessage({ id: "message.linkPreviewPrompt.allowing" })}
          disabled={state === "declining"}
          onClick={allow}
        >
          {formatMessage({ id: state === "failed" ? "message.linkPreviewPrompt.retry" : "message.linkPreviewPrompt.allow" })}
        </Button>
        <Button
          focusableWhenDisabled
          variant="ghost"
          loading={state === "declining"}
          loadingLabel={formatMessage({ id: "message.linkPreviewPrompt.saving" })}
          disabled={state === "allowing"}
          onClick={decline}
        >
          {formatMessage({ id: "message.linkPreviewPrompt.dontAllow" })}
        </Button>
      </MessageEmbedFooter>
    </MessageEmbed>
  );
}

/** Holds a preview card's place, at a card's size, while it loads after Allow. */
export function LinkPreviewCardSkeleton() {
  const { formatMessage } = useIntl();
  return (
    <MessageEmbed
      role="status"
      aria-busy="true"
      aria-label={formatMessage({ id: "message.linkPreviewPrompt.loadingPreview" })}
      size="item"
      data-app-link-preview-pending=""
    >
      <MessageEmbedHeader className="grid gap-3 py-4">
        <Skeleton variant="line" className="w-20" />
        <Skeleton variant="line" className="w-64 max-w-full" />
        <Skeleton variant="block" className="h-5 w-20" />
        <Skeleton variant="line" className="w-60 max-w-full" />
      </MessageEmbedHeader>
    </MessageEmbed>
  );
}
