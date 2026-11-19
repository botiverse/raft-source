import { useIntl } from "react-intl";
import { Button, Spinner, Text, TextLink, TextLinkDownloadIcon } from "@botiverse/raft-ui";
import { trackDesktopDownloadClicked } from "../../analytics/appDownload";
import { desktopDownloadUrl } from "../../utils/desktopDownload";
import type { DesktopTarget } from "../../utils/desktopDownload";
import type { DesktopFirstOffer } from "./useDesktopFirstOffer";

/**
 * The setup's computer step in a browser: get Raft Desktop first, the commands
 * one click away (Wug / huxijin, 2026-11-14). Nova's 11-08 setup funnel: a third
 * of new servers stop at this step, about half of them without copying a single
 * command, and they are almost all at a computer that could run the app, which
 * adds it in one click (Add This Mac). Only for a computer that has a build
 * (`view.recommended`): a phone, a tablet, an ARM Linux box or a Windows PC
 * before its build ships get the commands as before (the caller decides).
 *
 * Same tab: the link resolves to a file download, as in Settings › About.
 */
export function SetupDesktopDownload({ offer }: { offer: DesktopFirstOffer }) {
  const { formatMessage } = useIntl();
  const { recommended, footnote } = offer.view;
  if (!recommended) return null;
  const clicked = (target: DesktopTarget) => {
    trackDesktopDownloadClicked("server_setup", target, "same_tab");
    offer.downloaded(target);
  };
  return (
    <div className="stack-y-3" data-testid="onboarding-desktop-download">
      <p className="text-callout text-foreground">
        {formatMessage({ id: "onboarding.computerRuntime.desktopBody" })}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          render={(
            <a
              href={desktopDownloadUrl(recommended.target)}
              aria-label={formatMessage({ id: recommended.labelId })}
              data-testid="onboarding-desktop-download-recommended"
              data-target={recommended.target}
              onClick={() => clicked(recommended.target)}
            />
          )}
          nativeButton={false}
          variant="accent"
          size="lg"
        >
          {formatMessage({ id: recommended.labelId })}
        </Button>
        {footnote ? (
          <TextLink
            render={(
              <a
                href={desktopDownloadUrl(footnote.target)}
                aria-label={formatMessage({ id: footnote.labelId })}
                data-testid={`onboarding-desktop-download-${footnote.target}`}
                onClick={() => clicked(footnote.target)}
              />
            )}
            className="text-footnote"
          >
            {formatMessage({ id: footnote.labelId })}
            <TextLinkDownloadIcon />
          </TextLink>
        ) : null}
      </div>
      {offer.waiting ? (
        <p className="flex items-center gap-2 text-footnote text-foreground-muted" data-testid="onboarding-desktop-download-waiting">
          <Spinner size="xs" />
          {formatMessage({ id: "onboarding.computerRuntime.desktopWaiting" })}
        </p>
      ) : null}
      <Text.Sans size="caption" variant="muted" className="block">
        {formatMessage({ id: "onboarding.computerRuntime.commandHint" })}
        <TextLink onClick={offer.useCommand} className="ml-1" data-testid="onboarding-desktop-download-use-command">
          {formatMessage({ id: "onboarding.computerRuntime.commandOpen" })}
        </TextLink>
      </Text.Sans>
    </div>
  );
}
