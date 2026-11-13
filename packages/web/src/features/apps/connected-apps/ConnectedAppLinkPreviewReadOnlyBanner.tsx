import { TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import Banner from "../../../components/ui/Banner";
import { opensInNewTabAriaLabel } from "../../../components/ui/LeavingRaftMark";

const LINK_PREVIEWS_DOCS_URL = "https://docs.raft.build/developers/raft-apps/link-previews/";

/**
 * On the App's page under My Apps, for an App that did not declare version 2
 * (#proj-apps:#55). Info, not warning: the App works, its previews are the
 * simpler kind. It also shows a registration that dropped the field by accident.
 */
export function ConnectedAppLinkPreviewReadOnlyBanner() {
  const { formatMessage } = useIntl();
  const docsLabel = formatMessage({ id: "settings.connectedApps.linkPreviewReadOnly.docs" });
  return (
    <Banner
      intent="info"
      density="sm"
      live={false}
      data-testid="connected-app-link-preview-read-only"
      title={formatMessage({ id: "settings.connectedApps.linkPreviewReadOnly.title" })}
      actions={(
        <TextLink variant="strong" render={<a href={LINK_PREVIEWS_DOCS_URL} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, docsLabel)} />}>
          {docsLabel}
          <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
        </TextLink>
      )}
    >
      {formatMessage(
        { id: "settings.connectedApps.linkPreviewReadOnly.body" },
        { code: (chunks) => <code key="preview-versions" className="rounded-sticker bg-fill-muted px-1 font-mono text-mono-code text-foreground">{chunks}</code> },
      )}
    </Banner>
  );
}
