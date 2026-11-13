import { useCallback } from "react";
import { Button, MarkdownLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import { setPublicVisitorConsent } from "../../analytics/publicVisitorConsent";

const PRIVACY_POLICY_URL = "https://raft.build/privacy";

/**
 * The public page's cookie banner (cindyz, 2026-10-14): a logged-out visitor
 * chooses whether the page may keep a random visitor id. Not modal: the page
 * stays readable either way. Where the law requires asking first, nothing is
 * stored before a choice, and the page shows this in the join banner's place
 * until the visitor chooses; elsewhere the id is on by default and this opens
 * from Cookie settings (cindyz, 2026-10-15). Accept and Reject look the
 * same: refusing must be as easy and as visible as accepting (CNIL guidance on
 * cookie banners). Copy follows the GOV.UK Design System cookie banner,
 * without splitting out analytics cookies (cindyz, 2026-10-15).
 */
export default function PublicCookieConsent({ onDone }: { onDone: () => void }) {
  const { formatMessage } = useIntl();
  const accept = useCallback(() => {
    setPublicVisitorConsent("accepted");
    onDone();
  }, [onDone]);
  const decline = useCallback(() => {
    setPublicVisitorConsent("declined");
    onDone();
  }, [onDone]);
  return (
    <Banner
      intent="info"
      density="sm"
      role="region"
      aria-label={formatMessage({ id: "pages.publicServer.cookieConsent.label" })}
      className="w-full shrink-0 rounded-none border-x-0 border-b-0 !px-5 max-sm:!px-3"
      data-testid="public-cookie-consent"
      title={formatMessage({ id: "pages.publicServer.cookieConsent.title" })}
      actions={(
        <div className="flex items-center gap-2">
          <Button size="md" variant="outline" onClick={accept} data-testid="public-cookie-consent-accept">
            {formatMessage({ id: "pages.publicServer.cookieConsent.accept" })}
          </Button>
          <Button size="md" variant="outline" onClick={decline} data-testid="public-cookie-consent-decline">
            {formatMessage({ id: "pages.publicServer.cookieConsent.decline" })}
          </Button>
        </div>
      )}
    >
      <span>
        {formatMessage({ id: "pages.publicServer.cookieConsent.body" })}
        {/* A link inside the sentence: raft-ui's prose link (MarkdownLink).
            The gap is a margin, not a space literal: Chinese copy takes no space. */}
        <MarkdownLink href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="ml-1" data-testid="public-cookie-consent-privacy">
          {formatMessage({ id: "pages.publicServer.cookieConsent.privacyLink" })}
          <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
        </MarkdownLink>
      </span>
    </Banner>
  );
}
